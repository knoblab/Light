//! SensorClean Dual-Branch (Sharp + Bokeh) Sensor Dust Detection & Plane-Detrended Annulus SNR Verifier.
//! Exact 1:1 port of `python/raw_pipeline.py:462-1020` and `1611-1770`.

#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unimplemented,
    clippy::todo,
    clippy::unreachable
)]

pub mod annulus;
pub mod cfa_luma;
pub mod multi;
pub mod noise_model;
pub mod profile;
pub mod tiles;
pub mod workspace;

pub use annulus::{AnnulusEval, AnnulusGrids, eval_single_radius_annulus, verify_annulus_plane_snr};
pub use cfa_luma::{extract_cfa_half_streams, BayerLayout, CfaHalfStreams};
pub use multi::cluster_multi_frame_spots;
pub use noise_model::NoiseModel;
pub use profile::{match_against_sensor_profile, ApertureModel};
pub use tiles::{
    deduplicate_tile_candidates, extract_tile_buffer, generate_tile_specs, TileSpec,
    DEFAULT_HALO, DEFAULT_TILE_SIZE,
};
pub use workspace::DetectionWorkspace;

use rayon::prelude::*;
use sc_color::{median_f32, percentile_f32};
use sc_core::{DetectedDustSpot, DetectionParams, DetectionResult};
use sc_imgproc::{
    dilate_f32, draw_aa_circle_rgb, draw_filled_circle_u8, ellipse_kernel,
    extract_sharp_candidates, gaussian_blur_f32, gaussian_blur_f32_into,
    gradient_magnitude_f32_into, pad_invalid_border_nearest, resize_bilinear_f32,
    resize_inter_area_f32, resize_nearest_bool, upsample_bilinear_f32_into,
};
use std::f64::consts::PI;

#[derive(Clone, Debug)]
struct RawCandidate {
    cx: f64,
    cy: f64,
    work_cx: f64,
    work_cy: f64,
    radius: f64,
    work_radius: f64,
    area: f64,
    perimeter: f64,
    circularity: f64,
    contrast_drop_pct: f64,
    score: f64,
    spot_type: &'static str,
}

#[inline]
fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

#[inline]
fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[inline]
fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// Output of `detect_from_gray`: JSON-serializable `DetectionResult`, `mask_auto` (`work_w × work_h` `u8`),
/// and `viz_bw_edge` (`work_w × work_h × 3` RGB `u8`).
pub struct DetectionOutput {
    pub result: DetectionResult,
    pub mask_auto_u8: Vec<u8>,
    pub viz_bw_edge_rgb: Vec<u8>,
}

