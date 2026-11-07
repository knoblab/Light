//! Continuous Signed Distance Field (SDF) analytic masks for circle dust spots
//! and capsule manual brush strokes with cosine/Gaussian smooth feathering.
//!
//! Provides sub-pixel accurate alpha evaluation anchored to CFA sensor space.

#![forbid(unsafe_code)]

use sc_core::{BrushPoint, DetectedDustSpot, ManualBrushStroke};
use std::f64::consts::PI;

/// A geometric element that can evaluate signed distance: negative inside, positive outside.
#[derive(Clone, Debug)]
pub enum AnalyticElement {
    Circle {
        cx: f64,
        cy: f64,
        core_r: f64,
        feather: f64,
    },
    CapsuleSegment {
        p0: BrushPoint,
        p1: BrushPoint,
        core_r: f64,
        feather: f64,
    },
}

impl AnalyticElement {
    /// Computes the signed distance $\phi(\vec{x})$ to the outer feathered boundary.
    /// $\phi \le -\text{feather}$ is the 100% solid core.
    /// $\phi = 0$ is the outer boundary ($\alpha = 0$).
    #[inline]
    pub fn signed_distance(&self, x: f64, y: f64) -> (f64, f64) {
        match self {
            Self::Circle {
                cx,
                cy,
                core_r,
                feather,
            } => {
                let dx = x - cx;
                let dy = y - cy;
                let d = dx.hypot(dy);
                // Outer radius = core_r + feather
                let outer_r = *core_r + *feather;
                (d - outer_r, *feather)
            }
            Self::CapsuleSegment {
                p0,
                p1,
                core_r,
                feather,
            } => {
                let vx = p1.x - p0.x;
                let vy = p1.y - p0.y;
                let ux = x - p0.x;
                let uy = y - p0.y;
                let v_len2 = vx * vx + vy * vy;
                let t = if v_len2 > 1e-12 {
                    ((ux * vx + uy * vy) / v_len2).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                let px = p0.x + t * vx;
                let py = p0.y + t * vy;
                let d = (x - px).hypot(y - py);
                let outer_r = *core_r + *feather;
                (d - outer_r, *feather)
            }
        }
    }
}

/// Composite continuous mask made of additive spots/strokes and subtractive erase strokes.
#[derive(Clone, Debug, Default)]
pub struct CompositeAnalyticMask {
    pub add_elements: Vec<AnalyticElement>,
    pub erase_elements: Vec<AnalyticElement>,
}

impl CompositeAnalyticMask {
    pub fn new() -> Self {
        Self::default()
    }

    /// Builds a composite mask from detected spots and manual brush strokes in sensor coordinates.
    pub fn from_spots_and_strokes(
        spots: &[DetectedDustSpot],
        strokes: &[ManualBrushStroke],
        inpaint_radius: f64,
    ) -> Self {
        let mut mask = Self::new();
        let inpaint_r = inpaint_radius.clamp(3.0, 25.0);
        let feather = (inpaint_r * 0.70).max(3.0);

        for spot in spots {
            if !spot.enabled {
                continue;
            }
            let skirt_mult = if spot.spot_type.as_deref() == Some("bokeh") {
                1.72
            } else {
                1.55
            };
            let core_r = (spot.radius * skirt_mult + 2.0).max(3.0);
            mask.add_elements.push(AnalyticElement::Circle {
                cx: spot.cx,
                cy: spot.cy,
                core_r,
                feather,
            });
        }

        for stroke in strokes {
            let is_erase = stroke.mode == "erase";
            let r = stroke.radius.max(2.0);
            let pts = &stroke.points;
            if pts.len() == 1 {
                let elem = AnalyticElement::Circle {
                    cx: pts[0].x,
                    cy: pts[0].y,
                    core_r: r,
                    feather,
                };
                if is_erase {
                    mask.erase_elements.push(elem);
                } else {
                    mask.add_elements.push(elem);
                }
            } else if pts.len() > 1 {
                for i in 0..(pts.len() - 1) {
                    let elem = AnalyticElement::CapsuleSegment {
                        p0: pts[i],
                        p1: pts[i + 1],
                        core_r: r,
                        feather,
                    };
                    if is_erase {
                        mask.erase_elements.push(elem);
                    } else {
                        mask.add_elements.push(elem);
                    }
                }
            }
        }

        mask
    }

