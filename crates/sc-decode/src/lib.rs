//! SensorClean RAW and ordinary image decoder + CFA DNG roundtrip writer (`sc-decode`).
//!
//! - Uses pure-Rust `lightcraft-raw` for CFA RAW decoding and lossless LJ92 / uncompressed CFA DNG writing.
//! - Wraps all untrusted file parsing in `std::panic::catch_unwind` so a corrupt file can never crash a worker.
//! - Enforces Phase 0 safety invariants:
//!   1. Never mistakes a 1-channel Bayer mosaic TIFF for a grayscale image (`test_single_channel_mosaic_is_rejected`).
//!   2. Flags 8-bit fallback previews inside RAW extensions as `DecodeKind::EmbeddedPreview` so fake DNG exports are blocked.

#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unimplemented,
    clippy::todo,
    clippy::unreachable
)]

use image::{DynamicImage, GenericImageView};
use lightcraft_color::{D65, REC2020, SRGB, bradford};
use lightcraft_raw::{
    DngCompression, DngWriteOptions, Method, RawData, RawImage,
    color::{as_shot_white_xy, camera_to_rec2020, wb_multipliers},
    embedded_preview, write_dng,
};
use rayon::prelude::*;
use sc_color::{
    build_srgb8_to_linear16_lut, compute_det_gray_from_16bit, compute_det_gray_from_srgb8,
    linear_16bit_to_srgb_8bit, percentile_f32,
};
use sc_core::{
    CfaPattern, CropRect, DecodeKind, ExifMetadata, Geometry, Orientation, Result, ScError,
    SessionMetadata, Stats16Bit,
};
use sc_imgproc::resize_inter_area_u16_rgb;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;

pub const RAW_EXTENSIONS: &[&str] = &[
    "rw2", "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "orf", "pef", "raf", "srw", "3fr",
    "iiq", "rwl", "erf", "kdc", "dcr", "mos", "mrw", "fff",
];

pub fn is_raw_extension(ext_lower: &str) -> bool {
    let clean = ext_lower.trim_start_matches('.');
    RAW_EXTENSIONS.contains(&clean)
}

/// Decodes a RAW file into a `lightcraft_raw::RawImage` inside a `catch_unwind` isolation boundary.
pub fn decode_raw_isolated(bytes: &[u8]) -> Result<RawImage> {
    let res = catch_unwind(AssertUnwindSafe(|| lightcraft_raw::decode(bytes)));
    match res {
        Ok(Ok(raw)) => Ok(raw),
        Ok(Err(e)) => Err(ScError::CorruptInput(format!(
            "RAW 파일을 디코딩할 수 없습니다: {e}"
        ))),
        Err(_) => Err(ScError::DecoderPanic(
            "손상된 RAW 데이터를 처리하는 중 디코더 예외가 격리되었습니다.".into(),
        )),
    }
}

/// Writes a `RawImage` (with potentially healed CFA `u16` samples) to a CFA DNG (Lossless JPEG 256×256 tiles or uncompressed).
pub fn write_cfa_dng_isolated(raw: &RawImage, lossless_jpeg: bool) -> Result<Vec<u8>> {
    let compression = if lossless_jpeg {
        DngCompression::Lj92 { tile: 256 }
    } else {
        DngCompression::Uncompressed
    };
    let opts = DngWriteOptions {
        compression,
        ..Default::default()
    };
    let res = catch_unwind(AssertUnwindSafe(|| write_dng(raw, &opts)));
    match res {
        Ok(Ok(dng_bytes)) => Ok(dng_bytes),
        Ok(Err(e)) => Err(ScError::Pipeline(format!("CFA DNG 생성 실패: {e}"))),
        Err(_) => Err(ScError::DecoderPanic(
            "CFA DNG 인코딩 중 예외가 격리되었습니다.".into(),
        )),
    }
}

/// Returns mutable access to the underlying `u16` CFA/Linear buffer of a `RawImage`.
pub fn raw_pixels_u16_mut(raw: &mut RawImage) -> Result<&mut [u16]> {
    match &mut raw.data {
        RawData::U16(v) => Ok(v.as_mut_slice()),
        RawData::F32(_) => Err(ScError::UnsupportedFormat(
            "부동소수점 DNG는 u16 CFA 직접 수정 대상이 아닙니다.".into(),
        )),
    }
}

