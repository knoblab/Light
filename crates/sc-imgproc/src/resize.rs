use rayon::prelude::*;

#[derive(Clone, Debug)]
struct AreaTap {
    index: usize,
    weight: f32,
}

/// Precomputes box-integration weights along 1D from `src_len` to `dst_len` matching `cv2.INTER_AREA`.
fn build_area_weights(src_len: usize, dst_len: usize) -> Vec<Vec<AreaTap>> {
    let scale = src_len as f64 / dst_len.max(1) as f64;
    let inv_scale = 1.0 / scale;
    let mut table = Vec::with_capacity(dst_len);
    for d in 0..dst_len {
        let fsx1 = d as f64 * scale;
        let fsx2 = fsx1 + scale;
        let sx1 = fsx1.ceil() as usize;
        let sx2 = fsx2.floor() as usize;

        let mut taps = Vec::new();
        if (sx1 as f64) > fsx1 && sx1 > 0 {
            let idx = (sx1 - 1).min(src_len - 1);
            let w = ((sx1 as f64 - fsx1).min(scale) * inv_scale) as f32;
            if w > 0.0 {
                taps.push(AreaTap { index: idx, weight: w });
            }
        }
        for sx in sx1..sx2.min(src_len) {
            taps.push(AreaTap {
                index: sx,
                weight: inv_scale as f32,
            });
        }
        if fsx2 > sx2 as f64 && sx2 < src_len && sx2 >= sx1 {
            let w = ((fsx2 - sx2 as f64).min(scale) * inv_scale) as f32;
            if w > 0.0 {
                taps.push(AreaTap { index: sx2, weight: w });
            }
        }
        if taps.is_empty() {
            let idx = ((fsx1.floor() as isize).clamp(0, src_len as isize - 1)) as usize;
            taps.push(AreaTap {
                index: idx,
                weight: 1.0,
            });
        } else {
            let sum: f32 = taps.iter().map(|t| t.weight).sum();
            if sum > 0.0 && (sum - 1.0).abs() > 1e-6 {
                for t in &mut taps {
                    t.weight /= sum;
                }
            }
        }
        table.push(taps);
    }
    table
}

/// Single-channel `f32` area-averaging downsampler (`cv2.INTER_AREA`).
/// Falls back to bilinear interpolation when upsampling.
pub fn resize_inter_area_f32(
    src: &[f32],
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
) -> Vec<f32> {
    if sw == 0 || sh == 0 || dw == 0 || dh == 0 || src.len() < sw.saturating_mul(sh) {
        return Vec::new();
    }
    if sw == dw && sh == dh {
        return src[..sw * sh].to_vec();
    }
    if dw > sw || dh > sh {
        return resize_bilinear_f32(src, sw, sh, dw, dh);
    }

    let x_taps = build_area_weights(sw, dw);
    let y_taps = build_area_weights(sh, dh);

    // Horizontal pass: (sw, sh) -> (dw, sh)
    let mut horiz = vec![0.0f32; dw * sh];
    horiz
        .par_chunks_mut(dw)
        .enumerate()
        .for_each(|(sy, out_row)| {
            let in_row = &src[sy * sw..(sy + 1) * sw];
            for (dx, taps) in x_taps.iter().enumerate() {
                let mut acc = 0.0f32;
                for tap in taps {
                    acc += in_row[tap.index] * tap.weight;
                }
                out_row[dx] = acc;
            }
        });

    // Vertical pass: (dw, sh) -> (dw, dh)
    let mut dst = vec![0.0f32; dw * dh];
    dst.par_chunks_mut(dw)
        .enumerate()
        .for_each(|(dy, out_row)| {
            for tap in &y_taps[dy] {
                let in_row = &horiz[tap.index * dw..(tap.index + 1) * dw];
                for (out_px, &v) in out_row.iter_mut().zip(in_row.iter()) {
                    *out_px += v * tap.weight;
                }
            }
        });

    dst
}

