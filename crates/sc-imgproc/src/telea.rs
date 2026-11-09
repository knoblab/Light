//! Fast Marching Method (FMM) image inpainting based on Telea (2004),
//! "An Image Inpainting Technique Based on the Fast Marching Method".
//!
//! Replaces OpenCV `cv2.inpaint(..., cv2.INPAINT_TELEA)` with a pure-Rust,
//! zero-unsafe implementation.

use crate::gaussian::gaussian_blur_f32;
use std::cmp::Ordering;
use std::collections::BinaryHeap;

const FLAG_KNOWN: u8 = 0;
const FLAG_BAND: u8 = 1;
const FLAG_INSIDE: u8 = 2;

#[derive(Copy, Clone, Debug, PartialEq)]
struct HeapItem {
    dist: f32,
    idx: usize,
}

impl Eq for HeapItem {}

impl PartialOrd for HeapItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for HeapItem {
    fn cmp(&self, other: &Self) -> Ordering {
        // Min-heap: smaller distances have higher priority
        other
            .dist
            .total_cmp(&self.dist)
            .then_with(|| self.idx.cmp(&other.idx))
    }
}

/// Solves the 2D Eikonal equation $|\nabla T| = 1$ using upwind finite differences.
#[inline]
fn solve_eikonal_at(
    t: &[f32],
    flags: &[u8],
    w: usize,
    h: usize,
    x: usize,
    y: usize,
) -> f32 {
    let mut tx = f32::INFINITY;
    if x > 0 && flags[y * w + (x - 1)] == FLAG_KNOWN {
        tx = tx.min(t[y * w + (x - 1)]);
    }
    if x + 1 < w && flags[y * w + (x + 1)] == FLAG_KNOWN {
        tx = tx.min(t[y * w + (x + 1)]);
    }

    let mut ty = f32::INFINITY;
    if y > 0 && flags[(y - 1) * w + x] == FLAG_KNOWN {
        ty = ty.min(t[(y - 1) * w + x]);
    }
    if y + 1 < h && flags[(y + 1) * w + x] == FLAG_KNOWN {
        ty = ty.min(t[(y + 1) * w + x]);
    }

    if tx.is_infinite() && ty.is_infinite() {
        return f32::INFINITY;
    }
    if tx.is_infinite() {
        return ty + 1.0;
    }
    if ty.is_infinite() {
        return tx + 1.0;
    }

    let diff = (tx - ty).abs();
    if diff >= 1.0 {
        tx.min(ty) + 1.0
    } else {
        0.5 * (tx + ty + (2.0 - diff * diff).max(0.0).sqrt())
    }
}

#[inline]
fn grad_t(t: &[f32], flags: &[u8], w: usize, h: usize, x: usize, y: usize) -> (f32, f32) {
    let tp = t[y * w + x];
    let gx = {
        let has_left = x > 0 && flags[y * w + (x - 1)] != FLAG_INSIDE;
        let has_right = x + 1 < w && flags[y * w + (x + 1)] != FLAG_INSIDE;
        if has_left && has_right {
            (t[y * w + (x + 1)] - t[y * w + (x - 1)]) * 0.5
        } else if has_left {
            tp - t[y * w + (x - 1)]
        } else if has_right {
            t[y * w + (x + 1)] - tp
        } else {
            0.0
        }
    };
    let gy = {
        let has_up = y > 0 && flags[(y - 1) * w + x] != FLAG_INSIDE;
        let has_down = y + 1 < h && flags[(y + 1) * w + x] != FLAG_INSIDE;
        if has_up && has_down {
            (t[(y + 1) * w + x] - t[(y - 1) * w + x]) * 0.5
        } else if has_up {
            tp - t[(y - 1) * w + x]
        } else if has_down {
            t[(y + 1) * w + x] - tp
        } else {
            0.0
        }
    };
    (gx, gy)
}

#[allow(dead_code)]
#[inline]
fn grad_img(img: &[f32], flags: &[u8], w: usize, h: usize, x: usize, y: usize) -> (f32, f32) {
    let val = img[y * w + x];
    let gx = {
        let has_left = x > 0 && flags[y * w + (x - 1)] == FLAG_KNOWN;
        let has_right = x + 1 < w && flags[y * w + (x + 1)] == FLAG_KNOWN;
        if has_left && has_right {
            (img[y * w + (x + 1)] - img[y * w + (x - 1)]) * 0.5
        } else if has_left {
            val - img[y * w + (x - 1)]
        } else if has_right {
            img[y * w + (x + 1)] - val
        } else {
            0.0
        }
    };
    let gy = {
        let has_up = y > 0 && flags[(y - 1) * w + x] == FLAG_KNOWN;
        let has_down = y + 1 < h && flags[(y + 1) * w + x] == FLAG_KNOWN;
        if has_up && has_down {
            (img[(y + 1) * w + x] - img[(y - 1) * w + x]) * 0.5
        } else if has_up {
            val - img[(y - 1) * w + x]
        } else if has_down {
            img[(y + 1) * w + x] - val
        } else {
            0.0
        }
    };
    (gx, gy)
}

