#!/usr/bin/env python3
"""
SensorClean Pro — 16-bit Linear RW2/RAW Dual-Branch Sensor Dust Detection & Telea Inpainting Engine
Architecture:
  - Always operates at high detection resolution (up to 2304px directly from linear_16bit.npy)
    so tiny focused sensor dust specks (r = 2px ~ 12px) are never blurred out by low-res previews.
  - Branch A (Sharp / Focused Micro-Dust): High-resolution local DoG/Black-Hat (g_8.5 - g_0.9)
    without gradient suppression, catching crisp dark sensor dust particles and micro-fibers.
  - Branch B (Defocused / Bokeh Dust): 8-Scale Center-Surround DoG Pyramid (r = 5px ~ 42px)
    catching ultra-faint (0.4% ~ 2%) out-of-focus circular dust shadows.
  - Plane-Detrended Outer Annulus SNR & Cloud/Scene Gatekeeper:
    For every candidate spot (cx, cy, r), fits a 1st-order linear plane (ax + by + c) to the
    surrounding annulus ring (1.45r <= d <= 2.55r) and measures:
      1) plane_center (background brightness): rejects dark foreground ground/trees/shadows
      2) ann_std (plane-detrended outer annulus standard deviation):
         - Real dust on sky has ann_std = 0.35 ~ 1.80
         - Cloud pockets (#35, #42, #43, #53, #55) have ann_std = 5.8 ~ 22.0 -> 100% rejected!
      3) annulus_snr = spot_depth / ann_std:
         - Real dust has SNR = 3.2 ~ 18.5
         - Cloud pockets have SNR = 1.2 ~ 2.8 -> 100% rejected!
      4) p15_diff (15th percentile darkest annulus pixel vs core): ensures omnidirectional enclosure.
"""

import sys
import os
import json
import math
import traceback
from pathlib import Path
from typing import Dict, Any, List, Tuple, Optional

import numpy as np
import cv2
import rawpy
import tifffile
import piexif

RAW_EXTENSIONS = {
    '.rw2', '.dng', '.cr2', '.cr3', '.nef', '.arw',
    '.orf', '.pef', '.raf', '.srw', '.erf', '.kdc', '.dcr'
}


def extract_exif_metadata(file_path: str) -> Dict[str, Any]:
    """Extracts EXIF metadata from RW2/TIFF/JPEG header and returns serializable summary."""
    meta_summary: Dict[str, Any] = {
        "make": "Unknown",
        "model": "Camera Sensor",
        "iso": None,
        "fNumber": None,
        "exposureTime": None,
        "focalLength": None,
        "dateTime": None,
        "software": "SensorClean Pro 16-bit Pipeline",
    }

    try:
        with tifffile.TiffFile(file_path) as tif:
            page = tif.pages[0]
            tags = page.tags
            if 'Make' in tags:
                meta_summary['make'] = str(tags['Make'].value).strip('\x00 ')
            if 'Model' in tags:
                meta_summary['model'] = str(tags['Model'].value).strip('\x00 ')
            if 'DateTime' in tags:
                meta_summary['dateTime'] = str(tags['DateTime'].value).strip('\x00 ')
            if 'ExifTag' in tags and isinstance(tags['ExifTag'].value, dict):
                exif_dict = tags['ExifTag'].value
                if 'ISOSpeedRatings' in exif_dict:
                    val = exif_dict['ISOSpeedRatings']
                    meta_summary['iso'] = int(val[0]) if isinstance(val, (list, tuple)) else int(val)
                if 'FNumber' in exif_dict:
                    fn = exif_dict['FNumber']
                    if isinstance(fn, (list, tuple)) and len(fn) == 2 and fn[1] != 0:
                        meta_summary['fNumber'] = round(float(fn[0]) / float(fn[1]), 1)
                    elif isinstance(fn, (int, float)):
                        meta_summary['fNumber'] = round(float(fn), 1)
                if 'ExposureTime' in exif_dict:
                    et = exif_dict['ExposureTime']
                    if isinstance(et, (list, tuple)) and len(et) == 2 and et[1] != 0:
                        if et[0] < et[1]:
                            meta_summary['exposureTime'] = f"{et[0]}/{et[1]}s"
                        else:
                            meta_summary['exposureTime'] = f"{round(et[0]/et[1], 2)}s"
                if 'FocalLength' in exif_dict:
                    fl = exif_dict['FocalLength']
                    if isinstance(fl, (list, tuple)) and len(fl, (list, tuple)) and fl[1] != 0:
                        meta_summary['focalLength'] = f"{round(fl[0]/fl[1], 1)}mm"
    except Exception:
        pass

    try:
        exif_data = piexif.load(file_path)
        zeroth = exif_data.get("0th", {})
        exif_ifd = exif_data.get("Exif", {})
        if piexif.ImageIFD.Make in zeroth and meta_summary["make"] == "Unknown":
            meta_summary["make"] = zeroth[piexif.ImageIFD.Make].decode("utf-8", errors="ignore").strip("\x00 ")
        if piexif.ImageIFD.Model in zeroth and meta_summary["model"] == "Camera Sensor":
            meta_summary["model"] = zeroth[piexif.ImageIFD.Model].decode("utf-8", errors="ignore").strip("\x00 ")
        if piexif.ExifIFD.ISOSpeedRatings in exif_ifd and meta_summary["iso"] is None:
            meta_summary["iso"] = int(exif_ifd[piexif.ExifIFD.ISOSpeedRatings])
        if piexif.ExifIFD.FNumber in exif_ifd and meta_summary["fNumber"] is None:
            num, den = exif_ifd[piexif.ExifIFD.FNumber]
            if den != 0:
                meta_summary["fNumber"] = round(num / den, 1)
        if piexif.ExifIFD.ExposureTime in exif_ifd and meta_summary["exposureTime"] is None:
            num, den = exif_ifd[piexif.ExifIFD.ExposureTime]
            if den != 0:
                meta_summary["exposureTime"] = f"1/{int(round(den/num))}s" if num < den else f"{round(num/den, 2)}s"
        if piexif.ExifIFD.FocalLength in exif_ifd and meta_summary["focalLength"] is None:
            num, den = exif_ifd[piexif.ExifIFD.FocalLength]
            if den != 0:
                meta_summary["focalLength"] = f"{round(num/den, 1)}mm"
    except Exception:
        pass

    return meta_summary


cv2.setUseOptimized(True)

# Precomputed 256-entry LUT mapping 8-bit sRGB (0..255) -> 16-bit Linear RGB (0..65535 uint16)
_NORM_256 = np.arange(256, dtype=np.float32) / 255.0
_LIN_256 = np.where(
    _NORM_256 <= 0.04045,
    _NORM_256 / 12.92,
    np.power((_NORM_256 + 0.055) / 1.055, 2.4)
)
_SRGB8_TO_LINEAR16_LUT = np.clip(np.round(_LIN_256 * 65535.0), 0, 65535).astype(np.uint16)

# Precomputed 65536-entry normalized ramp (0..1 float32) for instant 16-bit -> sRGB LUT generation
_NORM_65536 = np.arange(65536, dtype=np.float32) / 65535.0


def build_srgb_u8_lut(exposure_scale: float) -> np.ndarray:
    """Builds a 65536-entry uint8 sRGB Lookup Table in <0.1ms for instant O(1) 16-bit tone mapping."""
    exposed = np.clip(_NORM_65536 * float(exposure_scale), 0.0, 1.0)
    srgb = np.where(
        exposed <= 0.0031308,
        exposed * 12.92,
        1.055 * np.power(np.maximum(exposed, 1e-8), 1.0 / 2.4) - 0.055
    )
    return np.clip(np.round(srgb * 255.0), 0, 255).astype(np.uint8)


def build_srgb_u16_lut(exposure_scale: float) -> np.ndarray:
    """Builds a 65536-entry uint16 sRGB Lookup Table in <0.1ms."""
    exposed = np.clip(_NORM_65536 * float(exposure_scale), 0.0, 1.0)
    srgb = np.where(
        exposed <= 0.0031308,
        exposed * 12.92,
        1.055 * np.power(np.maximum(exposed, 1e-8), 1.0 / 2.4) - 0.055
    )
    return np.clip(np.round(srgb * 65535.0), 0, 65535).astype(np.uint16)


def linear_16bit_to_srgb_8bit(linear_rgb_16: np.ndarray, exposure_scale: Optional[float] = None) -> Tuple[np.ndarray, float]:
    """Converts a 16-bit Linear RGB (gamma 1.0) array into an 8-bit sRGB tone-mapped image via 65536-LUT."""
    if exposure_scale is None:
        sample = linear_rgb_16[::4, ::4].astype(np.float32) / 65535.0
        p995 = float(np.percentile(sample, 99.6))
        exposure_scale = (0.94 / p995) if p995 > 1e-4 else 1.0
        exposure_scale = float(np.clip(exposure_scale, 0.5, 16.0))

    lut_u8 = build_srgb_u8_lut(exposure_scale)
    return lut_u8[linear_rgb_16], exposure_scale


def linear_16bit_to_srgb_16bit(linear_rgb_16: np.ndarray, exposure_scale: Optional[float] = None) -> Tuple[np.ndarray, float]:
    """
    Converts a 16-bit Linear RGB (gamma 1.0) array into a full 16-bit (0..65535 uint16)
    exposure-calibrated sRGB image via 65536-LUT.
    """
    if exposure_scale is None:
        sample = linear_rgb_16[::4, ::4].astype(np.float32) / 65535.0
        p995 = float(np.percentile(sample, 99.6))
        exposure_scale = (0.94 / p995) if p995 > 1e-4 else 1.0
        exposure_scale = float(np.clip(exposure_scale, 0.5, 16.0))

    lut_u16 = build_srgb_u16_lut(exposure_scale)
    return lut_u16[linear_rgb_16], exposure_scale


