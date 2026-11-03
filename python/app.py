"""
SensorClean Pro — Standalone Streamlit + OpenCV + rawpy 16-bit RW2 Sensor Dust Remover
Dual-Branch Architecture:
  - Branch A (Sharp / Focused Micro-Dust): High-resolution local DoG/Black-Hat without gradient suppression
  - Branch B (Defocused / Bokeh Dust): 8-Scale Center-Surround DoG Pyramid
  - Plane-Detrended Outer Annulus SNR & Cloud/Scene False-Positive Gatekeeper
실행 방법:
  pip install -r requirements.txt
  streamlit run app.py
"""

import io
import math
import tempfile
from pathlib import Path
from typing import Tuple, List, Dict, Any

import streamlit as st
import numpy as np
import cv2
import rawpy
import tifffile
import piexif
from PIL import Image

st.set_page_config(
    page_title="SensorClean Pro — 16-bit RW2 듀얼 센서 먼지 자동 제거기",
    layout="wide",
    initial_sidebar_state="expanded"
)

RAW_EXTENSIONS = {'.rw2', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.pef', '.raf'}


def linear_16bit_to_srgb_8bit(linear_rgb_16: np.ndarray, exposure_scale: float = None) -> Tuple[np.ndarray, float]:
    """16-bit 선형 RGB 배열을 화면 표시용 8-bit sRGB 이미지로 톤매핑합니다."""
    norm = linear_rgb_16.astype(np.float32) / 65535.0
    if exposure_scale is None:
        p995 = float(np.percentile(norm, 99.6))
        exposure_scale = float(np.clip((0.94 / p995) if p995 > 1e-4 else 1.0, 0.5, 16.0))
    exposed = np.clip(norm * exposure_scale, 0.0, 1.0)
    srgb = np.where(
        exposed <= 0.0031308,
        exposed * 12.92,
        1.055 * np.power(np.maximum(exposed, 1e-8), 1.0 / 2.4) - 0.055
    )
    return np.clip(np.round(srgb * 255.0), 0, 255).astype(np.uint8), exposure_scale


@st.cache_data(show_spinner="rawpy 16-bit 선형(Linear Gamma 1.0) 디모자이킹 처리 중...")
def load_16bit_linear_image(file_bytes: bytes, file_name: str) -> Tuple[np.ndarray, Dict[str, Any]]:
    ext = Path(file_name).suffix.lower()
    meta: Dict[str, Any] = {
        "file_name": file_name,
        "ext": ext,
        "make": "Panasonic" if ext == ".rw2" else "Camera",
        "model": "Lumix Sensor" if ext == ".rw2" else "RAW Sensor",
        "is_raw": ext in RAW_EXTENSIONS,
        "exposure_scale": None
    }

    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = tmp.name

    if ext in RAW_EXTENSIONS:
        with rawpy.imread(tmp_path) as raw:
            linear_rgb_16 = raw.postprocess(
                gamma=(1, 1),
                no_auto_bright=True,
                output_bps=16,
                use_camera_wb=True,
                half_size=False,
                demosaic_algorithm=rawpy.DemosaicAlgorithm.AHD
            )
            meta["white_level"] = int(raw.white_level)
            meta["camera_wb"] = [float(x) for x in raw.camera_whitebalance]
    else:
        file_arr = np.frombuffer(file_bytes, dtype=np.uint8)
        bgr = cv2.imdecode(file_arr, cv2.IMREAD_UNCHANGED)
        if bgr.ndim == 2:
            rgb = cv2.cvtColor(bgr, cv2.COLOR_GRAY2RGB)
        elif bgr.shape[2] == 4:
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGRA2RGB)
        else:
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

        if rgb.dtype == np.uint16:
            linear_rgb_16 = rgb
        else:
            norm_srgb = rgb.astype(np.float32) / 255.0
            linear_f = np.where(
                norm_srgb <= 0.04045,
                norm_srgb / 12.92,
                np.power((norm_srgb + 0.055) / 1.055, 2.4)
            )
            linear_rgb_16 = np.clip(np.round(linear_f * 65535.0), 0, 65535).astype(np.uint16)
            meta["exposure_scale"] = 1.0

    return linear_rgb_16, meta


