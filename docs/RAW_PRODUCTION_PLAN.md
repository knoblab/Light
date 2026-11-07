# SensorClean: 제품 수준 RAW 처리를 위한 분석 및 실행 계획

> **구현 언어를 Rust로 바꾸는 계획은 [RAW_PRODUCTION_PLAN_RUST.md](RAW_PRODUCTION_PLAN_RUST.md)를 참고하세요.** 이 문서의 1장(현황 분석)과 2장(합격 기준)은 두 계획이 공유합니다. 3~4장의 Python 구조와 로드맵은 Rust 계획에서 대체됩니다.

작성일: 2026-11-05 · 기준 커밋: `6fac965`

---

## 0. 요약

지금 SensorClean은 **센서 먼지 검출 데모로는 잘 동작하지만, RAW를 다루는 제품이라고 보기는 어렵습니다.** 원인은 세 가지입니다.

1. **RAW 데이터가 보존되지 않습니다.** 서버 경로는 RAW를 불러오자마자 sRGB 기준 RGB로 현상합니다(AHD 디모자이크, 하이라이트 클립). 그 RGB를 고친 다음 "Linear DNG"로 저장합니다. 결과물은 원본 RAW가 아니고, 메타데이터(EXIF/XMP)도 하나도 기록되지 않습니다.
2. **브라우저 경로의 "RAW 디코딩"은 실제로는 내장 JPEG입니다.** 서버가 응답하지 않으면 브라우저 디코더로 넘어가는데, 이 디코더는 대부분의 RAW에서 카메라가 넣어 둔 8비트 미리보기 JPEG를 센서 해상도로 **확대**합니다. 그 결과를 "16-bit linear"라고 표시하고 DNG로 내보냅니다.
3. **운영 구조가 데모 수준입니다.** Python 작업 프로세스가 하나뿐이고, 업로드할 때 다른 사용자의 세션을 지웁니다. 인증이 없고, 서버를 켤 때 인터넷에서 pip로 패키지를 설치하며, Windows에서는 실행되지 않습니다. 배포 설정(Cloudflare Pages)으로는 Express 서버를 띄울 수 없습니다.

**권장 방향**은 다음과 같습니다.

- **CFA(베이어 모자이크) 단계에서 먼지를 고칩니다.** 마스크 밖 원본 RAW 값은 비트 단위로 그대로 두고, 결과는 CFA DNG로 저장합니다.
- **비파괴 XMP 사이드카(Lightroom 스팟 제거 형식)를 기본 출력으로 둡니다.**
- **데스크톱 우선(로컬) 아키텍처로 바꿉니다.** 현재 React UI는 Tauri 셸로 감싸고, Python 엔진은 패키지로 묶어 사이드카로 실행합니다.

---

## 1. 현재 상태 분석

### 1.1 구조 개요

```
[React UI: App.tsx(1929줄) + DarkroomCanvas]
        │  localSensorEngine.ts  ← 이름은 local이지만 /api/* 서버를 먼저 호출함
        ├─(1순위)─ Express server.ts ── stdin/stdout JSON ── python/raw_pipeline.py (rawpy·OpenCV)
        └─(서버 실패 시)─ Web Worker sensorWorker.ts
                    ├ tiffRawDecoder.ts  (자체 TIFF 파서 + UTIF + 내장 JPEG 추출)
                    ├ dustAlgorithms.ts  (Python 알고리즘을 TS로 옮긴 사본, 2100줄)
                    └ binaryExporters.ts (DNG/TIFF/PNG/JPEG/ZIP 직접 작성)
[python/app.py] Streamlit 단독 앱. 세 번째 사본이며 임계값이 또 다름
```

- 같은 검출·복원 알고리즘이 **세 군데에 따로 구현**되어 있습니다(raw_pipeline.py, dustAlgorithms.ts, app.py). 예를 들어 `plane_center` 임계값이 86과 88로 다르고, 보케 스케일 수가 12와 8로 다릅니다. 기준이 되는 구현이 없습니다.
- 세션 ID 접두어(`sc_` 또는 `local_`)로 처리 엔진이 정해집니다(`localSensorEngine.ts:76`). 한 세션 안에서 엔진을 바꿀 수 없고, 어느 경로로 처리됐는지에 따라 결과 품질이 크게 달라집니다.

### 1.2 RAW 처리 정확도 (가장 중요)