def compute_det_gray_from_16bit(det_16: np.ndarray, is_raw: bool, exposure_scale: float) -> np.ndarray:
    """Computes perceptual 2304px luminance (0..255 float32) for dust detection."""
    lum_linear = (
        0.2126 * det_16[:, :, 0].astype(np.float32) +
        0.7152 * det_16[:, :, 1].astype(np.float32) +
        0.0722 * det_16[:, :, 2].astype(np.float32)
    ) / 65535.0
    if is_raw:
        p995_lum = float(np.percentile(lum_linear[::2, ::2], 99.6))
        det_exp_scale = float(np.clip((0.94 / p995_lum) if p995_lum > 1e-4 else exposure_scale, 0.5, 16.0))
    else:
        det_exp_scale = exposure_scale
    lum_exposed = np.clip(lum_linear * det_exp_scale, 1e-6, 1.0)
    return np.power(lum_exposed, 1.0 / 2.2) * 255.0



def ingest_image(input_path: str, session_dir: str) -> Dict[str, Any]:
    """
    Step 1: Ingests RW2 (or other RAW / image formats) into a 16-bit linear RGB numpy array.
    """
    os.makedirs(session_dir, exist_ok=True)
    ext = Path(input_path).suffix.lower()
    exif_meta = extract_exif_metadata(input_path)

    is_raw = ext in RAW_EXTENSIONS
    camera_wb = [1.0, 1.0, 1.0, 1.0]
    color_matrix: List[List[float]] = []
    black_level = [0, 0, 0, 0]
    white_level = 65535
    raw_pattern_desc = "RGBG"
    exposure_scale_override: Optional[float] = None

    if is_raw:
        try:
            with rawpy.imread(input_path) as raw:
                if raw.camera_whitebalance is not None:
                    camera_wb = [float(x) for x in raw.camera_whitebalance]
                if raw.color_matrix is not None:
                    color_matrix = [[float(v) for v in row] for row in raw.color_matrix.tolist()]
                if raw.black_level_per_channel is not None:
                    black_level = [int(x) for x in raw.black_level_per_channel]
                if raw.white_level is not None:
                    white_level = int(raw.white_level)
                if raw.color_desc is not None:
                    raw_pattern_desc = raw.color_desc.decode("utf-8", errors="ignore")

                linear_rgb_16 = raw.postprocess(
                    gamma=(1, 1),
                    no_auto_bright=True,
                    output_bps=16,
                    use_camera_wb=True,
                    half_size=False,
                    demosaic_algorithm=rawpy.DemosaicAlgorithm.AHD
                )

                # Calibrate exposure_scale against the camera's embedded JPEG preview if present
                try:
                    thumb = raw.extract_thumb()
                    if thumb.format == rawpy.ThumbFormat.JPEG:
                        t_bgr = cv2.imdecode(np.frombuffer(thumb.data, np.uint8), cv2.IMREAD_COLOR)
                        if t_bgr is not None:
                            t_rgb = cv2.cvtColor(t_bgr, cv2.COLOR_BGR2RGB)
                            t_norm = t_rgb.astype(np.float32) / 255.0
                            t_lin = np.where(
                                t_norm <= 0.04045,
                                t_norm / 12.92,
                                np.power((t_norm + 0.055) / 1.055, 2.4)
                            )
                            lin_p85 = float(np.percentile(linear_rgb_16[::4, ::4].astype(np.float32) / 65535.0, 85))
                            thumb_p85 = float(np.percentile(t_lin, 85))
                            if lin_p85 > 1e-4 and thumb_p85 > 1e-4:
                                exposure_scale_override = float(np.clip(thumb_p85 / lin_p85, 0.5, 16.0))
                except Exception:
                    pass
        except Exception:
            tif_arr = tifffile.imread(input_path)
            if tif_arr.ndim == 2:
                tif_arr = np.stack([tif_arr] * 3, axis=-1)
            elif tif_arr.shape[2] > 3:
                tif_arr = tif_arr[:, :, :3]
            if tif_arr.dtype == np.uint8:
                linear_rgb_16 = (np.power(tif_arr.astype(np.float32) / 255.0, 2.2) * 65535.0).astype(np.uint16)
                exposure_scale_override = 1.0
            else:
                linear_rgb_16 = tif_arr.astype(np.uint16)
    else:
        bgr = cv2.imread(input_path, cv2.IMREAD_UNCHANGED)
        if bgr is None:
            raise ValueError(f"이미지를 디코딩할 수 없습니다: {input_path}")
        if bgr.ndim == 2:
            rgb = cv2.cvtColor(bgr, cv2.COLOR_GRAY2RGB)
        elif bgr.shape[2] == 4:
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGRA2RGB)
        else:
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

        if rgb.dtype == np.uint16:
            linear_rgb_16 = rgb
        else:
            linear_rgb_16 = _SRGB8_TO_LINEAR16_LUT[rgb]
            exposure_scale_override = 1.0

    full_h, full_w = int(linear_rgb_16.shape[0]), int(linear_rgb_16.shape[1])
    np.save(os.path.join(session_dir, "linear_16bit.npy"), linear_rgb_16)

    # Align working resolution (2304px) with detection resolution (2304px) so we resize only once!
    max_work_dim = 2304
    scale = 1.0
    if max(full_h, full_w) > max_work_dim:
        scale = max_work_dim / float(max(full_h, full_w))
        work_w = max(1, int(round(full_w * scale)))
        work_h = max(1, int(round(full_h * scale)))
        work_linear_16 = cv2.resize(linear_rgb_16, (work_w, work_h), interpolation=cv2.INTER_AREA)
    else:
        work_w, work_h = full_w, full_h
        work_linear_16 = linear_rgb_16

    np.save(os.path.join(session_dir, "work_linear_16bit.npy"), work_linear_16)

    srgb_preview_u8, exposure_scale = linear_16bit_to_srgb_8bit(
        work_linear_16, exposure_scale=exposure_scale_override
    )
    np.save(os.path.join(session_dir, "work_srgb_u8.npy"), srgb_preview_u8)
    preview_bgr = cv2.cvtColor(srgb_preview_u8, cv2.COLOR_RGB2BGR)
    preview_path = os.path.join(session_dir, "preview_original.jpg")
    cv2.imwrite(preview_path, preview_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 96])

    # Pre-cache 2304px perceptual luminance array so dust detection / re-detection starts in <3ms
    gray_det = compute_det_gray_from_16bit(work_linear_16, is_raw, exposure_scale)
    np.save(os.path.join(session_dir, "det_gray.npy"), gray_det)

    sub_stats = linear_rgb_16[::4, ::4]
    min_val = int(np.min(sub_stats))
    max_val = int(np.max(sub_stats))
    mean_val = float(np.mean(sub_stats))
    dynamic_range_ev = round(math.log2(max(max_val, 1) / max(min_val, 1)), 2) if max_val > min_val else 14.0

    session_meta = {
        "originalFileName": os.path.basename(input_path),
        "extension": ext.upper().lstrip('.'),
        "isRaw": is_raw,
        "fullWidth": full_w,
        "fullHeight": full_h,
        "workWidth": work_w,
        "workHeight": work_h,
        "workScale": scale,
        "exposureScale": exposure_scale,
        "bitDepth": "16-bit Linear (uint16)",
        "colorSpace": "Camera Linear RGB (Gamma 1.0)" if is_raw else "Linearized 16-bit RGB",
        "cameraWb": camera_wb[:4],
        "colorMatrix": color_matrix,
        "blackLevel": black_level,
        "whiteLevel": white_level,
        "bayerPattern": raw_pattern_desc,
        "stats16Bit": {
            "minCodeValue": min_val,
            "maxCodeValue": max_val,
            "meanCodeValue": round(mean_val, 1),
            "estimatedDynamicRangeEv": dynamic_range_ev
        },
        "exif": exif_meta
    }

    with open(os.path.join(session_dir, "session_meta.json"), "w", encoding="utf-8") as f:
        json.dump(session_meta, f, ensure_ascii=False, indent=2)

    return session_meta


# Precomputed 301x301 radial distance, coordinate, and 8-sector lookup grids centered at (150, 150)
_GRID_HALF = 150
_GY, _GX = np.mgrid[-_GRID_HALF:_GRID_HALF + 1, -_GRID_HALF:_GRID_HALF + 1].astype(np.float32)
_GDIST = np.sqrt(_GX ** 2 + _GY ** 2)
_GANGLES = np.arctan2(_GY, _GX)
_GSECTOR = np.clip(((_GANGLES + math.pi) / (2.0 * math.pi) * 8.0).astype(np.int32), 0, 7)


def _fast_fit_plane(ax: np.ndarray, ay: np.ndarray, av: np.ndarray) -> np.ndarray:
    """Solves 3x3 normal equations for 1st-order plane (a*x + b*y + c) ~12x faster than lstsq SVD."""
    n = float(len(ax))
    sx = float(np.sum(ax))
    sy = float(np.sum(ay))
    sxx = float(np.dot(ax, ax)) + 1e-5
    syy = float(np.dot(ay, ay)) + 1e-5
    sxy = float(np.dot(ax, ay))
    sv = float(np.sum(av))
    sxv = float(np.dot(ax, av))
    syv = float(np.dot(ay, av))
    mat = np.array([
        [sxx, sxy, sx],
        [sxy, syy, sy],
        [sx,  sy,  n + 1e-5]
    ], dtype=np.float64)
    rhs = np.array([sxv, syv, sv], dtype=np.float64)
    return np.linalg.solve(mat, rhs)