def verify_annulus_plane_snr(
    img_gray: np.ndarray,
    grad_map: np.ndarray,
    bg_std_map: np.ndarray,
    hf_tex_map: np.ndarray,
    cx: float,
    cy: float,
    r: float,
    is_sharp_branch: bool,
    cloud_protection: float,
    sensitivity: float = 68.0
) -> Tuple[bool, float, float, float, float]:
    """
    1. 외곽 도넛 링(1.30r ~ 2.25r) 전체 픽셀에 1차 평면을 먼저 피팅해 트리밍 전 배경 분산(ann_all_std)과
       스팬(p95 - p05)을 검사하여 구름 골짜기(#35..#55) 및 나뭇가지 경계를 즉시 차단합니다.
    2. 구름/나무가 아님이 확인된 영역에서는 외곽 링 하위 32% 어두운 픽셀(인접한 다른 먼지 간섭)을 제외한
       상위 깨끗한 배경 픽셀로 평면을 재피팅하여 초저대비(0.15~0.5%) 보케 먼지도 정밀 검출합니다.
    """
    h, w = img_gray.shape[:2]
    ix, iy = int(round(cx)), int(round(cy))
    prot = 0.55 + (cloud_protection / 100.0) * 0.60

    if iy < 0 or iy >= h or ix < 0 or ix >= w:
        return False, r, 0.0, 0.0, 0.0
    if float(bg_std_map[iy, ix]) > (3.40 if is_sharp_branch else 2.65) / prot:
        return False, r, 0.0, 0.0, 0.0
    if float(hf_tex_map[iy, ix]) > 1.55 / prot:
        return False, r, 0.0, 0.0, 0.0

    scale_mults = [1.0] if is_sharp_branch else [0.88, 1.0, 1.15]
    best_res = (False, r, 0.0, 0.0, 0.0)
    best_score = -1.0

    for mult in scale_mults:
        cand_r = max(1.4, r * mult)
        r_out = int(round(max(cand_r * 2.25, cand_r + 5.0)))
        if ix < r_out or ix >= w - r_out or iy < r_out or iy >= h - r_out:
            continue

        patch = img_gray[iy - r_out:iy + r_out + 1, ix - r_out:ix + r_out + 1]
        grad_patch = grad_map[iy - r_out:iy + r_out + 1, ix - r_out:ix + r_out + 1]
        yy, xx = np.mgrid[-r_out:r_out + 1, -r_out:r_out + 1]
        dist = np.sqrt((xx.astype(np.float32)) ** 2 + (yy.astype(np.float32)) ** 2)

        if not is_sharp_branch and float(np.percentile(grad_patch[dist <= cand_r * 1.35], 90)) > 3.5:
            continue

        core_mask = dist <= max(1.2, cand_r * (0.52 if is_sharp_branch else 0.48))
        ann_mask = (dist >= max(cand_r * 1.30, cand_r + 1.8)) & (dist <= r_out)
        if int(np.sum(ann_mask)) < 16 or int(np.sum(core_mask)) < 1:
            continue

        ax, ay, av = xx[ann_mask].astype(np.float32), yy[ann_mask].astype(np.float32), patch[ann_mask].astype(np.float32)
        X = np.column_stack([ax, ay, np.ones_like(ax)])
        coeffs1, _, _, _ = np.linalg.lstsq(X, av, rcond=None)
        res1 = av - (X @ coeffs1)
        ann_all_std = float(np.std(res1))
        p05_r, p95_r = np.percentile(res1, [5, 95])

        if ann_all_std > (1.85 if is_sharp_branch else 1.45) / prot or (p95_r - p05_r) > (5.2 if is_sharp_branch else 4.2) / prot:
            continue

        lo_p, hi_p = np.percentile(res1, [32, 95])
        clean_idx = (res1 >= lo_p) & (res1 <= hi_p)
        if int(np.sum(clean_idx)) >= 10:
            coeffs, _, _, _ = np.linalg.lstsq(X[clean_idx], av[clean_idx], rcond=None)
            res_clean = av[clean_idx] - (X[clean_idx] @ coeffs)
        else:
            coeffs, res_clean = coeffs1, res1

        plane_center = float(coeffs[2])
        if plane_center < 88.0:
            continue

        ann_clean_std = float(np.std(res_clean))
        core_pixels = patch[core_mask].astype(np.float32)
        core_val = float(np.percentile(core_pixels, 25)) if is_sharp_branch else float(np.mean(core_pixels))
        depth = plane_center - core_val

        sens_factor = 1.32 - (sensitivity / 100.0) * 0.52
        if depth < (2.15 if is_sharp_branch else 0.62) * sens_factor:
            continue

        eff_noise = max(ann_clean_std, ann_all_std * 0.62, 0.22)
        snr = depth / eff_noise
        if snr < (3.20 if is_sharp_branch else 1.88) * sens_factor * (0.82 + 0.18 * prot):
            continue

        contrast_pct = (depth / max(plane_center, 20.0)) * 100.0
        isotropy = float(np.clip(1.0 - (eff_noise / (depth * 1.5 + 0.35)), 0.62, 0.98))
        score = depth * (snr ** 0.5)
        if score > best_score:
            best_score = score
            best_res = (True, cand_r, contrast_pct, isotropy, snr)

    return best_res