| # | 문제 | 위치 | 영향 |
|---|---|---|---|
| R1 | `raw.postprocess()`가 출력 색공간 sRGB, 하이라이트 클립, AHD 디모자이크라는 기본값으로 바로 현상합니다. 원본 CFA 값(`raw_image_visible`)은 쓰지 않습니다. | `raw_pipeline.py:267` | 원본 RAW 보존 불가. 하이라이트와 sRGB 밖 색역 손실. 문서의 "zero DR loss" 주장과 다름 |
| R2 | 메타데이터에는 `colorSpace: "Camera Linear RGB"`라고 적지만 실제 데이터는 선형 sRGB 원색 기준입니다. | `raw_pipeline.py:384` | 잘못된 표시. 후속 색 변환 오류 |
| R3 | 노출 기준을 내장 JPEG의 85번째 백분위 비율로 맞춥니다. | `raw_pipeline.py:276-294` | 장면에 따라 노출이 흔들리는 임시방편. 검출 임계값이 이 값에 의존 |
| R4 | 브라우저 디코더는 CFA를 디코딩하지 않습니다. 베이어 IFD는 건너뛰고(`:1094`), 압축 RAW는 내장 JPEG를 센서 해상도로 확대합니다(`:1187-1214`, `:1797-1802`). | `tiffRawDecoder.ts` | 8비트 JPEG가 "RAW 16-bit"로 둔갑해 DNG로 출력됨 |
| R5 | CR3와 RAF는 미리보기 JPEG만 뽑습니다. 그런데 UI와 `index.html` 문구는 "전 기종 RAW 지원"을 광고합니다. | `tiffRawDecoder.ts:822`, `:936` | 사용자 신뢰 문제 |
| R6 | 방향(orientation), 크롭(ActiveArea/DefaultCrop), 블랙 레벨 반복 패턴, LinearizationTable, OpcodeList(GainMap, 렌즈 보정)를 모델로 다루지 않습니다. | 전반 | CFA 출력으로 가려면 반드시 필요 |
| R7 | 연속 촬영 매칭이 **방향이 적용된 출력 좌표**에서 이뤄집니다. 먼지는 센서에 붙어 있으므로 센서 좌표에서 맞춰야 합니다. | `raw_pipeline.py:1569-` | 가로·세로 사진이 섞이면 매칭이 틀림 |

### 1.3 출력과 메타데이터

| # | 문제 | 위치 |
|---|---|---|
| O1 | **서버 경로는 어떤 형식으로 내보내도 EXIF, XMP, ICC를 기록하지 않습니다.** piexif는 읽기에만 씁니다. | `raw_pipeline.py:1403-1566` |
| O2 | 서버가 `colorSpace` 요청 값을 무시합니다(구조 분해 대상에 없음). UI의 색공간 선택이 서버 경로에서는 효과가 없습니다. | `server.ts:454-461` |
| O3 | DNG가 LinearRaw이면서 ColorMatrix1으로 XYZ에서 sRGB로 가는 행렬을 쓰는데, UniqueCameraModel은 실제 카메라명입니다. 이 경우 Lightroom이 그 카메라의 프로파일을 잘못 적용할 수 있습니다(실제 확인 필요). Make 값이 없으면 `"Panasonic"`으로 채웁니다. | `raw_pipeline.py:1416-1443` |
| O4 | 16비트 TIFF가 sRGB 감마로 인코딩되지만 ICC 프로파일을 넣지 않습니다. | `raw_pipeline.py:1526-1541` |
| O5 | **TS 쪽 DNG/TIFF 작성기에 메모리 덮어쓰기 버그가 있습니다.** IFD0 바깥 데이터(ICC, XMP)를 IFD 바로 뒤에 이어 쓰는데, ExifIFD는 2048, SubIFD는 6144, 픽셀은 32768 위치에 고정되어 있습니다. ICC, XMP, 문자열 태그를 합쳐 약 1.6KB를 넘으면 ExifIFD를 덮어씁니다. Lightroom을 거친 XMP는 보통 수 KB라 이 조건에 쉽게 걸립니다. 약 32KB를 넘으면 픽셀 데이터까지 덮어씁니다. `writeIfdBlock`의 반환값도 검사하지 않습니다. | `binaryExporters.ts:197-232`, `:695-776` |
| O6 | TS 쪽 DNG의 IFD0 미리보기를 **전체 해상도 8비트**로 넣습니다. 61MP 기준 약 550MB를 ArrayBuffer 하나에 담아야 해서 브라우저 메모리 부족(OOM) 위험이 큽니다. | `binaryExporters.ts:666-699` |
| O7 | 한글 파일명이 `[^a-zA-Z0-9._-]` 규칙에 걸려 모두 `_`가 되고, 결국 `sensor_cleaned`로 바뀝니다. | `server.ts:482-489` 외 |

### 1.4 검출과 복원 알고리즘

