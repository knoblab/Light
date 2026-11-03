# DNG·TIFF·JPG·PNG 전 포맷 카메라 및 EXIF/XMP 메타데이터 완전 보존 엔진

카메라 원본 파일(RAW, RW2, DNG, TIFF, JPEG)에서 카메라 제조사(Make), 모델(Model), 렌즈 정보(LensModel), 촬영 파라미터(셔터스피드, 조리개, ISO, 초점거리, 화이트밸런스 등) 및 EXIF/XMP 바이너리 블록을 완전히 파싱하여 보존하고, DNG·16비트 TIFF·JPG·PNG로 내보낼 때 100% 무손실로 주입하는 시스템을 구현합니다.

## User Review & Critical Decisions

> [!IMPORTANT]
> 사용자가 Phase 1 질문을 통해 확정한 요구사항을 반영하였습니다:
> - **보존 범위**: 카메라 제조사, 모델, 렌즈 및 모든 EXIF 태그(EXIF IFD, GPS, 촬영 설정) 완전 보존.
> - **주입 방식**: EXIF 및 XMP 바이너리 블록을 원본 규격에 맞추어 무손실 직접 주입 (DNG/TIFF IFD 링크, JPEG APP1 마커 세그먼트, PNG eXIf/iTXt 청크).

- **확정된 결정 1**: 모든 내보내기 포맷(DNG, TIFF, JPG, PNG)에서 카메라 모델명 및 렌즈 정보가 윈도우 탐색기, 맥 Finder, 라이트룸, 스마트폰 갤러리 상세정보에서 그대로 유지되도록 합니다.
- **확정된 결정 2**: 먼지가 제거된 픽셀 데이터만 정밀 복원되고, 카메라 메타데이터 및 ICC 광색역 프로파일은 원본과 동일하게 1:1 패키징됩니다.

---

## 1. Overview & Core Concept

- **목적**: 사용자가 센서 먼지를 제거한 후 사진을 내보냈을 때 카메라 모델명(`Lumix DC-G9`, `Sony ILCE-7M4`, `Canon EOS R5` 등), 렌즈 정보, 촬영 일시, ISO, 셔터스피드, 조리개, 색온도, GPS 정보 등이 삭제되거나 "Unknown"으로 유실되는 문제를 방지합니다.
- **지원 대상**:
  - **입력**: RAW(.rw2, .cr2, .cr3, .nef, .arw, .orf, .raf), .dng, .tif/.tiff, .jpg/.jpeg, .png
  - **출력**:
    - **DNG (16-bit)**: IFD0 (카메라 제조사/모델, 소프트웨어, 일시) + ExifIFD (태그 34665: 노출값, 렌즈, ISO 등) + XMP (태그 700) + ICC (태그 34675)
    - **TIFF (16-bit)**: 표준 ExifIFD 서브 디렉터리 및 원본 메타데이터 완벽 복제
    - **JPG (98%)**: `APP1` (`\xFF\xE1`) Exif 블록 + `APP1` XMP 블록 + `APP2` ICC 프로파일 직접 주입
    - **PNG (무손실)**: 표준 `eXIf` 청크 및 `iTXt` (XMP) 청크 주입

---

