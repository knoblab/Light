//! `sc-heal`: Production CFA Bayer Healing & Deterministic Inpainting Engine.
//!
//! Replaces OpenCV 8-bit inpainting and temporary RGB-demosaiced inpainting with:
//! - Sub-pixel continuous SDF analytic masks (spots + capsule brush strokes).
//! - 4-Phase Bayer background plane fit and transmission gain correction.
//! - Same-phase sub-grid green-guided color difference Telea harmonic inpainting.
//! - Deterministic coordinate-hashed SplitMix64 grain synthesis.
//! - Content-addressed dirty ROI cache for sub-millisecond interactive updates.

#![forbid(unsafe_code)]

pub mod analytic_mask;
pub mod cfa_inpaint;
pub mod gain_correction;
pub mod grain;
pub mod roi_cache;

use analytic_mask::CompositeAnalyticMask;
use cfa_inpaint::inpaint_cfa_roi;
pub use cfa_inpaint::BayerPattern;
use roi_cache::{RoiCache, RoiCacheKey};
use sc_core::{DetectedDustSpot, ManualBrushStroke};

/// Bounding box in sensor pixel coordinates.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct BBox {
    pub x0: usize,
    pub y0: usize,
    pub x1: usize,
    pub y1: usize,
}

impl BBox {
    pub fn intersects(&self, other: &Self) -> bool {
        self.x0 < other.x1 && self.x1 > other.x0 && self.y0 < other.y1 && self.y1 > other.y0
    }

    pub fn merge(&self, other: &Self) -> Self {
        Self {
            x0: self.x0.min(other.x0),
            y0: self.y0.min(other.y0),
            x1: self.x1.max(other.x1),
            y1: self.y1.max(other.y1),
        }
    }
}