- **검출 해상도가 2304px로 고정**되어 있습니다(`raw_pipeline.py:329`, `:652`). 최소 반경을 검출 해상도 기준 1.2px로 막아 두었기 때문에, 원본 기준으로 잡을 수 있는 최소 반경이 24MP에서 약 3px, 100MP에서 약 6px입니다. 고화소일수록 작은 먼지를 놓칩니다.
- **임계값이 8비트 감마 단위의 고정 숫자**입니다(86, 3.45, 1.55 등). 이 값들은 특정 샘플에 맞춰 조정됐습니다(주석에 `#35`, `#42` 같은 샘플 번호가 남아 있음). ISO에 따른 노이즈 모델이 없어서 고감도 사진에서는 오검출과 미검출이 같이 늘어납니다.
- 밝기가 86 미만인 영역은 아예 검출하지 않습니다. 하늘이 아닌 장면의 먼지는 대상이 아닙니다.
- **복원 방식**: 디모자이크된 RGB에 Telea 인페인팅과 가우시안 블렌딩, 노이즈 합성을 적용합니다. 문제가 두 가지 있습니다.
  - 마스크를 2304px 작업 해상도에서 그린 뒤 최근접 보간으로 원본 크기까지 늘립니다(`:1156-1159`). 그래서 원본 해상도에서는 경계가 계단 모양입니다.
  - 보케 먼지는 **반투명한 감쇠(transmission)** 현상인데, 이를 인페인팅으로 **지워 버립니다.** 구름 결처럼 먼지 아래에 있던 디테일이 사라집니다. 게인 보정(나누기)으로 처리하는 편이 맞습니다.
- 연속 촬영 모드는 14px 고정 허용 오차로 단순 연결 군집화를 합니다(O(n²)). 다른 프레임에서 찾은 위치를 투영해 추가하는 스팟은 원형도 0.95, 대비 1.5%라는 **임의의 값**으로 만들어지고, 기본으로 켜진 상태라 먼지가 없는 곳도 복원할 수 있습니다(`:1668-1697`).

### 1.5 서버와 운영

| # | 문제 | 위치 |
|---|---|---|
| S1 | 업로드할 때 `pruneOldSessions(1)`이 가장 최근 1개를 제외한 **다른 사용자의 세션을 삭제**합니다. 다중 업로드는 `pruneOldSessions(0)`이라 전부 삭제합니다. | `server.ts:317`, `:686` |
| S2 | Python 작업 프로세스가 하나뿐이고 대기열도 없습니다. 요청 하나가 240초 제한에 걸리면 프로세스를 종료하면서 **대기 중인 모든 요청이 함께 실패**합니다. | `server.ts:149-253` |
| S3 | 서버 시작 시 `bash`, `curl`, `get-pip.py`로 실행 중 설치를 하고 버전도 고정하지 않습니다. 실행 파일 경로를 `.venv/bin/python`으로 고정해 **Windows에서 동작하지 않습니다.** | `server.ts:44-95` |
| S4 | 인증과 권한 관리가 없습니다. 세션 ID만 알면 원본 RAW와 `.npy` 파일까지 받을 수 있습니다. | `server.ts:285-297` |
| S5 | 메모리: 100MP 기준 RGB uint16 한 벌이 600MB인데, 원본과 체크포인트를 합쳐 세션당 약 1.2GB를 쓰고 이를 최대 3세션까지 캐시합니다. 디스크에도 `.npy`를 여러 개 저장합니다. | `raw_pipeline.py:139-168`, `:406-415` |
| S6 | 업로드 제한이 200MB라 IIQ나 150MP 파일은 거부됩니다. 진행 상황 스트리밍과 취소 기능이 없습니다. | `server.ts:38` |
| S7 | `wrangler.toml`이 Cloudflare Pages(정적 호스팅)용이라 Express와 Python을 실행할 수 없습니다. 배포하면 항상 브라우저 대체 경로(R4)로만 동작합니다. | `wrangler.toml` |

### 1.6 프런트엔드와 UX

- `App.tsx` 한 파일에 1929줄, `useState` 약 30개가 몰려 있고 상태 저장소(store)가 없습니다. 실행 취소/다시 실행 기록도 React 상태에 스냅샷으로 쌓습니다.
- **원본 해상도 1:1 보기가 불가능합니다.** 2304px JPEG 미리보기를 CSS로 최대 4배까지 확대할 뿐입니다(`DarkroomCanvas.tsx:497`, `:804-842`). 먼지 검수에는 픽셀 단위 확인이 필수입니다.
- 화면 표시에 색 관리가 없습니다(img 태그와 2D canvas 기본값).
- 내보낼 때 청크를 모두 메모리에 모은 뒤 Blob을 만듭니다(`localSensorEngine.ts:91-106`). File System Access API 스트리밍을 쓰지 않습니다.
- 문자열이 모두 한국어로 하드코딩되어 있어 다국어 지원이 없습니다.
- **브랜드와 법적 위험**:
  - 컴포넌트 이름이 `AdobeScIcon`이고, "Adobe Signature" 스타일의 아이콘과 Adobe식 배지를 씁니다.
  - "100% rejected", "zero halo", "무손실" 같은 과장 문구가 있습니다.

