/// Exact 2D Euclidean Voronoi nearest-valid-pixel border padding, replacing
/// `cv2.distanceTransformWithLabels(invalid_u8, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)`
/// in `raw_pipeline.py:727-739`.
///
/// For any pixel where `gray[i] < min_valid` (e.g. `< 8.0` black letterbox/pillarbox bars),
/// replaces its value with the value of the closest valid (`>= min_valid`) pixel in L2 distance.
pub fn pad_invalid_border_nearest(gray: &[f32], w: usize, h: usize, min_valid: f32) -> Vec<f32> {
    if w == 0 || h == 0 || gray.len() < w.saturating_mul(h) {
        return Vec::new();
    }
    let slice = &gray[..w * h];
    let all_valid = slice.iter().all(|&v| v >= min_valid);
    if all_valid {
        return slice.to_vec();
    }
    let any_valid = slice.iter().any(|&v| v >= min_valid);
    if !any_valid {
        return slice.to_vec();
    }

    const INF: i64 = 1_000_000_000_000;

    // Pass 1 (vertical): for each column x and row y, find the closest valid row `best_y[y * w + x]`
    let mut col_dist2 = vec![INF; w * h];
    let mut best_y = vec![0usize; w * h];

    for x in 0..w {
        let mut last_valid_y: Option<usize> = None;
        for y in 0..h {
            if slice[y * w + x] >= min_valid {
                last_valid_y = Some(y);
            }
            if let Some(vy) = last_valid_y {
                let dy = (y - vy) as i64;
                col_dist2[y * w + x] = dy * dy;
                best_y[y * w + x] = vy;
            }
        }
        let mut next_valid_y: Option<usize> = None;
        for y in (0..h).rev() {
            if slice[y * w + x] >= min_valid {
                next_valid_y = Some(y);
            }
            if let Some(vy) = next_valid_y {
                let dy = (vy - y) as i64;
                let d2 = dy * dy;
                if d2 < col_dist2[y * w + x] {
                    col_dist2[y * w + x] = d2;
                    best_y[y * w + x] = vy;
                }
            }
        }
    }

    // Pass 2 (horizontal lower envelope of parabolas `(x - q)^2 + col_dist2[y, q]`)
    let mut out = slice.to_vec();
    let mut v = vec![0usize; w];
    let mut z = vec![0.0f64; w + 1];

    for y in 0..h {
        let row_d2 = &col_dist2[y * w..(y + 1) * w];
        let row_by = &best_y[y * w..(y + 1) * w];

        // Build lower envelope over columns `q` where `row_d2[q] < INF`
        let mut k = 0usize;
        let mut has_any = false;
        for q in 0..w {
            if row_d2[q] >= INF {
                continue;
            }
            if !has_any {
                v[0] = q;
                z[0] = f64::NEG_INFINITY;
                z[1] = f64::INFINITY;
                has_any = true;
                continue;
            }
            let fq = row_d2[q] as f64 + (q * q) as f64;
            let mut s = {
                let vk = v[k];
                let fvk = row_d2[vk] as f64 + (vk * vk) as f64;
                (fq - fvk) / (2.0 * (q as f64 - vk as f64))
            };
            while s <= z[k] {
                if k == 0 {
                    break;
                }
                k -= 1;
                let vk = v[k];
                let fvk = row_d2[vk] as f64 + (vk * vk) as f64;
                s = (fq - fvk) / (2.0 * (q as f64 - vk as f64));
            }
            if s <= z[k] {
                v[0] = q;
                z[0] = f64::NEG_INFINITY;
                z[1] = f64::INFINITY;
            } else {
                k += 1;
                v[k] = q;
                z[k] = s;
                z[k + 1] = f64::INFINITY;
            }
        }

        if !has_any {
            continue;
        }

        let mut env_idx = 0usize;
        for x in 0..w {
            while z[env_idx + 1] < x as f64 {
                env_idx += 1;
            }
            if slice[y * w + x] < min_valid {
                let nearest_x = v[env_idx];
                let nearest_y = row_by[nearest_x];
                out[y * w + x] = slice[nearest_y * w + nearest_x];
            }
        }
    }

    out
}