/// Returns shared access to the underlying `u16` CFA/Linear buffer of a `RawImage`.
pub fn raw_pixels_u16(raw: &RawImage) -> Result<&[u16]> {
    match &raw.data {
        RawData::U16(v) => Ok(v.as_slice()),
        RawData::F32(_) => Err(ScError::UnsupportedFormat(
            "부동소수점 DNG는 u16 CFA 버퍼가 아닙니다.".into(),
        )),
    }
}

/// Complete output of `ingest_bytes`: everything needed to initialize a SensorClean session.
pub struct IngestedSessionData {
    pub meta: SessionMetadata,
    pub geometry: Geometry,
    /// Optional preserved `RawImage` when the input was decoded as a true CFA/Linear RAW.
    pub raw_image: Option<RawImage>,
    /// Full-resolution 16-bit linear RGB (`full_w × full_h × 3`).
    pub linear_16bit: Vec<u16>,
    /// Working-resolution (`<= 2304px`) 16-bit linear RGB (`work_w × work_h × 3`).
    pub work_linear_16bit: Vec<u16>,
    /// Working-resolution (`<= 2304px`) 8-bit sRGB preview (`work_w × work_h × 3`).
    pub work_srgb_u8: Vec<u8>,
    /// Perceptual luminance (`work_w × work_h` `f32` in `0.0..=255.0`) for dust detection.
    pub det_gray: Vec<f32>,
}

fn convert_orientation(o: lightcraft_geom::Orientation) -> Orientation {
    Orientation::from_exif(o.to_exif())
}

fn orient_rgb_u16(src: &[u16], w: usize, h: usize, orient: Orientation) -> (Vec<u16>, usize, usize) {
    if orient == Orientation::Normal {
        return (src.to_vec(), w, h);
    }
    let (ow, oh) = orient.oriented_size(w, h);
    let mut dst = vec![0u16; ow * oh * 3];
    for sy in 0..h {
        for sx in 0..w {
            let p = orient.apply(sx as f64, sy as f64, w, h);
            let dx = (p.x.round() as isize).clamp(0, ow as isize - 1) as usize;
            let dy = (p.y.round() as isize).clamp(0, oh as isize - 1) as usize;
            let s_base = (sy * w + sx) * 3;
            let d_base = (dy * ow + dx) * 3;
            dst[d_base] = src[s_base];
            dst[d_base + 1] = src[s_base + 1];
            dst[d_base + 2] = src[s_base + 2];
        }
    }
    (dst, ow, oh)
}

fn extract_exif_from_raw(raw: &RawImage) -> ExifMetadata {
    let m = &raw.metadata;
    let exposure_time = m.exposure_time.map(|et| {
        if et > 0.0 && et < 1.0 {
            format!("1/{}s", (1.0 / et).round() as u32)
        } else {
            format!("{:.2}s", et)
        }
    });
    let focal_length = m.focal_length.map(|fl| format!("{:.1}mm", fl));
    let f_number = m.f_number.map(|fn_val| (fn_val * 10.0).round() / 10.0);
    let date_time = m.capture_time.as_ref().map(|dt| dt.to_exif());

    ExifMetadata {
        make: m.make.clone().unwrap_or_else(|| "Unknown".into()),
        model: m.model.clone().unwrap_or_else(|| "Camera Sensor".into()),
        iso: m.iso,
        f_number,
        exposure_time,
        focal_length,
        date_time,
        software: "SensorClean Pro 16-bit Pipeline".into(),
        raw_xmp_bytes: Vec::new(),
    }
}

