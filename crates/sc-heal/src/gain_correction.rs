//! 4-Phase CFA Background Plane Fitting & Transmission Gain Correction.
//!
//! Fits independent linear gradient planes $P_p(x, y) = a_p x + b_p y + c_p$ for each
//! of the 4 Bayer phases $(x \pmod 2, y \pmod 2) \in \{(0,0), (1,0), (0,1), (1,1)\}$
//! on clean outer-ring pixels, detrending the patch before inpainting.

#![forbid(unsafe_code)]

use sc_color::percentile_f32;
use sc_detect::annulus::fast_fit_plane;

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct PlaneCoeffs {
    pub a: f64,
    pub b: f64,
    pub c: f64,
}

impl PlaneCoeffs {
    #[inline]
    pub fn eval(&self, nx: f32, ny: f32) -> f32 {
        (self.a as f32) * nx + (self.b as f32) * ny + (self.c as f32)
    }
}

/// Fits 4 independent 1st-order planes to outer-ring pixels for each Bayer phase.
/// Uses trimmed robust estimation on [15%, 85%] residual percentiles.
pub fn fit_4phase_background_planes(
    cfa: &[u16],
    ring_mask: &[u8],
    rw: usize,
    rh: usize,
) -> Option<[PlaneCoeffs; 4]> {
    let half_rw = (rw as f32 * 0.5).max(1.0);
    let half_rh = (rh as f32 * 0.5).max(1.0);

    let mut phase_x = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    let mut phase_y = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    let mut phase_val = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];

    for y in 0..rh {
        let py = y % 2;
        let ny = (y as f32 - half_rh) / half_rh;
        for x in 0..rw {
            let px = x % 2;
            let phase = py * 2 + px;
            let idx = y * rw + x;

            if ring_mask[idx] != 0 {
                let nx = (x as f32 - half_rw) / half_rw;
                phase_x[phase].push(nx);
                phase_y[phase].push(ny);
                phase_val[phase].push(cfa[idx] as f32);
            }
        }
    }

    let mut result = [PlaneCoeffs { a: 0.0, b: 0.0, c: 0.0 }; 4];

    for p in 0..4 {
        if phase_x[p].len() < 8 {
            return None;
        }

        // Initial plane fit
        let init_c = fast_fit_plane(&phase_x[p], &phase_y[p], &phase_val[p]);
        let residuals: Vec<f32> = (0..phase_x[p].len())
            .map(|i| {
                phase_val[p][i]
                    - (init_c[0] as f32 * phase_x[p][i]
                        + init_c[1] as f32 * phase_y[p][i]
                        + init_c[2] as f32)
            })
            .collect();

        let mut res_sorted = residuals.clone();
        let lo_r = percentile_f32(&mut res_sorted, 15.0) as f32;
        let hi_r = percentile_f32(&mut res_sorted, 85.0) as f32;

        let mut rx_c = Vec::new();
        let mut ry_c = Vec::new();
        let mut val_c = Vec::new();

        for i in 0..phase_x[p].len() {
            if residuals[i] >= lo_r && residuals[i] <= hi_r {
                rx_c.push(phase_x[p][i]);
                ry_c.push(phase_y[p][i]);
                val_c.push(phase_val[p][i]);
            }
        }

        if rx_c.len() < 6 {
            result[p] = PlaneCoeffs {
                a: init_c[0],
                b: init_c[1],
                c: init_c[2],
            };
        } else {
            let refit_c = fast_fit_plane(&rx_c, &ry_c, &val_c);
            result[p] = PlaneCoeffs {
                a: refit_c[0],
                b: refit_c[1],
                c: refit_c[2],
            };
        }
    }

    Some(result)
}

/// Detrends a CFA ROI patch using the 4-phase plane coefficients.
/// Returns `(detrended, plane_values)`.
pub fn detrend_cfa_patch(
    cfa: &[u16],
    planes: &[PlaneCoeffs; 4],
    rw: usize,
    rh: usize,
) -> (Vec<f32>, Vec<f32>) {
    let half_rw = (rw as f32 * 0.5).max(1.0);
    let half_rh = (rh as f32 * 0.5).max(1.0);

    let total = rw * rh;
    let mut detrended = vec![0.0f32; total];
    let mut plane_values = vec![0.0f32; total];

    for y in 0..rh {
        let py = y % 2;
        let ny = (y as f32 - half_rh) / half_rh;
        for x in 0..rw {
            let px = x % 2;
            let phase = py * 2 + px;
            let idx = y * rw + x;
            let p_val = planes[phase].eval((x as f32 - half_rw) / half_rw, ny);
            plane_values[idx] = p_val;
            detrended[idx] = cfa[idx] as f32 - p_val;
        }
    }

    (detrended, plane_values)
}

/// Restores the detrended values by adding back the 4-phase plane values.
#[inline]
pub fn restore_cfa_patch(detrended: &[f32], plane_values: &[f32]) -> Vec<f32> {
    detrended
        .iter()
        .zip(plane_values.iter())
        .map(|(&d, &p)| d + p)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_4phase_planes_perfectly_on_synthetic_bayer_slopes() {
        let rw = 32usize;
        let rh = 32usize;
        let mut cfa = vec![0u16; rw * rh];
        let mut ring_mask = vec![255u8; rw * rh];

        // Mask center 16x16 as hole (ring_mask = 0)
        for y in 8..24 {
            for x in 8..24 {
                ring_mask[y * rw + x] = 0;
            }
        }

        // Each phase has a known plane
        // P0: 1000 + 10 * x - 5 * y
        // P1: 2000 + 20 * x - 10 * y
        // P2: 2000 + 20 * x - 10 * y
        // P3: 1500 + 15 * x - 8 * y
        for y in 0..rh {
            let py = y % 2;
            for x in 0..rw {
                let px = x % 2;
                let phase = py * 2 + px;
                let val = match phase {
                    0 => 1000.0 + 10.0 * x as f32 - 5.0 * y as f32,
                    1 => 2000.0 + 20.0 * x as f32 - 10.0 * y as f32,
                    2 => 2000.0 + 20.0 * x as f32 - 10.0 * y as f32,
                    _ => 1500.0 + 15.0 * x as f32 - 8.0 * y as f32,
                };
                cfa[y * rw + x] = val.round() as u16;
            }
        }

        let planes = fit_4phase_background_planes(&cfa, &ring_mask, rw, rh)
            .expect("plane fit should succeed");

        let (detrended, plane_vals) = detrend_cfa_patch(&cfa, &planes, rw, rh);
        let restored = restore_cfa_patch(&detrended, &plane_vals);

        for i in 0..(rw * rh) {
            assert!(
                (restored[i] - cfa[i] as f32).abs() < 1e-3,
                "Restored CFA pixel should match original plane"
            );
            assert!(
                detrended[i].abs() < 1.0,
                "Detrended residual on plane should be near zero, got {}",
                detrended[i]
            );
        }
    }
}
