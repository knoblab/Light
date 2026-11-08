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
    resize_inter_area_u16_rgb, resize_nearest_u8,
};
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

/// Fast boundary-weighted Telea / inverse-distance harmonic fill on a detrended 2D ROI patch.
/// For every masked pixel `(x, y)` (`mask[y * rw + x] != 0`), interpolates from surrounding
/// unmasked boundary pixels weighted by `1 / (dist^2 + 1)^1.5`, followed by Gaussian harmonic smoothing.
fn telea_harmonic_fill_roi(
    detrended: &[f32],
    mask: &[u8],
    rw: usize,
    rh: usize,
    harm_sigma: f64,
) -> Vec<f32> {
    // Collect boundary pixels: unmasked pixels (`mask == 0`) that have at least one masked 8-neighbour
    let mut boundary_pts: Vec<(f32, f32, f32)> = Vec::new();
    for y in 0..rh {
        for x in 0..rw {
            if mask[y * rw + x] != 0 {
                continue;
            }
            let mut adj = false;
            for dy in -1isize..=1 {
                for dx in -1isize..=1 {
                    let ny = y as isize + dy;
                    let nx = x as isize + dx;
                    if ny >= 0
                        && ny < rh as isize
                        && nx >= 0
                        && nx < rw as isize
                        && mask[ny as usize * rw + nx as usize] != 0
                    {
                        adj = true;
                        break;
                    }
                }
                if adj {
                    break;
                }
            }
            if adj {
                boundary_pts.push((x as f32, y as f32, detrended[y * rw + x]));
            }
        }
    }

    let mut telea = detrended.to_vec();
    if !boundary_pts.is_empty() {
        let stride = (boundary_pts.len() / 256).max(1);
        for y in 0..rh {
            for x in 0..rw {
                let idx = y * rw + x;
                if mask[idx] == 0 {
                    continue;
                }
                let fx = x as f32;
                let fy = y as f32;
                let mut w_sum = 0.0f32;
                let mut v_sum = 0.0f32;
                for &(bx, by, bv) in boundary_pts.iter().step_by(stride) {
                    let d2 = (fx - bx).powi(2) + (fy - by).powi(2) + 1.0;
                    let w = 1.0 / (d2 * d2.sqrt());
                    w_sum += w;
                    v_sum += w * bv;
                }
                if w_sum > 1e-12 {
                    telea[idx] = v_sum / w_sum;
                } else {
                    telea[idx] = 0.0;
                }
            }
        }
    } else {
        for i in 0..(rw * rh) {
            if mask[i] != 0 {
                telea[i] = 0.0;
            }
        }
    }

    let smooth = gaussian_blur_f32(&telea, rw, rh, harm_sigma);
    let mut filled = Vec::with_capacity(rw * rh);
    for i in 0..(rw * rh) {
        filled.push(0.45 * telea[i] + 0.55 * smooth[i]);
    }
    filled
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
    let skirt_pad_px = ((inpaint_r * 0.45).round() as usize).max(2);
    let feather_px = ((inpaint_r * 0.70).round() as usize).max(3);
    let feather_sigma = (feather_px as f64 * 0.55).max(2.0);
    let ring_width_px = ((inpaint_r * 1.4 + 5.0).round() as usize).max(7);
    let ring_pad = ring_width_px + 4;

    let work_mask = build_combined_mask(
        work_h,
        work_w,
        work_scale,
        &params.spots,
        &params.manual_strokes,
    );

    let full_mask = if (full_w, full_h) != (work_w, work_h) {
        resize_nearest_u8(&work_mask, work_w, work_h, full_w, full_h)
    } else {
        work_mask.clone()
    };

    let kw_skirt = skirt_pad_px * 2 + 1;
    let k_skirt = ellipse_kernel(kw_skirt, kw_skirt);
    let full_mask_core = dilate_u8(&full_mask, full_w, full_h, kw_skirt, kw_skirt, &k_skirt);
    let inpainted_pixels = full_mask_core.iter().filter(|&&v| v != 0).count();

    let mut healed_16bit = linear_16bit.to_vec();
    let mut healed_work_u8 = work_orig_u8.to_vec();
    let mut roi_count = 0usize;

    if inpainted_pixels > 0 {
        let kw_feather = feather_px * 2 + 1;
        let k_feather = ellipse_kernel(kw_feather, kw_feather);
        let full_mask_expanded =
            dilate_u8(&full_mask_core, full_w, full_h, kw_feather, kw_feather, &k_feather);

        // Extract connected component bounding boxes of `full_mask_expanded`
        let bboxes = extract_mask_bboxes(&full_mask_expanded, full_w, full_h);
        let kw_ring = ring_width_px * 2 + 1;
        let k_ring = ellipse_kernel(kw_ring, kw_ring);
        let mut rng = DeterministicRng::new(42);
        let lut_u8 = if !is_input_16bit {
            Some(build_srgb_u8_lut(exposure_scale))
        } else {
            None
        };

        for (x0, y0, x1, y1) in bboxes {
            let bx1 = x0.saturating_sub(ring_pad);
            let by1 = y0.saturating_sub(ring_pad);
            let bx2 = (x1 + ring_pad).min(full_w);
            let by2 = (y1 + ring_pad).min(full_h);
            let rw = bx2 - bx1;
            let rh = by2 - by1;
            if rw == 0 || rh == 0 {
                continue;
            }
            roi_count += 1;

            let mut roi_expanded = vec![0u8; rw * rh];
            let mut roi_core = vec![0u8; rw * rh];
            let mut any_core = false;
            for y in 0..rh {
                for x in 0..rw {
                    let g_idx = (by1 + y) * full_w + (bx1 + x);
                    let exp_v = full_mask_expanded[g_idx];
                    roi_expanded[y * rw + x] = exp_v;
                    if exp_v > 0 && full_mask_core[g_idx] > 0 {
                        roi_core[y * rw + x] = 255;
                        any_core = true;
                    }
                }
            }
            if !any_core {
                continue;
            }

            let exp_f32: Vec<f32> = roi_expanded.iter().map(|&v| v as f32 / 255.0).collect();
            let mut roi_alpha = gaussian_blur_f32(&exp_f32, rw, rh, feather_sigma);
            for i in 0..(rw * rh) {
                if roi_core[i] > 0 {
                    roi_alpha[i] = 1.0;
                } else {
                    roi_alpha[i] = (roi_alpha[i] * 1.12).clamp(0.0, 1.0);
                }
            }

            let roi_outer_dilated =
                dilate_u8(&roi_expanded, rw, rh, kw_ring, kw_ring, &k_ring);

            let mut ring_coords: Vec<(usize, usize)> = Vec::new();
            for y in 0..rh {
                for x in 0..rw {
                    let r_idx = y * rw + x;
                    let g_idx = (by1 + y) * full_w + (bx1 + x);
                    if roi_outer_dilated[r_idx] > 0 && full_mask_expanded[g_idx] == 0 {
                        ring_coords.push((x, y));
                    }
                }
            }

            let half_rw = (rw as f32 * 0.5).max(1.0);
            let half_rh = (rh as f32 * 0.5).max(1.0);

            // Fit 1st-order plane per RGB channel on [15%, 85%] trimmed green-channel ring pixels
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
                let mut res_g: Vec<f32> = (0..ring_coords.len())
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
                let _ = &mut res_g;
                if rx_c.len() >= 12 {
                    coeffs_3ch = Some([
                        fast_fit_plane(&rx_c, &ry_c, &ch_vals[0]),
                        fast_fit_plane(&rx_c, &ry_c, &ch_vals[1]),
                        fast_fit_plane(&rx_c, &ry_c, &ch_vals[2]),
                    ]);
                }
            }

            let harm_sigma = (rw.min(rh) as f64 * 0.10).clamp(2.0, 8.0);

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
                        if alpha <= 0.0 {
                            continue;
                        }
                        let mut h_val = roi_healed[r_idx];
                        if grain_std > 1.0 {
                            h_val += rng.next_gaussian() * (grain_std * 0.85);
                        }
                        let g_idx = ((by1 + y) * full_w + (bx1 + x)) * 3 + ch;
                        let base_val = healed_16bit[g_idx] as f32;
                        let blended = base_val * (1.0 - alpha) + h_val * alpha;
                        healed_16bit[g_idx] = blended.round().clamp(0.0, 65535.0) as u16;
                    }
                }
            }

            // Update working preview checkpoint on this ROI
            let wx1 = ((bx1 as f64 * work_scale).floor() as usize).min(work_w);
            let wy1 = ((by1 as f64 * work_scale).floor() as usize).min(work_h);
            let wx2 = ((bx2 as f64 * work_scale).ceil() as usize).min(work_w);
            let wy2 = ((by2 as f64 * work_scale).ceil() as usize).min(work_h);
            if wx2 > wx1 && wy2 > wy1 {
                let mut patch_16 = Vec::with_capacity(rw * rh * 3);
                for y in by1..by2 {
                    let row = &healed_16bit[y * full_w * 3..(y + 1) * full_w * 3];
                    patch_16.extend_from_slice(&row[bx1 * 3..bx2 * 3]);
                }
                let ww_p = wx2 - wx1;
                let wh_p = wy2 - wy1;
                let patch_work = if (rw, rh) != (ww_p, wh_p) {
                    resize_inter_area_u16_rgb(&patch_16, rw, rh, ww_p, wh_p)
                } else {
                    patch_16
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