def detect_dust_spots(
    linear_rgb_16: np.ndarray,
    exposure_scale: float,
    method: str,
    sensitivity: int,
    cloud_protection: int,
    min_radius: int,
    max_radius: int,
    min_circularity: float
) -> Tuple[np.ndarray, np.ndarray, List[Dict[str, Any]]]:
    """
    [Step 2] 듀얼 브랜치 검출기:
      - Branch A: 초점 맞은 미세/선명 먼지 검출
      - Branch B: 흐릿한 보케 원형 먼지 검출 (실제 대비 기반 반경 매칭 + 인접 먼지 간섭 제거)
    """
    full_h, full_w = linear_rgb_16.shape[:2]
    det_scale = min(1.0, 2304.0 / float(max(full_h, full_w)))
    det_w, det_h = max(1, int(round(full_w * det_scale))), max(1, int(round(full_h * det_scale)))
    det_16 = cv2.resize(linear_rgb_16, (det_w, det_h), interpolation=cv2.INTER_AREA) if det_scale < 1.0 else linear_rgb_16

    lum = (
        0.2126 * det_16[:, :, 0].astype(np.float32) +
        0.7152 * det_16[:, :, 1].astype(np.float32) +
        0.0722 * det_16[:, :, 2].astype(np.float32)
    ) / 65535.0
    gray_det = np.power(np.clip(lum * exposure_scale, 1e-6, 1.0), 1.0 / 2.2) * 255.0

    s1 = cv2.GaussianBlur(gray_det, (0, 0), 0.9)
    g8 = cv2.GaussianBlur(s1, (0, 0), 8.5)
    denoise_det = cv2.GaussianBlur(gray_det, (0, 0), 1.8)
    bg_mean_22 = cv2.GaussianBlur(denoise_det, (0, 0), 22.0)
    bg_sq_22 = cv2.GaussianBlur((denoise_det - bg_mean_22) ** 2, (0, 0), 22.0)
    bg_std_map = np.sqrt(np.maximum(bg_sq_22, 0.0))
    hf_texture = cv2.GaussianBlur(np.abs(s1 - g8), (0, 0), 18.0)

    sobel_x = cv2.Sobel(denoise_det, cv2.CV_32F, 1, 0, ksize=3)
    sobel_y = cv2.Sobel(denoise_det, cv2.CV_32F, 0, 1, ksize=3)
    grad_mag = cv2.GaussianBlur(np.sqrt(sobel_x ** 2 + sobel_y ** 2), (0, 0), 1.5)

    prot = 0.55 + (cloud_protection / 100.0) * 0.60
    candidates = []
    combined_vis = np.zeros((det_h, det_w), dtype=np.float32)

    run_sharp = "초점" in method or "Dual" in method
    run_bokeh = "보케" in method or "Dual" in method

    if run_sharp:
        sharp_diff = np.maximum(g8 - s1, 0.0)
        valid_bg = (g8 >= 88.0) & (bg_std_map <= (3.2 / prot)) & (hf_texture <= (1.45 / prot))
        sharp_gated = np.where(valid_bg, sharp_diff, 0.0)
        combined_vis = np.maximum(combined_vis, sharp_gated * 1.4)

        diff_thresh = max(1.75, 4.10 - (sensitivity / 100.0) * 2.55)
        bm_sharp = (sharp_gated >= diff_thresh).astype(np.uint8) * 255
        cnts, _ = cv2.findContours(bm_sharp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in cnts:
            area_d = float(cv2.contourArea(c))
            if area_d < 2.2 or area_d > 500.0:
                continue
            (cx_d, cy_d), enc_r_d = cv2.minEnclosingCircle(c)
            r_d = max(1.6, 0.55 * enc_r_d + 0.45 * math.sqrt(area_d / math.pi))
            r_full = r_d / det_scale
            if r_full < min_radius or r_full > max_radius:
                continue
            passed, opt_r_d, contrast_pct, isotropy, snr = verify_annulus_plane_snr(
                s1, grad_mag, bg_std_map, hf_texture,
                float(cx_d), float(cy_d), r_d, True, float(cloud_protection), float(sensitivity)
            )
            if not passed or isotropy < min_circularity:
                continue
            candidates.append({
                "cx": int(round(cx_d / det_scale)),
                "cy": int(round(cy_d / det_scale)),
                "radius": round(opt_r_d / det_scale, 1),
                "circularity": round(isotropy, 3),
                "contrast_pct": round(contrast_pct, 2),
                "score": snr * 1.25,
                "spot_type": "sharp"
            })

    if run_bokeh:
        quiet_sky = (bg_mean_22 >= 88.0) & (bg_std_map <= 1.6) & (hf_texture <= 1.1)
        min_r_d = max(7.2, min_radius * det_scale)
        max_r_d = max(min_r_d + 5.0, max_radius * det_scale * 0.90)
        bokeh_radii = np.geomspace(min_r_d, max_r_d, num=8)

        b_stack = []
        c_stack = []
        for r_b in bokeh_radii:
            g_in = cv2.GaussianBlur(denoise_det, (0, 0), r_b * 0.46)
            g_out = cv2.GaussianBlur(denoise_det, (0, 0), r_b * 1.16)
            raw_band = ((g_out - g_in) / np.maximum(g_out, 25.0)) * 255.0
            if int(np.sum(quiet_sky)) > 200:
                sky_vals = raw_band[quiet_sky]
                med = float(np.median(sky_vals))
                mad_sky = float(np.median(np.abs(sky_vals - med))) * 1.4826
            else:
                med = float(np.median(raw_band))
                mad_sky = float(np.median(np.abs(raw_band - med))) * 1.4826
            eff_mad = max(mad_sky, 0.16)
            b_stack.append(np.maximum((raw_band - med) / eff_mad, 0.0))
            c_stack.append(np.maximum(raw_band - med, 0.0) * ((r_b / min_r_d) ** (-0.08)))

        b_arr = np.stack(b_stack, axis=0)
        c_arr = np.stack(c_stack, axis=0)
        b_max = cv2.GaussianBlur(np.max(b_arr, axis=0), (0, 0), 1.6)
        b_idx = np.argmax(c_arr, axis=0)
        combined_vis = np.maximum(combined_vis, np.where((bg_mean_22 >= 88.0) & (bg_std_map <= 3.0 / prot), b_max, 0.0))

        z_thresh = max(1.15, 4.35 - (sensitivity / 100.0) * 3.10)
        nms_k = max(15, int(round(min_r_d * 1.85)) | 1)
        loc_max = cv2.dilate(b_max, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (nms_k, nms_k)))
        b_ys, b_xs = np.where((b_max >= z_thresh) & (b_max >= loc_max - 1e-4))
        for py, px in zip(b_ys, b_xs):
            r_d = float(bokeh_radii[int(b_idx[py, px])])
            passed, opt_r_d, contrast_pct, isotropy, snr = verify_annulus_plane_snr(
                denoise_det, grad_mag, bg_std_map, hf_texture,
                float(px), float(py), r_d, False, float(cloud_protection), float(sensitivity)
            )
            if not passed or isotropy < min_circularity:
                continue
            r_full = opt_r_d / det_scale
            if r_full < min_radius or r_full > max_radius:
                continue
            candidates.append({
                "cx": int(round(px / det_scale)),
                "cy": int(round(py / det_scale)),
                "radius": round(r_full, 1),
                "circularity": round(isotropy, 3),
                "contrast_pct": round(contrast_pct, 2),
                "score": snr,
                "spot_type": "bokeh"
            })

    candidates.sort(key=lambda c: c["score"], reverse=True)
    spots = []
    dust_mask = np.zeros((full_h, full_w), dtype=np.uint8)
    for cand in candidates:
        if any(math.hypot(cand["cx"] - k["cx"], cand["cy"] - k["cy"]) < max(cand["radius"], k["radius"]) * 0.92 for k in spots):
            continue
        spots.append(cand)
        cv2.circle(dust_mask, (cand["cx"], cand["cy"]), int(round(cand["radius"] * 1.32 + 2)), 255, -1)

    vis_full = cv2.resize(combined_vis, (full_w, full_h), interpolation=cv2.INTER_LINEAR) if det_scale < 1.0 else combined_vis
    z_vis = np.clip((vis_full / max(float(np.percentile(vis_full, 99.3)), 2.5)) * 215.0, 0, 255).astype(np.uint8)
    bw_edge_viz = cv2.cvtColor(z_vis, cv2.COLOR_GRAY2RGB)
    for sp in spots:
        cv2.circle(bw_edge_viz, (sp["cx"], sp["cy"]), int(round(sp["radius"])), (255, 255, 255), 1, lineType=cv2.LINE_AA)

    return dust_mask, bw_edge_viz, spots


