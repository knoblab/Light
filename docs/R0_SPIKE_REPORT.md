# R0 Spike Report — SensorClean Pure-Rust RAW & DNG Engine Verification

> **작성일**: 2026-11-07
> **상태**: **GO (전 항목 통과)** — Option A (`lightcraft-raw` + `lightcraft-tiff` 순수 Rust 백엔드) 채택 확정

---

## 1. 스파이크 목표 및 배경

[`RAW_PRODUCTION_PLAN_RUST.md`](file:///C:/Users/erida/OneDrive/Documents/repo/Sc/SensorClean/docs/RAW_PRODUCTION_PLAN_RUST.md) §2(R0)에서 정의한 5대 사전 기술 검증 항목을 실제 카메라 RAW 샘플(`src/RAW Sample/_1180814.RW2`)과 합성 CFA DNG, 손상 바이트 코퍼스 20종을 대상으로 실측 검증하였다.

### 백엔드 아키텍처 결정 (`lightcraft-raw` vs `rawler`)
- 원안의 `rawler 0.8.0`은 **LGPL-2.1 라이선스**, **CFA DNG 라이터 미성숙**, **일부 압축 CR3 미지원** 리스크가 존재했다.
- 이에 따라 R0에서 클린룸 순수 Rust 엔진(`lightcraft-raw`, `lightcraft-tiff`, `lightcraft-meta`, `lightcraft-color`, `lightcraft-raster`, `lightcraft-geom`, `MIT OR Apache-2.0`, `#![forbid(unsafe_code)]`)을 [`sc-decode`](file:///C:/Users/erida/OneDrive/Documents/repo/Sc/SensorClean/crates/sc-decode/src/lib.rs)의 기본 백엔드로 채택하여 검증했다.

---

## 2. R0.1 ~ R0.4 실측 결과 요약

| 검증 항목 | 기준 (Go Gate) | 실측 결과 | 판정 |
|---|---|---|---|
| **R0.1 포맷 디코딩 & 지오메트리** | 실제 RW2 및 합성 CFA DNG의 `cfa`, `black_level`, `white_level`, `active_area`, `crop_area`, `orientation` 추출 | `_1180814.RW2`: `4816×3464`, `cpp=1`, `CFA="BGGR"`, `12-bit`, `black_mean=143`, `white=4095`, `active=(8, 8, 4592×3448)`, `crop=(0, 0, 4592×3448)` 정확 추출 | **PASS** |
| **R0.2 CFA DNG 비트 단위 무손실 왕복** | 중심 16×16 ROI만 수정 후 Lossless JPEG(LJ92 256×256 타일) CFA DNG로 저장 → 재디코딩 시 비수정 영역 픽셀 차이 `0` | 합성 CFA DNG(`256×192`) 및 실제 `_1180814.RW2`(`4816×3464`, 총 `16,682,624` 샘플) 모두 **`outside_roi_bit_diff = 0` (100% 비트 일치)** | **PASS** |
| **R0.3 손상/절단 입력 패닉 격리** | 0바이트, 랜덤 가비지, 잘린 TIFF/DNG 헤더, 무한 루프 IFD 오프셋 등 20종 이상 입력에서 패닉 0건 | 20종 악성·손상 페이로드 전수 테스트 시 패닉 0건 (`Result::Err(ScError::CorruptInput)` 반환) | **PASS** |
| **R0.4 Phase 0 안전성 회귀 불변조건** | ① 1채널 Bayer 모자이크 TIFF 거부<br>② 8-bit 폴백 TIFF의 `EmbeddedPreview` 분류 및 가짜 DNG 내보내기 차단 | `phase0_single_channel_mosaic_is_rejected_and_8bit_tiff_is_embedded_preview` 통과 | **PASS** |

---

## 3. 실측 로그 (`cargo test -p sc-decode --test r0_spike -- --nocapture`)

```text
running 4 tests
test phase0_single_channel_mosaic_is_rejected_and_8bit_tiff_is_embedded_preview ... ok
test r0_corrupt_and_truncated_files_never_panic ... ok
test r0_cfa_dng_roundtrip_bit_exact_outside_modified_roi ... ok
[R0 Real RW2] 4816x3464, cpp=1, cfa=Some("BGGR"), bits=12, black_mean=143, white=4095, active=Rect { x: 8, y: 8, width: 4592, height: 3448 }, crop=Rect { x: 0, y: 0, width: 4592, height: 3448 }, decode_ms=769.0ms
[R0 Real RW2 -> CFA DNG] dng_size=13758588 bytes, write_ms=2837.5ms, outside_roi_bit_diff=0
test r0_real_rw2_sample_decode_and_cfa_dng_roundtrip ... ok
```

- 원본 `_1180814.RW2` 크기: `19,626,496` bytes (19.6 MB)
- LJ92 무손실 압축 CFA DNG 출력 크기: `13,758,588` bytes (13.8 MB, 원본 대비 **29.9% 용량 절감** 및 100% 무손실)
- 비수정 영역 비트 오차: **`0` / `16,682,368` pixels**

---

## 4. R0.5 최종 Go / No-Go 판정

- **판정**: **GO (Option A 확정)**
- C++ 사이드카(`LibRaw` / `dng_sdk`) 없이 **100% 순수 Rust 단일 워크스페이스**만으로 R1(`sc-core`, `sc-session`, `sc-server`, `sc-cli`) 및 R2(`sc-imgproc`, `sc-color`, `sc-detect`) 본 구현으로 즉시 진입함을 승인한다.
