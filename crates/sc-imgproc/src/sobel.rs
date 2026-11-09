use crate::gaussian::{gaussian_blur_f32_into, reflect_101};
use rayon::prelude::*;

/// Computes 3×3 Sobel horizontal (`dx`) and vertical (`dy`) derivatives matching `cv2.Sobel(..., CV_32F, 1, 0, ksize=3)`
/// and `cv2.Sobel(..., CV_32F, 0, 1, ksize=3)` with `BORDER_REFLECT_101`.
pub fn sobel_3x3_f32(src: &[f32], w: usize, h: usize) -> (Vec<f32>, Vec<f32>) {
    if w == 0 || h == 0 || src.len() < w.saturating_mul(h) {
        return (Vec::new(), Vec::new());
    }
    let mut dx = vec![0.0f32; w * h];
    let mut dy = vec![0.0f32; w * h];
    sobel_3x3_f32_into(src, &mut dx, &mut dy, w, h);
    (dx, dy)
}

/// In-place buffer version of `sobel_3x3_f32`.
pub fn sobel_3x3_f32_into(src: &[f32], dx: &mut [f32], dy: &mut [f32], w: usize, h: usize) {
    let n = w * h;
    if w == 0 || h == 0 || src.len() < n || dx.len() < n || dy.len() < n {
        return;
    }
    dx[..n]
        .par_chunks_mut(w)
        .zip(dy[..n].par_chunks_mut(w))
        .enumerate()
        .for_each(|(y, (row_dx, row_dy))| {
            let ym1 = reflect_101(y as isize - 1, h);
            let y0 = y;
            let yp1 = reflect_101(y as isize + 1, h);

            let r_m1 = &src[ym1 * w..(ym1 + 1) * w];
            let r_0 = &src[y0 * w..(y0 + 1) * w];
            let r_p1 = &src[yp1 * w..(yp1 + 1) * w];

            if w > 2 {
                // Left border x = 0
                let xm1 = reflect_101(-1, w);
                let x0 = 0;
                let xp1 = 1;
                row_dx[0] = (r_m1[xp1] - r_m1[xm1]) + 2.0 * (r_0[xp1] - r_0[xm1]) + (r_p1[xp1] - r_p1[xm1]);
                row_dy[0] = (r_p1[xm1] - r_m1[xm1]) + 2.0 * (r_p1[x0] - r_m1[x0]) + (r_p1[xp1] - r_m1[xp1]);

                // Fast interior: x in 1..w - 1 (no reflect_101!)
                for x in 1..w - 1 {
                    let xm1 = x - 1;
                    let x0 = x;
                    let xp1 = x + 1;

                    let p00 = r_m1[xm1];
                    let p01 = r_m1[x0];
                    let p02 = r_m1[xp1];

                    let p10 = r_0[xm1];
                    let p12 = r_0[xp1];

                    let p20 = r_p1[xm1];
                    let p21 = r_p1[x0];
                    let p22 = r_p1[xp1];

                    row_dx[x] = (p02 - p00) + 2.0 * (p12 - p10) + (p22 - p20);
                    row_dy[x] = (p20 - p00) + 2.0 * (p21 - p01) + (p22 - p02);
                }

                // Right border x = w - 1
                let xm1 = w - 2;
                let x0 = w - 1;
                let xp1 = reflect_101(w as isize, w);
                row_dx[x0] = (r_m1[xp1] - r_m1[xm1]) + 2.0 * (r_0[xp1] - r_0[xm1]) + (r_p1[xp1] - r_p1[xm1]);
                row_dy[x0] = (r_p1[xm1] - r_m1[xm1]) + 2.0 * (r_p1[x0] - r_m1[x0]) + (r_p1[xp1] - r_m1[xp1]);
            } else {
                for x in 0..w {
                    let xm1 = reflect_101(x as isize - 1, w);
                    let x0 = x;
                    let xp1 = reflect_101(x as isize + 1, w);

                    let p00 = r_m1[xm1];
                    let p01 = r_m1[x0];
                    let p02 = r_m1[xp1];

                    let p10 = r_0[xm1];
                    let p12 = r_0[xp1];

                    let p20 = r_p1[xm1];
                    let p21 = r_p1[x0];
                    let p22 = r_p1[xp1];

                    row_dx[x] = (p02 - p00) + 2.0 * (p12 - p10) + (p22 - p20);
                    row_dy[x] = (p20 - p00) + 2.0 * (p21 - p01) + (p22 - p02);
                }
            }
        });
}

/// Computes smoothed Sobel gradient magnitude `GaussianBlur(sqrt(sobel_x^2 + sobel_y^2), sigma=1.5)`
/// matching `raw_pipeline.py:756-758`.
pub fn gradient_magnitude_f32(src: &[f32], w: usize, h: usize, smooth_sigma: f64) -> Vec<f32> {
    let mut dst = vec![0.0f32; w * h];
    let mut sx = vec![0.0f32; w * h];
    let mut sy = vec![0.0f32; w * h];
    gradient_magnitude_f32_into(src, &mut sx, &mut sy, &mut dst, w, h, smooth_sigma);
    dst
}

/// In-place buffer version of `gradient_magnitude_f32`.
pub fn gradient_magnitude_f32_into(
    src: &[f32],
    sx: &mut [f32],
    sy: &mut [f32],
    dst: &mut [f32],
    w: usize,
    h: usize,
    smooth_sigma: f64,
) {
    let n = w * h;
    if w == 0 || h == 0 || src.len() < n || sx.len() < n || sy.len() < n || dst.len() < n {
        return;
    }
    sobel_3x3_f32_into(src, sx, sy, w, h);
    dst[..n].par_chunks_mut(w).enumerate().for_each(|(y, out_row)| {
        let x_row = &sx[y * w..(y + 1) * w];
        let y_row = &sy[y * w..(y + 1) * w];
        for (i, out_px) in out_row.iter_mut().enumerate() {
            *out_px = x_row[i].hypot(y_row[i]);
        }
    });
    if smooth_sigma > 0.0 {
        let mag_clone = dst[..n].to_vec();
        gaussian_blur_f32_into(&mag_clone, sx, dst, w, h, smooth_sigma);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sobel_linear_ramp() {
        let w = 8;
        let h = 8;
        // Horizontal ramp: f(x, y) = x
        let mut src = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                src[y * w + x] = x as f32;
            }
        }
        let (dx, dy) = sobel_3x3_f32(&src, w, h);
        // Interior dx for ramp with step 1: (p02 - p00) + 2*(p12 - p10) + (p22 - p20) = 2 + 4 + 2 = 8.0
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                assert!((dx[y * w + x] - 8.0).abs() < 1e-4);
                assert!(dy[y * w + x].abs() < 1e-4);
            }
        }
    }
}