### 1.7 저장소 정리 상태

- 패키지 이름이 `react-example`입니다. `@google/genai`, `motion`, `dotenv`는 사용하지 않는데 의존성에 있고, `.env.example`에 GEMINI 키 항목이 남아 있습니다.
- `public/assets/aistudio/`에 약 8MB의 스크린샷(사용자 사진 포함)이 **배포 번들에 그대로 들어갑니다.**
- 테스트와 CI가 없고 Python 의존성도 고정되지 않았습니다. 시스템 Python 3.14에 rawpy가 설치되어 있지 않습니다.
- **라이선스가 AGPL-3.0**입니다. SaaS로 상용화하면 소스 공개 의무가 생깁니다. 사업 모델과 함께 결정해야 합니다.

---

## 2. "제품 수준 RAW 처리"의 정의 (합격 기준)

| 영역 | 합격 기준 |
|---|---|
| 원본 보존 | CFA DNG 출력에서 **마스크 밖 픽셀이 원본 RAW와 비트 단위로 동일**(차이 0). 블랙/화이트 레벨, CFA 패턴, 크롭, 방향, 색 행렬 보존 |
| 호환성 | `dng_validate`(Adobe DNG SDK) 경고 0개. Lightroom Classic/ACR, Capture One, darktable, RawTherapee에서 열림. 같은 프로파일 조건에서 원본 RAW와의 렌더링 색차 ΔE2000 평균 1.0 이하 |
| 메타데이터 | EXIF(촬영값, 렌즈, GPS), XMP(별점, 키워드), 촬영 시각 보존. MakerNote는 `DNGPrivateData`로 보존 |
| 비파괴 | Lightroom이 읽을 수 있는 XMP 사이드카(`crs:RetouchAreas`)로 스팟을 내보내 원본 RAW를 건드리지 않는 방식 지원 |
| 카메라 범위 | 주요 5개 제조사 최신 바디 30종 이상(베이어), 후지 X-Trans 별도 지원. 테스트 코퍼스로 회귀 검증 |
| 검출 품질 | 합성 먼지 벤치마크에서 대비 1% 이상 재현율 95% 이상, 정밀도 90% 이상. 먼지 없는 세트에서 이미지당 오검출 1개 이하 |
| 성능 | 기준 PC(8코어, 32GB)에서 45MP 불러오기+검출 10초 이하, 스팟 1개 증분 복원 300ms 이하, 100MP 최대 메모리 2.5GB 이하 |
| 안정성 | 세션 격리, 작업 대기열, 취소, 장애 후 복구, 오류 보고 체계 |

---

## 3. 목표 구조와 주요 결정

### 3.1 결정 1: 실행 형태 (권장: A)

| 안 | 장점 | 단점 |
|---|---|---|
| **A. 데스크톱 로컬 앱**: Tauri 2 + 현재 React UI + Python 엔진 사이드카(uv/PyInstaller로 패키징) | 수백 MB RAW를 업로드할 필요가 없고 전체 해상도 메모리를 확보할 수 있음. 개인정보 걱정 없음. 사진가 작업 흐름(로컬 폴더, Lightroom 연동)에 맞음 | 코드 서명, 자동 업데이트, OS별 빌드 필요 |
| B. 웹 SaaS (현재 서버 강화) | 설치가 필요 없음 | 업로드 대역폭, 저장소 비용, 대기열/인증/확장성 구축, AGPL 공개 의무 |
| C. 브라우저 전용 (LibRaw WASM) | 서버가 필요 없음 | wasm32 4GB 메모리 한계, 61MP 이상에서 불안정, 성능 |

엔진은 실행 형태와 상관없이 **독립된 Python 패키지와 CLI**로 만듭니다. 그러면 나중에 B로도 확장할 수 있습니다.

### 3.2 결정 2: 출력 전략 (세 가지 모두 제공, 우선순위 순)