/// Heals a full-size CFA image using analytic SDF masks and 4-phase Bayer inpainting with cancellation support.
#[allow(clippy::too_many_arguments)]
pub fn heal_cfa_image_cancellable(
    cfa: &[u16],
    width: usize,
    height: usize,
    spots: &[DetectedDustSpot],
    strokes: &[ManualBrushStroke],
    pattern: BayerPattern,
    inpaint_radius: f64,
    preserve_grain: bool,
    grain_seed: u64,
    mut cache: Option<&mut RoiCache>,
    cancel: Option<&sc_core::CancelToken>,
) -> sc_core::Result<(Vec<u16>, usize)> {
    let inpaint_r = inpaint_radius.clamp(3.0, 25.0);
    let composite_mask =
        CompositeAnalyticMask::from_spots_and_strokes(spots, strokes, inpaint_r);

    if composite_mask.add_elements.is_empty() {
        return Ok((cfa.to_vec(), 0));
    }

    let ring_pad = ((inpaint_r * 1.4 + 5.0).round() as usize).max(8);

    // 1. Generate bounding boxes for all active elements
    let mut initial_boxes = Vec::new();
    for elem in &composite_mask.add_elements {
        match elem {
            analytic_mask::AnalyticElement::Circle {
                cx,
                cy,
                core_r,
                feather,
            } => {
                let r = core_r + feather + ring_pad as f64;
                let x0 = ((cx - r).floor() as isize).max(0) as usize;
                let y0 = ((cy - r).floor() as isize).max(0) as usize;
                let x1 = ((cx + r).ceil() as usize).min(width);
                let y1 = ((cy + r).ceil() as usize).min(height);
                if x1 > x0 && y1 > y0 {
                    initial_boxes.push(BBox { x0, y0, x1, y1 });
                }
            }
            analytic_mask::AnalyticElement::CapsuleSegment {
                p0,
                p1,
                core_r,
                feather,
            } => {
                let r = core_r + feather + ring_pad as f64;
                let min_x = p0.x.min(p1.x);
                let max_x = p0.x.max(p1.x);
                let min_y = p0.y.min(p1.y);
                let max_y = p0.y.max(p1.y);
                let x0 = ((min_x - r).floor() as isize).max(0) as usize;
                let y0 = ((min_y - r).floor() as isize).max(0) as usize;
                let x1 = ((max_x + r).ceil() as usize).min(width);
                let y1 = ((max_y + r).ceil() as usize).min(height);
                if x1 > x0 && y1 > y0 {
                    initial_boxes.push(BBox { x0, y0, x1, y1 });
                }
            }
        }
    }

    if initial_boxes.is_empty() {
        return Ok((cfa.to_vec(), 0));
    }

    // 2. Iteratively merge overlapping bounding boxes
    let mut merged_boxes = Vec::new();
    for mut b in initial_boxes {
        let mut did_merge = true;
        while did_merge {
            did_merge = false;
            let mut i = 0;
            while i < merged_boxes.len() {
                if b.intersects(&merged_boxes[i]) {
                    b = b.merge(&merged_boxes[i]);
                    merged_boxes.swap_remove(i);
                    did_merge = true;
                } else {
                    i += 1;
                }
            }
        }
        merged_boxes.push(b);
    }

    let mut out_cfa = cfa.to_vec();
    let mut total_inpainted_pixels = 0usize;

    // Hash of inpainting parameters
    let params_hash = {
        let mut h = grain_seed;
        h = h.wrapping_add((inpaint_r.to_bits()) ^ (preserve_grain as u64));
        h
    };

    // 3. Process each merged ROI
    for b in merged_boxes {
        if let Some(c) = cancel {
            c.check()?;
        }
        // Align bounding box to even 2x2 Bayer boundaries
        let rx0 = b.x0 - (b.x0 % 2);
        let ry0 = b.y0 - (b.y0 % 2);
        let mut rx1 = b.x1;
        if rx1 % 2 != 0 && rx1 < width {
            rx1 += 1;
        }
        let mut ry1 = b.y1;
        if ry1 % 2 != 0 && ry1 < height {
            ry1 += 1;
        }

        let rw = rx1 - rx0;
        let rh = ry1 - ry0;
        if rw < 4 || rh < 4 {
            continue;
        }

        // Extract ROI patch from cfa
        let mut roi_cfa = Vec::with_capacity(rw * rh);
        for y in ry0..ry1 {
            let row_start = y * width + rx0;
            roi_cfa.extend_from_slice(&cfa[row_start..row_start + rw]);
        }

        let cache_key = RoiCacheKey::new(rx0, ry0, rw, rh, params_hash, &roi_cfa);

        let healed_patch = if let Some(ref c) = cache {
            c.get(&cache_key).cloned()
        } else {
            None
        };

        let final_patch = if let Some(cached) = healed_patch {
            cached
        } else {
            // Rasterize analytic maps for this ROI
            let maps = composite_mask.rasterize_roi(rx0, ry0, rw, rh, ring_pad);

            let healed = inpaint_cfa_roi(
                &roi_cfa,
                &maps.alpha,
                &maps.core_mask,
                &maps.ring_mask,
                rw,
                rh,
                rx0,
                ry0,
                pattern,
                inpaint_r as f32,
                preserve_grain,
                grain_seed,
            );

            if let Some(ref mut c) = cache {
                c.insert(cache_key, healed.clone());
            }
            healed
        };

        // Write healed patch back into out_cfa and count modified pixels
        for y in 0..rh {
            let gy = ry0 + y;
            for x in 0..rw {
                let gx = rx0 + x;
                let patch_idx = y * rw + x;
                let full_idx = gy * width + gx;
                let healed_val = final_patch[patch_idx];
                if healed_val != cfa[full_idx] {
                    total_inpainted_pixels += 1;
                    out_cfa[full_idx] = healed_val;
                }
            }
        }
    }

    Ok((out_cfa, total_inpainted_pixels))
}

