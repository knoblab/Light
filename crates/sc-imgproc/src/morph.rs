use rayon::prelude::*;

/// Builds an elliptical structuring element (`kw × kh` bytes, `1` inside ellipse, `0` outside),
/// matching `cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kw, kh))`.
pub fn ellipse_kernel(kw: usize, kh: usize) -> Vec<u8> {
    if kw == 0 || kh == 0 {
        return Vec::new();
    }
    let rx = (kw / 2) as isize;
    let ry = (kh / 2) as isize;
    if rx == 0 || ry == 0 {
        return vec![1u8; kw * kh];
    }
    let inv_rx2 = 1.0 / (rx as f64 * rx as f64);
    let inv_ry2 = 1.0 / (ry as f64 * ry as f64);
    let mut mask = vec![0u8; kw * kh];
    for y in 0..kh {
        let dy = y as isize - ry;
        let dy2 = (dy * dy) as f64 * inv_ry2;
        for x in 0..kw {
            let dx = x as isize - rx;
            let d = (dx * dx) as f64 * inv_rx2 + dy2;
            if d <= 1.0 + 1e-9 {
                mask[y * kw + x] = 1;
            }
        }
    }
    mask
}

/// Grayscale `f32` dilation (`cv2.dilate`) with an arbitrary `kw × kh` binary structuring element.
pub fn dilate_f32(
    src: &[f32],
    w: usize,
    h: usize,
    kw: usize,
    kh: usize,
    kernel: &[u8],
) -> Vec<f32> {
    if w == 0 || h == 0 || src.len() < w.saturating_mul(h) || kernel.len() < kw.saturating_mul(kh) {
        return Vec::new();
    }
    let rx = (kw / 2) as isize;
    let ry = (kh / 2) as isize;

    // Precollect active offsets `(dx, dy)` for speed
    let offsets: Vec<(isize, isize)> = (0..kh)
        .flat_map(|ky| {
            (0..kw).filter_map(move |kx| {
                if kernel[ky * kw + kx] != 0 {
                    Some((kx as isize - rx, ky as isize - ry))
                } else {
                    None
                }
            })
        })
        .collect();

    let mut dst = vec![0.0f32; w * h];
    dst.par_chunks_mut(w).enumerate().for_each(|(y, out_row)| {
        let yi = y as isize;
        for (x, out_px) in out_row.iter_mut().enumerate() {
            let xi = x as isize;
            let mut max_v = f32::NEG_INFINITY;
            for &(dx, dy) in &offsets {
                let sy = (yi + dy).clamp(0, h as isize - 1) as usize;
                let sx = (xi + dx).clamp(0, w as isize - 1) as usize;
                let v = src[sy * w + sx];
                if v > max_v {
                    max_v = v;
                }
            }
            *out_px = if max_v.is_finite() { max_v } else { src[y * w + x] };
        }
    });
    dst
}

/// Binary / grayscale `u8` dilation (`cv2.dilate`) with an arbitrary `kw × kh` binary structuring element.
pub fn dilate_u8(
    src: &[u8],
    w: usize,
    h: usize,
    kw: usize,
    kh: usize,
    kernel: &[u8],
) -> Vec<u8> {
    if w == 0 || h == 0 || src.len() < w.saturating_mul(h) || kernel.len() < kw.saturating_mul(kh) {
        return Vec::new();
    }
    let rx = (kw / 2) as isize;
    let ry = (kh / 2) as isize;

    let offsets: Vec<(isize, isize)> = (0..kh)
        .flat_map(|ky| {
            (0..kw).filter_map(move |kx| {
                if kernel[ky * kw + kx] != 0 {
                    Some((kx as isize - rx, ky as isize - ry))
                } else {
                    None
                }
            })
        })
        .collect();

    let mut dst = vec![0u8; w * h];
    dst.par_chunks_mut(w).enumerate().for_each(|(y, out_row)| {
        let yi = y as isize;
        for (x, out_px) in out_row.iter_mut().enumerate() {
            let xi = x as isize;
            let mut max_v = 0u8;
            for &(dx, dy) in &offsets {
                let sy = (yi + dy).clamp(0, h as isize - 1) as usize;
                let sx = (xi + dx).clamp(0, w as isize - 1) as usize;
                let v = src[sy * w + sx];
                if v > max_v {
                    max_v = v;
                    if max_v == 255 {
                        break;
                    }
                }
            }
            *out_px = max_v;
        }
    });
    dst
}