1. **XMP 사이드카 (비파괴, 기본값)**: 스팟을 Lightroom/ACR 형식인 `crs:RetouchAreas`(heal 유형, 정규화 좌표, 반경, 소스 오프셋)로 내보냅니다. 원본은 건드리지 않습니다. 위험이 가장 낮고 가치는 가장 큽니다.
2. **CFA DNG (파괴적이지만 원본 충실)**:
   - DNG 입력: 원본 파일을 복사한 뒤 **먼지 영역이 걸린 타일/스트립만** 같은 압축 방식(비압축 또는 LJ92)으로 다시 인코딩해 교체합니다. 나머지 태그는 모두 유지하고 `NewRawImageDigest`는 다시 계산하며 미리보기도 새로 만듭니다.
   - 독점 RAW 입력(RW2, CR3, NEF, ARW, ORF, RAF 등): LibRaw의 `raw_image_visible`, `raw_pattern`, `black_level_per_channel`, `white_level`, `rgb_xyz_matrix`, `camera_whitebalance`, 크기와 여백 정보로 **CFA DNG 1.6**을 씁니다(LJ92 타일, EXIF/XMP/MakerNote 포함).
   - 선택 기능: 사용자가 Adobe DNG Converter를 설치했다면 먼저 DNG로 변환한 다음 위의 "DNG 입력" 경로로 처리합니다. Adobe의 이중 광원 행렬과 Opcode가 그대로 보존됩니다.
3. **렌더링된 16비트 TIFF, JPEG, PNG**: 카메라 행렬로 XYZ를 거쳐 목표 색공간(sRGB, Display P3, Adobe RGB, ProPhoto)으로 정확히 변환하고, ICC와 EXIF를 넣습니다.

### 3.3 결정 3: 처리 도메인

```
RAW ──LibRaw unpack──► CFA uint16 (센서 좌표, 크롭 전)
   │                       │
   │   ┌───────────────────┘
   │   ▼
   │  검출용 렌더: CFA → 하프사이즈 4채널(R,G1,G2,B) → 녹색 평균 휘도
   │             (디모자이크 없음, 원본의 1/2 해상도, 노이즈 모델 정규화)
   │   ▼
   │  검출 (센서 좌표, 노이즈 시그마 단위 임계값, 타일 처리)
   │   ▼
   │  복원 (CFA 도메인, 같은 색 격자끼리):
   │    - 반투명 보케 먼지 → 감쇠 게인맵 추정 후 나누기 (아래 디테일 보존)
   │    - 불투명 선명 먼지/섬유 → 색 평면별 인페인팅 (PatchMatch 또는 Telea + 결 합성)
   │   ▼
   ├─► CFA DNG / DNG 부분 패치
   ├─► XMP 사이드카 (센서 좌표 → 방향/크롭 적용 정규화 좌표)
   └─► 화면 미리보기·TIFF: 별도 렌더 파이프라인(디모자이크 + 색 관리)
```

- **좌표계 기준은 센서(CFA) 좌표 하나입니다.** 화면, 작업, 출력 좌표는 모두 변환 함수 하나(방향, 크롭, 스케일)로 계산합니다. 연속 촬영 매칭과 먼지 프로파일도 센서 좌표로 처리합니다.
- **알고리즘 구현은 하나만 둡니다**(Python 엔진). TS 쪽 `dustAlgorithms.ts`와 `tiffRawDecoder.ts`의 대체 경로는 없애거나, "미리보기 전용(JPEG/PNG 편집)" 모드로 명시적으로 격하합니다.

### 3.4 목표 모듈 구성 (Python 엔진)

```
engine/sensorclean_engine/
  io/        decode.py (LibRaw 래퍼, 형식 판별, 카메라 지원표)
             dng_reader.py / dng_writer.py (CFA·LinearRaw, LJ92, 타일, 태그 전체)
             metadata.py (EXIF/XMP/MakerNote 읽기·쓰기, ExifTool 선택 연동)
             xmp_sidecar.py (crs:RetouchAreas)
  model/     raw_image.py (CFA, 패턴, 블랙/화이트, 행렬, 기하 정보를 담는 데이터 클래스)
             geometry.py (센서↔출력 좌표 변환, 방향, 크롭)
  color/     matrices.py, render.py (디모자이크, WB, 카메라→XYZ→출력, ICC)
  detect/    noise_model.py, sharp.py, bokeh.py, verify.py, tiles.py
  heal/      gain_correction.py, cfa_inpaint.py, grain.py, roi_cache.py
  session/   store.py (메모리맵 기반 세션, 메모리 예산, 정리)
  api/       ipc_server.py (JSON-RPC over stdio/HTTP, 진행률 이벤트, 취소)
  cli.py     (일괄 처리: sensorclean detect|heal|export <files>)
tests/       pytest + 골든 코퍼스 + 합성 먼지 벤치마크
```

---

## 4. 단계별 로드맵

일정은 1인 풀타임 기준의 대략적인 추정입니다.

