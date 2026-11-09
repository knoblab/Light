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
    let mut tmp = vec![0.0f32; w * h];
    let mut dst = vec![0.0f32; w * h];
    gaussian_blur_f32_into(src, &mut tmp, &mut dst, w, h, sigma);
    dst
}

/// In-place reusable buffer version of `gaussian_blur_f32`.
pub fn gaussian_blur_f32_into(
    src: &[f32],
    tmp: &mut [f32],
    dst: &mut [f32],
    w: usize,
    h: usize,
    sigma: f64,
) {
    let n = w * h;
    if w == 0 || h == 0 || src.len() < n || tmp.len() < n || dst.len() < n {
        return;
    }
    // Pyramidal acceleration for large sigma on large images (e.g. background estimation)
    if sigma >= 8.0 && w >= 256 && h >= 256 {
        let (down, dw, dh) = downsample_2x_f32(src, w, h);
        let blurred_down = gaussian_blur_f32(&down, dw, dh, sigma * 0.5);
        upsample_bilinear_f32_into(&blurred_down, dw, dh, dst, w, h);
        return;
    }
    let kernel = build_gaussian_kernel(sigma);
    if kernel.len() <= 1 {
        dst[..n].copy_from_slice(&src[..n]);
        return;
    }
    let radius = (kernel.len() / 2) as isize;
    let k_len = kernel.len();

    // 1. Horizontal pass
    tmp[..n].par_chunks_mut(w).enumerate().for_each(|(y, out_row)| {
        let in_row = &src[y * w..(y + 1) * w];
        let r = radius as usize;
        let inner_x1 = w.saturating_sub(r);

        for x in 0..r.min(w) {
            let xi = x as isize;
            let mut acc = 0.0f32;
            for (ki, &k) in kernel.iter().enumerate() {
                let sx = reflect_101(xi + ki as isize - radius, w);
                acc += in_row[sx] * k;
            }
            out_row[x] = acc;
        }

        if inner_x1 > r {
            for x in r..inner_x1 {
                let start = x - r;
                let slice = &in_row[start..start + k_len];
                let mut acc = 0.0f32;
                for (&v, &k) in slice.iter().zip(kernel.iter()) {
                    acc += v * k;
                }
                out_row[x] = acc;
            }
        }

        for x in inner_x1.max(r)..w {
            let xi = x as isize;
            let mut acc = 0.0f32;
            for (ki, &k) in kernel.iter().enumerate() {
                let sx = reflect_101(xi + ki as isize - radius, w);
                acc += in_row[sx] * k;
            }
            out_row[x] = acc;
        }
    });

    // 2. Vertical pass (interior rows directly slice without reflect_101)
    let inner_y0 = radius as usize;
    let inner_y1 = h.saturating_sub(radius as usize);

    dst[..n].par_chunks_mut(w).enumerate().for_each(|(y, out_row)| {
        let yi = y as isize;
        out_row.fill(0.0);

        if y >= inner_y0 && y < inner_y1 {
            for (ki, &k) in kernel.iter().enumerate() {
                let sy = y + ki - inner_y0;
                let in_row = &tmp[sy * w..(sy + 1) * w];
                for (out_px, &v) in out_row.iter_mut().zip(in_row.iter()) {
                    *out_px += v * k;
                }
            }
        } else {
            for (ki, &k) in kernel.iter().enumerate() {
                let sy = reflect_101(yi + ki as isize - radius, h);
                let in_row = &tmp[sy * w..(sy + 1) * w];
                for (out_px, &v) in out_row.iter_mut().zip(in_row.iter()) {
                    *out_px += v * k;
                }
            }
        }
    });
}

/// Downsamples a 2D float image by 2x using 2x2 box averaging.
pub fn downsample_2x_f32(src: &[f32], w: usize, h: usize) -> (Vec<f32>, usize, usize) {
    let dw = (w / 2).max(1);
    let dh = (h / 2).max(1);
    let mut dst = vec![0.0f32; dw * dh];
    for dy in 0..dh {
        let sy = dy * 2;
        let sy_next = (sy + 1).min(h - 1);
        let r0 = &src[sy * w..(sy + 1) * w];
        let r1 = &src[sy_next * w..(sy_next + 1) * w];
        let out_row = &mut dst[dy * dw..(dy + 1) * dw];
        for dx in 0..dw {
            let sx = dx * 2;
            let sx_next = (sx + 1).min(w - 1);
            out_row[dx] = 0.25 * (r0[sx] + r0[sx_next] + r1[sx] + r1[sx_next]);
        }
    }
    (dst, dw, dh)
}

/// Upsamples a 2D float image to `(target_w, target_h)` using bilinear interpolation.
pub fn upsample_bilinear_f32(src: &[f32], sw: usize, sh: usize, target_w: usize, target_h: usize) -> Vec<f32> {
    if target_w == 0 || target_h == 0 {
        return Vec::new();
    }
    if sw == target_w && sh == target_h {
        return src[..target_w * target_h].to_vec();
    }
    let mut dst = vec![0.0f32; target_w * target_h];
    upsample_bilinear_f32_into(src, sw, sh, &mut dst, target_w, target_h);
    dst
}

/// In-place buffer version of `upsample_bilinear_f32`.
pub fn upsample_bilinear_f32_into(src: &[f32], sw: usize, sh: usize, dst: &mut [f32], target_w: usize, target_h: usize) {
    if target_w == 0 || target_h == 0 || dst.len() < target_w * target_h {
        return;
    }
    if sw == target_w && sh == target_h {
        dst[..target_w * target_h].copy_from_slice(&src[..target_w * target_h]);
        return;
    }
    let x_scale = sw as f32 / target_w as f32;
    let y_scale = sh as f32 / target_h as f32;

    for dy in 0..target_h {
        let fy = (dy as f32 + 0.5) * y_scale - 0.5;
        let sy0 = (fy.floor() as isize).clamp(0, sh as isize - 1) as usize;
        let sy1 = (sy0 + 1).min(sh - 1);
        let wy = (fy - sy0 as f32).clamp(0.0, 1.0);

        let out_row = &mut dst[dy * target_w..(dy + 1) * target_w];
        for dx in 0..target_w {
            let fx = (dx as f32 + 0.5) * x_scale - 0.5;
            let sx0 = (fx.floor() as isize).clamp(0, sw as isize - 1) as usize;
            let sx1 = (sx0 + 1).min(sw - 1);
            let wx = (fx - sx0 as f32).clamp(0.0, 1.0);

            let v00 = src[sy0 * sw + sx0];
            let v10 = src[sy0 * sw + sx1];
            let v01 = src[sy1 * sw + sx0];
            let v11 = src[sy1 * sw + sx1];

            let top = v00 * (1.0 - wx) + v10 * wx;
            let bot = v01 * (1.0 - wx) + v11 * wx;
            out_row[dx] = top * (1.0 - wy) + bot * wy;
        }
    }
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