def inpaint_16bit_telea(
    linear_rgb_16: np.ndarray,
    dust_mask: np.ndarray,
    inpaint_radius: int = 6,
    preserve_grain: bool = True
) -> np.ndarray:
    dilated_mask = cv2.dilate(dust_mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)), iterations=1)
    alpha_f32 = np.clip(cv2.GaussianBlur(dilated_mask.astype(np.float32) / 255.0, (0, 0), max(2.0, inpaint_radius * 0.45)) * 1.15, 0.0, 1.0)
    clean_bg = (dilated_mask == 0)
    rng = np.random.default_rng(42)

    inpainted_16 = np.empty_like(linear_rgb_16, dtype=np.uint16)
    for ch in range(3):
        orig_f32 = linear_rgb_16[:, :, ch].astype(np.float32)
        telea_f32 = cv2.inpaint(orig_f32, dilated_mask, float(inpaint_radius), cv2.INPAINT_TELEA)
        healed_f32 = 0.65 * telea_f32 + 0.35 * cv2.GaussianBlur(telea_f32, (0, 0), 1.6)
        if preserve_grain and np.any(clean_bg):
            hf = orig_f32 - cv2.GaussianBlur(orig_f32, (0, 0), 1.2)
            grain_std = min(float(np.median(np.abs(hf[clean_bg]))) * 1.4826, 450.0)
            if grain_std > 1.0:
                healed_f32 += rng.normal(0.0, grain_std * 0.85, size=orig_f32.shape).astype(np.float32)
        blended = orig_f32 * (1.0 - alpha_f32) + healed_f32 * alpha_f32
        inpainted_16[:, :, ch] = np.clip(np.round(blended), 0, 65535).astype(np.uint16)
    return inpainted_16