### Phase 0: 안정화와 정직한 표기 (1주)
목표: 현재 기능이 사용자를 속이거나 파일을 망가뜨리지 않게 합니다.
- [x] 브라우저 대체 경로에서 **내장 JPEG를 RAW로 취급하지 않기**(R4, R5). 세션에 `decodeKind`를 기록하고, 미리보기로 열린 RAW와 일반 이미지는 DNG 내보내기를 막고 안내 배너를 표시합니다. 베이어 모자이크를 회색조 이미지로 읽던 UTIF 경로도 차단했습니다. (`src/engine/exportPolicy.ts`)
- [x] `binaryExporters.ts`의 IFD 바깥 데이터 겹침 버그 수정(O5): 태그 크기를 측정해 오프셋을 배치하고 4GB 초과는 오류로 처리합니다. DNG IFD0 미리보기는 긴 변 1024px로 축소했습니다(O6). 재현 테스트 포함.
- [x] 서버의 `pruneOldSessions`를 TTL(2시간)과 세션 소유권(클라이언트 쿠키) 기준으로 교체했습니다(S1). 다른 클라이언트의 세션·ZIP은 조회도 삭제도 되지 않습니다.
- [x] Python 경로를 OS에 맞게 찾고(`.venv\Scripts\python.exe`, `SENSORCLEAN_PYTHON`), 실행 중 pip 설치를 없앴습니다. 대신 `npm run setup:python`과 `python/constraints.txt`(버전 고정)를 둡니다(S3).
- [x] 과장 문구와 "Camera Linear RGB" 등 잘못된 표기를 정정했습니다. 파비콘과 아이콘 컴포넌트를 `SensorCleanIcon`으로 교체했습니다(Adobe 양식 제거).
- [x] `package.json` 이름 변경, 사용하지 않는 의존성 제거(`@google/genai`, `dotenv`, `motion`, `esbuild`, `autoprefixer`), 스크린샷을 `docs/dev-screenshots/`로 이동, `.env.example` 정리, `bun.lock` 갱신.
- [x] CI(GitHub Actions): `tsc --noEmit`, `vitest`, `vite build`, `pytest`, `ruff`(구문 오류와 미정의 이름만 검사; 전체 규칙은 Phase 1에서 코드 분리 후 적용).

**완료 기준**: Windows에서 `npm run dev`로 서버 경로가 동작합니다. 이 문서에 정리한 P0 버그가 재현되지 않습니다. → 서버 경로는 합성 이미지로 업로드·검출·내보내기·격리까지 확인했습니다. 실제 RAW 파일과 브라우저 화면은 아직 확인하지 못했습니다.

**0단계에서 추가로 발견해 고친 문제**
- `buildIccProfileBytes`의 버퍼가 1024바이트로 고정되어, 샘플 곡선을 쓰는 sRGB/Display P3 프로파일 생성이 예외로 실패했습니다(브라우저 경로에서 해당 색공간 내보내기 전부 불가).
- `runPythonPipeline`이 Python 쪽 실제 오류나 시간 초과에도 같은 작업을 새 프로세스로 처음부터 다시 실행했습니다.
- Python 실행 파일이 없으면 `spawn` 오류가 처리되지 않거나 알 수 없는 오류 메시지가 나왔습니다. 이제 설치 안내를 반환합니다.
- 한글 파일명: multer가 파일명을 latin1로 해석하고, 서버가 비ASCII 문자를 모두 `_`로 바꾸고, OpenCV `imwrite`가 비ASCII 경로에서 실패했습니다(O7). Windows 사용자명이 한글이면 세션 폴더 전체가 실패했을 문제입니다.
- 알 수 없는 내보내기 형식이 `.dng` 이름의 JPEG 파일로 만들어졌습니다.

### Phase 1: RAW 핵심 엔진 재구성 (2~3주)
- [ ] `engine/` 패키지를 만들고 `raw_pipeline.py`를 모듈별로 나눕니다. `app.py`(Streamlit)는 폐기하거나 엔진을 불러 쓰게 합니다.
- [ ] `RawImage` 모델을 만듭니다: CFA uint16(메모리맵), CFA 패턴(2×2 / 6×6), 채널별 블랙 레벨, 화이트 레벨, WB, `rgb_xyz_matrix`, 방향, 여백과 크롭.
- [ ] 센서↔출력 좌표 변환(`geometry.py`)과 왕복 정확도 단위 테스트를 만듭니다.
- [ ] 렌더 파이프라인: 화면 미리보기는 하프사이즈 렌더로 빠르게, 출력용은 고품질 디모자이크로 만들고, 색 변환에 카메라 행렬을 씁니다.
- [ ] 세션 저장소: `.npy` 여러 벌 대신 CFA 한 벌을 메모리맵으로 두고 피라미드 타일을 캐시합니다. 메모리 예산을 설정할 수 있게 합니다.
- [ ] 테스트 코퍼스를 구성합니다. raw.pixls.us 등에서 라이선스가 명확한 샘플을 받아 5개 제조사, X-Trans, DNG(비압축, LJ92, 타일)를 고루 넣고 Git LFS 또는 별도 스크립트로 내려받습니다.

