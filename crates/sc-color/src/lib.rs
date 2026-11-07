//! Color conversion, 16-bit linear ↔ sRGB LUTs, and perceptual detection luminance (`det_gray`)
//! matching `python/raw_pipeline.py:143-254`.

#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unimplemented,
    clippy::todo,
    clippy::unreachable
)]

pub mod cct;
pub mod icc;
pub mod spaces;
pub mod transfer;

pub use spaces::{
    ADOBE_RGB, BRADFORD, ColorSpace, D50, D65, DISPLAY_P3, LUMA_709, LUMA_2020, Mat3, PROPHOTO,
    REC2020, RgbSpace, SRGB, WORKING, Xy, bradford, luminance_2020,
};

use rayon::prelude::*;

/// Exact linear-interpolated percentile matching `np.percentile(arr, q_pct)` (`0.0 <= q_pct <= 100.0`).
pub fn percentile_f32(values: &mut [f32], q_pct: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.total_cmp(b));
    let n = values.len();
    if n == 1 {
        return values[0] as f64;
    }
    let pos = (q_pct.clamp(0.0, 100.0) / 100.0) * (n - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = (lo + 1).min(n - 1);
    let frac = pos - lo as f64;
    values[lo] as f64 * (1.0 - frac) + values[hi] as f64 * frac
}

/// Exact median matching `np.median(arr)`.
pub fn median_f32(values: &mut [f32]) -> f64 {
    percentile_f32(values, 50.0)
}

/// Builds the 256-entry LUT mapping 8-bit sRGB (`0..=255`) -> 16-bit Linear RGB (`0..=65535`).
/// Matches `_SRGB8_TO_LINEAR16_LUT` in `raw_pipeline.py:144-150`.
pub fn build_srgb8_to_linear16_lut() -> [u16; 256] {
    let mut lut = [0u16; 256];
    for (i, slot) in lut.iter_mut().enumerate() {
        let norm = i as f64 / 255.0;
        let lin = if norm <= 0.04045 {
            norm / 12.92
        } else {
            ((norm + 0.055) / 1.055).powf(2.4)
        };
        *slot = (lin * 65535.0).round().clamp(0.0, 65535.0) as u16;
    }
    lut
}

/// Builds a 65536-entry `u8` sRGB Lookup Table matching `build_srgb_u8_lut` in `raw_pipeline.py:191-199`.
pub fn build_srgb_u8_lut(exposure_scale: f64) -> Vec<u8> {
    let scale = exposure_scale as f32;
    let mut lut = vec![0u8; 65536];
    for (i, slot) in lut.iter_mut().enumerate() {
        let norm = i as f32 / 65535.0;
        let exposed = (norm * scale).clamp(0.0, 1.0);
        let srgb = if exposed <= 0.0031308 {
            exposed * 12.92
        } else {
            1.055 * exposed.max(1e-8).powf(1.0 / 2.4) - 0.055
        };
        *slot = (srgb * 255.0).round().clamp(0.0, 255.0) as u8;
    }
    lut
}

/// Builds a 65536-entry `u16` sRGB Lookup Table matching `build_srgb_u16_lut` in `raw_pipeline.py:202-210`.
pub fn build_srgb_u16_lut(exposure_scale: f64) -> Vec<u16> {
    let scale = exposure_scale as f32;
    let mut lut = vec![0u16; 65536];
    for (i, slot) in lut.iter_mut().enumerate() {
        let norm = i as f32 / 65535.0;
        let exposed = (norm * scale).clamp(0.0, 1.0);
        let srgb = if exposed <= 0.0031308 {
            exposed * 12.92
        } else {
            1.055 * exposed.max(1e-8).powf(1.0 / 2.4) - 0.055
        };
        *slot = (srgb * 65535.0).round().clamp(0.0, 65535.0) as u16;
    }
    lut
}

/// Estimates `exposure_scale` from every 4th row and 4th column of a 3-channel `u16` image
/// matching `raw_pipeline.py:216-219`.
pub fn estimate_exposure_scale(linear_rgb_16: &[u16], w: usize, h: usize) -> f64 {
    if w == 0 || h == 0 || linear_rgb_16.len() < w.saturating_mul(h).saturating_mul(3) {
        return 1.0;
    }
    let mut sample = Vec::with_capacity((h.div_ceil(4)) * (w.div_ceil(4)) * 3);
    for y in (0..h).step_by(4) {
        let row = &linear_rgb_16[y * w * 3..(y + 1) * w * 3];
        for x in (0..w).step_by(4) {
            let base = x * 3;
            sample.push(row[base] as f32 / 65535.0);
            sample.push(row[base + 1] as f32 / 65535.0);
            sample.push(row[base + 2] as f32 / 65535.0);
        }
    }
    let p996 = percentile_f32(&mut sample, 99.6);
    let scale = if p996 > 1e-4 { 0.94 / p996 } else { 1.0 };
    scale.clamp(0.5, 16.0)
}

