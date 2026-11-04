# 전 세계 매이저 카메라 RAW 포맷 풀 지원 및 브라우저 전용 초고속 디코더 고도화 계획

Canon(.CR2, .CR3), Nikon(.NEF, .NRW), Sony(.ARW), Fujifilm(.RAF), Olympus(.ORF), Pentax(.PEF), Samsung(.SRW), Hasselblad(.3FR), PhaseOne(.IIQ), Leica(.RWL), Panasonic(.RW2), Adobe(.DNG) 등 전 세계 주요 카메라 RAW 파일 포맷을 브라우저 로컬 Web Worker에서 서버 전송 없이 100% 로컬로 직접 디코딩하고, 카메라 제조사별 고유 컨테이너(ISOBMFF, RAF Header, TIFF SubIFD/MakerNote)로부터 원본 센서 해상도와 정밀 EXIF를 완벽히 추출합니다.

## User Review & Critical Decisions

> [!IMPORTANT]
> 사용자 질의응답을 통해 확정된 제품 및 아키텍처 결정 사항입니다.

- **지원 포맷 범위 (확정)**: 요청하신 6종 포맷(.NEF, .NRW, .RAF, .CR3, .CR2, .ARW)을 포함하여 Olympus(.ORF), Pentax(.PEF), Samsung(.SRW), Hasselblad(.3FR), PhaseOne(.IIQ), Leica(.RWL), Panasonic(.RW2), Adobe(.DNG) 등 글로벌 주요 제조사의 모든 RAW 포맷을 포괄적으로 지원합니다.
- **디코딩 아키텍처 (확정)**: 대용량 RAW 파일(50MB~150MB+)을 서버로 전송하지 않고 브라우저 로컬(Web Worker + OffscreenCanvas)에서 직접 바이트 수준으로 컨테이너를 파싱하여 수백 밀리초 이내에 16비트 선형 배열 및 고해상도 작업 버퍼로 로드합니다.
- **메타데이터 & 센서 규격 보존 (확정)**: Canon ISOBMFF box 파서, Fuji RAF 헤더 파서, Nikon/Sony/Olympus TIFF SubIFD 파서를 통해 카메라 제조사 고유 태그, 렌즈 정보, 셔터/조리개/ISO/화각, 그리고 센서의 유효 해상도(Effective Sensor Resolution)를 완벽하게 추출하고 내보내기 시 보존합니다.

---

## 1. Overview & Core Concept

- **What It Does**: 현존하는 거의 모든 상용 카메라 브랜드(Canon, Nikon, Sony, Fujifilm, Panasonic, Olympus, Pentax, Leica, Hasselblad, PhaseOne)의 RAW 포맷을 드래그앤드롭만으로 즉시 열람하고, 16비트 선형 센서 물리 기반으로 먼지를 탐지·복원합니다.
- **Target Audience**: 다양한 바디(예: 소니 A7/A1, 니콘 Z/D시리즈, 캐논 R/EOS시리즈, 후지 X/GFX시리즈 등)를 사용하는 상업 사진가, 천체/풍경 사진가, 스튜디오 리터쳐.
- **Key Value**: 별도의 외부 변환기(DNG Converter 등)를 거칠 필요 없이 원본 RAW 파일을 브라우저에 바로 던져 넣어 작업할 수 있으며, 네트워크 대역폭 소모 없이 안전하게 개인 사진을 다룰 수 있습니다.

---

## 2. Supported Camera RAW Formats & Container Specifications