fn extract_exif_from_bytes(bytes: &[u8]) -> ExifMetadata {
    let mut meta = ExifMetadata::default();
    if let Ok(m) = catch_unwind(AssertUnwindSafe(|| lightcraft_meta::extract(bytes))) {
        if let Some(make) = m.make.filter(|s| !s.is_empty()) {
            meta.make = make;
        }
        if let Some(model) = m.model.filter(|s| !s.is_empty()) {
            meta.model = model;
        }
        meta.iso = m.iso;
        meta.f_number = m.f_number.map(|v| (v * 10.0).round() / 10.0);
        meta.exposure_time = m.exposure_time.map(|et| {
            if et > 0.0 && et < 1.0 {
                format!("1/{}s", (1.0 / et).round() as u32)
            } else {
                format!("{:.2}s", et)
            }
        });
        meta.focal_length = m.focal_length.map(|fl| format!("{:.1}mm", fl));
        meta.date_time = m.capture_time.as_ref().map(|dt| dt.to_exif());
    }
    meta
}

/// Develops a `RawImage` into oriented 16-bit linear sRGB (`full_w × full_h × 3`) and estimates
/// thumbnail-calibrated `exposure_scale_override` when an embedded JPEG preview is present.
fn develop_raw_to_linear16_srgb(
    raw: &RawImage,
    raw_bytes: &[u8],
) -> Result<(Vec<u16>, usize, usize, Option<f64>)> {
    let cam_rgb = raw
        .develop(Method::Ahd)
        .map_err(|e| ScError::CorruptInput(format!("RAW 디모자이킹 실패: {e}")))?;

    let white_xy = as_shot_white_xy(raw);
    let (cam_to_rec2020, _) = camera_to_rec2020(raw, white_xy);
    let rec2020_to_xyz = REC2020.to_xyz();
    let srgb_from_xyz = SRGB.from_xyz();
    let rec2020_to_srgb = srgb_from_xyz
        .mul(&bradford(REC2020.white, D65))
        .mul(&rec2020_to_xyz);
    let cam_to_srgb = rec2020_to_srgb.mul(&cam_to_rec2020);
    let m = cam_to_srgb.0;

    let uw = cam_rgb.width;
    let uh = cam_rgb.height;
    let mut unoriented_16 = vec![0u16; uw * uh * 3];
    unoriented_16
        .par_chunks_mut(3)
        .zip(cam_rgb.data.par_iter())
        .for_each(|(out, px)| {
            let r = px[0] as f64;
            let g = px[1] as f64;
            let b = px[2] as f64;
            let sr = m[0][0] * r + m[0][1] * g + m[0][2] * b;
            let sg = m[1][0] * r + m[1][1] * g + m[1][2] * b;
            let sb = m[2][0] * r + m[2][1] * g + m[2][2] * b;
            out[0] = (sr.clamp(0.0, 1.0) * 65535.0).round() as u16;
            out[1] = (sg.clamp(0.0, 1.0) * 65535.0).round() as u16;
            out[2] = (sb.clamp(0.0, 1.0) * 65535.0).round() as u16;
        });

    let orient = convert_orientation(raw.orientation);
    let (linear_16bit, full_w, full_h) = orient_rgb_u16(&unoriented_16, uw, uh, orient);

    // Calibrate exposure_scale against the camera's embedded JPEG preview if present (`raw_pipeline.py:298-315`)
    let mut exposure_scale_override = None;
    if let Some(jpeg_bytes) = embedded_preview(raw_bytes)
        && let Ok(img) = image::load_from_memory(&jpeg_bytes)
    {
        let rgb8 = img.to_rgb8();
        let lut_lin = build_srgb8_to_linear16_lut();
        let mut thumb_lin: Vec<f32> = rgb8
            .as_raw()
            .iter()
            .step_by(3)
            .map(|&v| lut_lin[v as usize] as f32 / 65535.0)
            .collect();
        let mut lin_sub = Vec::with_capacity((full_h.div_ceil(4)) * (full_w.div_ceil(4)) * 3);
        for y in (0..full_h).step_by(4) {
            let row = &linear_16bit[y * full_w * 3..(y + 1) * full_w * 3];
            for x in (0..full_w).step_by(4) {
                let b = x * 3;
                lin_sub.push(row[b] as f32 / 65535.0);
                lin_sub.push(row[b + 1] as f32 / 65535.0);
                lin_sub.push(row[b + 2] as f32 / 65535.0);
            }
        }
        let lin_p85 = percentile_f32(&mut lin_sub, 85.0);
        let thumb_p85 = percentile_f32(&mut thumb_lin, 85.0);
        if lin_p85 > 1e-4 && thumb_p85 > 1e-4 {
            exposure_scale_override = Some((thumb_p85 / lin_p85).clamp(0.5, 16.0));
        }
    }

    Ok((linear_16bit, full_w, full_h, exposure_scale_override))
}