def encode_linear_dng_bytes(rgb_16bit: np.ndarray, meta: Dict[str, Any]) -> bytes:
    buf = io.BytesIO()
    extra_tags = [
        (271, 's', 0, str(meta.get("make", "Panasonic")), True),
        (272, 's', 0, str(meta.get("model", "Lumix Sensor")), True),
        (50706, 'B', 4, b'\x01\x04\x00\x00', True),
        (50707, 'B', 4, b'\x01\x01\x00\x00', True),
        (50708, 's', 0, f"{meta.get('make', 'Panasonic')} {meta.get('model', 'Lumix')}", True),
        (50714, 'I', 3, (0, 0, 0), True),
        (50717, 'I', 3, (65535, 65535, 65535), True),
    ]
    tifffile.imwrite(
        buf,
        rgb_16bit,
        photometric='rgb',
        planarconfig='contig',
        compression=None,
        software="SensorClean Pro 16-bit Linear DNG Pipeline",
        extratags=extra_tags
    )
    return buf.getvalue()


st.title("SensorClean Pro — 16-bit RW2 듀얼(초점+보케) 센서 먼지 자동 제거기")
st.caption("Dual-Branch (초점 미세 먼지 + 멀티스케일 보케 먼지) · 외곽 도넛 링 평면 보정 SNR 구름/피사체 오탐지 차단 · 16-bit Telea + 입자감 복원")