| 카메라 제조사 | 확장자 | 컨테이너 구조 및 전용 파서 전략 |
| :--- | :--- | :--- |
| **Canon** | `.CR3` | **ISOBMFF (QuickTime/MP4 box)**: `ftypcrx `, `moov`/`trak`/`mdat`, `prvw`(Preview JPEG), `thmb` 박스를 파싱하여 최고해상도 원본 임베디드 스트림 및 EXIF 메타데이터 바이트 추출 |
| **Canon** | `.CR2` | **TIFF 확장 헤더 (`II\x2a\x00\x10\x00\x00\x00`)**: IFD0(미리보기), IFD1(썸네일), IFD2/3(슬라이스 RAW), Exif IFD 및 Canon MakerNote 태그 파싱 |
| **Nikon** | `.NEF`, `.NRW` | **TIFF 베이스 (`II\x2a\x00`)**: IFD0 SubIFD0/1, Exif MakerNote, JpgFromRaw(전체 해상도 JPEG) 오프셋 및 센서 풀사이즈 추출 |
| **Fujifilm** | `.RAF` | **Fujifilm CCD-RAW 헤더 (`FUJIFILMCCD-RAW `)**: 오프셋 84~104의 내장 JPEG 오프셋/길이 파싱 및 Fuji EXIF IFD 파서 구동 |
| **Sony** | `.ARW` | **TIFF 베이스 (`II\x2a\x00`)**: IFD0, SubIFD, SR2SubIFD(Tag 0x7010), 내장 최고 해상도 프리뷰 및 카메라 센서 치수 파싱 |
| **Olympus / OM** | `.ORF` | **Olympus 헤더 (`II\x52\x4f` 0x4F52, `II\x53\x52` 0x5253)**: 매직 바이트 검증 및 IFD 트리 탐색 |
| **Panasonic** | `.RW2`, `.RAW` | **Panasonic 헤더 (`II\x55\x00`)**: Tag 0x002E(JpgFromRaw), SensorWidth(0x0002), SensorHeight(0x0003) 파싱 |
| **Pentax** | `.PEF` | **TIFF 베이스 (`II\x2a\x00`)**: Pentax MakerNote 및 내장 풀사이즈 스트림 추출 |
| **Samsung** | `.SRW` | **TIFF 베이스**: 삼성 NX 시리즈 고유 IFD 구조 및 프리뷰 추출 |
| **Hasselblad** | `.3FR`, `.FFF` | **Hasselblad TIFF**: 중형 디지털 백 센서 메타데이터 및 프리뷰 파싱 |
| **PhaseOne** | `.IIQ` | **PhaseOne TIFF**: IQ 시리즈 중형 센서 치수 및 프리뷰 추출 |
| **Leica** | `.RWL`, `.DNG` | **TIFF / DNG 규격**: 라이카 M/SL/Q 시리즈 DNG/RWL 완벽 호환 |
| **Adobe 표준** | `.DNG` | **Adobe Digital Negative**: 16비트 선형 TIFF 스트립, SubIFD, DefaultCropSize 파싱 |

---

## 3. Technical Architecture & Implementation Details

### Parser Architecture Diagram

```
┌────────────────────────────────────────────────────────────────────────┐
│                      User Drop / File Open Event                       │
│    (.NEF, .NRW, .RAF, .CR3, .CR2, .ARW, .ORF, .PEF, .SRW, .3FR, etc.)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ ArrayBuffer
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Web Worker: decodeImageFileLocal (src/engine/tiffRawDecoder.ts)        │
│                                                                        │
│ 1. Header & Signature Sniffing:                                        │
│    ├─ ISOBMFF ('ftypcrx ' at +4): Canon CR3 Parser                     │
│    │  └─ traverseBoxes() -> extract 'prvw' box / JPEG stream & EXIF    │
│    ├─ Magic 'FUJIFILMCCD-RAW': Fujifilm RAF Parser                     │
│    │  └─ read offset at +84/+88 -> extract embedded preview & EXIF     │
│    ├─ Magic 0x4F52 ('RO') / 0x5253 ('SR'): Olympus ORF Parser          │
│    ├─ Magic 0x0055 (85): Panasonic RW2 Parser                          │
│    └─ Magic 0x002A (42): Standard TIFF (NEF, NRW, ARW, CR2, PEF, DNG)  │
│                                                                        │
│ 2. Deep IFD & MakerNote Traversal:                                     │
│    ├─ SubIFDs (Tag 330), Exif IFD (Tag 34665), MakerNote (Tag 37500)   │
│    ├─ Highest Resolution Preview Detection (SOF0/SOF1/SOF2 dimensions) │
│    └─ Native Sensor Dimensions (ImageWidth, ExifImageWidth, DNG crop)  │
│                                                                        │
│ 3. Color Space & 16-bit Linear Buffer Synthesis:                       │
│    ├─ Embedded ICC Profile (APP2 / Tag 34675) extraction & recognition │
│    └─ Perceptual 8-bit to 16-bit Linear LUT mapping (0..65535)         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ DecodedImagePayload
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Main Thread & UI Engine                                                │
│ ├─ Session Metadata: Brand, Model, Lens, Shutter, Aperture, ISO, Sensor │
│ ├─ DarkroomCanvas: Native resolution rendering & 16-bit Dust Inspection│
│ └─ Export Pipeline: DNG 16-bit Linear / TIFF 16-bit / PNG / JPEG       │
└────────────────────────────────────────────────────────────────────────┘
```