/// Heals a full-size CFA image using analytic SDF masks and 4-phase Bayer inpainting.
///
/// Guaranteed Invariant: Pixels outside the healed ROIs are strictly bit-identical (`diff == 0`).
#[allow(clippy::too_many_arguments)]
pub fn heal_cfa_image(
    cfa: &[u16],
    width: usize,
    height: usize,
    spots: &[DetectedDustSpot],
    strokes: &[ManualBrushStroke],
    pattern: BayerPattern,
    inpaint_radius: f64,
    preserve_grain: bool,
    grain_seed: u64,
    cache: Option<&mut RoiCache>,
) -> (Vec<u16>, usize) {
    heal_cfa_image_cancellable(
        cfa,
        width,
        height,
        spots,
        strokes,
        pattern,
        inpaint_radius,
        preserve_grain,
        grain_seed,
        cache,
        None,
    )
    .unwrap_or_else(|_| (cfa.to_vec(), 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_cfa_heal_guarantees_bit_exactness_outside_roi() {
        let w = 64usize;
        let h = 64usize;
        let mut cfa = vec![2048u16; w * h];

        // Linear gradient in background with dust spot attenuation at (32, 32)
        for y in 0..h {
            for x in 0..w {
                let dx = x as f64 - 32.0;
                let dy = y as f64 - 32.0;
                let mut val = (1000 + x * 20 + y * 10) as f64;
                if dx * dx + dy * dy <= 16.0 {
                    val *= 0.70; // 30% dust shadow attenuation
                }
                cfa[y * w + x] = val.round() as u16;
            }
        }

        let original = cfa.clone();

        let spot = DetectedDustSpot {
            id: "spot_1".into(),
            index: 0,
            cx: 32.0,
            cy: 32.0,
            work_cx: 0.0,
            work_cy: 0.0,
            radius: 4.0,
            work_radius: 0.0,
            area: 50.0,
            perimeter: 25.0,
            circularity: 0.95,
            contrast_drop_pct: 12.0,
            spot_type: Some("dust".into()),
            confidence: Some(0.95),
            enabled: true,
            is_manual: false,
            tier: None,
            is_multi_confirmed: None,
            is_projected: None,
            cluster_id: None,
            match_count: None,
            total_frames: None,
        };

        let (healed, modified_count) = heal_cfa_image(
            &cfa,
            w,
            h,
            &[spot],
            &[],
            BayerPattern::RgGb,
            5.0,
            false,
            42,
            None,
        );

        assert!(modified_count > 0, "At least some pixels should be healed");

        // Verify that far-away pixels are 100% bit-exact (0 diff)
        let mut diff_count = 0usize;
        for y in 0..h {
            for x in 0..w {
                let dx = x as f64 - 32.0;
                let dy = y as f64 - 32.0;
                let dist = dx.hypot(dy);
                let idx = y * w + x;
                if dist > 20.0 {
                    assert_eq!(
                        healed[idx], original[idx],
                        "Pixel at ({x}, {y}) outside ROI must be bit-exact to original"
                    );
                } else if healed[idx] != original[idx] {
                    diff_count += 1;
                }
            }
        }

        assert_eq!(diff_count, modified_count);
    }

    #[test]
    fn cancellation_stops_healing_immediately() {
        let w = 64usize;
        let h = 64usize;
        let cfa = vec![2048u16; w * h];
        let spot = DetectedDustSpot {
            id: "spot_cancel".into(),
            index: 0,
            cx: 32.0,
            cy: 32.0,
            work_cx: 0.0,
            work_cy: 0.0,
            radius: 4.0,
            work_radius: 0.0,
            area: 50.0,
            perimeter: 25.0,
            circularity: 0.95,
            contrast_drop_pct: 12.0,
            spot_type: Some("dust".into()),
            confidence: Some(0.95),
            enabled: true,
            is_manual: false,
            tier: None,
            is_multi_confirmed: None,
            is_projected: None,
            cluster_id: None,
            match_count: None,
            total_frames: None,
        };

        let cancel = sc_core::CancelToken::new();
        cancel.cancel(); // Pre-cancelled

        let res = heal_cfa_image_cancellable(
            &cfa,
            w,
            h,
            &[spot],
            &[],
            BayerPattern::RgGb,
            5.0,
            false,
            42,
            None,
            Some(&cancel),
        );

        assert!(matches!(res, Err(sc_core::ScError::Cancelled)));
    }
}
