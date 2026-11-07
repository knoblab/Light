//! Sensor Coordinate Profile Matching and Lens Aperture-Dependent Blur Model.
//!
//! Tracks physical sensor dust spots across different focal lengths, aperture stops,
//! and zoom settings using invariant sensor coordinates.

#![forbid(unsafe_code)]

use sc_core::DetectedDustSpot;

/// Aperture-dependent optical model for sensor dust shadow projection.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ApertureModel {
    /// Reference aperture f-number $f_0$ (e.g. 16.0).
    pub ref_f_number: f64,
    /// Reference spot radius $r_0$ at $f_0$.
    pub ref_radius: f64,
    /// Reference contrast drop percentage $\Delta C_0$ at $f_0$.
    pub ref_contrast_drop: f64,
}

impl ApertureModel {
    pub fn new(ref_f_number: f64, ref_radius: f64, ref_contrast_drop: f64) -> Self {
        Self {
            ref_f_number: ref_f_number.max(1.0),
            ref_radius: ref_radius.max(0.5),
            ref_contrast_drop: ref_contrast_drop.max(0.1),
        }
    }

    /// Predicts expected spot radius at target aperture $f$.
    /// As aperture widens (smaller f-number), the shadow becomes larger and blurrier.
    pub fn predict_radius_at(&self, target_f_number: f64) -> f64 {
        let f_ratio = self.ref_f_number / target_f_number.clamp(1.0, 64.0);
        // Shadow expansion as lens opens up
        self.ref_radius * (1.0 + 0.35 * (f_ratio - 1.0).max(0.0))
    }

    /// Predicts expected contrast drop percentage at target aperture $f$.
    /// As aperture widens, contrast drops sharply (diffuse shadow).
    pub fn predict_contrast_at(&self, target_f_number: f64) -> f64 {
        let f_ratio = target_f_number.clamp(1.0, 64.0) / self.ref_f_number;
        (self.ref_contrast_drop * f_ratio.powf(1.1)).clamp(0.5, 95.0)
    }
}

/// Matches detected dust spots on a new frame against a persistent physical sensor profile.
pub fn match_against_sensor_profile(
    spots: &[DetectedDustSpot],
    profile_spots: &[DetectedDustSpot],
    tolerance_px: f64,
) -> Vec<(usize, Option<usize>)> {
    let mut matches = Vec::with_capacity(spots.len());

    for (s_idx, spot) in spots.iter().enumerate() {
        let mut best_prof_idx = None;
        let mut min_dist = tolerance_px;

        for (p_idx, prof) in profile_spots.iter().enumerate() {
            let dist = (spot.cx - prof.cx).hypot(spot.cy - prof.cy);
            if dist < min_dist {
                min_dist = dist;
                best_prof_idx = Some(p_idx);
            }
        }

        matches.push((s_idx, best_prof_idx));
    }

    matches
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aperture_model_scales_properly() {
        let model = ApertureModel::new(16.0, 8.0, 20.0);

        // At f/8 (wider aperture), radius increases, contrast drops
        let r8 = model.predict_radius_at(8.0);
        let c8 = model.predict_contrast_at(8.0);
        assert!(r8 > 8.0);
        assert!(c8 < 20.0);

        // At f/22 (narrower aperture), contrast increases
        let c22 = model.predict_contrast_at(22.0);
        assert!(c22 > 20.0);
    }
}