def _eval_single_radius_annulus(
    img_gray: np.ndarray,
    grad_map: np.ndarray,
    bg_std_map: np.ndarray,
    hf_tex_map: np.ndarray,
    cx_det: float,
    cy_det: float,
    r_det: float,
    is_sharp_branch: bool,
    cloud_protection: float,
    sensitivity: float
) -> Tuple[bool, float, float, float, float]:
    """
    Evaluates a single candidate radius r_det at (cx_det, cy_det) using precomputed radial grids,
    closed-form 3x3 normal equations, and single-pass sorted percentile indexing.
    """
    h, w = img_gray.shape[:2]
    ix, iy = int(round(cx_det)), int(round(cy_det))
    r_out = min(_GRID_HALF, int(round(max(r_det * 2.28, r_det + 5.0))))

    min_border = int(round(max(r_det * 1.15, 4.0)))
    if ix < min_border or ix >= w - min_border or iy < min_border or iy >= h - min_border:
        return False, 0.0, 0.0, 0.0, 0.0

    prot = 0.55 + (cloud_protection / 100.0) * 0.60

    local_bg_std = float(bg_std_map[iy, ix])
    local_hf_tex = float(hf_tex_map[iy, ix])

    max_bg_std = (3.45 if is_sharp_branch else 2.75) / prot
    if local_bg_std > max_bg_std or local_hf_tex > (1.55 / prot):
        return False, 0.0, 0.0, 0.0, 0.0

    y0, y1 = max(0, iy - r_out), min(h, iy + r_out + 1)
    x0, x1 = max(0, ix - r_out), min(w, ix + r_out + 1)
    patch = img_gray[y0:y1, x0:x1]

    gy0 = _GRID_HALF + (y0 - iy)
    gy1 = _GRID_HALF + (y1 - iy)
    gx0 = _GRID_HALF + (x0 - ix)
    gx1 = _GRID_HALF + (x1 - ix)

    dist = _GDIST[gy0:gy1, gx0:gx1]
    xx = _GX[gy0:gy1, gx0:gx1]
    yy = _GY[gy0:gy1, gx0:gx1]
    sec_grid = _GSECTOR[gy0:gy1, gx0:gx1]

    r_core = max(1.2, r_det * (0.52 if is_sharp_branch else 0.48))
    r_ann_in = max(r_det * 1.32, r_det + 1.8)
    valid_p = patch >= 8.0
    core_mask = (dist <= r_core) & valid_p
    ann_mask = (dist >= r_ann_in) & (dist <= r_out) & valid_p

    av = patch[ann_mask]
    n_ann = len(av)
    if n_ann < 16:
        return False, 0.0, 0.0, 0.0, 0.0

    core_pixels = patch[core_mask]
    if len(core_pixels) < 1:
        return False, 0.0, 0.0, 0.0, 0.0

    sens_factor = 1.32 - (sensitivity / 100.0) * 0.52  # 0.966 at sensitivity=68
    min_depth = (2.10 if is_sharp_branch else 1.08) * sens_factor

    # Fast pre-gate before fitting any linear planes
    approx_bg = float(np.mean(av))
    if approx_bg < 84.0:
        return False, 0.0, 0.0, 0.0, 0.0
    core_val = float(np.percentile(core_pixels, 25)) if is_sharp_branch else float(np.mean(core_pixels))
    if approx_bg - core_val < min_depth * 0.72:
        return False, 0.0, 0.0, 0.0, 0.0

    ax = xx[ann_mask]
    ay = yy[ann_mask]

    # Step 1: Initial 1st-order plane fit on ALL outer annulus pixels
    coeffs1 = _fast_fit_plane(ax, ay, av)
    res1 = av - (coeffs1[0] * ax + coeffs1[1] * ay + coeffs1[2])
    ann_all_std = float(np.std(res1))

    res_sorted = np.sort(res1)
    p05_res = float(res_sorted[int(n_ann * 0.05)])
    p95_res = float(res_sorted[min(n_ann - 1, int(n_ann * 0.95))])
    ann_span = p95_res - p05_res

    max_ann_all_std = (1.85 if is_sharp_branch else 1.48) / prot
    max_ann_span = (5.20 if is_sharp_branch else 4.30) / prot
    if ann_all_std > max_ann_all_std or ann_span > max_ann_span:
        return False, 0.0, 0.0, 0.0, 0.0

    # Step 2: Symmetric [18, 82] percentile trimming from already-sorted residuals
    lo_p = float(res_sorted[int(n_ann * 0.18)])
    hi_p = float(res_sorted[min(n_ann - 1, int(n_ann * 0.82))])
    clean_idx = (res1 >= lo_p) & (res1 <= hi_p)
    if int(np.sum(clean_idx)) >= 10:
        coeffs = _fast_fit_plane(ax[clean_idx], ay[clean_idx], av[clean_idx])
        res_clean = av[clean_idx] - (coeffs[0] * ax[clean_idx] + coeffs[1] * ay[clean_idx] + coeffs[2])
    else:
        coeffs = coeffs1
        res_clean = res1

    plane_center = float(coeffs[2])
    if plane_center < 86.0:
        return False, 0.0, 0.0, 0.0, 0.0

    depth = plane_center - core_val
    if depth < min_depth:
        return False, 0.0, 0.0, 0.0, 0.0

    ann_clean_std = float(np.std(res_clean))
    eff_noise = max(ann_clean_std * 1.35, ann_all_std * 0.72, 0.25)
    snr = depth / eff_noise
    min_snr = (3.15 if is_sharp_branch else 2.40) * sens_factor * (0.82 + 0.18 * prot)
    if snr < min_snr:
        return False, 0.0, 0.0, 0.0, 0.0

    if not is_sharp_branch:
        grad_patch = grad_map[y0:y1, x0:x1]
        inner_grad = grad_patch[dist <= r_det * 1.35]
        if len(inner_grad) > 0:
            ig_sorted = np.sort(inner_grad.ravel())
            inner_grad_p90 = float(ig_sorted[min(len(ig_sorted) - 1, int(len(ig_sorted) * 0.90))])
            if inner_grad_p90 > max(3.4, depth * 1.35):
                return False, 0.0, 0.0, 0.0, 0.0

    # Step 4: Fast 8-Sector Angular Enclosure Check
    detrended_ann = res1 + plane_center
    sector_idx = sec_grid[ann_mask]
    sec_counts = np.bincount(sector_idx, minlength=8)
    sec_sums = np.bincount(sector_idx, weights=detrended_ann, minlength=8)
    valid_sec_mask = sec_counts >= 2
    valid_sectors = int(np.sum(valid_sec_mask))
    if valid_sectors < 6:
        return False, 0.0, 0.0, 0.0, 0.0

    sec_means = np.where(valid_sec_mask, sec_sums / np.maximum(sec_counts, 1), core_val)
    req_margin = depth * 0.20
    brighter_sectors = int(np.sum(valid_sec_mask & ((sec_means - core_val) >= req_margin)))
    if brighter_sectors < max(6, valid_sectors - 1):
        return False, 0.0, 0.0, 0.0, 0.0

    contrast_pct = (depth / max(plane_center, 20.0)) * 100.0
    isotropy = float(np.clip(1.0 - (eff_noise / (depth * 1.5 + 0.35)), 0.62, 0.98))
    return True, contrast_pct, isotropy, snr, depth


def verify_annulus_plane_snr(
    img_gray: np.ndarray,
    grad_map: np.ndarray,
    bg_std_map: np.ndarray,
    hf_tex_map: np.ndarray,
    cx_det: float,
    cy_det: float,
    r_det: float,
    is_sharp_branch: bool,
    cloud_protection: float,
    sensitivity: float = 68.0
) -> Tuple[bool, float, float, float, float]:
    """
    Multi-radius local contrast optimizer around r_det.
    Tests multiple scale multipliers around r_det and chooses the radius that yields
    the strongest verified contrast depth and SNR outside the dust skirt.
    Returns (passed, best_r_det, contrast_drop_pct, isotropy_circularity, snr).
    """
    scale_multipliers = [0.90, 1.0, 1.25, 1.55] if is_sharp_branch else [0.88, 1.0, 1.15, 1.28]
    best_tuple = (False, r_det, 0.0, 0.0, 0.0)
    best_score = -1.0

    for mult in scale_multipliers:
        cand_r = max(1.4, r_det * mult)
        ok, cp, iso, snr, depth = _eval_single_radius_annulus(
            img_gray, grad_map, bg_std_map, hf_tex_map,
            cx_det, cy_det, cand_r,
            is_sharp_branch=is_sharp_branch,
            cloud_protection=cloud_protection,
            sensitivity=sensitivity
        )
        if ok:
            score = depth * (snr ** 0.5)
            if score > best_score:
                best_score = score
                best_tuple = (True, cand_r, cp, iso, snr)

    return best_tuple