/// Runs Dual-Branch Sensor Dust Detection on a `det_w × det_h` perceptual luminance array (`gray_det`)
/// with cooperative cancellation support, using a pre-allocated `DetectionWorkspace` to eliminate allocations.
#[allow(clippy::too_many_arguments)]
pub fn detect_from_gray_cancellable_with_workspace(
    ws: &mut DetectionWorkspace,
    gray_det: &[f32],
    det_w: usize,
    det_h: usize,
    full_w: usize,
    full_h: usize,
    work_w: usize,
    work_h: usize,
    work_scale: f64,
    params: &DetectionParams,
    cancel: Option<&sc_core::CancelToken>,
) -> sc_core::Result<DetectionOutput> {
    let n_det = det_w.saturating_mul(det_h);
    let pyr_w = (det_w / 2).max(1);
    let pyr_h = (det_h / 2).max(1);
    let n_pyr = pyr_w.saturating_mul(pyr_h);

    if det_w == 0 || det_h == 0 || gray_det.len() < n_det {
        return Ok(DetectionOutput {
            result: DetectionResult {
                method: params.method.clone(),
                sensitivity: params.sensitivity,
                cloud_protection: params.cloud_protection,
                min_radius: params.min_radius,
                max_radius: params.max_radius,
                min_circularity: params.min_circularity,
                total_detected: 0,
                sharp_count: 0,
                bokeh_count: 0,
                multi_confirmed_count: None,
                single_frame_count: None,
                projected_count: None,
                spots: Vec::new(),
            },
            mask_auto_u8: vec![0u8; work_w * work_h],
            viz_bw_edge_rgb: vec![0u8; work_w * work_h * 3],
        });
    }

    ws.prepare_for_dims(det_w, det_h, pyr_w, pyr_h, work_w, work_h);

    if let Some(c) = cancel {
        c.check()?;
    }

    let _ = full_h;
    let det_scale = det_w as f64 / full_w.max(1) as f64;
    let method = params.method.to_ascii_lowercase();
    let sensitivity = params.sensitivity;
    let min_radius_full = params.min_radius;
    let max_radius_full = params.max_radius;
    let min_circularity = params.min_circularity;
    let cloud_protection = params.cloud_protection;

    let min_r_det = (min_radius_full * det_scale).max(1.2);
    let max_r_det = (max_radius_full * det_scale).max(min_r_det + 4.0);

    // 1. Pad black letterbox/pillarbox bars (< 8.0) with nearest valid photo pixels
    for i in 0..n_det {
        ws.valid_photo_mask[i] = gray_det[i] >= 8.0;
    }
    let gray_filt_pad = pad_invalid_border_nearest(&gray_det[..n_det], det_w, det_h, 8.0);
    ws.gray_filt.copy_from_slice(&gray_filt_pad);

    if let Some(c) = cancel {
        c.check()?;
    }

    // 2. Regional Background Macro-Std Map (sigma=22) & High-Frequency Foliage Texture Map
    gaussian_blur_f32_into(&ws.gray_filt, &mut ws.tmp_det, &mut ws.s1, det_w, det_h, 0.9);
    gaussian_blur_f32_into(&ws.s1, &mut ws.tmp_det, &mut ws.g8, det_w, det_h, 8.5);
    gaussian_blur_f32_into(&ws.gray_filt, &mut ws.tmp_det, &mut ws.denoise_det, det_w, det_h, 1.8);

    for i in 0..n_det {
        let ok = ws.valid_photo_mask[i];
        ws.s1_masked[i] = if ok { ws.s1[i] } else { 0.0 };
        ws.denoise_masked[i] = if ok { ws.denoise_det[i] } else { 0.0 };
    }

    gaussian_blur_f32_into(&ws.denoise_det, &mut ws.tmp_det, &mut ws.bg_mean_22, det_w, det_h, 22.0);
    ws.bg_diff_sq
        .par_iter_mut()
        .zip(ws.denoise_det.par_iter().zip(ws.bg_mean_22.par_iter()))
        .for_each(|(sq, (&d, &m))| {
            let c = (d - m).max(-3.2);
            *sq = c * c;
        });
    gaussian_blur_f32_into(&ws.bg_diff_sq, &mut ws.tmp_det, &mut ws.bg_sq_22, det_w, det_h, 22.0);
    ws.bg_std_map
        .par_iter_mut()
        .zip(ws.bg_sq_22.par_iter())
        .for_each(|(std, &sq)| {
            *std = sq.max(0.0).sqrt();
        });

    ws.hf_diff_clamped
        .par_iter_mut()
        .zip(ws.s1.par_iter().zip(ws.g8.par_iter()))
        .for_each(|(hf, (&s, &g))| {
            let diff = s - g;
            *hf = diff.abs().min((diff + 2.8).max(2.8));
        });
    gaussian_blur_f32_into(&ws.hf_diff_clamped, &mut ws.tmp_det, &mut ws.hf_texture, det_w, det_h, 18.0);
    gradient_magnitude_f32_into(
        &ws.denoise_det,
        &mut ws.dx_buf,
        &mut ws.dy_buf,
        &mut ws.grad_mag,
        det_w,
        det_h,
        1.5,
    );

    let prot = (0.55 + (cloud_protection / 100.0) * 0.60) as f32;
    let mut raw_candidates: Vec<RawCandidate> = Vec::new();
    ws.combined_vis_det.fill(0.0);

    let run_sharp = matches!(
        method.as_str(),
        "dual" | "multiscale" | "hybrid" | "sharp" | "blackhat"
    );
    let run_bokeh = matches!(
        method.as_str(),
        "dual" | "multiscale" | "hybrid" | "bokeh" | "dog"
    );

    // ─── BRANCH A: Sharp / Focused Sensor Dust Detector ───
    if run_sharp {
        let max_std = 3.45 / prot;
        let max_hf = 1.55 / prot;
        let diff_thresh = (4.10 - (sensitivity / 100.0) * 2.55).max(1.75) as f32;

        ws.bm_sharp.fill(0);
        for i in 0..n_det {
            if ws.valid_photo_mask[i]
                && ws.g8[i] >= 50.0
                && ws.bg_std_map[i] <= max_std
                && ws.hf_texture[i] <= max_hf
            {
                let sd = (ws.g8[i] - ws.s1[i]).max(0.0);
                let vis = sd * 1.4;
                if vis > ws.combined_vis_det[i] {
                    ws.combined_vis_det[i] = vis;
                }
                if sd >= diff_thresh {
                    ws.bm_sharp[i] = 255;
                }
            }
        }

        let comp_cands = extract_sharp_candidates(&ws.bm_sharp, det_w, det_h);
        let grids_ref = &ws.grids;
        let s1_masked_ref = &ws.s1_masked;
        let grad_mag_ref = &ws.grad_mag;
        let bg_std_map_ref = &ws.bg_std_map;
        let hf_texture_ref = &ws.hf_texture;

        let verified_sharp: Vec<RawCandidate> = comp_cands
            .into_par_iter()
            .filter_map(|c| {
                let r_full = c.radius / det_scale;
                if r_full < min_radius_full || r_full > max_radius_full {
                    return None;
                }
                let eval = verify_annulus_plane_snr(
                    grids_ref,
                    s1_masked_ref,
                    grad_mag_ref,
                    bg_std_map_ref,
                    hf_texture_ref,
                    det_w,
                    det_h,
                    c.cx,
                    c.cy,
                    c.radius,
                    true,
                    cloud_protection,
                    sensitivity,
                )?;
                if eval.isotropy < min_circularity {
                    return None;
                }
                let r_full_opt = eval.best_r_det / det_scale;
                let cx_full = c.cx / det_scale;
                let cy_full = c.cy / det_scale;
                Some(RawCandidate {
                    cx: round1(cx_full),
                    cy: round1(cy_full),
                    work_cx: round1(cx_full * work_scale),
                    work_cy: round1(cy_full * work_scale),
                    radius: round1(r_full_opt),
                    work_radius: round1(r_full_opt * work_scale * 1.55 + 2.5),
                    area: round1(c.area / (det_scale * det_scale)),
                    perimeter: round1(2.0 * PI * r_full_opt),
                    circularity: round3(eval.isotropy),
                    contrast_drop_pct: round2(eval.contrast_drop_pct),
                    score: eval.snr * 1.25,
                    spot_type: "sharp",
                })
            })
            .collect();

        raw_candidates.extend(verified_sharp);
    }

    // ─── BRANCH B: Defocused / Bokeh Circular Dust Detector (12-Scale DoG Pyramid) ───
    if run_bokeh {
        let pyr_scale_x = pyr_w as f64 / det_w as f64;
        let pyr_scale_y = pyr_h as f64 / det_h as f64;
        let pyr_scale = 0.5 * (pyr_scale_x + pyr_scale_y);

        let denoise_pyr = resize_inter_area_f32(&ws.denoise_det, det_w, det_h, pyr_w, pyr_h);
        ws.denoise_pyr.copy_from_slice(&denoise_pyr);

        for i in 0..n_det {
            ws.quiet_sky_mask[i] = ws.valid_photo_mask[i]
                && ws.bg_mean_22[i] >= 50.0
                && ws.bg_std_map[i] <= (2.85 / prot)
                && ws.hf_texture[i] <= (1.85 / prot);
        }
        let qsp = resize_nearest_bool(&ws.quiet_sky_mask, det_w, det_h, pyr_w, pyr_h);
        ws.quiet_sky_pyr.copy_from_slice(&qsp);

        let sky_indices: Vec<usize> = ws
            .quiet_sky_pyr
            .iter()
            .enumerate()
            .filter_map(|(idx, &ok)| if ok { Some(idx) } else { None })
            .collect();
        let has_quiet_sky = sky_indices.len() > 100;
        let sky_sub_indices: Vec<usize> = if has_quiet_sky {
            let stride = (sky_indices.len() / 25000).max(1);
            sky_indices.into_iter().step_by(stride).collect()
        } else {
            Vec::new()
        };

        let bokeh_min_r = min_r_det.max(7.2);
        let bokeh_max_r = (max_r_det * 0.98).max(bokeh_min_r + 6.0);
        let num_scales = 8usize;
        let bokeh_radii: Vec<f64> = (0..num_scales)
            .map(|i| {
                let t = i as f64 / (num_scales - 1) as f64;
                bokeh_min_r * (bokeh_max_r / bokeh_min_r).powf(t)
            })
            .collect();

        let denoise_pyr_ref = &ws.denoise_pyr;
        let sky_sub_indices_ref = &sky_sub_indices;

        let scale_bands: Vec<(Vec<f32>, Vec<f32>)> = bokeh_radii
            .par_iter()
            .map(|&r_b| {
                let r_p = r_b * pyr_scale;
                let mut g_in = gaussian_blur_f32(denoise_pyr_ref, pyr_w, pyr_h, r_p * 0.45);
                let mut g_out = gaussian_blur_f32(denoise_pyr_ref, pyr_w, pyr_h, r_p * 1.24);

                // Compute raw_band in-place in g_out
                for i in 0..n_pyr {
                    let go = g_out[i];
                    let gi = g_in[i];
                    g_out[i] = ((go - gi) / go.max(25.0)) * 255.0;
                }

                let mut sample_vals = if has_quiet_sky {
                    sky_sub_indices_ref.iter().map(|&idx| g_out[idx]).collect::<Vec<f32>>()
                } else {
                    let mut v = Vec::with_capacity((pyr_h.div_ceil(2)) * (pyr_w.div_ceil(2)));
                    for y in (0..pyr_h).step_by(2) {
                        for x in (0..pyr_w).step_by(2) {
                            v.push(g_out[y * pyr_w + x]);
                        }
                    }
                    v
                };

                let med = median_f32(&mut sample_vals) as f32;
                let mut abs_dev: Vec<f32> =
                    sample_vals.iter().map(|&v| (v - med).abs()).collect();
                let mad_sky = (median_f32(&mut abs_dev) * 1.4826) as f32;
                let eff_mad = mad_sky.max(0.16);
                let scale_weight = (r_b / bokeh_min_r).powf(-0.05) as f32;

                // In-place transform: g_in becomes z_b, g_out becomes c_b
                for i in 0..n_pyr {
                    let diff = (g_out[i] - med).max(0.0);
                    g_in[i] = diff / eff_mad;
                    g_out[i] = diff * scale_weight;
                }
                (g_in, g_out)
            })
            .collect();

        ws.max_z_pyr.fill(0.0);
        ws.best_c_pyr.fill(f32::NEG_INFINITY);
        ws.bokeh_best_idx_pyr.fill(0);

        for (s_idx, (z_b, c_b)) in scale_bands.iter().enumerate() {
            for i in 0..n_pyr {
                if z_b[i] > ws.max_z_pyr[i] {
                    ws.max_z_pyr[i] = z_b[i];
                }
                if c_b[i] > ws.best_c_pyr[i] {
                    ws.best_c_pyr[i] = c_b[i];
                    ws.bokeh_best_idx_pyr[i] = s_idx;
                }
            }
        }

        gaussian_blur_f32_into(
            &ws.max_z_pyr,
            &mut ws.pyr_scratch_a,
            &mut ws.bokeh_max_z_pyr,
            pyr_w,
            pyr_h,
            0.8,
        );
        upsample_bilinear_f32_into(
            &ws.bokeh_max_z_pyr,
            pyr_w,
            pyr_h,
            &mut ws.bokeh_max_z,
            det_w,
            det_h,
        );

        let max_vis_std = 3.0 / prot;
        for i in 0..n_det {
            if ws.valid_photo_mask[i]
                && ws.bg_mean_22[i] >= 50.0
                && ws.bg_std_map[i] <= max_vis_std
                && ws.bokeh_max_z[i] > ws.combined_vis_det[i]
            {
                ws.combined_vis_det[i] = ws.bokeh_max_z[i];
            }
        }

        let z_thresh = (4.42 - (sensitivity / 100.0) * 3.00).max(1.35) as f32;
        let nms_k_pyr = (((bokeh_min_r * pyr_scale * 1.85).round() as usize) | 1).max(7);
        let k_ell = ellipse_kernel(nms_k_pyr, nms_k_pyr);
        let local_max_pyr =
            dilate_f32(&ws.bokeh_max_z_pyr, pyr_w, pyr_h, nms_k_pyr, nms_k_pyr, &k_ell);

        let mut peaks = Vec::new();
        for py_p in 0..pyr_h {
            for px_p in 0..pyr_w {
                let idx_p = py_p * pyr_w + px_p;
                let z = ws.bokeh_max_z_pyr[idx_p];
                if z >= z_thresh && z >= local_max_pyr[idx_p] - 1e-4 {
                    peaks.push((px_p, py_p, ws.bokeh_best_idx_pyr[idx_p]));
                }
            }
        }

        let max_bokeh_std = 2.75 / prot;
        let grids_ref = &ws.grids;
        let denoise_masked_ref = &ws.denoise_masked;
        let grad_mag_ref = &ws.grad_mag;
        let bg_std_map_ref = &ws.bg_std_map;
        let hf_texture_ref = &ws.hf_texture;
        let valid_photo_mask_ref = &ws.valid_photo_mask;
        let bg_mean_22_ref = &ws.bg_mean_22;
        let denoise_det_ref = &ws.denoise_det;

        let verified_bokeh: Vec<RawCandidate> = peaks
            .into_par_iter()
            .filter_map(|(px_p, py_p, best_idx)| {
                let px = ((px_p as f64 / pyr_scale_x).round() as usize).min(det_w - 1);
                let py = ((py_p as f64 / pyr_scale_y).round() as usize).min(det_h - 1);
                let det_idx = py * det_w + px;
                if !valid_photo_mask_ref[det_idx]
                    || bg_mean_22_ref[det_idx] < 50.0
                    || bg_std_map_ref[det_idx] > max_bokeh_std
                {
                    return None;
                }

                // Refine dark center inside 3x3 full-res neighborhood
                let y_lo = py.saturating_sub(1);
                let y_hi = (py + 2).min(det_h);
                let x_lo = px.saturating_sub(1);
                let x_hi = (px + 2).min(det_w);
                let mut min_v = f32::INFINITY;
                let mut px_ref = px;
                let mut py_ref = py;
                for yy in y_lo..y_hi {
                    for xx in x_lo..x_hi {
                        let v = denoise_det_ref[yy * det_w + xx];
                        if v < min_v {
                            min_v = v;
                            px_ref = xx;
                            py_ref = yy;
                        }
                    }
                }

                let best_r_d = bokeh_radii[best_idx];
                let eval = verify_annulus_plane_snr(
                    grids_ref,
                    denoise_masked_ref,
                    grad_mag_ref,
                    bg_std_map_ref,
                    hf_texture_ref,
                    det_w,
                    det_h,
                    px_ref as f64,
                    py_ref as f64,
                    best_r_d,
                    false,
                    cloud_protection,
                    sensitivity,
                )?;
                if eval.isotropy < min_circularity {
                    return None;
                }

                let r_full = eval.best_r_det / det_scale;
                if r_full < min_radius_full || r_full > max_radius_full {
                    return None;
                }

                let cx_full = px_ref as f64 / det_scale;
                let cy_full = py_ref as f64 / det_scale;
                Some(RawCandidate {
                    cx: round1(cx_full),
                    cy: round1(cy_full),
                    work_cx: round1(cx_full * work_scale),
                    work_cy: round1(cy_full * work_scale),
                    radius: round1(r_full),
                    work_radius: round1(r_full * work_scale * 1.72 + 2.0),
                    area: round1(PI * r_full * r_full),
                    perimeter: round1(2.0 * PI * r_full),
                    circularity: round3(eval.isotropy),
                    contrast_drop_pct: round2(eval.contrast_drop_pct),
                    score: eval.snr,
                    spot_type: "bokeh",
                })
            })
            .collect();

        raw_candidates.extend(verified_bokeh);
    }

    // ─── Unified Non-Maximum Suppression across both Sharp and Bokeh branches ───
    raw_candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut accepted_spots: Vec<DetectedDustSpot> = Vec::new();

    for cand in raw_candidates {
        let is_dup = accepted_spots.iter().any(|kept| {
            let dist = (cand.cx - kept.cx).hypot(cand.cy - kept.cy);
            let min_sep = cand.radius.max(kept.radius) * 0.85;
            dist < min_sep
        });
        if !is_dup {
            let spot_idx = accepted_spots.len() + 1;
            accepted_spots.push(DetectedDustSpot {
                id: format!("dust-{spot_idx}"),
                index: spot_idx,
                cx: cand.cx,
                cy: cand.cy,
                work_cx: cand.work_cx,
                work_cy: cand.work_cy,
                radius: cand.radius,
                work_radius: cand.work_radius,
                area: cand.area,
                perimeter: cand.perimeter,
                circularity: cand.circularity,
                contrast_drop_pct: cand.contrast_drop_pct,
                spot_type: Some(cand.spot_type.to_string()),
                confidence: None,
                enabled: true,
                is_manual: false,
                tier: None,
                is_multi_confirmed: None,
                is_projected: None,
                cluster_id: None,
                match_count: None,
                total_frames: None,
            });
        }
    }

    // ─── Build `mask_auto` and `viz_bw_edge` at working resolution `(work_w, work_h)` ───
    ws.mask_auto_u8.fill(0);
    for sp in &accepted_spots {
        let r = (sp.work_radius.round() as isize).max(2);
        draw_filled_circle_u8(
            &mut ws.mask_auto_u8,
            work_w,
            work_h,
            sp.work_cx.round() as isize,
            sp.work_cy.round() as isize,
            r,
            255,
        );
    }

    let vis_work = if (det_w, det_h) != (work_w, work_h) {
        resize_bilinear_f32(&ws.combined_vis_det, det_w, det_h, work_w, work_h)
    } else {
        ws.combined_vis_det.clone()
    };
    let mut vis_sorted = vis_work.clone();
    let vis_scale = percentile_f32(&mut vis_sorted, 99.3).max(2.5) as f32;

    ws.viz_bw_edge_rgb.fill(0);
    for (i, &v) in vis_work.iter().enumerate() {
        let z = ((v / vis_scale) * 215.0).round().clamp(0.0, 255.0) as u8;
        let base = i * 3;
        ws.viz_bw_edge_rgb[base] = z;
        ws.viz_bw_edge_rgb[base + 1] = z;
        ws.viz_bw_edge_rgb[base + 2] = z;
    }
    for sp in &accepted_spots {
        let r_viz = (sp.radius * work_scale).round().max(3.0);
        draw_aa_circle_rgb(
            &mut ws.viz_bw_edge_rgb,
            work_w,
            work_h,
            sp.work_cx,
            sp.work_cy,
            r_viz,
            [255, 255, 255],
        );
    }

    let sharp_count = accepted_spots
        .iter()
        .filter(|s| s.spot_type.as_deref() == Some("sharp"))
        .count();
    let bokeh_count = accepted_spots
        .iter()
        .filter(|s| s.spot_type.as_deref() == Some("bokeh"))
        .count();

    let result = DetectionResult {
        method,
        sensitivity,
        cloud_protection,
        min_radius: min_radius_full,
        max_radius: max_radius_full,
        min_circularity,
        total_detected: accepted_spots.len(),
        sharp_count,
        bokeh_count,
        multi_confirmed_count: None,
        single_frame_count: None,
        projected_count: None,
        spots: accepted_spots,
    };

    Ok(DetectionOutput {
        result,
        mask_auto_u8: ws.mask_auto_u8.clone(),
        viz_bw_edge_rgb: ws.viz_bw_edge_rgb.clone(),
    })
}