/// Computes the inpaint value for pixel `p` from known neighbors within radius `inpaint_radius`.
#[allow(clippy::too_many_arguments)]
fn inpaint_point(
    img: &[f32],
    t: &[f32],
    flags: &[u8],
    w: usize,
    h: usize,
    px: usize,
    py: usize,
    radius: f32,
) -> f32 {
    let p_idx = py * w + px;
    let tp = t[p_idx];

    // Compute normal vector n = \nabla T(p)
    let (nx, ny) = grad_t(t, flags, w, h, px, py);
    let n_len = nx.hypot(ny);
    let (unx, uny) = if n_len > 1e-6 {
        (nx / n_len, ny / n_len)
    } else {
        (0.0, 0.0)
    };

    let r_int = (radius.ceil() as isize).max(1);
    let y0 = (py as isize - r_int).max(0) as usize;
    let y1 = (py as isize + r_int + 1).min(h as isize) as usize;
    let x0 = (px as isize - r_int).max(0) as usize;
    let x1 = (px as isize + r_int + 1).min(w as isize) as usize;

    let r2_max = radius * radius;
    let mut weight_sum = 0.0f32;
    let mut val_sum = 0.0f32;

    for qy in y0..y1 {
        for qx in x0..x1 {
            let q_idx = qy * w + qx;
            if flags[q_idx] != FLAG_KNOWN {
                continue;
            }

            let rx = px as f32 - qx as f32;
            let ry = py as f32 - qy as f32;
            let dist2 = rx * rx + ry * ry;
            if dist2 > r2_max || dist2 < 1e-6 {
                continue;
            }
            let dist = dist2.sqrt();

            // Directional weight: w_dir = |(p - q) . n| / |p - q|
            let w_dir = if n_len > 1e-6 {
                let dot = (rx * unx + ry * uny).abs();
                (dot / dist).clamp(0.01, 1.0)
            } else {
                1.0
            };

            // Distance weight: w_dst = 1 / dist^2
            let w_dst = 1.0 / dist2;

            // Level set weight: w_lev = 1 / (1 + |T(p) - T(q)|)
            let t_diff = (tp - t[q_idx]).abs();
            let w_lev = 1.0 / (1.0 + t_diff);

            // Image gradient at q: \nabla I(q)
            let (grad_ix, grad_iy) = grad_img(img, flags, w, h, qx, qy);

            // First-order Taylor prediction with slope clamping to satisfy the Maximum Principle
            // and eliminate runaway chromatic starburst spikes
            let grad_step = (grad_ix * rx + grad_iy * ry).clamp(-12.0, 12.0);
            let val_pred = img[q_idx] + grad_step;

            let w_total = w_dir * w_dst * w_lev;
            val_sum += w_total * val_pred;
            weight_sum += w_total;
        }
    }

    if weight_sum > 1e-8 {
        val_sum / weight_sum
    } else {
        img[p_idx]
    }
}

/// Fast Marching Method (Telea 2004) image inpainting on single-channel `f32` data.
///
/// Pixels where `mask[i] != 0` are inpainted using valid surrounding pixels within `inpaint_radius`.
/// Unmasked pixels (`mask[i] == 0`) remain strictly unmodified.
pub fn inpaint_telea_f32(
    img: &[f32],
    mask: &[u8],
    w: usize,
    h: usize,
    inpaint_radius: f32,
) -> Vec<f32> {
    let total = w * h;
    if img.len() < total || mask.len() < total || total == 0 {
        return img.to_vec();
    }

    let mut out_img = img.to_vec();
    let mut t = vec![f32::INFINITY; total];
    let mut flags = vec![FLAG_KNOWN; total];
    let mut heap = BinaryHeap::new();

    // 1. Initialize flags: KNOWN for unmasked, INSIDE for masked
    let mut masked_count = 0usize;
    for i in 0..total {
        if mask[i] != 0 {
            flags[i] = FLAG_INSIDE;
            masked_count += 1;
        } else {
            t[i] = 0.0;
        }
    }

    if masked_count == 0 {
        return out_img;
    }

    // 2. Identify boundary band: masked pixels that have at least one unmasked 4-neighbor
    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;
            if flags[idx] != FLAG_INSIDE {
                continue;
            }
            let is_boundary = (x > 0 && flags[idx - 1] == FLAG_KNOWN)
                || (x + 1 < w && flags[idx + 1] == FLAG_KNOWN)
                || (y > 0 && flags[idx - w] == FLAG_KNOWN)
                || (y + 1 < h && flags[idx + w] == FLAG_KNOWN);

            if is_boundary {
                let init_t = solve_eikonal_at(&t, &flags, w, h, x, y);
                t[idx] = init_t;
                flags[idx] = FLAG_BAND;
                heap.push(HeapItem {
                    dist: init_t,
                    idx,
                });
            }
        }
    }

    let r_eff = inpaint_radius.max(1.5);

    // 3. Fast Marching loop
    while let Some(HeapItem { dist, idx: p_idx }) = heap.pop() {
        // Stale heap entries check
        if flags[p_idx] != FLAG_BAND || dist > t[p_idx] {
            continue;
        }

        let px = p_idx % w;
        let py = p_idx / w;

        // Inpaint pixel p using already KNOWN neighbors
        out_img[p_idx] = inpaint_point(
            &out_img,
            &t,
            &flags,
            w,
            h,
            px,
            py,
            r_eff,
        );
        flags[p_idx] = FLAG_KNOWN;

        // Update 4-neighbors
        let neighbors = [
            (px > 0).then(|| (px - 1, py)),
            (px + 1 < w).then(|| (px + 1, py)),
            (py > 0).then(|| (px, py - 1)),
            (py + 1 < h).then(|| (px, py + 1)),
        ];

        for &n_opt in &neighbors {
            let Some((nx, ny)) = n_opt else { continue };
            let n_idx = ny * w + nx;
            let n_flag = flags[n_idx];

            if n_flag != FLAG_KNOWN {
                let new_t = solve_eikonal_at(&t, &flags, w, h, nx, ny);
                if new_t < t[n_idx] {
                    t[n_idx] = new_t;
                    flags[n_idx] = FLAG_BAND;
                    heap.push(HeapItem {
                        dist: new_t,
                        idx: n_idx,
                    });
                }
            }
        }
    }

    out_img
}