/// 3-channel interleaved `u16` RGB area-averaging downsampler (`cv2.resize(..., INTER_AREA)`).
pub fn resize_inter_area_u16_rgb(
    src: &[u16],
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
) -> Vec<u16> {
    let needed = sw.saturating_mul(sh).saturating_mul(3);
    if sw == 0 || sh == 0 || dw == 0 || dh == 0 || src.len() < needed {
        return Vec::new();
    }
    if sw == dw && sh == dh {
        return src[..needed].to_vec();
    }

    let x_taps = build_area_weights(sw, dw);
    let y_taps = build_area_weights(sh, dh);

    let mut horiz = vec![0.0f32; dw * sh * 3];
    horiz
        .par_chunks_mut(dw * 3)
        .enumerate()
        .for_each(|(sy, out_row)| {
            let in_row = &src[sy * sw * 3..(sy + 1) * sw * 3];
            for (dx, taps) in x_taps.iter().enumerate() {
                let mut r = 0.0f32;
                let mut g = 0.0f32;
                let mut b = 0.0f32;
                for tap in taps {
                    let base = tap.index * 3;
                    r += in_row[base] as f32 * tap.weight;
                    g += in_row[base + 1] as f32 * tap.weight;
                    b += in_row[base + 2] as f32 * tap.weight;
                }
                let out_base = dx * 3;
                out_row[out_base] = r;
                out_row[out_base + 1] = g;
                out_row[out_base + 2] = b;
            }
        });

    let mut dst = vec![0u16; dw * dh * 3];
    dst.par_chunks_mut(dw * 3)
        .enumerate()
        .for_each(|(dy, out_row)| {
            let mut acc = vec![0.0f32; dw * 3];
            for tap in &y_taps[dy] {
                let in_row = &horiz[tap.index * dw * 3..(tap.index + 1) * dw * 3];
                for (a, &v) in acc.iter_mut().zip(in_row.iter()) {
                    *a += v * tap.weight;
                }
            }
            for (out_px, a) in out_row.iter_mut().zip(acc) {
                *out_px = a.round().clamp(0.0, 65535.0) as u16;
            }
        });

    dst
}

/// Single-channel `f32` bilinear resizer (`cv2.INTER_LINEAR`).
pub fn resize_bilinear_f32(
    src: &[f32],
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
) -> Vec<f32> {
    if sw == 0 || sh == 0 || dw == 0 || dh == 0 || src.len() < sw.saturating_mul(sh) {
        return Vec::new();
    }
    if sw == dw && sh == dh {
        return src[..sw * sh].to_vec();
    }

    let scale_x = sw as f64 / dw as f64;
    let scale_y = sh as f64 / dh as f64;
    let mut dst = vec![0.0f32; dw * dh];

    dst.par_chunks_mut(dw)
        .enumerate()
        .for_each(|(dy, out_row)| {
            let fy = ((dy as f64 + 0.5) * scale_y - 0.5).clamp(0.0, (sh - 1) as f64);
            let y0 = fy.floor() as usize;
            let y1 = (y0 + 1).min(sh - 1);
            let wy = (fy - y0 as f64) as f32;
            let row0 = &src[y0 * sw..(y0 + 1) * sw];
            let row1 = &src[y1 * sw..(y1 + 1) * sw];

            for (dx, out_px) in out_row.iter_mut().enumerate() {
                let fx = ((dx as f64 + 0.5) * scale_x - 0.5).clamp(0.0, (sw - 1) as f64);
                let x0 = fx.floor() as usize;
                let x1 = (x0 + 1).min(sw - 1);
                let wx = (fx - x0 as f64) as f32;

                let v00 = row0[x0];
                let v01 = row0[x1];
                let v10 = row1[x0];
                let v11 = row1[x1];

                let top = v00 + (v01 - v00) * wx;
                let bot = v10 + (v11 - v10) * wx;
                *out_px = top + (bot - top) * wy;
            }
        });

    dst
}

/// Nearest-neighbour resizer for `u8` masks (`cv2.INTER_NEAREST`).
pub fn resize_nearest_u8(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    if sw == 0 || sh == 0 || dw == 0 || dh == 0 || src.len() < sw.saturating_mul(sh) {
        return Vec::new();
    }
    if sw == dw && sh == dh {
        return src[..sw * sh].to_vec();
    }
    let scale_x = sw as f64 / dw as f64;
    let scale_y = sh as f64 / dh as f64;
    let mut dst = vec![0u8; dw * dh];
    for dy in 0..dh {
        let sy = ((dy as f64 * scale_y).floor() as usize).min(sh - 1);
        let in_row = &src[sy * sw..(sy + 1) * sw];
        let out_row = &mut dst[dy * dw..(dy + 1) * dw];
        for (dx, out_px) in out_row.iter_mut().enumerate() {
            let sx = ((dx as f64 * scale_x).floor() as usize).min(sw - 1);
            *out_px = in_row[sx];
        }
    }
    dst
}

/// Nearest-neighbour resizer for boolean masks (`cv2.INTER_NEAREST`).
pub fn resize_nearest_bool(
    src: &[bool],
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
) -> Vec<bool> {
    if sw == 0 || sh == 0 || dw == 0 || dh == 0 || src.len() < sw.saturating_mul(sh) {
        return Vec::new();
    }
    if sw == dw && sh == dh {
        return src[..sw * sh].to_vec();
    }
    let scale_x = sw as f64 / dw as f64;
    let scale_y = sh as f64 / dh as f64;
    let mut dst = vec![false; dw * dh];
    for dy in 0..dh {
        let sy = ((dy as f64 * scale_y).floor() as usize).min(sh - 1);
        let in_row = &src[sy * sw..(sy + 1) * sw];
        let out_row = &mut dst[dy * dw..(dy + 1) * dw];
        for (dx, out_px) in out_row.iter_mut().enumerate() {
            let sx = ((dx as f64 * scale_x).floor() as usize).min(sw - 1);
            *out_px = in_row[sx];
        }
    }
    dst
}