with st.sidebar:
    st.header("1. 듀얼 센서 먼지 탐지 설정")
    method = st.selectbox(
        "탐지 모드",
        [
            "Dual (초점 맞은 미세 먼지 + 흐릿한 보케 먼지 통합)",
            "초점 맞은 선명/미세 먼지 집중",
            "흐릿한 보케 원형 먼지 집중"
        ],
        index=0
    )
    sensitivity = st.slider("감지 민감도 (Sensitivity)", min_value=1, max_value=100, value=68)
    cloud_protection = st.slider("구름·피사체 오탐지 차단 강도", min_value=10, max_value=100, value=75)
    min_radius, max_radius = st.slider("먼지 최소 / 최대 반경 (px)", min_value=2, max_value=60, value=(2, 40))
    min_circularity = st.slider("최소 원형도 & 대칭성", min_value=0.30, max_value=0.95, value=0.60, step=0.05)
    inpaint_radius = st.slider("Telea 인페인팅 반경 (px)", min_value=2, max_value=15, value=6)
    preserve_grain = st.checkbox("외곽 소프트 페더링 & 센서 입자감(Grain) 복원", value=True)

    st.divider()
    st.header("2. 시각화 옵션")
    show_overlay = st.toggle("먼지 시각화 보기", value=True)
    overlay_mode = st.radio("오버레이 표시 방식", ["빨간색 원 오버레이", "흑백 엣지 마스크 (대비 증폭)"], index=0)

uploaded_file = st.file_uploader(
    "카메라 RAW (RW2, DNG, CR2, NEF, ARW) 또는 JPG, PNG 파일을 업로드하세요",
    type=["rw2", "dng", "cr2", "nef", "arw", "jpg", "jpeg", "png", "tif", "tiff"]
)

if uploaded_file is not None:
    linear_16bit, meta = load_16bit_linear_image(uploaded_file.getvalue(), uploaded_file.name)
    srgb_preview, exp_scale = linear_16bit_to_srgb_8bit(linear_16bit, exposure_scale=meta.get("exposure_scale"))

    dust_mask, bw_edge_viz, spots = detect_dust_spots(
        linear_16bit, exp_scale, method, sensitivity, cloud_protection, min_radius, max_radius, min_circularity
    )

    st.markdown(
        f"**해상도:** `{linear_16bit.shape[1]} × {linear_16bit.shape[0]} px` · "
        f"**비트 심도:** `16-bit Linear RGB (uint16)` · "
        f"**검출된 센서 먼지:** `{len(spots)}개`"
    )

    col_left, col_right = st.columns(2)
    with col_left:
        st.subheader("검출 결과 및 먼지 시각화")
        if show_overlay:
            if overlay_mode == "빨간색 원 오버레이":
                vis_img = srgb_preview.copy()
                for sp in spots:
                    cv2.circle(vis_img, (sp["cx"], sp["cy"]), int(round(sp["radius"] + 2)), (239, 68, 68), 2, lineType=cv2.LINE_AA)
                st.image(vis_img, use_container_width=True)
            else:
                st.image(bw_edge_viz, use_container_width=True)
        else:
            st.image(srgb_preview, use_container_width=True)

    with col_right:
        st.subheader("16-bit Telea 인페인팅 복원 결과")
        if st.button("제거 적용 (16-bit cv2.inpaint Telea 실행)", type="primary", use_container_width=True):
            with st.spinner("16-bit 선형 RGB 채널별 Telea 인페인팅 및 센서 입자감 복원 중..."):
                healed_16bit = inpaint_16bit_telea(linear_rgb_16=linear_16bit, dust_mask=dust_mask, inpaint_radius=inpaint_radius, preserve_grain=preserve_grain)
                healed_srgb, _ = linear_16bit_to_srgb_8bit(healed_16bit, exposure_scale=exp_scale)
                st.session_state["healed_16bit"] = healed_16bit
                st.session_state["healed_srgb"] = healed_srgb

        if "healed_srgb" in st.session_state:
            st.image(st.session_state["healed_srgb"], use_container_width=True)
            dng_bytes = encode_linear_dng_bytes(st.session_state["healed_16bit"], meta)
            stem = Path(uploaded_file.name).stem

            dl_col1, dl_col2 = st.columns(2)
            with dl_col1:
                st.download_button(
                    label="선형 DNG 다운로드 (16-bit RAW)",
                    data=dng_bytes,
                    file_name=f"{stem}_cleaned_linear16.dng",
                    mime="image/x-adobe-dng",
                    use_container_width=True
                )
            with dl_col2:
                pil_png = Image.fromarray(st.session_state["healed_srgb"])
                png_buf = io.BytesIO()
                pil_png.save(png_buf, format="PNG")
                st.download_button(
                    label="고화질 PNG 다운로드",
                    data=png_buf.getvalue(),
                    file_name=f"{stem}_cleaned.png",
                    mime="image/png",
                    use_container_width=True
                )
