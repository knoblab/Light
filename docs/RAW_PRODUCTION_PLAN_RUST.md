# SensorClean: Rust 기반 제품 수준 RAW 처리 계획

작성일: 2026-11-05 · 기준: Phase 0(Python 기반) 완료 상태 · 이전 문서: [RAW_PRODUCTION_PLAN.md](RAW_PRODUCTION_PLAN.md)

이 문서는 기존 Python 계획의 **목표와 합격 기준은 그대로 두고**, 구현 기반을 Rust로 바꿨을 때 달라지는 구조, 일정, 위험을 다룹니다. 문제 분석(원본 RAW 미보존, 2304px 검출 한계, 임계값 과적합 등)은 기존 문서의 1장을 그대로 따릅니다.

---

## 0. 요약

**Rust로 바꾸면 이 프로젝트의 가장 어려운 부분이 쉬워지고, 가장 단순했던 부분이 어려워집니다.**

| | Python 계획 | Rust 계획 |
|---|---|---|
| RAW 디코딩 | LibRaw(rawpy). 디모자이크된 RGB 위주로 설계됨 | **rawler**(순수 Rust). CFA 데이터, 블랙/화이트 레벨, 크롭, 색 행렬을 구조체로 바로 제공 |
| CFA DNG 쓰기 | 직접 구현해야 함(가장 큰 위험, Phase 2) | rawler에 DNG 쓰기 모듈(LJPEG-92 압축 포함)이 있음. **수정한 픽셀로 쓸 수 있는지는 R0에서 검증** |
| 영상 처리 | OpenCV(가우시안, 모폴로지, Telea 인페인팅 등)를 그대로 사용 | OpenCV 없이 직접 구현해야 함. **이 계획에서 가장 큰 추가 비용** |
| 배포 | Python 런타임 동봉(PyInstaller 등) | 단일 실행 파일. 설치 크기와 콜드 스타트가 유리 |
| 성능·메모리 | NumPy 배열 복사가 많음 | 타일 단위 병렬 처리와 메모리맵으로 제어 가능 |
| 위험 | 라이브러리가 성숙함 | rawler는 **API 불안정, 메인테이너 1명, 손상 파일에서 panic** |

**권장 방향**
1. 데이터 흐름은 기존 계획 그대로 **CFA 도메인에서 복원**하고, 마스크 밖 원본 값은 비트 단위로 유지합니다.
2. 디코딩은 **rawler 우선**, LibRaw(rsraw)는 비교와 폴백용 선택 기능으로 둡니다.
3. 실행 형태는 **Tauri 2 + 현재 React 화면 재사용 + Rust 코어**로 가되, 이행 중에는 **기존 `/api/*` 계약을 유지하는 axum 서버**로 Express/Python을 먼저 대체합니다. 화면을 바꾸지 않고 엔진만 바꿀 수 있습니다.
4. **Python 엔진은 R4까지 "정답 기준(오라클)"으로 유지**합니다. 포팅한 Rust 결과를 Python과 비교하며 검증합니다.
5. 착수 전에 **R0 스파이크(1주)** 로 go/no-go를 판단합니다(아래 4장).

---

## 1. 조사 결과 (2026-11-05 확인)

### 1.1 rawler 0.8.0 (dnglab의 라이브러리)

확인한 사실:
- 2026-08-30 공개. 라이선스 **LGPL-2.1**, 최소 Rust **1.89**, edition 2024, 코드 약 3만 줄. 다운로드 약 20만 회로 사용자가 있습니다(czkawka, vkdt 등이 사용).
- **API가 안정적이지 않고 SemVer를 따르지 않는다**고 저장소가 명시합니다. 문서화 비율은 약 10%입니다.
- 지원 형식: CR2, CR3(CRAW, CRM 동영상 프레임 포함), CRW, NEF/NRW, ARW/SRF/SR2/ARQ(픽셀시프트), RAF(X-Trans 포함), ORF, RW2, PEF, SRW, IIQ, 3FR, MOS, MRW, ERF, KDC/DCR, ARI 등. 카메라는 500종 이상입니다.
- DNG 입력은 JPEG XL 압축 DNG까지 `jxl-oxide`로 처리합니다.
- **`RawImage` 구조체**가 이 계획에 필요한 거의 모든 정보를 갖고 있습니다.
  - 픽셀: `data`, `pixels_u16()`, **`pixels_u16_mut()`**(수정 가능)
  - 센서 정보: `width/height/cpp/bps`, `blacklevel`, `whitelevel`, `blackareas`(마스킹 영역), `active_area`, `crop_area`, `orientation`
  - 색: `wb_coeffs`, `xyz_to_cam`, `color_matrix`(광원별), `cropped_cfa()`
  - 쓰기용: `dng_tags`(DNG 태그 덮어쓰기)
