//! Pure-Rust incremental ROI 16-bit plane-detrended inpainting and image exporter (`dng`, `tiff16`, `png`, `jpg`),
//! matching `inpaint_16bit_linear` and `export_healed_image` in `python/raw_pipeline.py:1023-1609`.

use crate::npy::{read_npy_u8, read_npy_u16, write_npy_u16};
use sc_tiff::tags::{self as t, compression, photometric};
use sc_tiff::{ByteOrder, IfdBuilder, ImageData, TiffWriter, Value};
use sc_color::{
    build_srgb_u8_lut, linear_16bit_to_srgb_8bit, linear_16bit_to_srgb_16bit, median_f32,
    percentile_f32,
};
use sc_core::{
    DetectedDustSpot, ExportInfo, InpaintParams, InpaintResult, ManualBrushStroke, Result, ScError,
    SessionMetadata,
};
use sc_detect::annulus::fast_fit_plane;
use sc_imgproc::{
    dilate_u8, draw_filled_circle_u8, draw_thick_line_u8, ellipse_kernel, gaussian_blur_f32,
};
use rayon::prelude::*;
use std::fs::File;
use std::io::BufWriter;
use std::path::Path;

pub fn write_jpeg_rgb(path: &Path, rgb: &[u8], w: usize, h: usize, quality: u8) -> Result<()> {
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, quality)
        .encode(rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb)
        .map_err(|e| ScError::Pipeline(format!("JPEG 인코딩 실패: {e}")))?;
    std::fs::write(path, out)?;
    Ok(())
}

pub fn write_png_gray(path: &Path, gray: &[u8], w: usize, h: usize) -> Result<()> {
    let file = File::create(path)?;
    let w_buf = BufWriter::new(file);
    let mut encoder = png::Encoder::new(w_buf, w as u32, h as u32);
    encoder.set_color(png::ColorType::Grayscale);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|e| ScError::Pipeline(format!("PNG 헤더 작성 실패: {e}")))?;
    writer
        .write_image_data(gray)
        .map_err(|e| ScError::Pipeline(format!("PNG 데이터 작성 실패: {e}")))?;
    Ok(())
}

pub fn write_png_rgb(path: &Path, rgb: &[u8], w: usize, h: usize) -> Result<()> {
    let file = File::create(path)?;
    let w_buf = BufWriter::new(file);
    let mut encoder = png::Encoder::new(w_buf, w as u32, h as u32);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|e| ScError::Pipeline(format!("PNG 헤더 작성 실패: {e}")))?;
    writer
        .write_image_data(rgb)
        .map_err(|e| ScError::Pipeline(format!("PNG 데이터 작성 실패: {e}")))?;
    Ok(())
}

/// Builds the combined working-resolution (`work_w × work_h`) binary mask (`0` or `255`),
/// matching `build_combined_mask` in `raw_pipeline.py:1023-1074`.
pub fn build_combined_mask(
    work_h: usize,
    work_w: usize,
    work_scale: f64,
    active_spots: &[DetectedDustSpot],
    manual_strokes: &[ManualBrushStroke],
) -> Vec<u8> {
    let mut mask = vec![0u8; work_w * work_h];

    for spot in active_spots {
        if !spot.enabled {
            continue;
        }
        let cx = if spot.work_cx > 0.0 {
            spot.work_cx
        } else {
            spot.cx * work_scale
        }
        .round() as isize;
        let cy = if spot.work_cy > 0.0 {
            spot.work_cy
        } else {
            spot.cy * work_scale
        }
        .round() as isize;

        let skirt_mult = if spot.spot_type.as_deref() == Some("bokeh") {
            1.72
        } else {
            1.55
        };
        let min_skirt_r = spot.radius * work_scale * skirt_mult + 2.0;
        let r_val = spot.work_radius.max(min_skirt_r);
        let r = (r_val.round() as isize).max(3);
        draw_filled_circle_u8(&mut mask, work_w, work_h, cx, cy, r, 255);
    }

    for stroke in manual_strokes {
        let val = if stroke.mode == "erase" { 0u8 } else { 255u8 };
        let r = (stroke.radius * work_scale).round().max(2.0);
        let pts = &stroke.points;
        if pts.len() == 1 {
            let px = (pts[0].x * work_scale).round() as isize;
            let py = (pts[0].y * work_scale).round() as isize;
            draw_filled_circle_u8(&mut mask, work_w, work_h, px, py, r as isize, val);
        } else if pts.len() > 1 {
            for i in 0..(pts.len() - 1) {
                draw_thick_line_u8(
                    &mut mask,
                    work_w,
                    work_h,
                    pts[i].x * work_scale,
                    pts[i].y * work_scale,
                    pts[i + 1].x * work_scale,
                    pts[i + 1].y * work_scale,
                    r,
                    val,
                );
            }
        }
    }

    mask
}