## 2. Technical Architecture & Component Flow

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Original Image File (Client)                    │
│    (RAW / RW2 / DNG / TIFF / JPEG / PNG with embedded EXIF & XMP)      │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│             tiffRawDecoder.ts (Metadata Extraction Engine)             │
│  - Parses IFD0 Tags: Make, Model, DateTime, Software, Artist, etc.     │
│  - Parses ExifIFD Tags: ExposureTime, FNumber, ISO, LensModel, etc.    │
│  - Captures Raw APP1 EXIF segment bytes (\xFF\xE1)                     │
│  - Captures Raw XMP packet bytes (Tag 700 or http://ns.adobe.com...)   │
│  - Captures Raw GPS IFD block if present                              │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
                                     ▼ SessionMetadata (stores enriched EXIF)
┌────────────────────────────────────────────────────────────────────────┐
│               sensorWorker.ts (Inpaint + Package Coordinator)          │
│  - Performs 16-bit sensor dust inpainting on image channels            │
│  - Forwards complete SessionMetadata to binary exporters               │
└──────────────────┬─────────────────┬──────────────────┬────────────────┘
                   │                 │                  │
                   ▼                 ▼                  ▼
┌─────────────────────────┐ ┌──────────────────┐ ┌──────────────────────┐
│  writeLinearDngBuffer   │ │ writeTiff16Buffer│ │ injectExifAndIccTo   │
│  (Dual-IFD DNG 1.4)     │ │ (16-bit TIFF)    │ │ Jpeg / PNG           │
│  - IFD0 Make/Model/Date │ │ - Standard       │ │ - APP1 EXIF Segment  │
│  - Tag 34665: ExifIFD   │ │   ExifIFD subIFD │ │ - APP1 XMP Segment   │
│  - Tag 34853: GPS IFD   │ │ - Tag 34675: ICC │ │ - APP2 ICC Profile   │
│  - Tag 700: XMP Packet  │ │ - Tag 700: XMP   │ │ - PNG eXIf/iTXt      │
└─────────────────────────┘ └──────────────────┘ └──────────────────────┘
```

---

## 3. Key Implementation Steps

### 3.1 Metadata Extraction (`/src/engine/tiffRawDecoder.ts`)
- **EXIF IFD 확장 태그 수집**:
  - `LensModel` (Tag 42036 / 0xA434), `LensMake` (Tag 42035)
  - `ShutterSpeedValue` (Tag 37377), `ApertureValue` (Tag 37378), `ExposureBiasValue` (Tag 37380)
  - `MeteringMode` (Tag 37383), `Flash` (Tag 37385), `WhiteBalance` (Tag 41987)
  - `FocalLengthIn35mmFilm` (Tag 41989)
  - `Artist` (Tag 315), `Copyright` (Tag 33432), `DateTimeOriginal` (Tag 36867)
- **JPEG APP1 Segment 추출**:
  - `\xFF\xE1` 마커 중 `Exif\0\0` 헤더를 가진 전체 바이너리 블록 추출.
  - `\xFF\xE1` 마커 중 `http://ns.adobe.com/xap/1.0/\0` 헤더를 가진 XMP 패킷 추출.
- **TIFF/RAW 원본 ExifIFD 서브블록 보존**:
  - TIFF 태그 34665(ExifIFD), 태그 700(XMP), 태그 34853(GPS IFD)의 바이트 스트림을 `SessionMetadata`에 원본 그대로 보관.

### 3.2 DNG & TIFF ExifIFD Sub-Directory Builder (`/src/engine/binaryExporters.ts`)
- **IFD0 메타데이터 강화**:
  - 태그 271 (`Make`), 태그 272 (`Model`), 태그 306 (`DateTime`), 태그 305 (`Software`), 태그 315 (`Artist`), 태그 33432 (`Copyright`).
- **ExifIFD (Tag 34665) 서브 IFD 자동 생성**:
  - 노출 시간(태그 33434), 조리개(태그 33437), ISO(태그 34855), 촬영 일시(태그 36867/36868), 초점거리(태그 37386), 렌즈 모델(태그 42036) 등을 표준 규격에 맞게 인코딩하여 IFD0 내부 포인터로 연결.
- **XMP (Tag 700) & ICC (Tag 34675) 연동**:
  - 원본에 XMP가 있거나 추가 메타데이터가 있는 경우 태그 700으로 안전하게 연결.

### 3.3 JPEG & PNG 메타데이터 바이너리 주입 (`/src/engine/binaryExporters.ts`)
- **JPEG**:
  - 파일 헤더 구조: `SOI (\xFF\xD8)` -> `APP1 (EXIF)` -> `APP1 (XMP)` -> `APP2 (ICC Profile)` -> DQT/SOF/SOS 이미지 스트림.
  - 브라우저 캔버스가 잃어버리는 모든 EXIF 및 XMP를 원래 파일의 마커 세그먼트와 합성.
- **PNG**:
  - PNG 헤더 (`\x89PNG\r\n\x1a\n`) 바로 다음 `IHDR` 청크 뒤에 표준 `eXIf` 청크(EXIF raw bytes) 및 `iTXt` 청크(XMP 메타데이터) 삽입.

### 3.4 UI 및 메타데이터 인스펙터 연동 (`/src/App.tsx`)
- 우측 인스펙터 및 상단 헤더에 카메라 바디 및 렌즈 모델 정보 표시 (예: `Panasonic DC-G9 · LEICA DG 12-60mm`).
- "메타데이터 보존됨" 뱃지 제공으로 사용자가 안심하고 작업할 수 있도록 피드백 제공.

---

## 4. Verification & Testing Plan

1. **빌드 검증**:
   - `lint_applet` 및 `compile_applet` 통과 확인 (TypeScript 0 errors).
2. **바이너리 태그 정합성 검증**:
   - DNG 파일: TIFF 헤더 `II (0x4949)`, IFD0의 태그 271(Make), 272(Model), 34665(ExifIFD) 오프셋 정상 점검.
   - TIFF 파일: 16비트 포맷에서 ExifIFD 및 ICC 태그 34675 동시 존재 확인.
   - JPEG 파일: `FF D8 FF E1 [EXIF] FF E1 [XMP] FF E2 [ICC]` 헤더 정합성 확인.
   - PNG 파일: `eXIf` 청크 CRC32 체크섬 계산 및 유효성 확인.
3. **윈도우 / 맥 / 모바일 호환성**:
   - 출력된 파일을 사진 뷰어 또는 EXIF 리더에서 열었을 때 카메라 이름, 셔터, 조리개, ISO, 날짜가 완전히 표시되는지 확인.