- **DNG 쓰기**: `rawler::dng::writer`, `dng::convert`(압축 방식, 미리보기, 썸네일, 크롭 모드, 원본 파일 포함 옵션), `dng::original`(원본 압축본 포함). DNG 1.0~1.6 버전 상수와 **LJPEG-92 압축**을 지원합니다.

위험 요소:
- czkawka 프로젝트가 **손상된 파일에서 panic이 많이 난다**고 보고했습니다(퍼징 부족). 세션이 죽지 않도록 격리가 필요합니다.
- 메인테이너가 사실상 **1명**입니다. 안정적인 C FFI는 로드맵에 아직 없다고 메인테이너가 답했습니다.
- 라이선스 LGPL-2.1이 이 프로젝트의 AGPL-3.0과 어떻게 결합되는지는 **법적 확인이 필요**합니다(정확히 "-only"인지 "-or-later"인지 포함). 저는 판단하지 않았습니다.

### 1.2 그 밖의 선택지
- **rsraw 0.1.1**: LibRaw의 Rust 래퍼. 2026-03 공개, 이 크레이트에 의존하는 프로젝트가 아직 없어 성숙도가 낮습니다. LibRaw 자체는 400종 이상을 지원합니다. 폴백용으로만 적합합니다.
- **rawloader**: rawler의 원형이며 사실상 유지보수가 중단됐습니다. 쓰지 않습니다.
- **OpenCV Rust 바인딩**: 네이티브 OpenCV 빌드와 배포가 무거워서 Rust로 가는 이점을 상쇄합니다. 제품 코드에는 쓰지 않습니다.

### 1.3 확인하지 못한 것 (R0에서 검증)
- 수정한 `RawImage`를 `dng::writer`에 직접 넘겨 CFA DNG를 만들 수 있는지(`convert_raw_file`은 파일 입력 전용이라 그대로는 부족)
- 그렇게 만든 DNG가 Lightroom, Capture One, darktable에서 열리는지, `dng_validate` 경고가 없는지
- 실제 카메라 파일에서 rawler와 LibRaw의 블랙/화이트 레벨이 일치하는지
- 61MP/100MP 파일의 디코딩 시간과 메모리
- 아래 크레이트 후보들의 최신 유지보수 상태와 버전(이 문서에는 버전을 적지 않았습니다)

---

## 2. 아키텍처

### 2.1 결정 사항

| 결정 | 선택 | 이유 |
|---|---|---|
| 앱 형태 | Tauri 2 + React 재사용 + Rust 코어 | 수백 MB RAW를 업로드할 필요가 없고, 단일 사용자라 세션 격리 문제가 사라짐 |
| 이행 방식 | 1단계: axum 로컬 서버(기존 `/api/*` 계약 유지) → 이후 Tauri 래핑 | 화면 코드를 바꾸지 않고 Express+Python을 먼저 제거 |
| 디코더 | rawler 1순위, rsraw(LibRaw)는 cargo feature로 선택 | 단일 의존 위험을 낮추고, 두 디코더 결과를 서로 검증 |
| 오라클 | Python 엔진 유지(R4까지) | 포팅 오류를 숫자로 잡기 위해 |
| 출력 | XMP 사이드카(기본) / CFA DNG / 렌더 TIFF·JPEG·PNG | 기존 계획과 동일 |
| 오류 격리 | `catch_unwind` + 디코딩 작업자 프로세스 분리 검토 | rawler의 panic 위험 |

### 2.2 처리 도메인 (기존 계획과 동일)