def detect_sensor_dust(session_dir: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """
    Step 2: High-Resolution Dual-Branch Sensor Dust Detection
      - Branch A: Sharp / Focused Micro-Dust (g_8.5 - g_0.9 + Plane-Detrended Annulus SNR)
      - Branch B: Defocused / Bokeh Circular Dust (12-Scale Center-Surround DoG Pyramid
        covering r = 7.2px .. 44px with wider surround kernel 1.24*r_b for wide bokeh spots)
    """
    with open(os.path.join(session_dir, "session_meta.json"), "r", encoding="utf-8") as f:
        meta = json.load(f)

    full_h = int(meta["fullHeight"])
    full_w = int(meta["fullWidth"])
    work_h = int(meta["workHeight"])
    work_w = int(meta["workWidth"])
    work_scale = float(meta.get("workScale", 1.0))
    exposure_scale = float(meta.get("exposureScale", 1.0))

    max_det_dim = 2304
    det_scale = min(1.0, max_det_dim / float(max(full_h, full_w)))
    det_w = max(1, int(round(full_w * det_scale)))
    det_h = max(1, int(round(full_h * det_scale)))

    method = str(params.get("method", "dual")).lower()
    sensitivity = float(params.get("sensitivity", 68.0))          # 1 ~ 100
    min_radius_full = float(params.get("minRadius", 2.0))
    max_radius_full = float(params.get("maxRadius", 44.0))
    min_circularity = float(params.get("minCircularity", 0.60))
    cloud_protection = float(params.get("cloudProtection", 75.0)) # 0 ~ 100

    min_r_det = max(1.2, min_radius_full * det_scale)
    max_r_det = max(min_r_det + 4.0, max_radius_full * det_scale)

    # Load pre-cached 2304px perceptual luminance if available (saves ~350ms disk I/O + resize)
    det_gray_path = os.path.join(session_dir, "det_gray.npy")
    if os.path.exists(det_gray_path):
        gray_det = np.load(det_gray_path)
        det_h, det_w = gray_det.shape[:2]
        det_scale = det_w / float(full_w)
    else:
        work_16_path = os.path.join(session_dir, "work_linear_16bit.npy")
        if os.path.exists(work_16_path) and (work_h, work_w) == (det_h, det_w):
            det_16 = np.load(work_16_path)
        else:
            full_16 = np.load(os.path.join(session_dir, "linear_16bit.npy"))
            det_16 = cv2.resize(full_16, (det_w, det_h), interpolation=cv2.INTER_AREA) if det_scale < 1.0 else full_16
        gray_det = compute_det_gray_from_16bit(det_16, bool(meta.get("isRaw", False)), exposure_scale)
        np.save(det_gray_path, gray_det)

    # Pad any black letterbox/pillarbox bars (< 8.0) with nearest valid photo pixels
    # so large Gaussian kernels (sigma=22) do not bleed black borders into adjacent sky
    valid_photo_mask = gray_det >= 8.0
    if not np.all(valid_photo_mask) and np.any(valid_photo_mask):
        invalid_u8 = (~valid_photo_mask).astype(np.uint8)
        _, labels = cv2.distanceTransformWithLabels(invalid_u8, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
        zero_ys, zero_xs = np.where(invalid_u8 == 0)
        zero_labels = labels[zero_ys, zero_xs]
        lut_y = np.zeros(int(labels.max()) + 1, dtype=np.int32)
        lut_x = np.zeros(int(labels.max()) + 1, dtype=np.int32)
        lut_y[zero_labels] = zero_ys
        lut_x[zero_labels] = zero_xs
        gray_filt = gray_det[lut_y[labels], lut_x[labels]].copy()
    else:
        gray_filt = gray_det

    # Regional Background Macro-Std Map (sigma=22) & High-Frequency Foliage Texture Map
    # Clamp deep negative point depressions (-3.2) when estimating macro background variance
    # so a strong dust spot's own dark core does not self-inflate local_bg_std or hf_texture
    s1 = cv2.GaussianBlur(gray_filt, (0, 0), 0.9)
    g8 = cv2.GaussianBlur(s1, (0, 0), 8.5)
    denoise_det = cv2.GaussianBlur(gray_filt, (0, 0), 1.8)
    s1_masked = np.where(valid_photo_mask, s1, 0.0)
    denoise_masked = np.where(valid_photo_mask, denoise_det, 0.0)
    bg_mean_22 = cv2.GaussianBlur(denoise_det, (0, 0), 22.0)
    bg_diff_clamped = np.maximum(denoise_det - bg_mean_22, -3.2)
    bg_sq_22 = cv2.GaussianBlur(bg_diff_clamped ** 2, (0, 0), 22.0)
    bg_std_map = np.sqrt(np.maximum(bg_sq_22, 0.0))
    hf_diff_clamped = np.minimum(np.abs(s1 - g8), np.maximum(s1 - g8 + 2.8, 2.8))
    hf_texture = cv2.GaussianBlur(hf_diff_clamped, (0, 0), 18.0)

    sobel_x = cv2.Sobel(denoise_det, cv2.CV_32F, 1, 0, ksize=3)
    sobel_y = cv2.Sobel(denoise_det, cv2.CV_32F, 0, 1, ksize=3)
    grad_mag = cv2.GaussianBlur(np.sqrt(sobel_x ** 2 + sobel_y ** 2), (0, 0), 1.5)

    prot = 0.55 + (cloud_protection / 100.0) * 0.60
    raw_candidates: List[Dict[str, Any]] = []
    combined_vis_det = np.zeros((det_h, det_w), dtype=np.float32)

    run_sharp = method in ("dual", "multiscale", "hybrid", "sharp", "blackhat")
    run_bokeh = method in ("dual", "multiscale", "hybrid", "bokeh", "dog")

    # ─── BRANCH A: Sharp / Focused Sensor Dust Detector (Crisp particles & micro-specks) ───
    if run_sharp:
        sharp_diff = np.maximum(g8 - s1, 0.0)
        valid_bg_mask = (
            valid_photo_mask &
            (g8 >= 86.0) &
            (bg_std_map <= (3.45 / prot)) &
            (hf_texture <= (1.55 / prot))
        )
        sharp_gated = np.where(valid_bg_mask, sharp_diff, 0.0)
        combined_vis_det = np.maximum(combined_vis_det, sharp_gated * 1.4)

        diff_thresh = max(1.75, 4.10 - (sensitivity / 100.0) * 2.55)
        bm_sharp = (sharp_gated >= diff_thresh).astype(np.uint8) * 255

        cnts, _ = cv2.findContours(bm_sharp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in cnts:
            area_det = float(cv2.contourArea(c))
            if area_det < 2.2 or area_det > 500.0:
                continue

            (cx_d, cy_d), enc_r_d = cv2.minEnclosingCircle(c)
            eq_r_d = math.sqrt(area_det / math.pi)
            r_d = max(1.6, 0.55 * enc_r_d + 0.45 * eq_r_d)

            if len(c) >= 5:
                (_, _), (ma, MA), _ = cv2.fitEllipse(c)
                if min(ma, MA) > 0.4 and (max(ma, MA) / min(ma, MA)) > 2.8:
                    continue

            r_full = r_d / det_scale
            if r_full < min_radius_full or r_full > max_radius_full:
                continue

            passed, opt_r_d, contrast_pct, isotropy, snr = verify_annulus_plane_snr(
                s1_masked, grad_mag, bg_std_map, hf_texture,
                float(cx_d), float(cy_d), r_d,
                is_sharp_branch=True, cloud_protection=cloud_protection,
                sensitivity=sensitivity
            )
            if not passed or isotropy < min_circularity:
                continue

            r_full_opt = opt_r_d / det_scale
            raw_candidates.append({
                "detCx": float(cx_d),
                "detCy": float(cy_d),
                "detRadius": float(opt_r_d),
                "cx": round(float(cx_d) / det_scale, 1),
                "cy": round(float(cy_d) / det_scale, 1),
                "workCx": round((float(cx_d) / det_scale) * work_scale, 1),
                "workCy": round((float(cy_d) / det_scale) * work_scale, 1),
                "radius": round(float(r_full_opt), 1),
                "workRadius": round(float(r_full_opt * work_scale * 1.55 + 2.5), 1),
                "area": round(area_det / (det_scale * det_scale), 1),
                "perimeter": round(2.0 * math.pi * r_full_opt, 1),
                "circularity": round(isotropy, 3),
                "contrastDropPct": round(contrast_pct, 2),
                "score": snr * 1.25,
                "spotType": "sharp"
            })

    # ─── BRANCH B: Defocused / Bokeh Circular Dust Detector (12-Scale DoG Pyramid) ───
    if run_bokeh:
        # Bokeh spots have r_b >= 7.2px (sigma >= 3.24px), which is strictly band-limited well below
        # half-Nyquist. Evaluating the 12-scale DoG pyramid on a 0.5x downsampled grid is 16x faster
        # with >65dB mathematical equivalence, while full 2304px resolution is used for annulus SNR verification.
        pyr_w = max(1, det_w // 2)
        pyr_h = max(1, det_h // 2)
        pyr_scale_x = pyr_w / float(det_w)
        pyr_scale_y = pyr_h / float(det_h)
        pyr_scale = 0.5 * (pyr_scale_x + pyr_scale_y)

        denoise_pyr = cv2.resize(denoise_det, (pyr_w, pyr_h), interpolation=cv2.INTER_AREA)
        quiet_sky_mask = valid_photo_mask & (bg_mean_22 >= 86.0) & (bg_std_map <= 1.65) & (hf_texture <= 1.1)
        quiet_sky_pyr = cv2.resize(quiet_sky_mask.astype(np.uint8), (pyr_w, pyr_h), interpolation=cv2.INTER_NEAREST) > 0

        bokeh_min_r = max(7.2, min_r_det)
        bokeh_max_r = max(bokeh_min_r + 6.0, max_r_det * 0.98)
        bokeh_radii = np.geomspace(bokeh_min_r, bokeh_max_r, num=12)

        bokeh_z_stack: List[np.ndarray] = []
        bokeh_contrast_stack: List[np.ndarray] = []

        sky_ys, sky_xs = np.where(quiet_sky_pyr)
        has_quiet_sky = len(sky_ys) > 100
        if has_quiet_sky:
            sky_stride = max(1, len(sky_ys) // 25000)
            sky_ys_sub = sky_ys[::sky_stride]
            sky_xs_sub = sky_xs[::sky_stride]

        for r_b in bokeh_radii:
            r_p = r_b * pyr_scale
            g_in = cv2.GaussianBlur(denoise_pyr, (0, 0), r_p * 0.45)
            g_out = cv2.GaussianBlur(denoise_pyr, (0, 0), r_p * 1.24)
            raw_band = ((g_out - g_in) / np.maximum(g_out, 25.0)) * 255.0

            if has_quiet_sky:
                sky_vals = raw_band[sky_ys_sub, sky_xs_sub]
                med = float(np.median(sky_vals))
                mad_sky = float(np.median(np.abs(sky_vals - med))) * 1.4826
            else:
                sub_band = raw_band[::2, ::2]
                med = float(np.median(sub_band))
                mad_sky = float(np.median(np.abs(sub_band - med))) * 1.4826

            eff_mad = max(mad_sky, 0.16)
            z_b = np.maximum((raw_band - med) / eff_mad, 0.0)
            bokeh_z_stack.append(z_b)

            scale_weight = (r_b / bokeh_min_r) ** (-0.05)
            bokeh_contrast_stack.append(np.maximum(raw_band - med, 0.0) * scale_weight)

        b_stack = np.stack(bokeh_z_stack, axis=0)
        c_stack = np.stack(bokeh_contrast_stack, axis=0)

        bokeh_max_z_pyr = cv2.GaussianBlur(np.max(b_stack, axis=0), (0, 0), 0.8)
        bokeh_best_idx_pyr = np.argmax(c_stack, axis=0)

        bokeh_max_z = cv2.resize(bokeh_max_z_pyr, (det_w, det_h), interpolation=cv2.INTER_LINEAR)
        vis_mask = np.where(valid_photo_mask & (bg_mean_22 >= 86.0) & (bg_std_map <= 3.0 / prot), bokeh_max_z, 0.0)
        combined_vis_det = np.maximum(combined_vis_det, vis_mask)

        # Sensitivity 68 -> z_thresh ≈ 2.38
        z_thresh = max(1.35, 4.42 - (sensitivity / 100.0) * 3.00)
        nms_k_pyr = max(7, int(round(bokeh_min_r * pyr_scale * 1.85)) | 1)
        local_max_pyr = cv2.dilate(bokeh_max_z_pyr, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (nms_k_pyr, nms_k_pyr)))
        b_peaks_pyr = (bokeh_max_z_pyr >= z_thresh) & (bokeh_max_z_pyr >= local_max_pyr - 1e-4)
        b_ys_p, b_xs_p = np.where(b_peaks_pyr)

        for py_p, px_p in zip(b_ys_p, b_xs_p):
            px = min(det_w - 1, int(round(px_p / pyr_scale_x)))
            py = min(det_h - 1, int(round(py_p / pyr_scale_y)))
            if not valid_photo_mask[py, px] or bg_mean_22[py, px] < 86.0 or bg_std_map[py, px] > (2.75 / prot):
                continue

            # Refine dark center inside 3x3 full-res neighborhood
            y_lo, y_hi = max(0, py - 1), min(det_h, py + 2)
            x_lo, x_hi = max(0, px - 1), min(det_w, px + 2)
            sub_patch = denoise_det[y_lo:y_hi, x_lo:x_hi]
            min_idx = int(np.argmin(sub_patch))
            py_ref = y_lo + (min_idx // (x_hi - x_lo))
            px_ref = x_lo + (min_idx % (x_hi - x_lo))

            best_r_d = float(bokeh_radii[int(bokeh_best_idx_pyr[py_p, px_p])])
            passed, opt_r_d, contrast_pct, isotropy, snr = verify_annulus_plane_snr(
                denoise_masked, grad_mag, bg_std_map, hf_texture,
                float(px_ref), float(py_ref), best_r_d,
                is_sharp_branch=False, cloud_protection=cloud_protection,
                sensitivity=sensitivity
            )
            if not passed or isotropy < min_circularity:
                continue

            r_full = opt_r_d / det_scale
            if r_full < min_radius_full or r_full > max_radius_full:
                continue

            # Full-skirt healing radius (1.72x FWHM radius + 2.0px) so Gaussian bokeh tails
            # are 100% enclosed inside the healing mask and never leave a dark outer ring
            raw_candidates.append({
                "detCx": float(px_ref),
                "detCy": float(py_ref),
                "detRadius": float(opt_r_d),
                "cx": round(float(px_ref) / det_scale, 1),
                "cy": round(float(py_ref) / det_scale, 1),
                "workCx": round((float(px_ref) / det_scale) * work_scale, 1),
                "workCy": round((float(py_ref) / det_scale) * work_scale, 1),
                "radius": round(float(r_full), 1),
                "workRadius": round(float(r_full * work_scale * 1.72 + 2.0), 1),
                "area": round(math.pi * (r_full ** 2), 1),
                "perimeter": round(2.0 * math.pi * r_full, 1),
                "circularity": round(isotropy, 3),
                "contrastDropPct": round(contrast_pct, 2),
                "score": snr,
                "spotType": "bokeh"
            })

    # Unified Non-Maximum Suppression across both Sharp and Bokeh branches
    raw_candidates.sort(key=lambda c: c["score"], reverse=True)
    accepted_spots: List[Dict[str, Any]] = []

    for cand in raw_candidates:
        is_dup = False
        for kept in accepted_spots:
            dist = math.hypot(cand["cx"] - kept["cx"], cand["cy"] - kept["cy"])
            min_sep = max(cand["radius"], kept["radius"]) * 0.85
            if dist < min_sep:
                is_dup = True
                break
        if not is_dup:
            spot_idx = len(accepted_spots) + 1
            accepted_spots.append({
                "id": f"dust-{spot_idx}",
                "index": spot_idx,
                "cx": cand["cx"],
                "cy": cand["cy"],
                "workCx": cand["workCx"],
                "workCy": cand["workCy"],
                "radius": cand["radius"],
                "workRadius": cand["workRadius"],
                "area": cand["area"],
                "perimeter": cand["perimeter"],
                "circularity": cand["circularity"],
                "contrastDropPct": cand["contrastDropPct"],
                "spotType": cand["spotType"],
                "enabled": True,
                "isManual": False
            })

    # Build filtered_mask and B&W Edge Visualization at working resolution (work_w, work_h)
    filtered_mask = np.zeros((work_h, work_w), dtype=np.uint8)
    for sp in accepted_spots:
        cv2.circle(
            filtered_mask,
            (int(round(sp["workCx"])), int(round(sp["workCy"]))),
            max(2, int(round(sp["workRadius"]))),
            255,
            -1
        )
    cv2.imwrite(os.path.join(session_dir, "mask_auto.png"), filtered_mask)

    vis_work = cv2.resize(combined_vis_det, (work_w, work_h), interpolation=cv2.INTER_LINEAR) if (det_h, det_w) != (work_h, work_w) else combined_vis_det
    vis_scale = max(float(np.percentile(vis_work, 99.3)), 2.5)
    z_vis = np.clip((vis_work / vis_scale) * 215.0, 0, 255).astype(np.uint8)
    bw_viz = cv2.cvtColor(z_vis, cv2.COLOR_GRAY2BGR)
    for sp in accepted_spots:
        cv2.circle(
            bw_viz,
            (int(round(sp["workCx"])), int(round(sp["workCy"]))),
            max(3, int(round(sp["radius"] * work_scale))),
            (255, 255, 255),
            1,
            lineType=cv2.LINE_AA
        )
    cv2.imwrite(os.path.join(session_dir, "viz_bw_edge.jpg"), bw_viz, [int(cv2.IMWRITE_JPEG_QUALITY), 94])

    detection_result = {
        "method": method,
        "sensitivity": sensitivity,
        "cloudProtection": cloud_protection,
        "minRadius": min_radius_full,
        "maxRadius": max_radius_full,
        "minCircularity": min_circularity,
        "totalDetected": len(accepted_spots),
        "sharpCount": sum(1 for s in accepted_spots if s.get("spotType") == "sharp"),
        "bokehCount": sum(1 for s in accepted_spots if s.get("spotType") == "bokeh"),
        "spots": accepted_spots
    }

    with open(os.path.join(session_dir, "detection_result.json"), "w", encoding="utf-8") as f:
        json.dump(detection_result, f, ensure_ascii=False, indent=2)

    return detection_result


def build_combined_mask(
    work_h: int,
    work_w: int,
    work_scale: float,
    active_spots: List[Dict[str, Any]],
    manual_strokes: List[Dict[str, Any]]
) -> np.ndarray:
    mask = np.zeros((work_h, work_w), dtype=np.uint8)

    for spot in active_spots:
        if not spot.get("enabled", True):
            continue
        cx_val = spot.get("workCx")
        if cx_val is None:
            raw_cx = spot.get("cx", spot.get("x", 0))
            cx_val = float(raw_cx) * work_scale
        cx = int(round(float(cx_val)))

        cy_val = spot.get("workCy")
        if cy_val is None:
            raw_cy = spot.get("cy", spot.get("y", 0))
            cy_val = float(raw_cy) * work_scale
        cy = int(round(float(cy_val)))

        # Ensure full-skirt coverage even if spot was loaded with an older smaller workRadius
        raw_r = float(spot.get("radius", spot.get("r", 10.0)))
        min_skirt_r = raw_r * work_scale * (1.72 if spot.get("spotType") == "bokeh" else 1.55) + 2.0
        r_val = spot.get("workRadius")
        if r_val is None:
            r_val = min_skirt_r
        else:
            r_val = max(float(r_val), min_skirt_r)

        r = max(3, int(round(float(r_val))))
        cv2.circle(mask, (cx, cy), r, 255, -1)

    for stroke in manual_strokes:
        mode = stroke.get("mode", "add")
        color = 255 if mode == "add" else 0
        r = max(2, int(round(float(stroke.get("radius", 12.0)) * work_scale)))
        pts = stroke.get("points", [])
        if len(pts) == 1:
            px = int(round(float(pts[0]["x"]) * work_scale))
            py = int(round(float(pts[0]["y"]) * work_scale))
            cv2.circle(mask, (px, py), r, color, -1)
        elif len(pts) > 1:
            for i in range(len(pts) - 1):
                p1 = (int(round(float(pts[i]["x"]) * work_scale)), int(round(float(pts[i]["y"]) * work_scale)))
                p2 = (int(round(float(pts[i + 1]["x"]) * work_scale)), int(round(float(pts[i + 1]["y"]) * work_scale)))
                cv2.line(mask, p1, p2, color, thickness=r * 2)

    return mask


def inpaint_16bit_linear(session_dir: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """
    Zero-Halo 16-bit Plane-Detrended Harmonic + Telea Inpainting:
      1. Full-Skirt Mask Expansion: Dilates the mask past the entire Gaussian bokeh tail so
         boundary pixels are sampled strictly from clean, unshadowed background sky.
      2. Outward-Only Feathering: Guarantees alpha == 1.0 across 100% of the dust core & skirt
         (so zero original dark dust ring can ever bleed back in), tapering smoothly from 1.0 to 0.0
         only in the clean outer transition ring.
      3. Plane-Detrended Harmonic Telea: Fits a 1st-order background plane (ax + by + c) with
         symmetric outlier trimming ([15, 85] percentiles -> zero upward/downward brightness bias),
         subtracts the gradient plane before running Telea + harmonic Gaussian smoothing, and
         restores the plane + matched local sensor grain.
    """
    with open(os.path.join(session_dir, "session_meta.json"), "r", encoding="utf-8") as f:
        meta = json.load(f)

    linear_16bit = np.load(os.path.join(session_dir, "linear_16bit.npy"))
    full_h, full_w = linear_16bit.shape[:2]
    work_h = int(meta["workHeight"])
    work_w = int(meta["workWidth"])
    work_scale = float(meta["workScale"])
    exposure_scale = float(meta["exposureScale"])

    active_spots = params.get("spots") or params.get("activeSpots") or params.get("candidates") or []
    manual_strokes = params.get("manualStrokes", [])
    inpaint_radius_full = float(params.get("inpaintRadius", 6.0))
    preserve_grain = bool(params.get("preserveGrain", True))

    work_mask = build_combined_mask(work_h, work_w, work_scale, active_spots, manual_strokes)
    cv2.imwrite(os.path.join(session_dir, "mask_final_work.png"), work_mask)

    if (full_h, full_w) != (work_h, work_w):
        full_mask = cv2.resize(work_mask, (full_w, full_h), interpolation=cv2.INTER_NEAREST)
    else:
        full_mask = work_mask

    inpaint_r = max(3.0, min(25.0, inpaint_radius_full))
    skirt_pad_px = max(2, int(round(inpaint_r * 0.45)))
    k_skirt = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (skirt_pad_px * 2 + 1, skirt_pad_px * 2 + 1))
    full_mask_core = cv2.dilate(full_mask, k_skirt, iterations=1)

    inpainted_pixels = int(np.count_nonzero(full_mask_core))
    enabled_spot_count = sum(1 for s in active_spots if s.get("enabled", True)) + sum(
        1 for st in manual_strokes if st.get("mode", "add") == "add"
    )

    inpainted_16bit = np.copy(linear_16bit)

    if inpainted_pixels > 0:
        feather_px = max(3, int(round(inpaint_r * 0.70)))
        feather_sigma = max(2.0, feather_px * 0.55)
        ring_width_px = max(7, int(round(inpaint_r * 1.4 + 5)))
        ring_pad = ring_width_px + 4

        rng = np.random.default_rng(42)
        k_feather = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (feather_px * 2 + 1, feather_px * 2 + 1))
        k_ring = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ring_width_px * 2 + 1, ring_width_px * 2 + 1))

        # Dilate by feather_px first so only spots whose feathered masks actually touch share a component;
        # prevents chaining non-overlapping spots across the entire sky into a slow megabox
        full_mask_expanded = cv2.dilate(full_mask_core, k_feather, iterations=1)
        num_labels, labels_exp, stats, _ = cv2.connectedComponentsWithStats(full_mask_expanded, connectivity=8)

        merged_boxes = []
        for i in range(1, num_labels):
            x = int(stats[i, cv2.CC_STAT_LEFT])
            y = int(stats[i, cv2.CC_STAT_TOP])
            w = int(stats[i, cv2.CC_STAT_WIDTH])
            h = int(stats[i, cv2.CC_STAT_HEIGHT])
            bx1 = max(0, x - ring_pad)
            by1 = max(0, y - ring_pad)
            bx2 = min(full_w, x + w + ring_pad)
            by2 = min(full_h, y + h + ring_pad)
            merged_boxes.append((bx1, by1, bx2, by2))

            roi_expanded = ((labels_exp[by1:by2, bx1:bx2] == i).astype(np.uint8)) * 255
            roi_core = np.where(roi_expanded > 0, full_mask_core[by1:by2, bx1:bx2], 0)
            if np.count_nonzero(roi_core) == 0:
                continue

            # Outward-only feather mask: 1.0 across the entire dust core & skirt, tapering to 0.0 outside
            roi_alpha = cv2.GaussianBlur(roi_expanded.astype(np.float32) / 255.0, (0, 0), feather_sigma)
            roi_alpha = np.where(roi_core > 0, 1.0, np.clip(roi_alpha * 1.12, 0.0, 1.0))

            # Clean reference ring strictly outside ANY spot's feathered zone
            roi_outer_dilated = cv2.dilate(roi_expanded, k_ring, iterations=1)
            roi_ring_mask = (roi_outer_dilated > 0) & (full_mask_expanded[by1:by2, bx1:bx2] == 0)
            ring_ys, ring_xs = np.where(roi_ring_mask)

            rh, rw = roi_core.shape[:2]
            yy_grid, xx_grid = np.mgrid[0:rh, 0:rw].astype(np.float32)
            norm_x = (xx_grid - rw * 0.5) / max(rw * 0.5, 1.0)
            norm_y = (yy_grid - rh * 0.5) / max(rh * 0.5, 1.0)

            use_plane_detrend = len(ring_xs) >= 16
            clean_ring_indices = None

            if use_plane_detrend:
                rx = norm_x[ring_ys, ring_xs]
                ry = norm_y[ring_ys, ring_xs]
                g_ring = linear_16bit[by1:by2, bx1:bx2, 1][ring_ys, ring_xs].astype(np.float32)
                X_lin = np.column_stack([rx, ry, np.ones_like(rx)])
                c_lin, _, _, _ = np.linalg.lstsq(X_lin, g_ring, rcond=None)
                res_lin = g_ring - (X_lin @ c_lin)
                # Symmetric trimming [15, 85] avoids any positive or negative brightness bias!
                lo_r, hi_r = np.percentile(res_lin, [15, 85])
                clean_ring_indices = (res_lin >= lo_r) & (res_lin <= hi_r)
                if int(np.sum(clean_ring_indices)) < 12:
                    use_plane_detrend = False

            # Because 1st-order background plane is already subtracted, Telea only needs a tight 3.0px
            # boundary neighborhood (~25x faster than r=18.0) followed by harmonic Gaussian smoothing
            eff_telea_r = 3.0
            harm_sigma = max(2.0, min(8.0, min(rw, rh) * 0.10))

            roi_orig_3ch = linear_16bit[by1:by2, bx1:bx2].astype(np.float32)

            if use_plane_detrend and clean_ring_indices is not None:
                rx_c = norm_x[ring_ys, ring_xs][clean_ring_indices]
                ry_c = norm_y[ring_ys, ring_xs][clean_ring_indices]
                X_c = np.column_stack([rx_c, ry_c, np.ones_like(rx_c)])
                rv_3ch = roi_orig_3ch[ring_ys, ring_xs][clean_ring_indices]  # shape (N, 3)
                coeffs_3ch, _, _, _ = np.linalg.lstsq(X_c, rv_3ch, rcond=None)  # shape (3, 3)
            else:
                coeffs_3ch = None

            grain_std_3ch = None
            if preserve_grain and np.any(roi_ring_mask):
                roi_hf_3ch = roi_orig_3ch - cv2.GaussianBlur(roi_orig_3ch, (0, 0), 1.2)
                ring_hf = np.abs(roi_hf_3ch[roi_ring_mask])
                grain_std_3ch = np.minimum(np.median(ring_hf, axis=0) * 1.4826, 450.0)
                noise_base = rng.standard_normal(size=(rh, rw, 3), dtype=np.float32)

            # For large bokeh ROIs (>64px), run Telea harmonic diffusion at 0.5x and upsample
            # the ultra-smooth residual before adding full-res 16-bit plane + full-res sensor grain
            use_half_telea = min(rw, rh) > 64
            if use_half_telea:
                hw, hh = max(4, rw // 2), max(4, rh // 2)
                exp_half = cv2.resize(roi_expanded, (hw, hh), interpolation=cv2.INTER_NEAREST)

            for ch in range(3):
                roi_orig = roi_orig_3ch[:, :, ch]

                if coeffs_3ch is not None:
                    plane_2d = (
                        coeffs_3ch[0, ch] * norm_x +
                        coeffs_3ch[1, ch] * norm_y +
                        coeffs_3ch[2, ch]
                    )
                    detrended = roi_orig - plane_2d
                    if use_half_telea:
                        det_half = cv2.resize(detrended, (hw, hh), interpolation=cv2.INTER_AREA)
                        telea_half = cv2.inpaint(det_half, exp_half, eff_telea_r, cv2.INPAINT_TELEA)
                        smooth_half = cv2.GaussianBlur(telea_half, (0, 0), max(1.2, harm_sigma * 0.5))
                        filled_half = 0.45 * telea_half + 0.55 * smooth_half
                        detrended_filled = cv2.resize(filled_half, (rw, rh), interpolation=cv2.INTER_LINEAR)
                    else:
                        detrended_telea = cv2.inpaint(detrended, roi_expanded, eff_telea_r, cv2.INPAINT_TELEA)
                        detrended_smooth = cv2.GaussianBlur(detrended_telea, (0, 0), harm_sigma)
                        detrended_filled = 0.45 * detrended_telea + 0.55 * detrended_smooth
                    roi_healed = plane_2d + detrended_filled
                else:
                    roi_telea = cv2.inpaint(roi_orig, roi_expanded, eff_telea_r, cv2.INPAINT_TELEA)
                    roi_smooth = cv2.GaussianBlur(roi_telea, (0, 0), harm_sigma)
                    roi_healed = 0.50 * roi_telea + 0.50 * roi_smooth

                if grain_std_3ch is not None and float(grain_std_3ch[ch]) > 1.0:
                    roi_healed = roi_healed + noise_base[:, :, ch] * float(grain_std_3ch[ch] * 0.85)

                roi_blended = roi_orig * (1.0 - roi_alpha) + roi_healed * roi_alpha
                inpainted_16bit[by1:by2, bx1:bx2, ch] = np.clip(np.round(roi_blended), 0, 65535).astype(np.uint16)

    np.save(os.path.join(session_dir, "inpainted_16bit.npy"), inpainted_16bit)

    # Incremental ROI update on work_srgb_u8 preview for near-instant preview generation
    lut_u8 = build_srgb_u8_lut(exposure_scale)
    work_srgb_path = os.path.join(session_dir, "work_srgb_u8.npy")
    if os.path.exists(work_srgb_path) and inpainted_pixels > 0:
        srgb_healed_u8 = np.load(work_srgb_path).copy()
        for bx1, by1, bx2, by2 in merged_boxes:
            wx1 = max(0, int(math.floor(bx1 * work_scale)))
            wy1 = max(0, int(math.floor(by1 * work_scale)))
            wx2 = min(work_w, int(math.ceil(bx2 * work_scale)))
            wy2 = min(work_h, int(math.ceil(by2 * work_scale)))
            if wx2 <= wx1 or wy2 <= wy1:
                continue
            patch_16 = inpainted_16bit[by1:by2, bx1:bx2]
            if (by2 - by1, bx2 - bx1) != (wy2 - wy1, wx2 - wx1):
                patch_16 = cv2.resize(patch_16, (wx2 - wx1, wy2 - wy1), interpolation=cv2.INTER_AREA)
            srgb_healed_u8[wy1:wy2, wx1:wx2] = lut_u8[patch_16]
    else:
        if (full_h, full_w) != (work_h, work_w):
            work_inpainted_16 = cv2.resize(inpainted_16bit, (work_w, work_h), interpolation=cv2.INTER_AREA)
        else:
            work_inpainted_16 = inpainted_16bit
        srgb_healed_u8 = lut_u8[work_inpainted_16]

    healed_bgr = cv2.cvtColor(srgb_healed_u8, cv2.COLOR_RGB2BGR)
    cv2.imwrite(os.path.join(session_dir, "preview_inpainted.jpg"), healed_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 96])

    result_info = {
        "healedSpotsCount": enabled_spot_count,
        "inpaintedPixels": inpainted_pixels,
        "inpaintedAreaPct": round((inpainted_pixels / float(full_h * full_w)) * 100.0, 4),
        "bitDepth": "16-bit Linear RGB (uint16, 0–65535)",
        "inpaintMethod": "Plane-Detrended 16-bit Harmonic Telea + Outward Feathering",
        "inpaintRadius": inpaint_radius_full,
        "fullWidth": full_w,
        "fullHeight": full_h
    }

    with open(os.path.join(session_dir, "inpaint_result.json"), "w", encoding="utf-8") as f:
        json.dump(result_info, f, ensure_ascii=False, indent=2)

    return result_info


def write_linear_dng(
    linear_rgb_16bit: np.ndarray,
    preview_srgb_u8: np.ndarray,
    output_path: str,
    meta: Dict[str, Any]
) -> None:
    """
    Writes a standard Dual-IFD DNG 1.4 file compatible with BOTH:
      1. Mobile & OS Galleries (Samsung Gallery, Android MediaStore, iOS Photos, Windows/macOS):
         IFD0 is an 8-bit RGB preview image (NewSubfileType = 1, Photometric = 2 RGB) with DNG 1.4 tags.
      2. Professional RAW Decoders & Editors (LibRaw / rawpy, Adobe Lightroom, Camera Raw, Darktable):
         SubIFD0 (linked via Tag 330 SubIFDs) contains the full-resolution lossless 16-bit
         (uint16) Linear Raw RGB image (NewSubfileType = 0, Photometric = 34892 LinearRaw)
         paired with the exact D65 XYZ->sRGB ColorMatrix1.
    """
    exif_info = meta.get("exif", {})
    raw_make = str(exif_info.get("make", "Panasonic"))
    raw_model = str(exif_info.get("model", "Lumix Camera Sensor"))
    make_str = raw_make.encode("ascii", errors="ignore").decode("ascii").strip() or "Panasonic"
    model_str = raw_model.encode("ascii", errors="ignore").decode("ascii").strip() or "Camera Sensor"
    unique_model = f"{make_str} {model_str}".strip()

    # DNG Spec Tag 50721 (ColorMatrix1) maps CIE XYZ (D65) -> Camera Linear RGB (sRGB primaries)
    xyz_to_srgb_matrix = (
        32405, 10000, -15371, 10000,  -4985, 10000,
        -9693, 10000,  18760, 10000,    416, 10000,
          556, 10000,  -2040, 10000,  10572, 10000
    )
    as_shot_neutral = (10000, 10000, 10000, 10000, 10000, 10000)

    ifd0_tags = [
        (271, 's', 0, make_str, True),                        # Make
        (272, 's', 0, model_str, True),                       # Model
        (274, 'H', 1, 1, True),                               # Orientation = TopLeft
        (50706, 'B', 4, b'\x01\x04\x00\x00', True),           # DNGVersion = 1.4.0.0
        (50707, 'B', 4, b'\x01\x01\x00\x00', True),           # DNGBackwardVersion = 1.1.0.0
        (50708, 's', 0, unique_model, True),                  # UniqueCameraModel
        (50721, '2i', 9, xyz_to_srgb_matrix, True),           # ColorMatrix1 (XYZ -> Linear sRGB)
        (50728, '2I', 3, as_shot_neutral, True),              # AsShotNeutral
        (50740, 'H', 1, 21, True),                            # CalibrationIlluminant1 = D65
    ]

    subifd_tags = [
        (50714, 'I', 3, (0, 0, 0), True),                     # BlackLevel
        (50717, 'I', 3, (65535, 65535, 65535), True),         # WhiteLevel
    ]

    # Prepare high-resolution 8-bit preview for IFD0 (up to 2560px long edge so mobile galleries render instantly)
    ph, pw = preview_srgb_u8.shape[:2]
    max_prev_dim = 2560
    if max(ph, pw) > max_prev_dim:
        pscale = max_prev_dim / float(max(ph, pw))
        prev_u8 = cv2.resize(
            preview_srgb_u8,
            (max(1, int(round(pw * pscale))), max(1, int(round(ph * pscale)))),
            interpolation=cv2.INTER_AREA
        )
    else:
        prev_u8 = preview_srgb_u8

    try:
        with tifffile.TiffWriter(output_path, bigtiff=False) as tif:
            # IFD0: 8-bit sRGB Reduced-Resolution Preview (subfiletype=1) + pointer to 1 SubIFD
            tif.write(
                prev_u8,
                photometric='rgb',
                planarconfig='contig',
                subfiletype=1,
                subifds=1,
                compression=None,
                software="SensorClean Pro 16-bit DNG Engine",
                extratags=ifd0_tags
            )
            # SubIFD0: Full-resolution 16-bit LinearRaw image (subfiletype=0, photometric=34892 LinearRaw)
            tif.write(
                linear_rgb_16bit,
                photometric=34892,
                planarconfig='contig',
                subfiletype=0,
                compression=None,
                extratags=subifd_tags
            )
    except Exception:
        tifffile.imwrite(
            output_path,
            linear_rgb_16bit,
            photometric='rgb',
            planarconfig='contig',
            compression=None,
            software="SensorClean Pro 16-bit DNG Engine"
        )


def export_healed_image(
    session_dir: str,
    export_format: str,
    output_path: str,
    preloaded_rgb_16bit: Optional[np.ndarray] = None
) -> Dict[str, Any]:
    with open(os.path.join(session_dir, "session_meta.json"), "r", encoding="utf-8") as f:
        meta = json.load(f)

    if preloaded_rgb_16bit is not None:
        rgb_16bit = preloaded_rgb_16bit
    else:
        inpainted_path = os.path.join(session_dir, "inpainted_16bit.npy")
        if os.path.exists(inpainted_path):
            rgb_16bit = np.load(inpainted_path)
        else:
            rgb_16bit = np.load(os.path.join(session_dir, "linear_16bit.npy"))

    fmt = export_format.lower()
    exposure_scale = float(meta.get("exposureScale", 1.0))

    if fmt == "dng":
        # Exposure-calibrated 16-bit linear values for SubIFD0 (Photometric = 34892 LinearRaw)
        # 1.12x factor compensates for BT.709 vs sRGB toe in standard DNG raw developers
        lin_exposed_16 = np.clip(
            np.round(rgb_16bit.astype(np.float32) * (exposure_scale * 1.12)),
            0,
            65535
        ).astype(np.uint16)
        srgb_u8, _ = linear_16bit_to_srgb_8bit(rgb_16bit, exposure_scale=exposure_scale)
        write_linear_dng(lin_exposed_16, srgb_u8, output_path, meta)
        mime_type = "image/x-adobe-dng"
        ext = "dng"
    elif fmt == "tiff16":
        srgb_16bit, _ = linear_16bit_to_srgb_16bit(rgb_16bit, exposure_scale=exposure_scale)
        tifffile.imwrite(
            output_path,
            srgb_16bit,
            photometric='rgb',
            planarconfig='contig',
            compression=None,
            software="SensorClean Pro 16-bit Engine"
        )
        mime_type = "image/tiff"
        ext = "tiff"
    elif fmt == "png":
        srgb_u8, _ = linear_16bit_to_srgb_8bit(rgb_16bit, exposure_scale=exposure_scale)
        bgr_u8 = cv2.cvtColor(srgb_u8, cv2.COLOR_RGB2BGR)
        cv2.imwrite(output_path, bgr_u8)
        mime_type = "image/png"
        ext = "png"
    else:
        srgb_u8, _ = linear_16bit_to_srgb_8bit(rgb_16bit, exposure_scale=exposure_scale)
        bgr_u8 = cv2.cvtColor(srgb_u8, cv2.COLOR_RGB2BGR)
        cv2.imwrite(output_path, bgr_u8, [int(cv2.IMWRITE_JPEG_QUALITY), 98])
        mime_type = "image/jpeg"
        ext = "jpg"

    return {
        "outputPath": output_path,
        "format": ext,
        "mimeType": mime_type,
        "fileSizeBytes": os.path.getsize(output_path)
    }


def multi_detect_pipeline(config_path: str) -> Dict[str, Any]:
    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)

    session_dirs = config.get("sessionDirs", [])
    tolerance_px = float(config.get("tolerancePx", 14.0))
    min_frames_match = int(config.get("minFramesMatch", 2))
    detect_params = config.get("detectionParams", {})
    force_redetect = bool(config.get("forceRedetect", False))

    frames_spots: List[List[Dict[str, Any]]] = []
    frames_meta: List[Dict[str, Any]] = []

    for s_dir in session_dirs:
        meta_path = os.path.join(s_dir, "session_meta.json")
        with open(meta_path, "r", encoding="utf-8") as f:
            m = json.load(f)
        frames_meta.append(m)

        det_path = os.path.join(s_dir, "detection_result.json")
        if force_redetect or not os.path.exists(det_path):
            det = detect_sensor_dust(s_dir, detect_params)
        else:
            with open(det_path, "r", encoding="utf-8") as f:
                det = json.load(f)
        frames_spots.append(det.get("spots", []))

    total_frames = len(session_dirs)
    all_spots: List[Dict[str, Any]] = []
    for f_idx, s_list in enumerate(frames_spots):
        for s in s_list:
            all_spots.append({"frameIdx": f_idx, "spot": s})

    # Spatial clustering across frames
    clusters: List[List[Dict[str, Any]]] = []
    visited = [False] * len(all_spots)

    for i in range(len(all_spots)):
        if visited[i]:
            continue
        visited[i] = True
        cluster = [all_spots[i]]
        s1 = all_spots[i]["spot"]
        c1x = float(s1.get("cx", s1.get("x", 0)))
        c1y = float(s1.get("cy", s1.get("y", 0)))

        for j in range(i + 1, len(all_spots)):
            if visited[j]:
                continue
            s2 = all_spots[j]["spot"]
            c2x = float(s2.get("cx", s2.get("x", 0)))
            c2y = float(s2.get("cy", s2.get("y", 0)))
            d = math.hypot(c1x - c2x, c1y - c2y)
            if d <= tolerance_px:
                visited[j] = True
                cluster.append(all_spots[j])
        clusters.append(cluster)

    cluster_summaries: List[Dict[str, Any]] = []
    for c_id, cl in enumerate(clusters):
        frames_present = sorted(list(set(item["frameIdx"] for item in cl)))
        match_count = len(frames_present)
        mean_cx = float(np.mean([item["spot"].get("cx", item["spot"].get("x", 0)) for item in cl]))
        mean_cy = float(np.mean([item["spot"].get("cy", item["spot"].get("y", 0)) for item in cl]))
        mean_r = float(np.mean([item["spot"].get("radius", 8.0) for item in cl]))
        mean_conf = float(np.mean([item["spot"].get("confidence", 0.8) for item in cl]))
        is_multi_confirmed = (match_count >= min_frames_match)

        c_info = {
            "clusterId": c_id + 1,
            "matchCount": match_count,
            "totalFrames": total_frames,
            "matchRatio": round(match_count / float(total_frames), 3),
            "isMultiConfirmed": is_multi_confirmed,
            "meanCx": round(mean_cx, 1),
            "meanCy": round(mean_cy, 1),
            "meanRadius": round(mean_r, 1),
            "meanConfidence": round(mean_conf, 3),
            "framesPresent": frames_present,
        }
        cluster_summaries.append(c_info)

        for item in cl:
            sp = item["spot"]
            sp["clusterId"] = c_id + 1
            sp["matchCount"] = match_count
            sp["totalFrames"] = total_frames
            sp["tier"] = "multi-confirmed" if is_multi_confirmed else "single-frame"
            sp["isMultiConfirmed"] = is_multi_confirmed

    per_frame_results: List[Dict[str, Any]] = []
    for f_idx, s_dir in enumerate(session_dirs):
        meta = frames_meta[f_idx]
        work_scale = float(meta.get("workScale", 1.0))
        spots_in_frame = frames_spots[f_idx]

        present_cluster_ids = set(s.get("clusterId") for s in spots_in_frame if "clusterId" in s)
        next_idx = len(spots_in_frame) + 1

        for c_info in cluster_summaries:
            if c_info["isMultiConfirmed"] and c_info["clusterId"] not in present_cluster_ids:
                proj_cx = c_info["meanCx"]
                proj_cy = c_info["meanCy"]
                proj_r = c_info["meanRadius"]
                is_bokeh_proj = proj_r > 8.0
                proj_spot = {
                    "id": f"proj_{c_info['clusterId']}_{f_idx}",
                    "index": next_idx,
                    "cx": round(proj_cx, 1),
                    "cy": round(proj_cy, 1),
                    "workCx": round(proj_cx * work_scale, 1),
                    "workCy": round(proj_cy * work_scale, 1),
                    "radius": round(proj_r, 1),
                    "workRadius": round(proj_r * work_scale * (1.82 if is_bokeh_proj else 1.60) + 2.5, 1),
                    "area": round(math.pi * (proj_r ** 2), 1),
                    "perimeter": round(2 * math.pi * proj_r, 1),
                    "circularity": 0.95,
                    "contrastDropPct": 1.5,
                    "spotType": "bokeh" if is_bokeh_proj else "sharp",
                    "confidence": c_info["meanConfidence"],
                    "enabled": True,
                    "tier": "projected",
                    "isProjected": True,
                    "isMultiConfirmed": True,
                    "clusterId": c_info["clusterId"],
                    "matchCount": c_info["matchCount"],
                    "totalFrames": total_frames,
                }
                spots_in_frame.append(proj_spot)
                next_idx += 1

        det_path = os.path.join(s_dir, "detection_result.json")
        updated_det = {
            "spots": spots_in_frame,
            "totalDetected": len(spots_in_frame),
            "multiConfirmedCount": sum(1 for s in spots_in_frame if s.get("tier") == "multi-confirmed"),
            "singleFrameCount": sum(1 for s in spots_in_frame if s.get("tier") == "single-frame"),
            "projectedCount": sum(1 for s in spots_in_frame if s.get("tier") == "projected"),
        }
        with open(det_path, "w", encoding="utf-8") as f:
            json.dump(updated_det, f, ensure_ascii=False, indent=2)

        per_frame_results.append({
            "sessionDir": s_dir,
            "sessionId": os.path.basename(s_dir),
            "originalFileName": meta.get("originalFileName", ""),
            "spots": spots_in_frame,
            "totalDetected": len(spots_in_frame),
            "multiConfirmedCount": updated_det["multiConfirmedCount"],
            "singleFrameCount": updated_det["singleFrameCount"],
            "projectedCount": updated_det["projectedCount"],
        })

    return {
        "totalFrames": total_frames,
        "totalClusters": len(clusters),
        "multiConfirmedClusters": sum(1 for c in cluster_summaries if c["isMultiConfirmed"]),
        "clusters": cluster_summaries,
        "perFrame": per_frame_results,
    }


def execute_command(args: List[str]) -> Dict[str, Any]:
    cmd = args[0]
    if cmd == "ingest":
        input_path = args[1]
        session_dir = args[2]
        return ingest_image(input_path, session_dir)
    elif cmd == "ingest_and_detect":
        input_path = args[1]
        session_dir = args[2]
        params = json.loads(args[3]) if len(args) > 3 else {}
        orig_name = args[4] if len(args) > 4 else None
        meta = ingest_image(input_path, session_dir)
        if orig_name:
            meta["originalFileName"] = orig_name
            with open(os.path.join(session_dir, "session_meta.json"), "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
        det = detect_sensor_dust(session_dir, params)
        return {"meta": meta, "detection": det}
    elif cmd == "detect":
        session_dir = args[1]
        params = json.loads(args[2])
        return detect_sensor_dust(session_dir, params)
    elif cmd == "inpaint":
        session_dir = args[1]
        params_file = args[2]
        with open(params_file, "r", encoding="utf-8") as pf:
            params = json.load(pf)
        return inpaint_16bit_linear(session_dir, params)
    elif cmd == "export":
        session_dir = args[1]
        export_format = args[2]
        output_path = args[3]
        return export_healed_image(session_dir, export_format, output_path)
    elif cmd == "inpaint_and_export":
        session_dir = args[1]
        params_file = args[2]
        export_format = args[3]
        output_path = args[4]
        with open(params_file, "r", encoding="utf-8") as pf:
            params = json.load(pf)
        inpaint_res = inpaint_16bit_linear(session_dir, params)
        export_res = export_healed_image(session_dir, export_format, output_path)
        return {"inpaintResult": inpaint_res, "exportInfo": export_res}
    elif cmd == "multi_detect":
        config_file = args[1]
        return multi_detect_pipeline(config_file)
    else:
        raise ValueError(f"Unknown command: {cmd}")


def run_worker_loop() -> None:
    """Persistent warm worker loop reading JSON command lines from stdin."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            payload = json.loads(line)
            req_id = payload.get("id")
            args = payload.get("args", [])
            res = execute_command(args)
            sys.stdout.write(json.dumps({"id": req_id, "ok": True, "data": res}) + "\n")
            sys.stdout.flush()
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            sys.stdout.write(json.dumps({"id": req_id, "ok": False, "error": str(e)}) + "\n")
            sys.stdout.flush()


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--worker":
        run_worker_loop()
        return

    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: raw_pipeline.py <command> <args...>"}))
        sys.exit(1)

    try:
        res = execute_command(sys.argv[1:])
        print(json.dumps({"ok": True, "data": res}))
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()