**완료 기준**: 코퍼스 전체를 디코딩할 수 있습니다. 좌표 왕복 오차는 0.01px 미만입니다. 100MP 최대 메모리는 2.5GB 이하입니다.

### Phase 2: CFA 도메인 복원과 출력 충실도 (3~4주)
- [ ] `gain_correction.py`: 링 영역에서 평면 배경을 맞추고, 반경 방향 감쇠 프로파일(투과율 맵)을 추정해 CFA 색 평면별로 나눕니다. 아래 디테일을 보존하는 것이 목적입니다.
- [ ] `cfa_inpaint.py`: 불투명 먼지는 같은 색 격자끼리 인페인팅하고, 링 영역의 노이즈 통계(포아송-가우시안)에 맞춰 결을 합성합니다.
- [ ] 마스크를 원본 해상도에서 해석적으로(원 또는 획 SDF) 만들어 최근접 보간 확대를 없앱니다.
- [ ] `dng_writer.py`: CFA DNG 1.6(LJ92 타일), ColorMatrix1/2, CalibrationIlluminant, AsShotNeutral, BaselineExposure, DefaultCrop, ActiveArea, BlackLevelRepeatDim, EXIF IFD, XMP, `DNGPrivateData`, OriginalRawFileName, 미리보기 IFD, `NewRawImageDigest`.
- [ ] DNG 입력 부분 패치: 영향받는 타일만 다시 인코딩하고 나머지 바이트는 그대로 둡니다.
- [ ] `xmp_sidecar.py`: Lightroom `crs:RetouchAreas`를 출력하고 LR/ACR에서 실제로 불러오는지 확인합니다.
- [ ] 렌더 TIFF/JPEG/PNG에 ICC와 EXIF를 넣고, 색공간 선택이 실제로 반영되게 합니다(O1, O2, O4).

**완료 기준**: 마스크 밖 비트 단위 동일성 테스트 통과, `dng_validate` 경고 0개, LR/C1/darktable/RawTherapee에서 열림, ΔE2000 기준 충족.

### Phase 3: 검출 품질 (2~3주)
- [ ] 노이즈 모델: ISO별 CFA 노이즈를 추정해 임계값을 고정 숫자가 아니라 **시그마 단위**로 바꿉니다.
- [ ] 원본(하프사이즈 CFA) 해상도에서 타일 단위로 검출해 고화소에서도 작은 먼지를 놓치지 않게 합니다.
- [ ] 합성 먼지 벤치마크를 만듭니다. 깨끗한 RAW에 물리 모델(감쇠 프로파일, 조리개별 크기와 흐림)로 먼지를 넣고 정밀도와 재현율을 자동 측정합니다.
- [ ] 고정 숫자(86, 3.45 등)를 벤치마크 기준으로 다시 정해 특정 샘플에 대한 과적합을 없앱니다.
- [ ] **먼지 프로파일**: 센서 좌표 기준 바디별 먼지 맵을 저장하고 재사용합니다. 조리개와 사출동공 차이에 따른 반경 방향 위치 변화를 허용 범위 모델로 반영합니다. 투영된 스팟은 기본으로 끄고 "검토 필요"로 표시합니다.

**완료 기준**: §2의 검출 품질 기준을 충족하고, 벤치마크 결과를 CI에서 회귀 추적합니다.

### Phase 4: 앱과 UX (3주)
- [ ] **타일 기반 전체 해상도 뷰어**(WebGL): 엔진이 만든 피라미드 타일로 1:1부터 800%까지 볼 수 있게 하고, 브러시 좌표는 센서 좌표로 바로 다룹니다.
- [ ] 상태 관리를 Zustand 같은 저장소로 옮기고 `App.tsx`를 기능 단위로 나눕니다. 실행 취소/다시 실행은 명령(command) 모델로 바꿉니다.
- [ ] 작업 진행률 이벤트(stdio 또는 SSE), 취소, 오류 보고 체계를 만듭니다.
- [ ] 일괄 처리 대기열: 폴더를 불러와 먼지 프로파일을 적용하고, 검토 후 일괄 내보내기(XMP 또는 DNG)합니다.
- [ ] 원본 전후 비교, 스팟 목록 필터(신뢰도, 유형), 단축키 정리를 합니다.
- [ ] 다국어 지원(ko/en)과 접근성(aria, 키보드)을 갖춥니다.
- [ ] 화면 색 관리: Display P3 캔버스와 미리보기 ICC를 처리합니다.

