//! CFA Bayer Inpainting via Same-Phase Sub-grid Extraction
//! and Green-Channel Guided Color Difference Telea Harmonic Diffusion.
//!
//! Preserves CFA mosaic phase alignment without demosaicing, ensuring zero color fringing.

#![forbid(unsafe_code)]

use crate::gain_correction::{detrend_cfa_patch, fit_4phase_background_planes, restore_cfa_patch};
use crate::grain::{deterministic_gaussian, estimate_4phase_ring_noise};
use sc_imgproc::inpaint_telea_harmonic_f32;

/// Standard 2x2 Bayer CFA Layout.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum BayerPattern {
    RgGb, // (0,0)=R,  (1,0)=Gr, (0,1)=Gb, (1,1)=B
    BgGr, // (0,0)=B,  (1,0)=Gb, (0,1)=Gr, (1,1)=R
    GrBg, // (0,0)=Gr, (1,0)=R,  (0,1)=B,  (1,1)=Gb
    GbRg, // (0,0)=Gb, (1,0)=B,  (0,1)=R,  (1,1)=Gr
}

impl BayerPattern {
    /// Maps phase index $p = py * 2 + px \in [0..3]$ to color channel: 0=R, 1=G, 2=B.
    #[inline]
    pub fn phase_to_channel(&self, phase: usize) -> usize {
        match self {
            Self::RgGb => match phase {
                0 => 0, // R
                1 => 1, // Gr
                2 => 1, // Gb
                _ => 2, // B
            },
            Self::BgGr => match phase {
                0 => 2, // B
                1 => 1, // Gb
                2 => 1, // Gr
                _ => 0, // R
            },
            Self::GrBg => match phase {
                0 => 1, // Gr
                1 => 0, // R
                2 => 2, // B
                _ => 1, // Gb
            },
            Self::GbRg => match phase {
                0 => 1, // Gb
                1 => 2, // B
                2 => 0, // R
                _ => 1, // Gr
            },
        }
    }

    pub fn from_bayer_str(s: &str) -> Self {
        match s.to_ascii_uppercase().as_str() {
            "BGGR" => Self::BgGr,
            "GRBG" => Self::GrBg,
            "GBRG" => Self::GbRg,
            _ => Self::RgGb,
        }
    }
}