```
RAW ──rawler decode──► RawFrame { cfa: Vec<u16>, pattern, black/white, wb, matrices, geometry }
                           │  (센서 좌표, 크롭 전. 메모리맵/타일 접근)
                           ▼
  검출용 렌더: CFA → 하프사이즈 4채널(R,G1,G2,B) → G 평균 휘도 (디모자이크 없음)
                           ▼
  검출: 노이즈 시그마 단위 임계값, 이중 브랜치(선명/보케), 환형 SNR 검증, 타일 병렬
                           ▼
  복원 (CFA 도메인, 같은 색 격자끼리)
    - 반투명 보케 먼지 → 감쇠 게인맵 추정 후 나누기
    - 불투명 먼지/섬유 → 색 평면별 인페인팅 + 결(grain) 합성
                           ▼
  ├─► CFA DNG (rawler writer, 변경 타일만 재인코딩 가능한지는 R0에서 확인)
  ├─► XMP 사이드카 (crs:RetouchAreas, 센서 좌표 → 방향/크롭 적용 정규화 좌표)
  └─► 화면 미리보기·TIFF: 렌더 파이프라인(디모자이크 + 색 변환 + ICC)
```

좌표계는 **센서(CFA) 좌표 하나**입니다. 화면·작업·출력 좌표는 모두 `Geometry` 변환 하나로 계산합니다.

### 2.3 워크스페이스 구성

```
Cargo.toml                (workspace, rust-toolchain.toml로 1.89 이상 고정)
crates/
  sc-core/      RawFrame, Geometry(센서↔출력 변환), 오류 타입, 진행률/취소 토큰
  sc-decode/    rawler 어댑터, rsraw 어댑터(feature), 지원 카메라 표, panic 격리
  sc-imgproc/   가우시안, 면적 리사이즈, 모폴로지, 연결 성분, 거리 변환, Telea (OpenCV 대체)
  sc-detect/    노이즈 모델, 선명/보케 브랜치, 환형 SNR 검증, 타일 처리
  sc-heal/      게인 보정, CFA 인페인팅, grain, 증분 ROI 캐시
  sc-dng/       DNG 쓰기 래퍼, 검증, XMP 사이드카, EXIF/MakerNote 보존
  sc-color/     카메라→XYZ→출력 행렬, 디모자이크, ICC
  sc-session/   세션 저장소(메모리맵), 타일 피라미드, 메모리 예산
  sc-server/    axum (이행용 /api 계약), 이후 sc-app 로 대체
  sc-cli/       clap: sensorclean detect|heal|export <files>
src-tauri/      Tauri 2 셸 (R5)
src/            React 화면 (유지, R5에서 엔진 호출만 교체)
tests/          코퍼스 다운로드 스크립트, 골든 데이터, 합성 먼지 벤치마크
legacy/python/  Python 엔진 (오라클, R4 종료 시 제거)
```

---

## 3. Python → Rust 포팅 맵

`python/raw_pipeline.py`(약 1800줄)의 동작을 옮깁니다. OpenCV가 하던 일은 `sc-imgproc`로 직접 만듭니다.

| Python / OpenCV | Rust 구현 | 난이도·메모 |
|---|---|---|
| `cv2.GaussianBlur` | 분리형 f32 가우시안 + rayon | 쉬움. 큰 시그마(22)는 박스 근사 또는 다단계 |
| `cv2.resize(INTER_AREA)` | `fast_image_resize` 등 면적 평균 | 쉬움 |
| `cv2.dilate/erode` (타원 커널) | 직접 구현 | 쉬움 |
| `cv2.Sobel` | 직접 구현 | 쉬움 |
| `cv2.findContours`, `contourArea` | `imageproc` 또는 직접 | 보통. CFA 검출은 연결 성분으로 대체 가능 |
| `minEnclosingCircle`, `fitEllipse` | 직접 구현 | 보통 |
| `connectedComponentsWithStats` | 직접 구현 | 쉬움 |
| `distanceTransformWithLabels` | 직접 구현 | 보통 |
| **`cv2.inpaint(TELEA)`** | Fast Marching 기반 직접 구현 | **어려움.** 결과 품질을 Python과 비교 필요. 이후 PatchMatch로 교체 여지 |
| `np.linalg.solve/lstsq` (3×3 평면 피팅) | 정규방정식 직접 풀이 또는 `nalgebra` | 쉬움 |
| `np.percentile`, `np.median` | `select_nth_unstable` | 쉬움 |
| `np.bincount`, 섹터 통계 | 배열 누적 | 쉬움 |
| `tifffile` / DNG 쓰기 | rawler writer + `sc-dng` | R0 결과에 따라 결정 |
| `piexif` (EXIF 읽기) | rawler 메타데이터 + EXIF 크레이트 | 보통 |
| `rawpy.postprocess` | 자체 렌더 파이프라인(`sc-color`) | 보통. 미리보기용이라 하프사이즈 렌더부터 |

