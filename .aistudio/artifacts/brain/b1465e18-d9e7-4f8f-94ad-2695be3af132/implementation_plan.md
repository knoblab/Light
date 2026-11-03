# 광색역 색공간 지원 (Adobe RGB · DCI-P3 · BT.2020 · ProPhoto RGB) 구현 계획

## 1. 목표 및 핵심 해결 과제
기존 `sRGB` 단일 색공간은 카메라 센서(RAW)나 광색역 촬영본(`Adobe RGB`, `DCI-P3`, `BT.2020`)의 깊은 에메랄드, 시안, 채도 높은 단풍/하늘 영역을 잘라내어(Gamut Clipping) 색감이 좁고 답답해지는 한계가 있습니다. 이를 해결하기 위해 **원본 색공간 자동 감지 + 수동 광색역 선택 + 전 포맷(DNG, 16-bit TIFF, PNG, JPG) 표준 ICC 프로파일 및 광색역 행렬 내장** 파이프라인을 구축합니다.

---

## 2. 세부 아키텍처 및 구현 항목

### A. 원본 색공간 및 내장 ICC 프로파일 자동 감지 (`/src/engine/colorSpaces.ts`, `/src/engine/tiffRawDecoder.ts`)
1. **메타데이터 및 바이너리 프로파일 추출**:
   - **TIFF / DNG / RAW (`Tag 34675 ICCProfile`)**, **JPEG (`APP2 ICC_PROFILE` 세그먼트)**, **PNG (`iCCP` / `cHRM` 청크)**에서 원본에 내장된 바이너리 ICC 프로파일(`Uint8Array`)과 프로파일 설명(`desc`)을 직접 추출합니다.
   - **EXIF 색공간 태그 감지**: `ColorSpace` (`Tag 40961 = 2` 또는 `65535 Uncalibrated`), `InteroperabilityIndex` (`"R03"` = Adobe RGB), 파나소닉 `.RW2` 내장 JPEG의 Adobe RGB 마커를 분석해 촬영 시 설정된 색공간(`Adobe RGB (1998)`, `Display P3`, `BT.2020`, `sRGB`)을 자동으로 판별합니다.
2. **Display P3 광색역 캔버스 디코딩 및 렌더링**:
   - 브라우저의 `OffscreenCanvas` 및 미리보기 캔버스에서 `colorSpace: 'display-p3'`(지원 기기) 및 `colorSpaceConversion: 'none'`을 활용하여 광색역 픽셀이 디코딩 과정에서 `sRGB`로 강제 클리핑되지 않도록 보존합니다.

### B. 6종 색공간 엔진 및 16-bit CIE XYZ(D50) 색역 변환 (`/src/engine/colorSpaces.ts`)
우측 패널 및 모바일 패널에서 즉시 확인·전환할 수 있는 색공간 옵션을 제공합니다:
1. **`auto` (원본 색공간 유지 - 기본값)**: 원본 파일에서 감지된 색공간과 내장 ICC 프로파일을 클리핑 없이 1:1 그대로 유지합니다.
2. **`adobe-rgb` (Adobe RGB 1998)**:
   - Primaries: `R(0.64, 0.33)`, `G(0.21, 0.71)`, `B(0.15, 0.06)`, White Point `D65`, Gamma `2.19921875 (563/256)`.
3. **`display-p3` (DCI-P3 / Display P3)**:
   - Primaries: `R(0.680, 0.320)`, `G(0.265, 0.690)`, `B(0.150, 0.060)`, White Point `D65`, sRGB/Display P3 전달 함수.
4. **`bt2020` (ITU-R BT.2020 / Rec.2020)**:
   - Primaries: `R(0.708, 0.292)`, `G(0.170, 0.797)`, `B(0.131, 0.046)`, White Point `D65`, BT.2020 12-bit TRC (`α=1.0993, β=0.0181`).
