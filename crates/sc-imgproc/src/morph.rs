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

    let offset_strides: Vec<isize> = offsets.iter().map(|&(dx, dy)| dy * (w as isize) + dx).collect();
    let inner_y0 = ry as usize;
    let inner_y1 = h.saturating_sub(ry as usize);
    let inner_x0 = rx as usize;
    let inner_x1 = w.saturating_sub(rx as usize);

    let mut dst = vec![0.0f32; w * h];
    dst.par_chunks_mut(w).enumerate().for_each(|(y, out_row)| {
        let in_row = &src[y * w..(y + 1) * w];
        let yi = y as isize;
        let is_inner_y = y >= inner_y0 && y < inner_y1;

        if is_inner_y && inner_x1 > inner_x0 {
            for x in 0..inner_x0 {
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
                out_row[x] = if max_v.is_finite() { max_v } else { in_row[x] };
            }

            for x in inner_x0..inner_x1 {
                let center_idx = (y * w + x) as isize;
                let mut max_v = f32::NEG_INFINITY;
                for &stride in &offset_strides {
                    let v = src[(center_idx + stride) as usize];
                    if v > max_v {
                        max_v = v;
                    }
                }
                out_row[x] = if max_v.is_finite() { max_v } else { in_row[x] };
            }

            for x in inner_x1..w {
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
                out_row[x] = if max_v.is_finite() { max_v } else { in_row[x] };
            }
        } else {
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
                *out_px = if max_v.is_finite() { max_v } else { in_row[x] };
            }
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

    let offset_strides: Vec<isize> = offsets.iter().map(|&(dx, dy)| dy * (w as isize) + dx).collect();
    let inner_y0 = ry as usize;
    let inner_y1 = h.saturating_sub(ry as usize);
    let inner_x0 = rx as usize;
    let inner_x1 = w.saturating_sub(rx as usize);

    let mut dst = vec![0u8; w * h];
    dst.par_chunks_mut(w).enumerate().for_each(|(y, out_row)| {
        let in_row = &src[y * w..(y + 1) * w];
        let yi = y as isize;
        let is_inner_y = y >= inner_y0 && y < inner_y1;

        if is_inner_y && inner_x1 > inner_x0 {
            for x in 0..inner_x0 {
                let xi = x as isize;
                let mut max_v = in_row[x];
                if max_v < 255 {
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
                }
                out_row[x] = max_v;
            }

            for x in inner_x0..inner_x1 {
                let center_idx = (y * w + x) as isize;
                let mut max_v = in_row[x];
                if max_v < 255 {
                    for &stride in &offset_strides {
                        let v = src[(center_idx + stride) as usize];
                        if v > max_v {
                            max_v = v;
                            if max_v == 255 {
                                break;
                            }
                        }
                    }
                }
                out_row[x] = max_v;
            }

            for x in inner_x1..w {
                let xi = x as isize;
                let mut max_v = in_row[x];
                if max_v < 255 {
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
                }
                out_row[x] = max_v;
            }
        } else {
            for (x, out_px) in out_row.iter_mut().enumerate() {
                let xi = x as isize;
                let mut max_v = in_row[x];
                if max_v < 255 {
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
                }
                *out_px = max_v;
            }
        }
    });
    dst
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dilate_u8_single_pixel() {
        let w = 7;
        let h = 7;
        let mut src = vec![0u8; w * h];
        src[3 * w + 3] = 255;
        let kernel = ellipse_kernel(3, 3);
        let dst = dilate_u8(&src, w, h, 3, 3, &kernel);
        // Center pixel and immediate orthogonal neighbors must be 255
        assert_eq!(dst[3 * w + 3], 255);
        assert_eq!(dst[2 * w + 3], 255);
        assert_eq!(dst[4 * w + 3], 255);
        assert_eq!(dst[3 * w + 2], 255);
        assert_eq!(dst[3 * w + 4], 255);
        // Corner pixel must be 0
        assert_eq!(dst[0], 0);
    }

    #[test]
    fn test_dilate_f32_preserves_maximum() {
        let w = 8;
        let h = 8;
        let mut src = vec![1.0f32; w * h];
        src[4 * w + 4] = 10.0;
        let kernel = ellipse_kernel(3, 3);
        let dst = dilate_f32(&src, w, h, 3, 3, &kernel);
        assert_eq!(dst[4 * w + 4], 10.0);
        assert_eq!(dst[3 * w + 4], 10.0);
        assert_eq!(dst[0], 1.0);
    }
}