**포팅 원칙**
1. 먼저 **동치 포팅**(결과가 Python과 같은지)을 한 뒤에 개선(노이즈 모델 등)합니다. 포팅과 개선을 섞으면 어느 쪽 문제인지 구분할 수 없습니다.
2. 비교 기준은 합성 먼지 벤치마크와 코퍼스입니다. 검출 위치 일치율, 복원 영역 오차(PSNR), 먼지 밖 비트 동일성을 자동으로 측정합니다. Phase 0에서 만든 `python/tests`의 합성 이미지 생성기를 그대로 재사용합니다.
3. Phase 0에서 겪은 문제를 Rust 테스트로 옮깁니다: 한글 경로, 비ASCII 파일명, 겹치지 않는 IFD 배치, 모자이크를 이미지로 오인하지 않기.

---

## 4. 로드맵

일정은 1인 풀타임 기준의 대략적인 추정입니다. 기존 Python 계획(약 15~19주)보다 **2~3주 길어지는 것**이 OpenCV 대체와 이중 구현 검증 비용입니다.

### R0: 스파이크와 go/no-go (1주)
작은 실험 프로젝트에서 아래를 검증합니다. 제품 코드를 쓰기 전에 가장 큰 불확실성을 먼저 없앱니다.
- [ ] 실제 RAW 5종 이상(RW2, DNG, CR3, NEF, ARW 등)을 rawler로 디코딩하고 `RawImage` 필드를 덤프합니다.
- [ ] **핵심 검증**: `pixels_u16_mut()`로 수정한 `RawImage`를 `dng::writer`로 CFA DNG로 쓰는 코드를 완성합니다. 수정하지 않은 경우 원본과 픽셀이 비트 단위로 같은지 확인합니다.
- [ ] 그 DNG를 `dng_validate`, darktable, RawTherapee, Lightroom Classic에서 열어 렌더 결과를 원본 RAW와 비교합니다.
- [ ] 같은 파일을 rsraw(LibRaw)로 읽어 블랙/화이트 레벨, CFA 패턴, WB 값이 일치하는지 비교합니다.
- [ ] 손상·잘린 파일 20개로 panic 빈도를 측정하고 `catch_unwind` 격리가 충분한지 봅니다.
- [ ] 61MP, 100MP 파일의 디코딩 시간과 최대 메모리를 측정합니다.
- [ ] LGPL-2.1과 AGPL-3.0 결합에 대한 법적 검토를 시작합니다.

**go 기준**: CFA DNG 라운드트립이 성공하고(무수정 시 비트 동일, 주요 편집기에서 열림), 61MP 디코딩이 3초 이하, 격리 방법이 확보될 것.
**no-go 시 대안**: (a) DNG 쓰기를 `sc-dng`에서 직접 구현(기존 TS 저장기에서 얻은 IFD 배치 경험 활용, LJPEG-92 인코더는 rawler 소스를 참고), (b) 디코딩만 rawler/LibRaw를 쓰고 쓰기는 XMP 사이드카 위주로 먼저 출시.

### R1: 코어와 서버 대체 (2주)
- [ ] 워크스페이스 구성, `sc-core`(`RawFrame`, `Geometry`), `sc-decode`(rawler 어댑터와 panic 격리).
- [ ] 센서↔출력 좌표 변환과 **속성 기반 테스트**(왕복 오차 0.01px 미만).
- [ ] `sc-session`: CFA 한 벌을 메모리맵으로 두고 메모리 예산을 설정할 수 있게 합니다.
- [ ] `sc-color`: 하프사이즈 빠른 렌더, 카메라 행렬 기반 sRGB 변환.
- [ ] `sc-server`(axum): 기존 `/api/upload|detect|inpaint|export-*|session/*` 계약을 구현해 **React를 수정하지 않고** Express와 Python 작업 프로세스를 대체합니다(검출·복원은 이 단계에서 임시로 Python 오라클 호출을 허용하되, 인터페이스는 Rust 쪽에 고정).
- [ ] Phase 0의 서버 동작 이식: 한글 파일명, TTL 정리, 내보내기 형식 검증, `decodeKind` 계약(`exportPolicy`).
- [ ] 테스트 코퍼스 구성(raw.pixls.us 등 라이선스가 명확한 샘플, 제조사 5개 이상 + X-Trans + DNG 변형).

