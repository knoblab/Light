/// Draws a filled circle on a single-channel `u8` mask (`cv2.circle(..., -1)`).
pub fn draw_filled_circle_u8(
    img: &mut [u8],
    w: usize,
    h: usize,
    cx: isize,
    cy: isize,
    radius: isize,
    val: u8,
) {
    if w == 0 || h == 0 || radius < 0 || img.len() < w.saturating_mul(h) {
        return;
    }
    let r2 = radius * radius;
    let y0 = (cy - radius).max(0) as usize;
    let y1 = (cy + radius).min(h as isize - 1).max(-1);
    if y1 < y0 as isize {
        return;
    }
    for y in y0..=y1 as usize {
        let dy = y as isize - cy;
        let dy2 = dy * dy;
        let x0 = (cx - radius).max(0) as usize;
        let x1 = (cx + radius).min(w as isize - 1).max(-1);
        if x1 < x0 as isize {
            continue;
        }
        let row = &mut img[y * w..(y + 1) * w];
        for (x, px_out) in row.iter_mut().enumerate().take(x1 as usize + 1).skip(x0) {
            let dx = x as isize - cx;
            if dx * dx + dy2 <= r2 {
                *px_out = val;
            }
        }
    }
}

/// Draws a thick line segment with circular caps on a single-channel `u8` mask (`cv2.line`).
#[allow(clippy::too_many_arguments)]
pub fn draw_thick_line_u8(
    img: &mut [u8],
    w: usize,
    h: usize,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    radius: f64,
    val: u8,
) {
    if w == 0 || h == 0 || radius <= 0.0 || img.len() < w.saturating_mul(h) {
        return;
    }
    let pad = radius.ceil() as isize + 1;
    let min_x = (x0.min(x1).floor() as isize - pad).max(0) as usize;
    let max_x = (x0.max(x1).ceil() as isize + pad).min(w as isize - 1).max(-1);
    let min_y = (y0.min(y1).floor() as isize - pad).max(0) as usize;
    let max_y = (y0.max(y1).ceil() as isize + pad).min(h as isize - 1).max(-1);
    if max_x < min_x as isize || max_y < min_y as isize {
        return;
    }

    let vx = x1 - x0;
    let vy = y1 - y0;
    let len2 = vx * vx + vy * vy;
    let r2 = radius * radius;

    for y in min_y..=max_y as usize {
        let py = y as f64;
        let row = &mut img[y * w..(y + 1) * w];
        for (x, px_out) in row.iter_mut().enumerate().take(max_x as usize + 1).skip(min_x) {
            let px = x as f64;
            let t = if len2 > 1e-9 {
                (((px - x0) * vx + (py - y0) * vy) / len2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let proj_x = x0 + t * vx;
            let proj_y = y0 + t * vy;
            let d2 = (px - proj_x).powi(2) + (py - proj_y).powi(2);
            if d2 <= r2 {
                *px_out = val;
            }
        }
    }
}

/// Draws a 1px anti-aliased circle outline on a 3-channel RGB `u8` buffer (`cv2.circle(..., lineType=cv2.LINE_AA)`).
#[allow(clippy::too_many_arguments)]
pub fn draw_aa_circle_rgb(
    img: &mut [u8],
    w: usize,
    h: usize,
    cx: f64,
    cy: f64,
    radius: f64,
    color: [u8; 3],
) {
    if w == 0 || h == 0 || radius <= 0.0 || img.len() < w.saturating_mul(h).saturating_mul(3) {
        return;
    }
    let pad = (radius + 2.0).ceil() as isize;
    let min_x = (cx.floor() as isize - pad).max(0) as usize;
    let max_x = (cx.ceil() as isize + pad).min(w as isize - 1).max(-1);
    let min_y = (cy.floor() as isize - pad).max(0) as usize;
    let max_y = (cy.ceil() as isize + pad).min(h as isize - 1).max(-1);
    if max_x < min_x as isize || max_y < min_y as isize {
        return;
    }

    for y in min_y..=max_y as usize {
        let dy = y as f64 - cy;
        for x in min_x..=max_x as usize {
            let dx = x as f64 - cx;
            let d = dx.hypot(dy);
            let dist_from_ring = (d - radius).abs();
            if dist_from_ring < 1.2 {
                let alpha = (1.2 - dist_from_ring).clamp(0.0, 1.0) as f32;
                let base = (y * w + x) * 3;
                for c in 0..3 {
                    let cur = img[base + c] as f32;
                    let target = color[c] as f32;
                    img[base + c] = (cur * (1.0 - alpha) + target * alpha).round().clamp(0.0, 255.0) as u8;
                }
            }
        }
    }
}