### Phase 5: 패키징과 배포 (2주, 결정 1이 A일 때)
- [ ] Tauri 2 셸 구성, Python 엔진 사이드카 빌드(Windows/macOS), 코드 서명, 공증(macOS), 자동 업데이트.
- [ ] 크래시 보고와 사용자 동의 기반 원격 측정.
- [ ] 실제 파일 열기와 저장 대화상자, 파일 관리자 연동, 결과 폴더 규칙(`_cleaned.dng`, `.xmp`).
- (B안을 택한다면: 작업 대기열(Redis/RQ), 세션 격리, 인증, 객체 저장소, 업로드 재개(tus), 프로세스 풀, 레이트 리밋, CSP/보안 헤더.)

### Phase 6: 베타와 출시 (2주)
- [ ] 카메라 지원표 공개(코퍼스 결과 기반), 알려진 제약 문서화(X-Trans, 픽셀 시프트, 스택형 RAW 등).
- [ ] 라이선스 정리: LibRaw(LGPL-2.1/CDDL), rawpy(MIT), OpenCV(Apache-2.0), Adobe DNG SDK(별도 라이선스), ExifTool(Artistic/GPL)을 쓴다면 그 라이선스, 그리고 프로젝트 자체 라이선스(AGPL 유지 여부).
- [ ] 클로즈드 베타(사진가 10~20명)로 오검출 사례를 모아 벤치마크에 반영합니다.

---

## 5. 테스트와 검증 전략

| 계층 | 내용 |
|---|---|
| 단위 | 좌표 변환 왕복, LJ92 인코딩/디코딩 왕복, TIFF IFD 작성기(오프셋 겹침, 정렬, 태그 형식), 색 행렬 |
| 골든 | 코퍼스 RAW → CFA DNG → 다시 디코딩했을 때 마스크 밖 차이 0. 메타데이터 비교는 `exiftool -a -G1` 출력 비교 |
| 호환성 | `dng_validate` 자동 실행. darktable-cli와 RawTherapee-cli로 렌더해 원본 RAW 렌더와 ΔE 비교. LR/C1은 수동 체크리스트 |
| 품질 | 합성 먼지 벤치마크(정밀도, 재현율, 이미지당 오검출), 복원 품질(링 영역 대비 노이즈 통계 차이, 엣지 아티팩트 지표) |
| 성능 | 24/45/61/100MP 기준 시간과 최대 메모리를 CI에서 회귀 추적 |
| E2E | Playwright로 불러오기 → 검출 → 브러시 → 내보내기 흐름 |

---

## 6. 위험과 먼저 정해야 할 사항

1. **실행 형태(A/B/C)**와 **라이선스·사업 모델(AGPL 유지 여부)**: 이후 모든 단계에 영향을 줍니다.
2. **CFA DNG 색 충실도**: LibRaw는 단일 광원 행렬만 제공해서 Adobe 변환본과 색이 다를 수 있습니다. 이 때문에 Adobe DNG Converter 연동을 선택 기능으로 넣고, XMP 사이드카를 기본값으로 둡니다.
3. **X-Trans와 특수 RAW**(픽셀 시프트, 4채널 이상, Sigma Foveon): 1차 범위에서 빼고 지원표에 명시합니다.
4. **Lightroom `crs:RetouchAreas` 형식은 공개 명세가 아닙니다.** 실제 LR이 만든 XMP를 역분석해야 하고, 버전이 바뀌면 깨질 수 있습니다. 호환성 테스트가 필요합니다.
5. **반투명 먼지 게인 보정**: 구름처럼 결이 있는 배경에서 투과율을 추정하는 일은 연구 성격이 있습니다. Phase 3 벤치마크로 검증한 뒤 기본값으로 올립니다.

---

## 7. 바로 착수할 작업 (첫 2주)

1. Phase 0 전체(약 1주)
2. `engine/` 패키지 골격, `RawImage` 모델, 좌표 변환과 테스트
3. 테스트 코퍼스 내려받기 스크립트와 디코딩 회귀 테스트
4. XMP 사이드카 원형: LR에서 직접 만든 스팟 제거 XMP를 분석하고, 검출 결과를 같은 형식으로 쓰는 최소 구현. 원본을 건드리지 않으면서 가장 빨리 쓸모 있는 결과물을 낼 수 있는 경로입니다.