/// Combined Telea FMM inpainting + Gaussian harmonic smoothing on detrended image data.
///
/// `0.45 * telea + 0.55 * gaussian(telea, harm_sigma)` inside masked regions,
/// strictly preserving original `detrended` samples outside `mask`.
pub fn inpaint_telea_harmonic_f32(
    detrended: &[f32],
    mask: &[u8],
    w: usize,
    h: usize,
    inpaint_radius: f32,
    harm_sigma: f64,
) -> Vec<f32> {
    let telea = inpaint_telea_f32(detrended, mask, w, h, inpaint_radius);
    let smooth = gaussian_blur_f32(&telea, w, h, harm_sigma);

    let mut result = Vec::with_capacity(w * h);
    for i in 0..(w * h) {
        if mask[i] != 0 {
            result.push(0.45 * telea[i] + 0.55 * smooth[i]);
        } else {
            result.push(detrended[i]);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telea_reconstructs_linear_plane_across_masked_hole() {
        let w = 80usize;
        let h = 80usize;
        let mut img = vec![0.0f32; w * h];
        let mut mask = vec![0u8; w * h];

        // 1st order linear plane: I(x, y) = 100.0 + 0.3 * x - 0.2 * y
        for y in 0..h {
            for x in 0..w {
                img[y * w + x] = 100.0 + 0.3 * x as f32 - 0.2 * y as f32;
            }
        }

        // Circular hole at center (40, 40) radius 10
        let (cx, cy, r) = (40.0f32, 40.0f32, 10.0f32);
        for y in 0..h {
            for x in 0..w {
                let dx = x as f32 - cx;
                let dy = y as f32 - cy;
                if dx * dx + dy * dy <= r * r {
                    mask[y * w + x] = 255;
                    img[y * w + x] = 0.0; // Corrupted
                }
            }
        }

        let healed = inpaint_telea_f32(&img, &mask, w, h, 6.0);

        // Check error inside hole
        let mut max_err = 0.0f32;
        let mut sum_sq_err = 0.0f32;
        let mut count = 0usize;

        for y in 0..h {
            for x in 0..w {
                let idx = y * w + x;
                let ground_truth = 100.0 + 0.3 * x as f32 - 0.2 * y as f32;
                if mask[idx] != 0 {
                    let err = (healed[idx] - ground_truth).abs();
                    max_err = max_err.max(err);
                    sum_sq_err += err * err;
                    count += 1;
                } else {
                    // Unmasked pixel must be bit-identical
                    assert_eq!(healed[idx], img[idx], "unmasked pixel changed!");
                }
            }
        }

        let rmse = (sum_sq_err / count as f32).sqrt();
        println!("[Telea Test] Reconstructed plane: count={count}, RMSE={rmse:.3}, MaxErr={max_err:.3}");
        assert!(rmse < 0.25, "RMSE should be < 0.25 on linear plane, got {rmse}");
    }

    #[test]
    fn harmonic_inpaint_preserves_unmasked_and_fills_hole() {
        let w = 40usize;
        let h = 40usize;
        let mut img = vec![50.0f32; w * h];
        let mut mask = vec![0u8; w * h];

        // Mask center 4x4
        for y in 18..22 {
            for x in 18..22 {
                mask[y * w + x] = 255;
                img[y * w + x] = 0.0;
            }
        }

        let healed = inpaint_telea_harmonic_f32(&img, &mask, w, h, 3.0, 1.5);
        for y in 0..h {
            for x in 0..w {
                let idx = y * w + x;
                if mask[idx] == 0 {
                    assert_eq!(healed[idx], 50.0, "unmasked must be untouched");
                } else {
                    assert!((healed[idx] - 50.0).abs() < 1.0, "hole must be restored to ~50.0, got {}", healed[idx]);
                }
            }
        }
    }
}