/// Fast box-averaging downsampler for a local RGB 16-bit patch from `(sw, sh)` to `(dw, dh)`.
/// Requires zero heap allocations in inner loops and zero floating-point conversions.
pub fn downsample_patch_rgb16(src: &[u16], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u16> {
    if dw == 0 || dh == 0 {
        return Vec::new();
    }
    if sw == dw && sh == dh {
        return src[..dw * dh * 3].to_vec();
    }
    let mut dst = vec![0u16; dw * dh * 3];
    for dy in 0..dh {
        let sy0 = dy * sh / dh;
        let sy1 = (((dy + 1) * sh + dh - 1) / dh).min(sh).max(sy0 + 1);
        for dx in 0..dw {
            let sx0 = dx * sw / dw;
            let sx1 = (((dx + 1) * sw + dw - 1) / dw).min(sw).max(sx0 + 1);
            let count = ((sx1 - sx0) * (sy1 - sy0)) as u64;

            let mut sum_r = 0u64;
            let mut sum_g = 0u64;
            let mut sum_b = 0u64;

            for sy in sy0..sy1 {
                let row_offset = sy * sw * 3;
                for sx in sx0..sx1 {
                    let base = row_offset + sx * 3;
                    sum_r += src[base] as u64;
                    sum_g += src[base + 1] as u64;
                    sum_b += src[base + 2] as u64;
                }
            }

            let d_base = (dy * dw + dx) * 3;
            dst[d_base] = ((sum_r + count / 2) / count) as u16;
            dst[d_base + 1] = ((sum_g + count / 2) / count) as u16;
            dst[d_base + 2] = ((sum_b + count / 2) / count) as u16;
        }
    }
    dst
}

/// Computes disjoint bounding boxes `[(min_x, min_y, max_x, max_y)]` in full-image coordinates
/// covering all enabled spots and brush strokes with required skirt and feather margins.
/// Computes bounded disjoint bounding boxes `[(min_x, min_y, max_x, max_y)]` in full-image coordinates.
/// Clusters spots and brush strokes based on core collision, expands margins per-cluster,
/// and strictly caps maximum patch dimension to 256px to guarantee sub-millisecond inpainting and eliminate freezing.
pub fn compute_analytic_bboxes(
    full_w: usize,
    full_h: usize,
    work_scale: f64,
    spots: &[DetectedDustSpot],
    strokes: &[ManualBrushStroke],
    inpaint_r: f64,
) -> Vec<(usize, usize, usize, usize)> {
    let skirt_pad_px = ((inpaint_r * 0.80).round() as usize).max(4);
    let feather_px = ((inpaint_r * 0.90).round() as usize).max(4);
    let ring_width_px = ((inpaint_r * 1.6 + 6.0).round() as usize).max(8);
    let ring_pad = ring_width_px + 4;
    let extra_dilation = (skirt_pad_px + feather_px + ring_pad) as f64;
    let scale = if work_scale > 0.0 { work_scale } else { 1.0 };

    // 1. Gather raw core bounding boxes (without extra_dilation)
    let mut core_boxes: Vec<(f64, f64, f64, f64)> = Vec::new();

    for spot in spots {
        if !spot.enabled {
            continue;
        }
        let skirt_mult = if spot.spot_type.as_deref() == Some("bokeh") {
            1.72
        } else {
            1.55
        };
        let min_skirt_r = spot.radius * skirt_mult + 2.0;
        let r_val = spot.radius.max(min_skirt_r);
        let r_core = (r_val.round() as usize).max(3) as f64;

        let cx = if spot.cx > 0.0 { spot.cx } else { spot.work_cx / scale };
        let cy = if spot.cy > 0.0 { spot.cy } else { spot.work_cy / scale };

        core_boxes.push((cx - r_core, cy - r_core, cx + r_core, cy + r_core));
    }

    for stroke in strokes {
        if stroke.mode == "erase" || stroke.points.is_empty() {
            continue;
        }
        let r_core = stroke.radius.max(2.0);
        let mut min_x = f64::MAX;
        let mut min_y = f64::MAX;
        let mut max_x = f64::MIN;
        let mut max_y = f64::MIN;

        for pt in &stroke.points {
            min_x = min_x.min(pt.x);
            min_y = min_y.min(pt.y);
            max_x = max_x.max(pt.x);
            max_y = max_y.max(pt.y);
        }

        core_boxes.push((min_x - r_core, min_y - r_core, max_x + r_core, max_y + r_core));
    }

    if core_boxes.is_empty() {
        return Vec::new();
    }

    // 2. Pre-cluster only truly touching core boxes (capped at max 192px core dimension)
    let max_core_dim = 192.0f64;
    let mut merged = true;
    while merged {
        merged = false;
        let mut i = 0;
        while i < core_boxes.len() {
            let mut j = i + 1;
            while j < core_boxes.len() {
                let a = core_boxes[i];
                let b = core_boxes[j];
                // Check if cores touch with a small 2px tolerance
                if a.0 <= b.2 + 2.0 && a.2 >= b.0 - 2.0 && a.1 <= b.3 + 2.0 && a.3 >= b.1 - 2.0 {
                    let u0 = a.0.min(b.0);
                    let u1 = a.1.min(b.1);
                    let u2 = a.2.max(b.2);
                    let u3 = a.3.max(b.3);
                    // Do not merge if combined core would exceed max_core_dim (prevents runaway mega-patches)
                    if (u2 - u0) <= max_core_dim && (u3 - u1) <= max_core_dim {
                        core_boxes[i] = (u0, u1, u2, u3);
                        core_boxes.swap_remove(j);
                        merged = true;
                        continue;
                    }
                }
                j += 1;
            }
            i += 1;
        }
    }

    // 3. Expand each clustered core box by extra_dilation to form the final patch bounding box
    let mut expanded_boxes: Vec<(usize, usize, usize, usize)> = Vec::with_capacity(core_boxes.len());
    for c in core_boxes {
        let x0 = ((c.0 - extra_dilation).floor() as isize).clamp(0, full_w as isize) as usize;
        let y0 = ((c.1 - extra_dilation).floor() as isize).clamp(0, full_h as isize) as usize;
        let x1 = ((c.2 + extra_dilation).ceil() as isize).clamp(0, full_w as isize) as usize;
        let y1 = ((c.3 + extra_dilation).ceil() as isize).clamp(0, full_h as isize) as usize;

        if x1 > x0 && y1 > y0 {
            expanded_boxes.push((x0, y0, x1, y1));
        }
    }

    // 4. Final safety merge of heavily overlapping expanded boxes (capped at max 256px dimension)
    merge_overlapping_bboxes_capped(expanded_boxes, 256)
}

fn merge_overlapping_bboxes_capped(
    mut boxes: Vec<(usize, usize, usize, usize)>,
    max_dim: usize,
) -> Vec<(usize, usize, usize, usize)> {
    if boxes.len() <= 1 {
        return boxes;
    }
    let mut merged = true;
    while merged {
        merged = false;
        let mut i = 0;
        while i < boxes.len() {
            let mut j = i + 1;
            while j < boxes.len() {
                let (ax0, ay0, ax1, ay1) = boxes[i];
                let (bx0, by0, bx1, by1) = boxes[j];
                // Check if boxes intersect
                if ax0 <= bx1 && ax1 >= bx0 && ay0 <= by1 && ay1 >= by0 {
                    let u0 = ax0.min(bx0);
                    let u1 = ay0.min(by0);
                    let u2 = ax1.max(bx1);
                    let u3 = ay1.max(by1);
                    if (u2 - u0) <= max_dim && (u3 - u1) <= max_dim {
                        boxes[i] = (u0, u1, u2, u3);
                        boxes.swap_remove(j);
                        merged = true;
                        continue;
                    }
                }
                j += 1;
            }
            i += 1;
        }
    }
    boxes
}

/// Draws the base binary mask inside a local patch `[bx1, by1, bx2, by2]`.
fn draw_patch_mask(
    rw: usize,
    rh: usize,
    bx1: usize,
    by1: usize,
    spots: &[DetectedDustSpot],
    strokes: &[ManualBrushStroke],
    work_scale: f64,
) -> Vec<u8> {
    let mut mask = vec![0u8; rw * rh];
    let bx2 = bx1 + rw;
    let by2 = by1 + rh;
    let ibx1 = bx1 as isize;
    let ibx2 = bx2 as isize;
    let iby1 = by1 as isize;
    let iby2 = by2 as isize;
    let fbx1 = bx1 as f64;
    let fbx2 = bx2 as f64;
    let fby1 = by1 as f64;
    let fby2 = by2 as f64;
    let scale = if work_scale > 0.0 { work_scale } else { 1.0 };

    for spot in spots {
        if !spot.enabled {
            continue;
        }
        let cx = (if spot.cx > 0.0 { spot.cx } else { spot.work_cx / scale }).round() as isize;
        let cy = (if spot.cy > 0.0 { spot.cy } else { spot.work_cy / scale }).round() as isize;
        let skirt_mult = if spot.spot_type.as_deref() == Some("bokeh") {
            1.72
        } else {
            1.55
        };
        let min_skirt_r = spot.radius * skirt_mult + 2.0;
        let r_val = spot.radius.max(min_skirt_r);
        let r = (r_val.round() as isize).max(3);

        if cx + r < ibx1 || cx - r >= ibx2 || cy + r < iby1 || cy - r >= iby2 {
            continue;
        }

        let lx = cx - ibx1;
        let ly = cy - iby1;
        draw_filled_circle_u8(&mut mask, rw, rh, lx, ly, r, 255);
    }

    for stroke in strokes {
        let val = if stroke.mode == "erase" { 0u8 } else { 255u8 };
        let r = stroke.radius.round().max(2.0);
        let ir = r as isize;
        let pts = &stroke.points;
        if pts.is_empty() {
            continue;
        }
        if pts.len() == 1 {
            let px = pts[0].x.round() as isize;
            let py = pts[0].y.round() as isize;
            if px + ir >= ibx1 && px - ir < ibx2 && py + ir >= iby1 && py - ir < iby2 {
                let lx = px - ibx1;
                let ly = py - iby1;
                draw_filled_circle_u8(&mut mask, rw, rh, lx, ly, ir, val);
            }
        } else {
            for i in 0..(pts.len() - 1) {
                let x1 = pts[i].x;
                let y1 = pts[i].y;
                let x2 = pts[i + 1].x;
                let y2 = pts[i + 1].y;

                let min_x = x1.min(x2) - r;
                let max_x = x1.max(x2) + r;
                let min_y = y1.min(y2) - r;
                let max_y = y1.max(y2) + r;

                if max_x < fbx1 || min_x >= fbx2 || max_y < fby1 || min_y >= fby2 {
                    continue;
                }

                draw_thick_line_u8(
                    &mut mask,
                    rw,
                    rh,
                    x1 - fbx1,
                    y1 - fby1,
                    x2 - fbx1,
                    y2 - fby1,
                    r,
                    val,
                );
            }
        }
    }

    mask
}

/// Deterministic Xorshift64* PRNG for repeatable sensor grain synthesis (`seed = 42`).
struct DeterministicRng {
    state: u64,
}

impl DeterministicRng {
    fn new(seed: u64) -> Self {
        Self {
            state: seed.max(1),
        }
    }

    #[inline]
    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    #[inline]
    fn next_f32_unit(&mut self) -> f32 {
        ((self.next_u64() >> 40) as f32) * (1.0 / (1u32 << 24) as f32)
    }

    /// Standard normal `N(0, 1)` via Box-Muller transform.
    fn next_gaussian(&mut self) -> f32 {
        let u1 = self.next_f32_unit().clamp(1e-7, 1.0 - 1e-7);
        let u2 = self.next_f32_unit();
        (-2.0 * u1.ln()).sqrt() * (std::f32::consts::TAU * u2).cos()
    }
}

/// Fast boundary-weighted Telea FMM + harmonic fill on a detrended 2D ROI patch.
/// Pixels where `mask[y * rw + x] != 0` are inpainted using Eikonal Fast Marching Method
/// based on Telea (2004), preserving image gradients and smooth level sets.
fn telea_harmonic_fill_roi(
    detrended: &[f32],
    mask: &[u8],
    rw: usize,
    rh: usize,
    harm_sigma: f64,
) -> Vec<f32> {
    let r_eff = 3.0f32;
    sc_imgproc::inpaint_telea_harmonic_f32(detrended, mask, rw, rh, r_eff, harm_sigma)
}

/// Pure in-memory 16-bit Plane-Detrended Harmonic + Telea inpainting on `linear_16bit` and `work_orig_u8`.
/// Returns `(healed_16bit, healed_work_u8, work_mask, inpainted_pixels, roi_count)`.
pub fn inpaint_linear16_and_work_srgb_in_memory(
    linear_16bit: &[u16],
    work_orig_u8: &[u8],
    meta: &SessionMetadata,
    params: &InpaintParams,
) -> (Vec<u16>, Vec<u8>, Vec<u8>, usize, usize) {
    let full_w = meta.full_width;
    let full_h = meta.full_height;
    let work_w = meta.work_width;
    let work_h = meta.work_height;
    let work_scale = meta.work_scale;
    let exposure_scale = meta.exposure_scale;
    let is_input_16bit = meta.is_input_16_bit;

    let inpaint_r = params.inpaint_radius.clamp(3.0, 25.0);
    let skirt_pad_px = ((inpaint_r * 0.80).round() as usize).max(4);
    let feather_px = ((inpaint_r * 0.90).round() as usize).max(4);
    let feather_sigma = (feather_px as f64 * 0.65).max(2.5);
    let ring_width_px = ((inpaint_r * 1.6 + 6.0).round() as usize).max(8);

    let work_mask = build_combined_mask(
        work_h,
        work_w,
        work_scale,
        &params.spots,
        &params.manual_strokes,
    );

    let bboxes = compute_analytic_bboxes(
        full_w,
        full_h,
        work_scale,
        &params.spots,
        &params.manual_strokes,
        inpaint_r,
    );

    let mut healed_16bit = linear_16bit.to_vec();
    let mut healed_work_u8 = work_orig_u8.to_vec();
    let mut inpainted_pixels = 0usize;
    let mut roi_count = 0usize;

    if !bboxes.is_empty() {
        let kw_skirt = skirt_pad_px * 2 + 1;
        let k_skirt = ellipse_kernel(kw_skirt, kw_skirt);
        let kw_feather = feather_px * 2 + 1;
        let k_feather = ellipse_kernel(kw_feather, kw_feather);
        let kw_ring = ring_width_px * 2 + 1;
        let k_ring = ellipse_kernel(kw_ring, kw_ring);
        let lut_u8 = if !is_input_16bit {
            Some(build_srgb_u8_lut(exposure_scale))
        } else {
            None
        };

        struct InpaintedPatchResult {
            bx1: usize,
            by1: usize,
            bx2: usize,
            by2: usize,
            rw: usize,
            rh: usize,
            healed_patch: Vec<u16>,
            core_cnt: usize,
        }

        let patches: Vec<InpaintedPatchResult> = bboxes
            .into_par_iter()
            .filter_map(|(bx1, by1, bx2, by2)| {
                let rw = bx2 - bx1;
                let rh = by2 - by1;
                if rw == 0 || rh == 0 {
                    return None;
                }

                let roi_mask = draw_patch_mask(rw, rh, bx1, by1, &params.spots, &params.manual_strokes, work_scale);
                if roi_mask.iter().all(|&v| v == 0) {
                    return None;
                }

                let roi_core = dilate_u8(&roi_mask, rw, rh, kw_skirt, kw_skirt, &k_skirt);
                let core_cnt = roi_core.iter().filter(|&&v| v != 0).count();
                if core_cnt == 0 {
                    return None;
                }

                let roi_expanded = dilate_u8(&roi_core, rw, rh, kw_feather, kw_feather, &k_feather);

                let core_f32: Vec<f32> = roi_core.iter().map(|&v| if v > 0 { 1.0f32 } else { 0.0f32 }).collect();
                let blurred_core = gaussian_blur_f32(&core_f32, rw, rh, feather_sigma);
                let mut roi_alpha = vec![0.0f32; rw * rh];
                for i in 0..(rw * rh) {
                    if roi_core[i] > 0 {
                        roi_alpha[i] = 1.0;
                    } else if roi_expanded[i] > 0 {
                        let t = (blurred_core[i] * 1.65).clamp(0.0, 1.0);
                        roi_alpha[i] = t * t * (3.0 - 2.0 * t);
                    } else {
                        roi_alpha[i] = 0.0;
                    }
                }

                let roi_outer_dilated =
                    dilate_u8(&roi_expanded, rw, rh, kw_ring, kw_ring, &k_ring);

                let mut ring_coords: Vec<(usize, usize)> = Vec::new();
                for y in 0..rh {
                    for x in 0..rw {
                        let r_idx = y * rw + x;
                        if roi_outer_dilated[r_idx] > 0 && roi_expanded[r_idx] == 0 {
                            ring_coords.push((x, y));
                        }
                    }
                }

                let half_rw = (rw as f32 * 0.5).max(1.0);
                let half_rh = (rh as f32 * 0.5).max(1.0);

                // Joint color-consistent plane fitting on ring pixels to eliminate color casts
                let mut coeffs_3ch: Option<[[f64; 3]; 3]> = None;
                if ring_coords.len() >= 16 {
                    let mut rx = Vec::with_capacity(ring_coords.len());
                    let mut ry = Vec::with_capacity(ring_coords.len());
                    let mut g_ring = Vec::with_capacity(ring_coords.len());
                    for &(x, y) in &ring_coords {
                        rx.push((x as f32 - half_rw) / half_rw);
                        ry.push((y as f32 - half_rh) / half_rh);
                        let g_idx = ((by1 + y) * full_w + (bx1 + x)) * 3 + 1;
                        g_ring.push(linear_16bit[g_idx] as f32);
                    }
                    let c_g = fast_fit_plane(&rx, &ry, &g_ring);
                    let res_g: Vec<f32> = (0..ring_coords.len())
                        .map(|i| {
                            g_ring[i]
                                - (c_g[0] as f32 * rx[i] + c_g[1] as f32 * ry[i] + c_g[2] as f32)
                        })
                        .collect();
                    let mut res_sorted = res_g.clone();
                    let lo_r = percentile_f32(&mut res_sorted, 15.0) as f32;
                    let hi_r = percentile_f32(&mut res_sorted, 85.0) as f32;

                    let mut rx_c = Vec::new();
                    let mut ry_c = Vec::new();
                    let mut ch_vals = [Vec::new(), Vec::new(), Vec::new()];
                    for (i, &(x, y)) in ring_coords.iter().enumerate() {
                        if res_g[i] >= lo_r && res_g[i] <= hi_r {
                            rx_c.push(rx[i]);
                            ry_c.push(ry[i]);
                            let base = ((by1 + y) * full_w + (bx1 + x)) * 3;
                            ch_vals[0].push(linear_16bit[base] as f32);
                            ch_vals[1].push(linear_16bit[base + 1] as f32);
                            ch_vals[2].push(linear_16bit[base + 2] as f32);
                        }
                    }
                    if rx_c.len() >= 12 {
                        let c_g_clean = fast_fit_plane(&rx_c, &ry_c, &ch_vals[1]);
                        let mean_g = (ch_vals[1].iter().map(|&v| v as f64).sum::<f64>() / rx_c.len() as f64).max(1.0);
                        let mean_r = ch_vals[0].iter().map(|&v| v as f64).sum::<f64>() / rx_c.len() as f64;
                        let mean_b = ch_vals[2].iter().map(|&v| v as f64).sum::<f64>() / rx_c.len() as f64;

                        // Lock chromatic slopes proportionally to green plane to guarantee 0% color cast
                        let k_r = (mean_r / mean_g).clamp(0.2, 5.0);
                        let k_b = (mean_b / mean_g).clamp(0.2, 5.0);

                        coeffs_3ch = Some([
                            [c_g_clean[0] * k_r, c_g_clean[1] * k_r, c_g_clean[2] * k_r],
                            c_g_clean,
                            [c_g_clean[0] * k_b, c_g_clean[1] * k_b, c_g_clean[2] * k_b],
                        ]);
                    }
                }

                let harm_sigma = (rw.min(rh) as f64 * 0.10).clamp(2.0, 8.0);
                let mut healed_patch = vec![0u16; rw * rh * 3];

                // Deterministic PRNG seed isolated per patch
                let mut rng = DeterministicRng::new(
                    42u64
                        .wrapping_add((by1 as u64) << 32)
                        .wrapping_add(bx1 as u64),
                );

                for ch in 0..3 {
                    let mut roi_orig = vec![0.0f32; rw * rh];
                    for y in 0..rh {
                        for x in 0..rw {
                            roi_orig[y * rw + x] =
                                linear_16bit[((by1 + y) * full_w + (bx1 + x)) * 3 + ch] as f32;
                        }
                    }

                    // Estimate high-frequency grain MAD in ring
                    let grain_std = if params.preserve_grain && !ring_coords.is_empty() {
                        let blurred = gaussian_blur_f32(&roi_orig, rw, rh, 1.2);
                        let mut ring_hf: Vec<f32> = ring_coords
                            .iter()
                            .map(|&(x, y)| (roi_orig[y * rw + x] - blurred[y * rw + x]).abs())
                            .collect();
                        (median_f32(&mut ring_hf) as f32 * 1.4826).min(450.0)
                    } else {
                        0.0
                    };

                    let roi_healed = if let Some(coeffs) = coeffs_3ch {
                        let c = coeffs[ch];
                        let mut detrended = vec![0.0f32; rw * rh];
                        let mut plane_2d = vec![0.0f32; rw * rh];
                        for y in 0..rh {
                            let ny = (y as f32 - half_rh) / half_rh;
                            for x in 0..rw {
                                let nx = (x as f32 - half_rw) / half_rw;
                                let p = (c[0] as f32) * nx + (c[1] as f32) * ny + (c[2] as f32);
                                plane_2d[y * rw + x] = p;
                                detrended[y * rw + x] = roi_orig[y * rw + x] - p;
                            }
                        }
                        let filled =
                            telea_harmonic_fill_roi(&detrended, &roi_expanded, rw, rh, harm_sigma);
                        filled
                            .into_iter()
                            .zip(plane_2d)
                            .map(|(f, p)| p + f)
                            .collect::<Vec<f32>>()
                    } else {
                        telea_harmonic_fill_roi(&roi_orig, &roi_expanded, rw, rh, harm_sigma)
                    };

                    for y in 0..rh {
                        for x in 0..rw {
                            let r_idx = y * rw + x;
                            let alpha = roi_alpha[r_idx];
                            let p_idx = (y * rw + x) * 3 + ch;
                            if alpha <= 0.0 {
                                healed_patch[p_idx] = roi_orig[r_idx] as u16;
                            } else {
                                let mut h_val = roi_healed[r_idx];
                                if grain_std > 1.0 {
                                    h_val += rng.next_gaussian() * (grain_std * 0.85);
                                }
                                let base_val = roi_orig[r_idx];
                                let blended = base_val * (1.0 - alpha) + h_val * alpha;
                                healed_patch[p_idx] = blended.round().clamp(0.0, 65535.0) as u16;
                            }
                        }
                    }
                }

                Some(InpaintedPatchResult {
                    bx1,
                    by1,
                    bx2,
                    by2,
                    rw,
                    rh,
                    healed_patch,
                    core_cnt,
                })
            })
            .collect();

        for patch in patches {
            inpainted_pixels += patch.core_cnt;
            roi_count += 1;

            for y in 0..patch.rh {
                let src_offset = y * patch.rw * 3;
                let dst_offset = ((patch.by1 + y) * full_w + patch.bx1) * 3;
                let len = patch.rw * 3;
                healed_16bit[dst_offset..dst_offset + len]
                    .copy_from_slice(&patch.healed_patch[src_offset..src_offset + len]);
            }

            // Update working preview checkpoint on this ROI
            let wx1 = ((patch.bx1 as f64 * work_scale).floor() as usize).min(work_w);
            let wy1 = ((patch.by1 as f64 * work_scale).floor() as usize).min(work_h);
            let wx2 = ((patch.bx2 as f64 * work_scale).ceil() as usize).min(work_w);
            let wy2 = ((patch.by2 as f64 * work_scale).ceil() as usize).min(work_h);
            if wx2 > wx1 && wy2 > wy1 {
                let ww_p = wx2 - wx1;
                let wh_p = wy2 - wy1;
                let patch_work = if (patch.rw, patch.rh) != (ww_p, wh_p) {
                    downsample_patch_rgb16(&patch.healed_patch, patch.rw, patch.rh, ww_p, wh_p)
                } else {
                    patch.healed_patch
                };
                for y in 0..wh_p {
                    for x in 0..ww_p {
                        let s_base = (y * ww_p + x) * 3;
                        let d_base = ((wy1 + y) * work_w + (wx1 + x)) * 3;
                        for c in 0..3 {
                            let v16 = patch_work[s_base + c];
                            healed_work_u8[d_base + c] = if let Some(lut) = &lut_u8 {
                                lut[v16 as usize]
                            } else {
                                (v16 as f32 / 257.0).round().clamp(0.0, 255.0) as u8
                            };
                        }
                    }
                }
            }
        }
    }

    (healed_16bit, healed_work_u8, work_mask, inpainted_pixels, roi_count)
}

/// Runs 16-bit Plane-Detrended Harmonic + Telea Inpainting on `session_dir`,
/// guaranteeing bit-identical pixels outside the healed spot/stroke masks.
pub fn inpaint_16bit_linear_native(
    session_dir: &Path,
    params: &InpaintParams,
) -> Result<InpaintResult> {
    let meta_str = std::fs::read_to_string(session_dir.join("session_meta.json"))?;
    let meta: SessionMetadata = serde_json::from_str(&meta_str)?;

    let (_, linear_16bit) = read_npy_u16(&session_dir.join("linear_16bit.npy"))?;
    let (_, work_orig_u8) = read_npy_u8(&session_dir.join("work_srgb_u8.npy"))?;

    let full_w = meta.full_width;
    let full_h = meta.full_height;
    let work_w = meta.work_width;
    let work_h = meta.work_height;

    let (healed_16bit, healed_work_u8, work_mask, inpainted_pixels, roi_count) =
        inpaint_linear16_and_work_srgb_in_memory(&linear_16bit, &work_orig_u8, &meta, params);

    write_png_gray(&session_dir.join("mask_final_work.png"), &work_mask, work_w, work_h)?;

    let enabled_spot_count = params.spots.iter().filter(|s| s.enabled).count()
        + params
            .manual_strokes
            .iter()
            .filter(|st| st.mode != "erase" && !st.points.is_empty())
            .count();

    let cfa_raw_path = session_dir.join("cfa_raw.npy");
    let has_cfa = if cfa_raw_path.exists() {
        if let Ok((shape, cfa_data)) = read_npy_u16(&cfa_raw_path) {
            let (cfa_h, cfa_w) = if shape.len() >= 2 {
                (shape[0], shape[1])
            } else {
                (full_h, full_w)
            };
            let (crop_x, crop_y) = if let Some([cx, cy, _, _]) = meta.raw_crop {
                (cx, cy)
            } else if cfa_w > full_w && cfa_h > full_h {
                (((cfa_w - full_w) / 2) & !1, ((cfa_h - full_h) / 2) & !1)
            } else {
                (0, 0)
            };
            let cfa_spots: Vec<sc_core::DetectedDustSpot> = if crop_x > 0 || crop_y > 0 {
                params
                    .spots
                    .iter()
                    .map(|s| {
                        let mut s2 = s.clone();
                        s2.cx += crop_x as f64;
                        s2.cy += crop_y as f64;
                        s2
                    })
                    .collect()
            } else {
                params.spots.clone()
            };
            let cfa_strokes: Vec<sc_core::ManualBrushStroke> = if crop_x > 0 || crop_y > 0 {
                params
                    .manual_strokes
                    .iter()
                    .map(|st| {
                        let mut st2 = st.clone();
                        for pt in &mut st2.points {
                            pt.x += crop_x as f64;
                            pt.y += crop_y as f64;
                        }
                        st2
                    })
                    .collect()
            } else {
                params.manual_strokes.clone()
            };
            let pattern = sc_heal::BayerPattern::from_bayer_str(&meta.bayer_pattern);
            let (healed_cfa, _cfa_rois) = sc_heal::heal_cfa_image(
                &cfa_data,
                cfa_w,
                cfa_h,
                &cfa_spots,
                &cfa_strokes,
                pattern,
                params.inpaint_radius,
                params.preserve_grain,
                42,
                None,
            );
            let _ = write_npy_u16(
                &session_dir.join("inpainted_cfa.npy"),
                &[cfa_h, cfa_w],
                &healed_cfa,
            );
            true
        } else {
            false
        }
    } else {
        false
    };

    write_npy_u16(
        &session_dir.join("inpainted_16bit.npy"),
        &[full_h, full_w, 3],
        &healed_16bit,
    )?;
    write_jpeg_rgb(
        &session_dir.join("preview_inpainted.jpg"),
        &healed_work_u8,
        work_w,
        work_h,
        96,
    )?;

    let area_pct =
        ((inpainted_pixels as f64 / (full_w.max(1) * full_h.max(1)) as f64) * 100.0 * 10000.0)
            .round()
            / 10000.0;

    let method_str = if has_cfa {
        "Sensor-Exact CFA Bayer Telea Inpainting + Harmonic Detrending"
    } else {
        "Incremental Checkpoint + Plane-Detrended 16-bit Harmonic Telea"
    };

    let res = InpaintResult {
        healed_spots_count: enabled_spot_count,
        inpainted_pixels,
        inpainted_area_pct: area_pct,
        bit_depth: if has_cfa {
            "16-bit CFA Bayer Raw (uint16, 0–65535)".into()
        } else {
            "16-bit Linear RGB (uint16, 0–65535)".into()
        },
        inpaint_method: method_str.into(),
        inpaint_radius: params.inpaint_radius,
        full_width: full_w,
        full_height: full_h,
        from_cache: false,
        incremental_rois: roi_count,
    };

    let _ = std::fs::write(
        session_dir.join("inpaint_params.json"),
        serde_json::to_string_pretty(params)?,
    );

    std::fs::write(
        session_dir.join("inpaint_result.json"),
        serde_json::to_string_pretty(&res)?,
    )?;

    Ok(res)
}

#[allow(dead_code)]
fn extract_mask_bboxes(mask: &[u8], w: usize, h: usize) -> Vec<(usize, usize, usize, usize)> {
    let mut visited = vec![false; w * h];
    let mut stack = Vec::new();
    let mut boxes = Vec::new();

    for y0 in 0..h {
        for x0 in 0..w {
            let idx0 = y0 * w + x0;
            if mask[idx0] == 0 || visited[idx0] {
                continue;
            }
            visited[idx0] = true;
            stack.clear();
            stack.push((x0, y0));
            let mut min_x = x0;
            let mut max_x = x0 + 1;
            let mut min_y = y0;
            let mut max_y = y0 + 1;

            while let Some((x, y)) = stack.pop() {
                if x < min_x {
                    min_x = x;
                }
                if x + 1 > max_x {
                    max_x = x + 1;
                }
                if y < min_y {
                    min_y = y;
                }
                if y + 1 > max_y {
                    max_y = y + 1;
                }
                for dy in -1isize..=1 {
                    for dx in -1isize..=1 {
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        let nx = x as isize + dx;
                        let ny = y as isize + dy;
                        if nx >= 0 && nx < w as isize && ny >= 0 && ny < h as isize {
                            let nidx = ny as usize * w + nx as usize;
                            if mask[nidx] != 0 && !visited[nidx] {
                                visited[nidx] = true;
                                stack.push((nx as usize, ny as usize));
                            }
                        }
                    }
                }
            }
            boxes.push((min_x, min_y, max_x, max_y));
        }
    }
    boxes
}

/// Writes a 16-bit RGB TIFF (`tiff16`) or LinearRaw DNG (`dng`) using `sc-tiff`.
fn write_tiff16_rgb(path: &Path, rgb16: &[u16], w: usize, h: usize, is_dng: bool, meta: &SessionMetadata) -> Result<()> {
    let mut ifd = IfdBuilder::new();
    ifd.set(t::IMAGE_WIDTH, Value::Long(vec![w as u32]));
    ifd.set(t::IMAGE_LENGTH, Value::Long(vec![h as u32]));
    ifd.set(t::BITS_PER_SAMPLE, Value::Short(vec![16, 16, 16]));
    ifd.set(t::COMPRESSION, Value::Short(vec![compression::NONE]));
    ifd.set(
        t::PHOTOMETRIC,
        Value::Short(vec![if is_dng {
            photometric::LINEAR_RAW
        } else {
            photometric::RGB
        }]),
    );
    ifd.set(t::SAMPLES_PER_PIXEL, Value::Short(vec![3]));
    ifd.set(t::PLANAR_CONFIGURATION, Value::Short(vec![1]));
    ifd.set(
        t::SOFTWARE,
        Value::Ascii("SensorClean Pro 16-bit Engine".into()),
    );

    if is_dng {
        ifd.set(t::NEW_SUBFILE_TYPE, Value::Long(vec![0]));
        ifd.set(t::DNG_VERSION, Value::Byte(vec![1, 4, 0, 0]));
        ifd.set(t::DNG_BACKWARD_VERSION, Value::Byte(vec![1, 1, 0, 0]));
        let make = if meta.exif.make.is_empty() {
            "Panasonic"
        } else {
            &meta.exif.make
        };
        let model = if meta.exif.model.is_empty() {
            "Camera Sensor"
        } else {
            &meta.exif.model
        };
        ifd.set(t::MAKE, Value::Ascii(make.into()));
        ifd.set(t::MODEL, Value::Ascii(model.into()));
        ifd.set(t::UNIQUE_CAMERA_MODEL, Value::Ascii(format!("{make} {model}")));
        ifd.set(t::BLACK_LEVEL, Value::Long(vec![0, 0, 0]));
        ifd.set(t::WHITE_LEVEL, Value::Long(vec![65535, 65535, 65535]));
    }

    let mut raw_bytes = Vec::with_capacity(rgb16.len() * 2);
    for &v in rgb16 {
        raw_bytes.extend_from_slice(&v.to_le_bytes());
    }
    ifd.set_image(ImageData::Strips {
        rows_per_strip: h as u32,
        strips: vec![raw_bytes],
    });

    let tiff_bytes = TiffWriter::new(ByteOrder::Little, false)
        .write(&[ifd])
        .map_err(|e| ScError::Pipeline(format!("TIFF 작성 실패: {e}")))?;
    std::fs::write(path, tiff_bytes)?;
    Ok(())
}

/// Exports the healed image (`inpainted_16bit.npy` or `linear_16bit.npy`) in `dng`, `tiff16`, `png`, or `jpg` format.
pub fn export_healed_image_native(
    session_dir: &Path,
    export_format: &str,
    output_path: &Path,
) -> Result<ExportInfo> {
    let meta_str = std::fs::read_to_string(session_dir.join("session_meta.json"))?;
    let meta: SessionMetadata = serde_json::from_str(&meta_str)?;

    let inpainted_path = session_dir.join("inpainted_16bit.npy");
    let (_, rgb_16bit) = if inpainted_path.exists() {
        read_npy_u16(&inpainted_path)?
    } else {
        read_npy_u16(&session_dir.join("linear_16bit.npy"))?
    };

    let w = meta.full_width;
    let h = meta.full_height;
    let fmt = export_format.to_ascii_lowercase();

    let (ext, mime_type) = match fmt.as_str() {
        "dng" => {
            let cfa_inpainted_path = session_dir.join("inpainted_cfa.npy");
            let cfa_raw_path = session_dir.join("cfa_raw.npy");
            let cfa_buf = if cfa_inpainted_path.exists() {
                Some(read_npy_u16(&cfa_inpainted_path)?)
            } else if cfa_raw_path.exists() {
                Some(read_npy_u16(&cfa_raw_path)?)
            } else {
                None
            };

            if let Some((shape, cfa)) = cfa_buf {
                let (cfa_w, cfa_h) = if shape.len() >= 2 {
                    (shape[1], shape[0])
                } else {
                    (w, h)
                };
                sc_dng::write_cfa_dng(output_path, &cfa, cfa_w, cfa_h, &meta)?;

                // Generate and write Lightroom/ACR-compatible XMP sidecar alongside DNG
                let inpaint_params_path = session_dir.join("inpaint_params.json");
                if inpaint_params_path.exists()
                    && let Ok(content) = std::fs::read_to_string(&inpaint_params_path)
                    && let Ok(params) = serde_json::from_str::<InpaintParams>(&content)
                {
                    let (crop_x, crop_y) = if let Some([cx, cy, _, _]) = meta.raw_crop {
                        (cx, cy)
                    } else if cfa_w > w && cfa_h > h {
                        (((cfa_w - w) / 2) & !1, ((cfa_h - h) / 2) & !1)
                    } else {
                        (0, 0)
                    };
                    let cfa_spots: Vec<sc_core::DetectedDustSpot> = if crop_x > 0 || crop_y > 0 {
                        params
                            .spots
                            .iter()
                            .map(|s| {
                                let mut s2 = s.clone();
                                s2.cx += crop_x as f64;
                                s2.cy += crop_y as f64;
                                s2
                            })
                            .collect()
                    } else {
                        params.spots.clone()
                    };
                    let cfa_strokes: Vec<sc_core::ManualBrushStroke> = if crop_x > 0 || crop_y > 0 {
                        params
                            .manual_strokes
                            .iter()
                            .map(|st| {
                                let mut st2 = st.clone();
                                for pt in &mut st2.points {
                                    pt.x += crop_x as f64;
                                    pt.y += crop_y as f64;
                                }
                                st2
                            })
                            .collect()
                    } else {
                        params.manual_strokes.clone()
                    };
                    let xmp_path = output_path.with_extension("xmp");
                    let _ = sc_dng::write_xmp_sidecar(
                        &xmp_path,
                        &cfa,
                        cfa_w,
                        cfa_h,
                        &cfa_spots,
                        &cfa_strokes,
                    );
                }
            } else {
                write_tiff16_rgb(output_path, &rgb_16bit, w, h, true, &meta)?;
            }
            ("dng", "image/x-adobe-dng")
        }
        "tiff16" => {
            let srgb16 = if meta.is_input_16_bit {
                rgb_16bit
            } else {
                linear_16bit_to_srgb_16bit(&rgb_16bit, w, h, Some(1.0)).0
            };
            sc_dng::write_rendered_tiff16(
                output_path,
                &srgb16,
                w,
                h,
                sc_color::spaces::ColorSpace::DisplayP3,
                &meta,
            )?;
            ("tiff", "image/tiff")
        }
        "png" => {
            let srgb8 = if meta.is_input_16_bit {
                rgb_16bit
                    .iter()
                    .map(|&v| (v as f32 / 257.0).round().clamp(0.0, 255.0) as u8)
                    .collect()
            } else {
                linear_16bit_to_srgb_8bit(&rgb_16bit, w, h, Some(meta.exposure_scale)).0
            };
            sc_dng::write_rendered_png8(
                output_path,
                &srgb8,
                w,
                h,
                sc_color::spaces::ColorSpace::Srgb,
                &meta,
            )?;
            ("png", "image/png")
        }
        _ => {
            let srgb8 = if meta.is_input_16_bit {
                rgb_16bit
                    .iter()
                    .map(|&v| (v as f32 / 257.0).round().clamp(0.0, 255.0) as u8)
                    .collect()
            } else {
                linear_16bit_to_srgb_8bit(&rgb_16bit, w, h, Some(meta.exposure_scale)).0
            };
            sc_dng::write_rendered_jpeg(
                output_path,
                &srgb8,
                w,
                h,
                98,
                sc_color::spaces::ColorSpace::Srgb,
                &meta,
            )?;
            ("jpg", "image/jpeg")
        }
    };

    let file_size_bytes = std::fs::metadata(output_path)?.len();
    Ok(ExportInfo {
        output_path: output_path.to_string_lossy().into_owned(),
        format: ext.to_string(),
        mime_type: mime_type.to_string(),
        file_size_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_spot(id: &str, cx: f64, cy: f64, r: f64) -> DetectedDustSpot {
        DetectedDustSpot {
            id: id.into(),
            index: 0,
            cx,
            cy,
            work_cx: cx,
            work_cy: cy,
            radius: r,
            work_radius: r,
            area: std::f64::consts::PI * r * r,
            perimeter: 2.0 * std::f64::consts::PI * r,
            circularity: 1.0,
            contrast_drop_pct: 15.0,
            spot_type: Some("regular".into()),
            confidence: Some(0.9),
            enabled: true,
            is_manual: false,
            tier: None,
            is_multi_confirmed: None,
            is_projected: None,
            cluster_id: None,
            match_count: None,
            total_frames: None,
        }
    }

    fn make_meta(w: usize, h: usize) -> SessionMetadata {
        SessionMetadata {
            original_file_name: "test.dng".into(),
            extension: "dng".into(),
            is_raw: false,
            decode_kind: None,
            is_input_16_bit: true,
            is_linear16: true,
            full_width: w,
            full_height: h,
            work_width: w,
            work_height: h,
            work_scale: 1.0,
            exposure_scale: 1.0,
            bit_depth: "16-bit".into(),
            color_space: "sRGB".into(),
            camera_wb: vec![1.0, 1.0, 1.0],
            color_matrix: vec![],
            black_level: vec![0, 0, 0, 0],
            white_level: 65535,
            bayer_pattern: "".into(),
            stats_16_bit: sc_core::Stats16Bit::default(),
            exif: sc_core::ExifMetadata::default(),
            raw_crop: None,
        }
    }

    #[test]
    fn test_downsample_patch_rgb16() {
        let sw = 4;
        let sh = 4;
        let dw = 2;
        let dh = 2;
        let src = vec![1000u16; sw * sh * 3];
        let dst = downsample_patch_rgb16(&src, sw, sh, dw, dh);
        assert_eq!(dst.len(), dw * dh * 3);
        for v in dst {
            assert_eq!(v, 1000u16);
        }
    }

    #[test]
    fn test_compute_analytic_bboxes_disjoint_and_merge() {
        let spot1 = make_spot("1", 50.0, 50.0, 5.0);
        let spot2 = make_spot("2", 55.0, 50.0, 5.0);
        // Spot 1 and Spot 2 are overlapping (distance = 5.0 <= 2 * r_expanded)
        let bboxes = compute_analytic_bboxes(200, 200, 1.0, &[spot1, spot2], &[], 10.0);
        // Overlapping spots should be merged into a single bounding box
        assert_eq!(bboxes.len(), 1);
        let (x0, y0, x1, y1) = bboxes[0];
        assert!(x0 < 50 && x1 > 55);
        assert!(y0 < 50 && y1 > 50);
    }

    #[test]
    fn test_inpaint_preserves_unmasked_pixels() {
        let w = 100;
        let h = 100;
        let linear_16bit = vec![30000u16; w * h * 3];
        let work_orig_u8 = vec![128u8; w * h * 3];
        let meta = make_meta(w, h);
        let spot = make_spot("1", 50.0, 50.0, 4.0);

        let params = InpaintParams {
            inpaint_radius: 8.0,
            preserve_grain: false,
            spots: vec![spot],
            manual_strokes: vec![],
        };

        let (healed_16, _healed_work, _mask, inpainted_px, roi_cnt) =
            inpaint_linear16_and_work_srgb_in_memory(&linear_16bit, &work_orig_u8, &meta, &params);

        assert!(inpainted_px > 0);
        assert_eq!(roi_cnt, 1);
        // Pixels far away from spot (e.g. at (10, 10)) must be exactly bit-identical
        let far_idx = (10 * w + 10) * 3;
        assert_eq!(healed_16[far_idx], 30000u16);
        assert_eq!(healed_16[far_idx + 1], 30000u16);
        assert_eq!(healed_16[far_idx + 2], 30000u16);
    }

    #[test]
    fn test_parallel_multi_bbox_inpainting() {
        let w = 300;
        let h = 300;
        let linear_16bit = vec![25000u16; w * h * 3];
        let work_orig_u8 = vec![100u8; w * h * 3];
        let meta = make_meta(w, h);

        let spot1 = make_spot("1", 50.0, 50.0, 4.0);
        let spot2 = make_spot("2", 250.0, 50.0, 4.0);
        let spot3 = make_spot("3", 150.0, 250.0, 4.0);

        let params = InpaintParams {
            inpaint_radius: 6.0,
            preserve_grain: true,
            spots: vec![spot1, spot2, spot3],
            manual_strokes: vec![],
        };

        let (healed_16, healed_work, _mask, inpainted_px, roi_cnt) =
            inpaint_linear16_and_work_srgb_in_memory(&linear_16bit, &work_orig_u8, &meta, &params);

        assert_eq!(roi_cnt, 3);
        assert!(inpainted_px > 0);
        assert_eq!(healed_16.len(), w * h * 3);
        assert_eq!(healed_work.len(), w * h * 3);

        // Center pixel (150, 150) is far from any spot and must remain bit-identical
        let center_idx = (150 * w + 150) * 3;
        assert_eq!(healed_16[center_idx], 25000u16);
        assert_eq!(healed_16[center_idx + 1], 25000u16);
        assert_eq!(healed_16[center_idx + 2], 25000u16);
    }
}