**완료 기준**: 코퍼스 전체를 디코딩하고, React 화면이 Rust 서버로 동작합니다. 100MP 최대 메모리 2.5GB 이하.

### R2: 영상 처리 기반과 검출 동치 포팅 (3~4주)
- [ ] `sc-imgproc` 프리미티브 구현과 각각의 단위 테스트(OpenCV 결과와 수치 비교).
- [ ] 하프사이즈 CFA 휘도 생성, 선명/보케 이중 브랜치, 환형 SNR 검증을 **Python과 동일한 결과**로 포팅합니다.
- [ ] 타일 단위 rayon 병렬화.
- [ ] 오라클 비교 하네스: 합성 벤치마크에서 검출 위치 일치율 95% 이상, 코퍼스에서 스팟 목록 차이 보고.

### R3: 복원과 출력 (3~4주)
- [ ] `sc-imgproc`의 Telea(Fast Marching) 구현과 Python 결과와의 PSNR 비교.
- [ ] `sc-heal`: CFA 도메인 게인 보정(반투명 먼지), 같은 색 격자 인페인팅, grain 합성(시드 고정으로 결정적), 마스크를 해석적으로 생성.
- [ ] `sc-dng`: R0에서 확정한 방식으로 CFA DNG 쓰기. 가능하면 영향받는 타일만 재인코딩. EXIF/XMP/MakerNote 보존.
- [ ] XMP 사이드카(`crs:RetouchAreas`): Lightroom이 실제로 만든 XMP를 분석해 같은 형식으로 출력.
- [ ] 렌더 TIFF/JPEG/PNG에 ICC와 EXIF를 기록하고 색공간 선택을 반영.

**완료 기준**: 마스크 밖 비트 동일성 테스트 통과, `dng_validate` 경고 0개, 주요 편집기에서 열림.

### R4: 검출 품질 개선 (2~3주)
- [ ] ISO별 노이즈 모델로 임계값을 **시그마 단위**로 전환합니다.
- [ ] 원본(하프사이즈 CFA) 해상도에서 검출해 고화소에서 작은 먼지를 놓치지 않게 합니다.
- [ ] 합성 먼지 벤치마크(정밀도·재현율·이미지당 오검출)를 CI에서 추적합니다.
- [ ] 센서 좌표 기준 먼지 프로파일과 연속 촬영 매칭.
- [ ] 위가 끝나면 **`legacy/python` 오라클을 제거**합니다.

### R5: 앱과 UX (3주)
- [ ] Tauri 2 셸. 큰 이미지 데이터는 JSON IPC가 아니라 **커스텀 프로토콜(URI scheme)** 로 타일을 제공합니다.
- [ ] WebGL 타일 뷰어(1:1 ~ 800%), 브러시 좌표는 센서 좌표로 직접 처리.
- [ ] 진행률 이벤트와 **협력적 취소**(`CancellationToken`).
- [ ] 폴더 일괄 처리 대기열, 전후 비교, 스팟 목록 필터, 다국어(ko/en), 접근성.
- [ ] 브라우저 대체 엔진(`dustAlgorithms.ts`, `tiffRawDecoder.ts`, `binaryExporters.ts`)과 Express 서버를 제거합니다.

### R6: 패키징과 출시 (2주)
- [ ] 코드 서명, macOS 공증, 자동 업데이트(Tauri updater).
- [ ] 크래시 보고(동의 기반), 카메라 지원표 공개(rawler 지원표 + 코퍼스 테스트 결과).
- [ ] `cargo-deny`로 의존성 라이선스 점검, 프로젝트 라이선스 정리.
- [ ] 클로즈드 베타(사진가 10~20명).

**합계: 약 17~22주** (R0 1 + R1 2 + R2 3~4 + R3 3~4 + R4 2~3 + R5 3 + R6 2)

---

## 5. Rust 특화 설계 지침