/// Inpaints a CFA ROI patch in-place using same-phase sub-grid extraction,
/// 4-phase linear plane detrending, green-guided color difference Telea harmonic inpainting,
/// deterministic grain synthesis, and continuous alpha feather blending.
#[allow(clippy::too_many_arguments)]
pub fn inpaint_cfa_roi(
    cfa: &[u16],
    alpha: &[f32],
    core_mask: &[u8],
    ring_mask: &[u8],
    rw: usize,
    rh: usize,
    rx0: usize,
    ry0: usize,
    pattern: BayerPattern,
    inpaint_radius: f32,
    preserve_grain: bool,
    grain_seed: u64,
) -> Vec<u16> {
    let total = rw * rh;
    if cfa.len() < total || alpha.len() < total || rw < 4 || rh < 4 {
        return cfa.to_vec();
    }

    // 1. Fit 4-phase background planes on outer ring
    let opt_planes = fit_4phase_background_planes(cfa, ring_mask, rw, rh);
    let (detrended_cfa, plane_vals) = if let Some(ref planes) = opt_planes {
        detrend_cfa_patch(cfa, planes, rw, rh)
    } else {
        (cfa.iter().map(|&v| v as f32).collect(), vec![0.0f32; total])
    };

    // 2. Extract 4 same-phase sub-grids
    let sub_w = rw.div_ceil(2);
    let sub_h = rh.div_ceil(2);
    let sub_total = sub_w * sub_h;

    let mut sub_imgs = [
        vec![0.0f32; sub_total],
        vec![0.0f32; sub_total],
        vec![0.0f32; sub_total],
        vec![0.0f32; sub_total],
    ];
    let mut sub_masks = [
        vec![0u8; sub_total],
        vec![0u8; sub_total],
        vec![0u8; sub_total],
        vec![0u8; sub_total],
    ];

    for y in 0..rh {
        let py = y % 2;
        let sy = y / 2;
        for x in 0..rw {
            let px = x % 2;
            let sx = x / 2;
            let phase = py * 2 + px;
            let full_idx = y * rw + x;
            let sub_idx = sy * sub_w + sx;

            sub_imgs[phase][sub_idx] = detrended_cfa[full_idx];
            if core_mask[full_idx] != 0 {
                sub_masks[phase][sub_idx] = 255;
            }
        }
    }

    let sub_radius = (inpaint_radius * 0.5).clamp(1.5, 12.0);
    let harm_sigma = (sub_w.min(sub_h) as f64 * 0.08).clamp(1.5, 6.0);

    // 3. Identify green and non-green phases
    let mut green_phases = Vec::with_capacity(2);
    let mut red_phases = Vec::with_capacity(1);
    let mut blue_phases = Vec::with_capacity(1);

    for p in 0..4 {
        match pattern.phase_to_channel(p) {
            1 => green_phases.push(p),
            0 => red_phases.push(p),
            _ => blue_phases.push(p),
        }
    }

    // 4. Inpaint green sub-grids first
    let mut healed_sub = sub_imgs.clone();
    for &gp in &green_phases {
        let has_mask = sub_masks[gp].iter().any(|&m| m != 0);
        if has_mask {
            healed_sub[gp] = inpaint_telea_harmonic_f32(
                &sub_imgs[gp],
                &sub_masks[gp],
                sub_w,
                sub_h,
                sub_radius,
                harm_sigma,
            );
        }
    }

    // 5. Compute averaged green guide
    let mut green_avg = vec![0.0f32; sub_total];
    if green_phases.len() == 2 {
        let g0 = &healed_sub[green_phases[0]];
        let g1 = &healed_sub[green_phases[1]];
        for i in 0..sub_total {
            green_avg[i] = 0.5 * (g0[i] + g1[i]);
        }
    } else if let Some(&gp) = green_phases.first() {
        green_avg.copy_from_slice(&healed_sub[gp]);
    }

    // 6. Inpaint Red and Blue using color differences (Channel - GreenAvg)
    for &cp in red_phases.iter().chain(blue_phases.iter()) {
        let has_mask = sub_masks[cp].iter().any(|&m| m != 0);
        if !has_mask {
            continue;
        }

        let mut diff = vec![0.0f32; sub_total];
        for i in 0..sub_total {
            diff[i] = sub_imgs[cp][i] - green_avg[i];
        }

        let healed_diff = inpaint_telea_harmonic_f32(
            &diff,
            &sub_masks[cp],
            sub_w,
            sub_h,
            sub_radius,
            harm_sigma,
        );

        for i in 0..sub_total {
            if sub_masks[cp][i] != 0 {
                healed_sub[cp][i] = green_avg[i] + healed_diff[i];
            }
        }
    }

    // 7. Re-interleave 4 phases back to full ROI size
    let mut healed_detrended = vec![0.0f32; total];
    for y in 0..rh {
        let py = y % 2;
        let sy = y / 2;
        for x in 0..rw {
            let px = x % 2;
            let sx = x / 2;
            let phase = py * 2 + px;
            let full_idx = y * rw + x;
            let sub_idx = sy * sub_w + sx;
            healed_detrended[full_idx] = healed_sub[phase][sub_idx];
        }
    }

    // 8. Restore 4-phase linear planes
    let restored = restore_cfa_patch(&healed_detrended, &plane_vals);

    // 9. Estimate local grain if requested
    let noise_std = if preserve_grain {
        estimate_4phase_ring_noise(cfa, ring_mask, rw, rh)
    } else {
        [0.0; 4]
    };

    // 10. Blend using continuous alpha mask and add deterministic grain
    let mut out = cfa.to_vec();
    for y in 0..rh {
        let py = y % 2;
        let gy = ry0 + y;
        for x in 0..rw {
            let px = x % 2;
            let gx = rx0 + x;
            let phase = py * 2 + px;
            let idx = y * rw + x;

            let a = alpha[idx];
            if a <= 0.0 {
                continue;
            }

            let mut h_val = restored[idx];
            if preserve_grain && noise_std[phase] > 0.5 {
                let g = deterministic_gaussian(gx, gy, phase, grain_seed);
                h_val += g * (noise_std[phase] * 0.85);
            }

            let orig_val = cfa[idx] as f32;
            let blended = orig_val * (1.0 - a) + h_val * a;
            out[idx] = blended.round().clamp(0.0, 65535.0) as u16;
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inpaint_cfa_restores_constant_cfa_patch() {
        let rw = 32usize;
        let rh = 32usize;
        let mut cfa = vec![1000u16; rw * rh];
        let mut core_mask = vec![0u8; rw * rh];
        let mut ring_mask = vec![255u8; rw * rh];
        let mut alpha = vec![0.0f32; rw * rh];

        // Mask center 10x10 hole
        for y in 11..21 {
            for x in 11..21 {
                let idx = y * rw + x;
                core_mask[idx] = 255;
                alpha[idx] = 1.0;
                ring_mask[idx] = 0;
                cfa[idx] = 0; // Corrupted
            }
        }

        let healed = inpaint_cfa_roi(
            &cfa,
            &alpha,
            &core_mask,
            &ring_mask,
            rw,
            rh,
            0,
            0,
            BayerPattern::RgGb,
            4.0,
            false,
            42,
        );

        // Check unmasked are untouched
        for y in 0..rh {
            for x in 0..rw {
                let idx = y * rw + x;
                if alpha[idx] == 0.0 {
                    assert_eq!(healed[idx], 1000);
                } else {
                    assert!(
                        (healed[idx] as i32 - 1000).abs() < 5,
                        "Hole pixel ({x},{y}) healed to {}, expected ~1000",
                        healed[idx]
                    );
                }
            }
        }
    }
}