/// Exact 2D squared Euclidean distance transform on a binary mask (`mask != 0` is inside seed).
///
/// For seed pixels where `mask[y * w + x] != 0`, the returned squared distance is `0`.
/// For non-seed pixels, returns the exact minimal squared Euclidean distance `min_{sx, sy: mask != 0} ((x - sx)^2 + (y - sy)^2)`.
///
/// Runs in O(W * H) time with separable parabolic lower envelopes (Felzenszwalb & Huttenlocher, Meijster).
pub fn euclidean_distance_transform_sq_u8(mask: &[u8], w: usize, h: usize) -> Vec<u32> {
    if w == 0 || h == 0 || mask.len() < w.saturating_mul(h) {
        return Vec::new();
    }
    const INF: u32 = 1_000_000_000;

    // Pass 1 (vertical): 1D distance along columns
    let mut col_d2 = vec![INF; w * h];
    for x in 0..w {
        let mut d = INF;
        for y in 0..h {
            if mask[y * w + x] != 0 {
                d = 0;
            } else if d < INF {
                d += 1;
            }
            col_d2[y * w + x] = if d < INF { d * d } else { INF };
        }
        d = INF;
        for y in (0..h).rev() {
            if mask[y * w + x] != 0 {
                d = 0;
            } else if d < INF {
                d += 1;
            }
            if d < INF {
                let d2 = d * d;
                if d2 < col_d2[y * w + x] {
                    col_d2[y * w + x] = d2;
                }
            }
        }
    }

    // Pass 2 (horizontal): 1D lower envelope of parabolas along rows
    let mut out = vec![INF; w * h];
    let mut v = vec![0usize; w];
    let mut z = vec![0.0f64; w + 1];

    for y in 0..h {
        let row_d2 = &col_d2[y * w..(y + 1) * w];
        let mut k = 0usize;
        let mut has_any = false;

        for q in 0..w {
            if row_d2[q] >= INF {
                continue;
            }
            if !has_any {
                v[0] = q;
                z[0] = f64::NEG_INFINITY;
                z[1] = f64::INFINITY;
                has_any = true;
                continue;
            }
            let fq = row_d2[q] as f64 + (q * q) as f64;
            let mut s = {
                let vk = v[k];
                let fvk = row_d2[vk] as f64 + (vk * vk) as f64;
                (fq - fvk) / (2.0 * (q as f64 - vk as f64))
            };
            while s <= z[k] {
                if k == 0 {
                    break;
                }
                k -= 1;
                let vk = v[k];
                let fvk = row_d2[vk] as f64 + (vk * vk) as f64;
                s = (fq - fvk) / (2.0 * (q as f64 - vk as f64));
            }
            if s <= z[k] {
                v[0] = q;
                z[0] = f64::NEG_INFINITY;
                z[1] = f64::INFINITY;
            } else {
                k += 1;
                v[k] = q;
                z[k] = s;
                z[k + 1] = f64::INFINITY;
            }
        }

        if !has_any {
            continue;
        }

        let mut env_idx = 0usize;
        for x in 0..w {
            while z[env_idx + 1] < x as f64 {
                env_idx += 1;
            }
            let nearest_x = v[env_idx];
            let dx = (x as isize - nearest_x as isize).unsigned_abs() as u32;
            let fvk = row_d2[nearest_x];
            out[y * w + x] = dx * dx + fvk;
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pads_black_letterbox_with_nearest_valid_pixel() {
        let w = 10;
        let h = 6;
        let mut img = vec![0.0f32; w * h];
        // Fill interior rows 2..4 with valid sky values (100 + x)
        for y in 2..4 {
            for x in 0..w {
                img[y * w + x] = 100.0 + x as f32;
            }
        }
        let padded = pad_invalid_border_nearest(&img, w, h, 8.0);
        for y in 0..h {
            for x in 0..w {
                assert_eq!(padded[y * w + x], 100.0 + x as f32);
            }
        }
    }

    #[test]
    fn exact_squared_euclidean_distance_transform() {
        let w = 20;
        let h = 20;
        let mut mask = vec![0u8; w * h];
        mask[10 * w + 10] = 255;
        let d2 = euclidean_distance_transform_sq_u8(&mask, w, h);
        assert_eq!(d2[10 * w + 10], 0);
        assert_eq!(d2[10 * w + 13], 9);
        assert_eq!(d2[13 * w + 14], 25);
        assert_eq!(d2[5 * w + 5], 50);
    }
}