**메모리와 성능**
- CFA는 `u16`(픽셀당 2바이트)이라 100MP도 약 200MB입니다. RGB f32(픽셀당 12바이트) 전체 복사본을 만들지 않고, 검출은 하프사이즈 단일 채널, 복원은 ROI 단위로만 f32를 씁니다.
- 큰 배열은 메모리맵(`memmap2`)과 타일 단위 `rayon` 병렬로 처리하고, 스크래치 버퍼는 풀로 재사용합니다.
- SIMD는 먼저 정확성을 확보한 뒤 `multiversion` 또는 `std::simd`로 병목만 최적화합니다.

**안정성**
- 릴리스 프로파일에서도 `panic = "unwind"`를 유지합니다(rawler panic을 `catch_unwind`로 잡기 위해). `panic = "abort"`는 쓰지 않습니다.
- 디코딩은 가능하면 별도 작업자 프로세스에서 실행해, 손상 파일이 앱 전체를 죽이지 못하게 합니다.
- `cargo-fuzz`로 디코딩 어댑터와 XMP/EXIF 파서를 퍼징합니다.
- `sc-*` 크레이트는 `#![forbid(unsafe_code)]`를 기본으로 하고, 성능상 필요한 `sc-imgproc` 일부만 예외로 하여 사유를 문서화합니다.

**결정성**
- grain 합성은 고정 시드의 PRNG를 써서 같은 입력에서 같은 출력이 나오게 합니다. 이후 골든 테스트가 가능합니다.

**오류 처리**
- 라이브러리 크레이트는 `thiserror`, 앱 경계에서만 `anyhow`를 씁니다. 사용자에게 보이는 오류는 한국어 메시지와 원인 코드를 분리합니다.

**도구**
- `rust-toolchain.toml`로 1.89 이상 고정, `clippy -D warnings`, `rustfmt`, `cargo-nextest`, `criterion` 벤치, `proptest`(좌표 변환과 IFD 배치), `cargo-deny`.
- CI는 Windows/macOS/Linux 매트릭스로 돌립니다. Windows 한글 경로 테스트를 반드시 포함합니다.

### 크레이트 후보 (착수 시 유지보수 상태와 버전을 확인할 것)

| 용도 | 후보 | 메모 |
|---|---|---|
| RAW 디코딩, DNG 쓰기 | `rawler` | 1.1절 참조. 버전 고정(0.8.0), 필요하면 포크 |
| LibRaw 폴백 | `rsraw` | 선택 feature |
| 배열·병렬 | `ndarray`(선택), `rayon`, `memmap2` | |
| 리사이즈 | `fast_image_resize` | 면적 평균 |
| 선형대수 | `nalgebra` 또는 직접 3×3 | |
| TIFF 읽기·쓰기 | `tiff` | 렌더 TIFF용. DNG는 rawler writer |
| EXIF | 읽기 `kamadak-exif`, 쓰기 `little_exif` 등 | 후보 비교 필요 |
| XMP | `quick-xml` | 사이드카 직접 생성 |
| ICC | `lcms2`(C 의존) 또는 순수 Rust 대안 | 배포 단순성 비교 |
| 서버(이행용) | `axum`, `tokio`, `tower-http` | R5에서 제거 가능 |
| 앱 | `tauri` 2 | |
| CLI·로그 | `clap`, `tracing` | |
| 직렬화 | `serde`, `serde_json` | 기존 `/api` JSON 계약 유지 |
| 테스트 | `proptest`, `criterion`, `insta` | |

---

## 6. 합격 기준

기존 문서 2장의 기준(원본 보존, 호환성, 메타데이터, 비파괴, 카메라 범위, 검출 품질, 안정성)을 그대로 따르고, Rust 전환으로 아래를 추가합니다.

| 항목 | 기준 |
|---|---|
| 성능 | 기준 PC(8코어, 32GB)에서 45MP 불러오기+검출 5초 이하(Python 목표 10초의 절반), 스팟 1개 증분 복원 200ms 이하 |
| 메모리 | 100MP 최대 2GB 이하 |
| 배포 | 설치 파일 100MB 이하, 콜드 스타트 2초 이하, 런타임 설치 단계 없음 |
| 동치성 | R2 종료 시 합성 벤치마크에서 Python 오라클 대비 검출 일치율 95% 이상, 복원 영역 PSNR 오차 0.5dB 이내 |
| 견고성 | 손상 파일 코퍼스에서 앱 크래시 0건(오류 메시지로 처리) |