/// Runs Dual-Branch Sensor Dust Detection on a `det_w × det_h` perceptual luminance array (`gray_det`)
/// using a pre-allocated `DetectionWorkspace`.
#[allow(clippy::too_many_arguments)]
pub fn detect_from_gray_with_workspace(
    ws: &mut DetectionWorkspace,
    gray_det: &[f32],
    det_w: usize,
    det_h: usize,
    full_w: usize,
    full_h: usize,
    work_w: usize,
    work_h: usize,
    work_scale: f64,
    params: &DetectionParams,
) -> DetectionOutput {
    detect_from_gray_cancellable_with_workspace(
        ws, gray_det, det_w, det_h, full_w, full_h, work_w, work_h, work_scale, params, None,
    )
    .unwrap_or_else(|_| DetectionOutput {
        result: DetectionResult {
            method: params.method.clone(),
            sensitivity: params.sensitivity,
            cloud_protection: params.cloud_protection,
            min_radius: params.min_radius,
            max_radius: params.max_radius,
            min_circularity: params.min_circularity,
            total_detected: 0,
            sharp_count: 0,
            bokeh_count: 0,
            multi_confirmed_count: None,
            single_frame_count: None,
            projected_count: None,
            spots: Vec::new(),
        },
        mask_auto_u8: vec![0u8; work_w * work_h],
        viz_bw_edge_rgb: vec![0u8; work_w * work_h * 3],
    })
}