/// Converts a 16-bit Linear RGB (`w × h × 3`) array into an 8-bit sRGB tone-mapped image via 65536-LUT.
/// Matches `linear_16bit_to_srgb_8bit` in `raw_pipeline.py:213-222`.
pub fn linear_16bit_to_srgb_8bit(
    linear_rgb_16: &[u16],
    w: usize,
    h: usize,
    exposure_scale_override: Option<f64>,
) -> (Vec<u8>, f64) {
    let exposure_scale =
        exposure_scale_override.unwrap_or_else(|| estimate_exposure_scale(linear_rgb_16, w, h));
    let lut = build_srgb_u8_lut(exposure_scale);
    let out: Vec<u8> = linear_rgb_16
        .par_iter()
        .map(|&v| lut[v as usize])
        .collect();
    (out, exposure_scale)
}

/// Converts a 16-bit Linear RGB (`w × h × 3`) array into a 16-bit sRGB tone-mapped image via 65536-LUT.
/// Matches `linear_16bit_to_srgb_16bit` in `raw_pipeline.py:225-237`.
pub fn linear_16bit_to_srgb_16bit(
    linear_rgb_16: &[u16],
    w: usize,
    h: usize,
    exposure_scale_override: Option<f64>,
) -> (Vec<u16>, f64) {
    let exposure_scale =
        exposure_scale_override.unwrap_or_else(|| estimate_exposure_scale(linear_rgb_16, w, h));
    let lut = build_srgb_u16_lut(exposure_scale);
    let out: Vec<u16> = linear_rgb_16
        .par_iter()
        .map(|&v| lut[v as usize])
        .collect();
    (out, exposure_scale)
}

/// Computes perceptual luminance (`0.0..=255.0` `f32`) for dust detection from `det_16` (`w × h × 3` `u16`).
/// Matches `compute_det_gray_from_16bit` in `raw_pipeline.py:240-254`.
pub fn compute_det_gray_from_16bit(
    det_16: &[u16],
    w: usize,
    h: usize,
    is_raw: bool,
    exposure_scale: f64,
) -> Vec<f32> {
    if w == 0 || h == 0 || det_16.len() < w.saturating_mul(h).saturating_mul(3) {
        return Vec::new();
    }
    let mut lum_linear = vec![0.0f32; w * h];
    lum_linear
        .par_iter_mut()
        .enumerate()
        .for_each(|(idx, out_l)| {
            let base = idx * 3;
            let r = det_16[base] as f32;
            let g = det_16[base + 1] as f32;
            let b = det_16[base + 2] as f32;
            *out_l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 65535.0;
        });

    let det_exp_scale = if is_raw {
        let mut sub = Vec::with_capacity((h.div_ceil(2)) * (w.div_ceil(2)));
        for y in (0..h).step_by(2) {
            let row = &lum_linear[y * w..(y + 1) * w];
            for x in (0..w).step_by(2) {
                sub.push(row[x]);
            }
        }
        let p996 = percentile_f32(&mut sub, 99.6);
        let s = if p996 > 1e-4 {
            0.94 / p996
        } else {
            exposure_scale
        };
        s.clamp(0.5, 16.0) as f32
    } else {
        exposure_scale as f32
    };

    let inv_gamma = 1.0f32 / 2.2f32;
    lum_linear
        .into_par_iter()
        .map(|l| (l * det_exp_scale).clamp(1e-6, 1.0).powf(inv_gamma) * 255.0)
        .collect()
}

/// Computes `det_gray` directly from an 8-bit sRGB preview when the input was an ordinary 16-bit image,
/// matching `raw_pipeline.py:386-391`.
pub fn compute_det_gray_from_srgb8(srgb_u8: &[u8], w: usize, h: usize) -> Vec<f32> {
    if w == 0 || h == 0 || srgb_u8.len() < w.saturating_mul(h).saturating_mul(3) {
        return Vec::new();
    }
    let mut out = vec![0.0f32; w * h];
    out.par_iter_mut().enumerate().for_each(|(idx, slot)| {
        let base = idx * 3;
        *slot = 0.2126 * srgb_u8[base] as f32
            + 0.7152 * srgb_u8[base + 1] as f32
            + 0.0722 * srgb_u8[base + 2] as f32;
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srgb8_linear16_roundtrip_matches_endpoints() {
        let lut_in = build_srgb8_to_linear16_lut();
        assert_eq!(lut_in[0], 0);
        assert_eq!(lut_in[255], 65535);
        let lut_out = build_srgb_u8_lut(1.0);
        for code in 0u8..=255 {
            let lin = lut_in[code as usize];
            let back = lut_out[lin as usize];
            assert!((back as i32 - code as i32).abs() <= 1, "code={code}, back={back}");
        }
    }
}