---

## 7. 위험과 대응

| 위험 | 영향 | 대응 |
|---|---|---|
| **rawler 단일 메인테이너, 불안정 API** | 버전 올릴 때 깨지거나 개발 중단 | 버전 고정, `sc-decode` 어댑터 뒤로 격리, LibRaw 폴백 feature, 필요 시 포크 유지 |
| **수정한 픽셀을 DNG로 쓰는 API가 없거나 불완전** | 이 계획의 핵심 이점(CFA DNG)이 사라짐 | **R0에서 먼저 검증.** no-go 시 `sc-dng` 직접 구현 또는 XMP 사이드카 우선 출시 |
| **LGPL-2.1과 AGPL-3.0 결합** | 배포 방식·소스 공개 의무에 영향 | R0에서 법적 검토. 프로젝트 라이선스 재검토 가능성 포함 |
| 손상 파일 panic | 앱 중단 | `catch_unwind`, 작업자 프로세스 분리, 퍼징 |
| **Telea 직접 구현 품질** | 복원 결과가 OpenCV와 달라짐 | 오라클 비교, 품질 지표 기준. 필요 시 PatchMatch로 대체 |
| 포팅 중 알고리즘 회귀 | 검출 품질 저하 | 동치 포팅 후 개선, 합성 벤치마크 CI |
| 이중 구현 기간의 유지 비용 | 일정 지연 | Python은 버그 수정만, 신규 기능은 Rust에만 |
| 큰 이미지의 WebView IPC 비용 | 화면 지연 | 커스텀 프로토콜 타일, JSON 직렬화 금지 |
| 1인 개발의 Rust 학습·생산성 | 일정 초과 | R0, R1을 작게 쪼개고 R2 이후 성능 이점은 일정이 안정된 뒤에 최적화 |
| 일부 RAW 형식·최신 카메라 지연 | 지원 범위 | 지원표를 코퍼스 결과로 공개, 미지원은 명시적 오류(미리보기로 속이지 않기) |

---

## 8. 현재 저장소의 처리

| 대상 | 처리 |
|---|---|
| `python/raw_pipeline.py`, `python/tests` | **오라클로 유지**. R4 종료 시 `legacy/`로 이동 후 제거. 합성 이미지 생성기와 테스트 시나리오는 Rust 테스트로 이식 |
| `server.ts`(Express) | R1에서 axum 서버로 대체. 소유권·TTL·형식 검증 로직은 이식(R5의 Tauri 전환 후에는 단일 사용자라 소유권 불필요) |
| `src/`(React) | 유지. R1에서는 변경 없음, R5에서 엔진 호출부만 교체 |
| `src/engine/exportPolicy.ts`와 `decodeKind` 개념 | 유지하고 Rust 쪽 메타데이터 계약으로 이식 |
| `src/engine/dustAlgorithms.ts`, `tiffRawDecoder.ts`, `binaryExporters.ts`, `workers/` | R5에서 제거. 단 `binaryExporters.test.ts`의 IFD 겹침 검증기는 Rust 속성 테스트로 이식 |
| `scripts/setup-python.mjs`, `python/constraints.txt` | R4까지 유지, 이후 제거 |
| Phase 0 산출물(문구 정정, 브랜딩, CI 골격, README) | 유지하고 Rust 빌드 단계로 확장 |

---

## 9. 바로 착수할 일 (첫 1~2주 = R0)

1. `spikes/rawler-dng/` 별도 Cargo 프로젝트를 만들고 1.3절 항목을 순서대로 검증합니다. 가장 먼저 **"수정한 RawImage → CFA DNG"** 입니다.
2. 사용할 실제 RAW 샘플을 모읍니다. 가지고 계신 카메라의 파일 몇 장(RW2, DNG 등)을 알려 주시면 코퍼스에 넣겠습니다. 가능하면 먼지가 보이는 하늘 사진이 좋습니다.
3. 라이선스 검토 요청(LGPL-2.1과 AGPL-3.0)을 시작합니다.
4. R0 결과로 go/no-go를 판단하고, 이 문서의 R1~R3 일정을 확정합니다.