5. **`prophoto-rgb` (ProPhoto RGB / ROMM RGB)**:
   - Primaries: `R(0.7347, 0.2653)`, `G(0.1596, 0.8404)`, `B(0.0366, 0.0001)`, White Point `D50`, Gamma `1.8`.
6. **`srgb` (sRGB IEC61966-2.1)**: 웹 표준 호환용 색공간.

- **16-bit 정밀 색공간 변환**:
  - 원본 색공간과 다른 출력 색공간을 수동 선택한 경우, 65,536단계 선형화 LUT → Bradford 색순응(Chromatic Adaptation)이 적용된 `3×3` `RGB_lin → CIE XYZ (D50) → Target_RGB_lin` 행렬 연산 → 타깃 색공간 65,536단계 감마 LUT를 거쳐 계조 손실 없이 변환합니다.
  - 먼지 영역 외 무손실 보존(`Zero-Touch Outside Mask`) 원칙은 동일하게 유지되어, `원본 유지(auto)` 시 먼지 바깥 픽셀은 단 1비트도 변하지 않습니다.

### C. 표준 ICC v2.4 바이너리 프로파일 생성 및 포맷별 내장 (`/src/engine/binaryExporters.ts`)
내보낸 사진을 갤러리 앱, 포토샵, 라이트룸, 운영체제 뷰어에서 열었을 때 광색역 색상이 정확히 표시되도록 모든 내보내기 포맷에 **실제 표준 ICC 프로파일 바이너리**를 심습니다:
1. **표준 ICC v2.4 프로파일 빌더 (`buildIccProfileBytes`)**:
   - 선택한 색공간(`Adobe RGB (1998)`, `Display P3`, `Rec.2020`, `ProPhoto RGB`, `sRGB`)의 D50 적응 원색 행렬(`rXYZ`, `gXYZ`, `bXYZ`), 백색점(`wtpt`), 감마 곡선(`rTRC`, `gTRC`, `bTRC`), 설명(`desc`) 태그를 포함한 국제 표준 ICC v2.4 바이너리를 생성합니다 (원본에 자체 ICC 프로파일이 있고 `auto` 모드인 경우 원본 ICC 바이너리를 그대로 보존).
2. **포맷별 프로파일 삽입**:
   - **DNG (16-bit)**: `IFD0`에 `ICCProfile (Tag 34675)` / `AsShotICCProfile (Tag 50831)` 및 선택된 광색역에 맞춘 `ColorMatrix1 (Tag 50721)`·`ProfileName (Tag 50936)`·`ProfileToneCurve (Tag 50940)`를 함께 기록합니다.
   - **TIFF (16-bit)**: `IFD0`에 `Tag 34675 (ICCProfile)` 바이너리를 내장하여 포토샵·라이트룸·캡처원에서 즉시 `Adobe RGB` / `Display P3` / `BT.2020`으로 인식되게 합니다.
   - **PNG (무손실)**: PNG 바이너리 스트림의 `IHDR` 직후에 표준 `cHRM`(원색 좌표) 및 `gAMA` 청크를 삽입하여 광색역 뷰어 호환성을 보장합니다.
   - **JPG (98%)**: JPEG `SOI (FF D8)` 마커 직후에 표준 `APP2 (FF E2, "ICC_PROFILE\0\x01\x01")` 세그먼트로 ICC 프로파일 바이너리를 무손실 삽입합니다.

### D. UI 통합 (`/src/App.tsx`)
- 상단 메타데이터 바에 현재 감지·적용된 색공간 배지(`Adobe RGB`, `Display P3`, `BT.2020` 등)를 표시합니다.
- 우측 패널(복원 설정 섹션) 및 내보내기 드롭다운/모바일 트레이에 **색공간 선택기(`원본 유지`, `Adobe RGB`, `DCI-P3`, `BT.2020`, `ProPhoto RGB`, `sRGB`)**를 배치하여 한 번의 클릭으로 색공간을 지정하고 내보낼 수 있게 합니다.