/// Runs Dual-Branch Sensor Dust Detection on a `det_w × det_h` perceptual luminance array (`gray_det`)
/// with cooperative cancellation support.
#[allow(clippy::too_many_arguments)]
pub fn detect_from_gray_cancellable(
    gray_det: &[f32],
    det_w: usize,
    det_h: usize,
    full_w: usize,
    full_h: usize,
    work_w: usize,
    work_h: usize,
    work_scale: f64,
    params: &DetectionParams,
    cancel: Option<&sc_core::CancelToken>,
) -> sc_core::Result<DetectionOutput> {
    let mut ws = DetectionWorkspace::new();
    detect_from_gray_cancellable_with_workspace(
        &mut ws, gray_det, det_w, det_h, full_w, full_h, work_w, work_h, work_scale, params, cancel,
    )
}

/// Runs Dual-Branch Sensor Dust Detection on a `det_w × det_h` perceptual luminance array (`gray_det`),
/// matching `detect_sensor_dust` in `raw_pipeline.py:677-1020`.
#[allow(clippy::too_many_arguments)]
pub fn detect_from_gray(
    gray_det: &[f32],
    det_w: usize,
    det_h: usize,
    full_w: usize,
    full_h: usize,
    work_w: usize,
    work_h: usize,
    work_scale: f64,
    params: &DetectionParams,
) -> DetectionOutput {
    let mut ws = DetectionWorkspace::new();
    detect_from_gray_with_workspace(
        &mut ws, gray_det, det_w, det_h, full_w, full_h, work_w, work_h, work_scale, params,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_stops_detection_immediately() {
        let w = 128usize;
        let h = 128usize;
        let gray = vec![128.0f32; w * h];
        let params = DetectionParams::default();
        let cancel = sc_core::CancelToken::new();
        cancel.cancel(); // Pre-cancelled

        let res = detect_from_gray_cancellable(
            &gray, w, h, w, h, w, h, 1.0, &params, Some(&cancel),
        );
        assert!(matches!(res, Err(sc_core::ScError::Cancelled)));
    }
}