/// Fallback when a file with a RAW extension cannot be decoded as a supported RAW format:
/// - Rejects 1-channel TIFFs (Bayer mosaic must never be passed off as a grayscale image!).
/// - Accepts 8-bit 3-channel TIFFs only as `DecodeKind::EmbeddedPreview`.
/// - Accepts 16-bit 3-channel TIFFs as `DecodeKind::RawDeveloped`.
#[allow(clippy::type_complexity)]
fn decode_raw_tiff_fallback(
    bytes: &[u8],
    raw_err: &ScError,
) -> Result<(Vec<u16>, usize, usize, DecodeKind, Option<f64>)> {
    let tiff = lightcraft_tiff::Tiff::parse(bytes)
        .map_err(|_| ScError::CorruptInput(format!("RAW 파일을 디코딩할 수 없습니다 ({raw_err})")))?;
    let ifd0 = tiff
        .ifds
        .first()
        .ok_or_else(|| ScError::CorruptInput(format!("TIFF IFD0 없음 ({raw_err})")))?;
    let spp = ifd0
        .u16(lightcraft_tiff::tags::SAMPLES_PER_PIXEL)
        .unwrap_or(1);
    if spp < 3 {
        return Err(ScError::UnsupportedFormat(format!(
            "지원되지 않는 RAW 형식입니다 (단일 채널 모자이크 거부: {raw_err})"
        )));
    }

    let dyn_img = image::load_from_memory(bytes)
        .map_err(|e| ScError::CorruptInput(format!("TIFF 폴백 디코딩 실패: {e}")))?;
    let (w, h) = dyn_img.dimensions();
    let (w, h) = (w as usize, h as usize);

    match dyn_img {
        DynamicImage::ImageRgb16(buf) => {
            Ok((buf.into_raw(), w, h, DecodeKind::RawDeveloped, Some(1.0)))
        }
        DynamicImage::ImageRgba16(buf) => {
            let mut rgb = Vec::with_capacity(w * h * 3);
            for px in buf.pixels() {
                rgb.push(px[0]);
                rgb.push(px[1]);
                rgb.push(px[2]);
            }
            Ok((rgb, w, h, DecodeKind::RawDeveloped, Some(1.0)))
        }
        other => {
            let rgb8 = other.to_rgb8();
            let mut linear_16 = Vec::with_capacity(w * h * 3);
            for &v in rgb8.as_raw() {
                let code = ((v as f32 / 255.0).powf(2.2) * 65535.0)
                    .round()
                    .clamp(0.0, 65535.0) as u16;
                linear_16.push(code);
            }
            Ok((
                linear_16,
                w,
                h,
                DecodeKind::EmbeddedPreview,
                Some(1.0),
            ))
        }
    }
}

