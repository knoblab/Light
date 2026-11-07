use crate::gaussian::{gaussian_blur_f32, reflect_101};
use rayon::prelude::*;

/// Computes 3×3 Sobel horizontal (`dx`) and vertical (`dy`) derivatives matching `cv2.Sobel(..., CV_32F, 1, 0, ksize=3)`
/// and `cv2.Sobel(..., CV_32F, 0, 1, ksize=3)` with `BORDER_REFLECT_101`.
pub fn sobel_3x3_f32(src: &[f32], w: usize, h: usize) -> (Vec<f32>, Vec<f32>) {
    if w == 0 || h == 0 || src.len() < w.saturating_mul(h) {
        return (Vec::new(), Vec::new());
    }
    let mut dx = vec![0.0f32; w * h];
    let mut dy = vec![0.0f32; w * h];

    dx.par_chunks_mut(w)
        .zip(dy.par_chunks_mut(w))
        .enumerate()
        .for_each(|(y, (row_dx, row_dy))| {
            let ym1 = reflect_101(y as isize - 1, h);
            let y0 = y;
            let yp1 = reflect_101(y as isize + 1, h);

            let r_m1 = &src[ym1 * w..(ym1 + 1) * w];
            let r_0 = &src[y0 * w..(y0 + 1) * w];
            let r_p1 = &src[yp1 * w..(yp1 + 1) * w];

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
        });

    (dx, dy)
}

/// Computes smoothed Sobel gradient magnitude `GaussianBlur(sqrt(sobel_x^2 + sobel_y^2), sigma=1.5)`
/// matching `raw_pipeline.py:756-758`.
pub fn gradient_magnitude_f32(src: &[f32], w: usize, h: usize, smooth_sigma: f64) -> Vec<f32> {
    let (sx, sy) = sobel_3x3_f32(src, w, h);
    let mag: Vec<f32> = sx
        .par_iter()
        .zip(sy.par_iter())
        .map(|(&gx, &gy)| gx.hypot(gy))
        .collect();
    if smooth_sigma > 0.0 {
        gaussian_blur_f32(&mag, w, h, smooth_sigma)
    } else {
        mag
    }
}