### Key Technical Implementations

1. **`src/engine/tiffRawDecoder.ts` 확장**:
   - `RAW_EXT_SET`에 `nef`, `nrw`, `raf`, `cr3`, `cr2`, `arw`, `orf`, `pef`, `srw`, `3fr`, `iiq`, `rwl`, `mos`, `mrw` 추가.
   - **Canon CR3 ISOBMFF Parser**:
     - 바이트 4~11에 위치한 `ftyp` 및 `crx ` 서명 검사.
     - ISO 박스(`moov`, `uuid`, `prvw`, `thmb`) 순회 루프 구현.
     - `prvw` 박스 내부의 고화질 풀해상도 JPEG 스트림 오프셋 및 바이트 크기 추출.
     - `CMT1`, `CMT2`, `CMT3`, `CMT4` 박스로부터 Canon TIFF EXIF 블록 추출.
   - **Fujifilm RAF Parser**:
     - 시작 16바이트의 `FUJIFILMCCD-RAW ` 검사.
     - 오프셋 84~92에서 내장 JPEG 오프셋과 길이 바이트를 빅엔디언으로 읽어 직접 추출.
     - RAF EXIF 헤더 오프셋 탐색을 통한 렌즈 및 촬영 파라미터 파싱.
   - **TIFF 기반 RAW (NEF, NRW, ARW, CR2, ORF, PEF) 확장**:
     - 매직 바이트 검증 확장: `0x4F52` (Olympus ORF), `0x5253`, `0x0055` (RW2), `0x002A` (Nikon, Sony, Canon CR2, Pentax).
     - Sony ARW의 SR2SubIFD (Tag 0x7010) 순회 및 전용 MakerNote 태그 처리.
     - Nikon NEF의 SubIFD0/SubIFD1 및 ScanOfScan JPEG 스트림 추출.
     - Canon CR2의 오프셋 8 이후 IFD 링크 및 스트립 테이블 처리.
2. **UI 입력 및 파일 필터 동기화**:
   - `src/App.tsx`:
     - 파일 업로드 `<input type="file" accept="..." />`에 `.rw2,.dng,.cr2,.cr3,.nef,.nrw,.raf,.arw,.orf,.pef,.srw,.3fr,.iiq,.rwl,.mos,.mrw,image/*` 전체 명시.
     - 빈 캔버스 드롭존 및 상단 헤더 툴팁에 "Canon(CR2/CR3), Nikon(NEF/NRW), Sony(ARW), Fujifilm(RAF), Panasonic(RW2), Olympus(ORF), Pentax(PEF), DNG 등 전 기종 RAW 지원" 안내 문구 반영.
   - `python/raw_pipeline.py` & `server.ts`:
     - 멀티 플랫폼 호환 및 서버 파이프라인(다운로드 및 일괄 처리)에서도 신규 확장자들을 정상적으로 허용하고 `rawpy`/`tifffile` 파이프라인과 일치시킵니다.

---

## 4. Verification & Testing Strategy

- **다양한 카메라 RAW 테스트**:
  - Canon CR3 (EOS R5/R6/R7 등 ISOBMFF 컨테이너)
  - Canon CR2 (EOS 5D Mark IV 등 레거시 TIFF 컨테이너)
  - Nikon NEF / NRW (Z9, Z7, D850 등 고해상도 니콘 컨테이너)
  - Sony ARW (A7R V, A7 IV, FX3 등 소니 컨테이너)
  - Fujifilm RAF (X-T5, X-H2, GFX100 등 후지필름 컨테이너)
  - Olympus ORF (OM-1, E-M1 등 올림푸스 컨테이너)
- **검증 항목**:
  1. 파일 드래그앤드롭 즉시 로컬 Web Worker 디코딩 성공 여부
  2. 제조사별 카메라 모델명, 렌즈명, 노출값(조리개, 셔터, ISO, 초점거리)의 정확한 추출 여부
  3. 센서 원본 해상도(Full Sensor Dimensions)의 정확한 유지 및 16비트 복원 파이프라인 연계
  4. 16비트 DNG / 16비트 TIFF / PNG / JPEG 무손실 내보내기 정상 동작 여부
  5. `compile_applet` 및 `lint_applet` 통과