/// Ingests an image or RAW file from disk into a `IngestedSessionData`.
pub fn ingest_file(path: &Path, original_file_name_override: Option<&str>) -> Result<IngestedSessionData> {
    let bytes = std::fs::read(path)?;
    let file_name = original_file_name_override
        .map(|s| s.to_string())
        .or_else(|| path.file_name().and_then(|s| s.to_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| "source_input.rw2".into());
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    ingest_bytes(&bytes, &file_name, &ext)
}

/// Ingests an image or RAW byte buffer into a `IngestedSessionData` with full panic isolation.
pub fn ingest_bytes(
    bytes: &[u8],
    original_file_name: &str,
    ext_hint: &str,
) -> Result<IngestedSessionData> {
    let ext = if !ext_hint.is_empty() {
        ext_hint.trim_start_matches('.').to_ascii_lowercase()
    } else {
        Path::new(original_file_name)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
    };

    let is_raw = is_raw_extension(&ext);
    let mut camera_wb = vec![1.0, 1.0, 1.0, 1.0];
    let mut color_matrix: Vec<Vec<f64>> = Vec::new();
    let mut black_level = vec![0i64, 0, 0, 0];
    let mut white_level = 65535u32;
    let mut bayer_pattern = "RGBG".to_string();
    let mut is_input_16bit = false;
    let mut raw_image_opt: Option<RawImage> = None;
    let mut exif_meta = extract_exif_from_bytes(bytes);

    let (linear_16bit, full_w, full_h, decode_kind, exposure_scale_override, geometry) = if is_raw {
        match decode_raw_isolated(bytes) {
            Ok(raw) => {
                exif_meta = extract_exif_from_raw(&raw);
                let wxy = as_shot_white_xy(&raw);
                let wbm = wb_multipliers(&raw.color, wxy);
                camera_wb = vec![wbm[0], wbm[1], wbm[2], wbm[1]];
                if let Some(cm) = raw.color.color_matrix[0].or(raw.color.color_matrix[1]) {
                    color_matrix = cm.0.iter().map(|r| r.to_vec()).collect();
                }
                let bl_mean = raw.black.mean().round() as i64;
                black_level = if raw.black.values.len() >= 4 {
                    raw.black.values[..4]
                        .iter()
                        .map(|&v| v.round() as i64)
                        .collect()
                } else {
                    vec![bl_mean; 4]
                };
                white_level = raw.white_at(0).round().clamp(1.0, 65535.0) as u32;
                if let Some(cfa) = &raw.cfa {
                    bayer_pattern = cfa.name();
                }

                let geom = Geometry::new(
                    raw.width,
                    raw.height,
                    CropRect::new(
                        raw.active_area.x,
                        raw.active_area.y,
                        raw.active_area.width,
                        raw.active_area.height,
                    ),
                    CropRect::new(raw.crop.x, raw.crop.y, raw.crop.width, raw.crop.height),
                    convert_orientation(raw.orientation),
                );

                let (lin16, fw, fh, exp_ovr) = develop_raw_to_linear16_srgb(&raw, bytes)?;
                let kind = if raw.cfa.is_some() {
                    DecodeKind::RawDeveloped
                } else {
                    DecodeKind::RawLinear16
                };
                raw_image_opt = Some(raw);
                (lin16, fw, fh, kind, exp_ovr, geom)
            }
            Err(raw_err) => {
                let (lin16, fw, fh, kind, exp_ovr) = decode_raw_tiff_fallback(bytes, &raw_err)?;
                let geom = Geometry::identity(fw, fh);
                (lin16, fw, fh, kind, exp_ovr, geom)
            }
        }
    } else {
        let dyn_img = catch_unwind(AssertUnwindSafe(|| image::load_from_memory(bytes)))
            .map_err(|_| ScError::DecoderPanic("이미지 디코딩 중 패닉이 격리되었습니다.".into()))?
            .map_err(|e| ScError::CorruptInput(format!("이미지를 디코딩할 수 없습니다: {e}")))?;

        let (w, h) = dyn_img.dimensions();
        let (fw, fh) = (w as usize, h as usize);
        let geom = Geometry::identity(fw, fh);

        match dyn_img {
            DynamicImage::ImageRgb16(buf) => {
                is_input_16bit = true;
                (
                    buf.into_raw(),
                    fw,
                    fh,
                    DecodeKind::Image16bit,
                    Some(1.0),
                    geom,
                )
            }
            DynamicImage::ImageRgba16(buf) => {
                is_input_16bit = true;
                let mut rgb = Vec::with_capacity(fw * fh * 3);
                for px in buf.pixels() {
                    rgb.push(px[0]);
                    rgb.push(px[1]);
                    rgb.push(px[2]);
                }
                (rgb, fw, fh, DecodeKind::Image16bit, Some(1.0), geom)
            }
            DynamicImage::ImageLuma16(buf) => {
                is_input_16bit = true;
                let mut rgb = Vec::with_capacity(fw * fh * 3);
                for px in buf.pixels() {
                    rgb.push(px[0]);
                    rgb.push(px[0]);
                    rgb.push(px[0]);
                }
                (rgb, fw, fh, DecodeKind::Image16bit, Some(1.0), geom)
            }
            other => {
                let rgb8 = other.to_rgb8();
                let lut = build_srgb8_to_linear16_lut();
                let lin16: Vec<u16> = rgb8
                    .as_raw()
                    .par_iter()
                    .map(|&v| lut[v as usize])
                    .collect();
                (lin16, fw, fh, DecodeKind::Image8bit, Some(1.0), geom)
            }
        }
    };

    // Working resolution (max 2304px) alignment
    let max_work_dim = 2304usize;
    let long_edge = full_w.max(full_h);
    let (work_w, work_h, work_scale, work_linear_16bit) = if long_edge > max_work_dim {
        let scale = max_work_dim as f64 / long_edge as f64;
        let ww = ((full_w as f64 * scale).round() as usize).max(1);
        let wh = ((full_h as f64 * scale).round() as usize).max(1);
        let resized = resize_inter_area_u16_rgb(&linear_16bit, full_w, full_h, ww, wh);
        (ww, wh, scale, resized)
    } else {
        (full_w, full_h, 1.0, linear_16bit.clone())
    };

    let (work_srgb_u8, exposure_scale) = if is_input_16bit {
        let u8_buf: Vec<u8> = work_linear_16bit
            .par_iter()
            .map(|&v| (v as f32 / 257.0).round().clamp(0.0, 255.0) as u8)
            .collect();
        (u8_buf, 1.0)
    } else {
        linear_16bit_to_srgb_8bit(&work_linear_16bit, work_w, work_h, exposure_scale_override)
    };

    let det_gray = if is_input_16bit {
        compute_det_gray_from_srgb8(&work_srgb_u8, work_w, work_h)
    } else {
        compute_det_gray_from_16bit(&work_linear_16bit, work_w, work_h, is_raw, exposure_scale)
    };

    // Subsampled 16-bit statistics (`linear_rgb_16[::4, ::4]`)
    let mut min_val = u16::MAX;
    let mut max_val = 0u16;
    let mut sum_val = 0u64;
    let mut count_val = 0u64;
    for y in (0..full_h).step_by(4) {
        let row = &linear_16bit[y * full_w * 3..(y + 1) * full_w * 3];
        for x in (0..full_w).step_by(4) {
            let base = x * 3;
            for c in 0..3 {
                let v = row[base + c];
                if v < min_val {
                    min_val = v;
                }
                if v > max_val {
                    max_val = v;
                }
                sum_val += v as u64;
                count_val += 1;
            }
        }
    }
    if count_val == 0 {
        min_val = 0;
    }
    let mean_val = if count_val > 0 {
        ((sum_val as f64 / count_val as f64) * 10.0).round() / 10.0
    } else {
        0.0
    };
    let dynamic_range_ev = if max_val > min_val {
        let ratio = (max_val.max(1) as f64) / (min_val.max(1) as f64);
        (ratio.log2() * 100.0).round() / 100.0
    } else {
        14.0
    };

    let meta = SessionMetadata {
        original_file_name: original_file_name.to_string(),
        extension: ext.to_ascii_uppercase(),
        is_raw,
        decode_kind: Some(decode_kind),
        is_input_16_bit: is_input_16bit,
        is_linear16: is_raw || !is_input_16bit,
        full_width: full_w,
        full_height: full_h,
        work_width: work_w,
        work_height: work_h,
        work_scale,
        exposure_scale,
        bit_depth: decode_kind.bit_depth_label().to_string(),
        color_space: decode_kind.color_space_label().to_string(),
        camera_wb,
        color_matrix,
        black_level,
        white_level,
        bayer_pattern,
        stats_16_bit: Stats16Bit {
            min_code_value: min_val as u32,
            max_code_value: max_val as u32,
            mean_code_value: mean_val,
            estimated_dynamic_range_ev: dynamic_range_ev,
        },
        exif: exif_meta,
    };

    let _ = CfaPattern::rggb();

    Ok(IngestedSessionData {
        meta,
        geometry,
        raw_image: raw_image_opt,
        linear_16bit,
        work_linear_16bit,
        work_srgb_u8,
        det_gray,
    })
}
