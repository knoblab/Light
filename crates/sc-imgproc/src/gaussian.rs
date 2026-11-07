use rayon::prelude::*;

/// OpenCV `BORDER_REFLECT_101` index mapping (`dcb|abcdefg|fed`).
#[inline]
pub fn reflect_101(idx: isize, len: usize) -> usize {
    if len <= 1 {
        return 0;
    }
    let period = (2 * (len - 1)) as isize;
    let mut m = idx % period;
    if m < 0 {
        m += period;
    }
    let mu = m as usize;
    if mu < len {
        mu
    } else {
        2 * (len - 1) - mu
    }
}

/// Builds a 1D normalized Gaussian kernel matching OpenCV's `getGaussianKernel` for `ksize = 0`:
/// `radius = round(sigma * 3.0)` for `CV_32F` (so `ksize = 2 * radius + 1 >= 3`).
pub fn build_gaussian_kernel(sigma: f64) -> Vec<f32> {
    if sigma <= 0.0 || !sigma.is_finite() {
        return vec![1.0];
    }
    // OpenCV getGaussianKernel for depth=CV_32F when ksize=0 uses:
    // ksize = round(sigma * 4 * 2 + 1) | 1
    let ksize = (((sigma * 8.0 + 1.0).round() as usize) | 1).clamp(3, 255);
    let radius = ksize / 2;
    let denom = -0.5 / (sigma * sigma);
    let mut kernel = Vec::with_capacity(ksize);
    let mut sum = 0.0f64;
    for i in 0..ksize {
        let d = i as f64 - radius as f64;
        let w = (d * d * denom).exp();
        kernel.push(w);
        sum += w;
    }
    let inv = if sum > 0.0 { 1.0 / sum } else { 1.0 };
    kernel.into_iter().map(|w| (w * inv) as f32).collect()
}

/// Separable 2D Gaussian blur on a single-channel `w × h` `f32` buffer using `BORDER_REFLECT_101`.
pub fn gaussian_blur_f32(src: &[f32], w: usize, h: usize, sigma: f64) -> Vec<f32> {
    if w == 0 || h == 0 || src.len() < w.saturating_mul(h) {
        return Vec::new();
    }
    let kernel = build_gaussian_kernel(sigma);
    if kernel.len() <= 1 {
        return src[..w * h].to_vec();
    }
    let radius = (kernel.len() / 2) as isize;

    // 1. Horizontal pass
    let mut tmp = vec![0.0f32; w * h];
    tmp.par_chunks_mut(w).enumerate().for_each(|(y, out_row)| {
        let in_row = &src[y * w..(y + 1) * w];
        for (x, out_px) in out_row.iter_mut().enumerate() {
            let xi = x as isize;
            let mut acc = 0.0f32;
            if xi >= radius && (x + radius as usize) < w {
                let start = (xi - radius) as usize;
                let slice = &in_row[start..start + kernel.len()];
                for (&v, &k) in slice.iter().zip(kernel.iter()) {
                    acc += v * k;
                }
            } else {
                for (ki, &k) in kernel.iter().enumerate() {
                    let sx = reflect_101(xi + ki as isize - radius, w);
                    acc += in_row[sx] * k;
                }
            }
            *out_px = acc;
        }
    });

    // 2. Vertical pass
    let mut dst = vec![0.0f32; w * h];
    dst.par_chunks_mut(w).enumerate().for_each(|(y, out_row)| {
        let yi = y as isize;
        for (ki, &k) in kernel.iter().enumerate() {
            let sy = reflect_101(yi + ki as isize - radius, h);
            let in_row = &tmp[sy * w..(sy + 1) * w];
            for (out_px, &v) in out_row.iter_mut().zip(in_row.iter()) {
                *out_px += v * k;
            }
        }
    });

    dst
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_image_stays_constant_after_gaussian() {
        let w = 64;
        let h = 48;
        let src = vec![123.5f32; w * h];
        for sigma in [0.8, 0.9, 1.8, 8.5, 18.0, 22.0] {
            let out = gaussian_blur_f32(&src, w, h, sigma);
            assert_eq!(out.len(), w * h);
            for v in out {
                assert!((v - 123.5).abs() < 1e-3, "sigma={sigma}, got {v}");
            }
        }
    }

    #[test]
    fn impulse_response_is_symmetric_and_sums_to_one() {
        let w = 31;
        let h = 31;
        let mut src = vec![0.0f32; w * h];
        src[15 * w + 15] = 100.0;
        let out = gaussian_blur_f32(&src, w, h, 2.0);
        let sum: f32 = out.iter().sum();
        assert!((sum - 100.0).abs() < 1e-2, "sum={sum}");
        assert!((out[15 * w + 13] - out[15 * w + 17]).abs() < 1e-5);
        assert!((out[13 * w + 15] - out[17 * w + 15]).abs() < 1e-5);
    }
}