    /// Evaluates continuous feather alpha $\alpha \in [0.0, 1.0]$ at sensor coordinate `(x, y)`.
    #[inline]
    pub fn evaluate_alpha(&self, x: f64, y: f64) -> f32 {
        if self.add_elements.is_empty() {
            return 0.0;
        }

        // Find min signed distance among additive elements
        let mut min_phi = f64::INFINITY;
        let mut active_feather = 3.0;

        for elem in &self.add_elements {
            let (phi, fth) = elem.signed_distance(x, y);
            if phi < min_phi {
                min_phi = phi;
                active_feather = fth;
            }
        }

        if min_phi >= 0.0 {
            return 0.0;
        }

        // Cosine feathering between outer boundary (0.0) and inner solid core (-feather)
        let mut alpha = if min_phi <= -active_feather {
            1.0f32
        } else {
            let norm = (min_phi + active_feather) / active_feather; // 0..1
            0.5 * (1.0 + (PI * (1.0 - norm)).cos() as f32)
        };

        // If there are erase strokes, subtract them
        if !self.erase_elements.is_empty() {
            let mut erase_min_phi = f64::INFINITY;
            let mut erase_feather = 3.0;
            for elem in &self.erase_elements {
                let (phi, fth) = elem.signed_distance(x, y);
                if phi < erase_min_phi {
                    erase_min_phi = phi;
                    erase_feather = fth;
                }
            }
            if erase_min_phi < 0.0 {
                let erase_alpha = if erase_min_phi <= -erase_feather {
                    1.0f32
                } else {
                    let norm = (erase_min_phi + erase_feather) / erase_feather;
                    0.5 * (1.0 + (PI * (1.0 - norm)).cos() as f32)
                };
                alpha = (alpha - erase_alpha).max(0.0);
            }
        }

        alpha
    }

    /// Rasterizes the alpha values and core/ring masks for a given rectangular ROI in sensor coordinates.
    pub fn rasterize_roi(
        &self,
        rx0: usize,
        ry0: usize,
        rw: usize,
        rh: usize,
        ring_pad: usize,
    ) -> RoiMaskMaps {
        let total = rw * rh;
        let mut alpha = vec![0.0f32; total];
        let mut core_mask = vec![0u8; total];
        let mut ring_mask = vec![0u8; total];

        let ring_outer = ring_pad as f64;

        for y in 0..rh {
            let gy = (ry0 + y) as f64;
            for x in 0..rw {
                let gx = (rx0 + x) as f64;
                let a = self.evaluate_alpha(gx, gy);
                let idx = y * rw + x;
                alpha[idx] = a;
                if a > 0.01 {
                    if a >= 0.99 {
                        core_mask[idx] = 255;
                    }
                } else {
                    // Check if within ring_pad of any add element
                    for elem in &self.add_elements {
                        let (phi, _) = elem.signed_distance(gx, gy);
                        if phi > 0.0 && phi <= ring_outer {
                            ring_mask[idx] = 255;
                            break;
                        }
                    }
                }
            }
        }

        RoiMaskMaps {
            alpha,
            core_mask,
            ring_mask,
            rw,
            rh,
        }
    }
}

/// Pre-rasterized maps for a single ROI.
pub struct RoiMaskMaps {
    pub alpha: Vec<f32>,
    pub core_mask: Vec<u8>,
    pub ring_mask: Vec<u8>,
    pub rw: usize,
    pub rh: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn circle_sdf_and_cosine_feathering() {
        let spot = DetectedDustSpot {
            id: "spot_1".into(),
            index: 0,
            cx: 50.0,
            cy: 50.0,
            work_cx: 0.0,
            work_cy: 0.0,
            radius: 10.0,
            work_radius: 0.0,
            area: 314.0,
            perimeter: 62.8,
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

        let mask = CompositeAnalyticMask::from_spots_and_strokes(&[spot], &[], 6.0);

        // Center must be 1.0 (deep core)
        assert_eq!(mask.evaluate_alpha(50.0, 50.0), 1.0);

        // Outside boundary must be 0.0
        assert_eq!(mask.evaluate_alpha(100.0, 100.0), 0.0);

        // Intermediate transition should be monotonic decreasing
        let a1 = mask.evaluate_alpha(50.0, 60.0);
        let a2 = mask.evaluate_alpha(50.0, 68.0);
        let a3 = mask.evaluate_alpha(50.0, 75.0);
        assert!(a1 >= a2, "alpha must be monotonic: {a1} >= {a2}");
        assert!(a2 >= a3, "alpha must be monotonic: {a2} >= {a3}");
    }

    #[test]
    fn capsule_brush_stroke_evaluation() {
        let stroke = ManualBrushStroke {
            id: "stroke_1".into(),
            mode: "brush".into(),
            radius: 8.0,
            points: vec![
                BrushPoint { x: 20.0, y: 20.0 },
                BrushPoint { x: 80.0, y: 20.0 },
            ],
        };

        let mask = CompositeAnalyticMask::from_spots_and_strokes(&[], &[stroke], 6.0);

        // Along segment midpoint (50, 20)
        assert_eq!(mask.evaluate_alpha(50.0, 20.0), 1.0);
        // Off segment (50, 60)
        assert_eq!(mask.evaluate_alpha(50.0, 60.0), 0.0);
    }
}
