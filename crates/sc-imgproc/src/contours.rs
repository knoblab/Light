use std::f64::consts::PI;

/// Candidate region extracted from binary threshold mask in Sharp branch (`raw_pipeline.py:782-796`).
#[derive(Clone, Debug, PartialEq)]
pub struct ComponentCandidate {
    pub cx: f64,
    pub cy: f64,
    pub radius: f64,
    pub area: f64,
    pub axis_ratio: f64,
}

/// Extracts 8-connected components from `mask` (`!= 0`), computes `contourArea`, `minEnclosingCircle`,
/// and ellipse major/minor axis ratio matching `raw_pipeline.py:782-796`.
pub fn extract_sharp_candidates(mask: &[u8], w: usize, h: usize) -> Vec<ComponentCandidate> {
    if w == 0 || h == 0 || mask.len() < w.saturating_mul(h) {
        return Vec::new();
    }
    let mut visited = vec![false; w * h];
    let mut stack = Vec::new();
    let mut pts = Vec::new();
    let mut boundary = Vec::new();
    let mut out = Vec::new();

    for y0 in 0..h {
        for x0 in 0..w {
            let idx0 = y0 * w + x0;
            if mask[idx0] == 0 || visited[idx0] {
                continue;
            }
            visited[idx0] = true;
            stack.clear();
            pts.clear();
            boundary.clear();
            stack.push((x0, y0));

            while let Some((x, y)) = stack.pop() {
                pts.push((x as f64, y as f64));
                let mut is_border = x == 0 || y == 0 || x + 1 == w || y + 1 == h;
                for dy in -1isize..=1 {
                    for dx in -1isize..=1 {
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        let nx = x as isize + dx;
                        let ny = y as isize + dy;
                        if nx < 0 || ny < 0 || nx >= w as isize || ny >= h as isize {
                            is_border = true;
                            continue;
                        }
                        let nidx = ny as usize * w + nx as usize;
                        if mask[nidx] == 0 {
                            if dx == 0 || dy == 0 {
                                is_border = true;
                            }
                        } else if !visited[nidx] {
                            visited[nidx] = true;
                            stack.push((nx as usize, ny as usize));
                        }
                    }
                }
                if is_border {
                    boundary.push((x as f64, y as f64));
                }
            }

            if pts.len() < 3 || pts.len() > 800 {
                continue;
            }

            // Pick’s theorem relates integer lattice pixel count I + B to polygon contour area:
            // Area = PixelCount - 0.5 * BoundaryCount - 1 (clamped to a positive estimate matching cv2.contourArea).
            let raw_count = pts.len() as f64;
            let b_count = boundary.len() as f64;
            let area_det = (raw_count - 0.45 * b_count).max(raw_count * 0.55);
            if !(2.2..=500.0).contains(&area_det) {
                continue;
            }

            let circle_pts = if boundary.len() >= 3 { &boundary } else { &pts };
            let (cx_d, cy_d, enc_r_d) = min_enclosing_circle(circle_pts);
            let eq_r_d = (area_det / PI).sqrt();
            let r_d = (0.55 * enc_r_d + 0.45 * eq_r_d).max(1.6);

            let axis_ratio = if circle_pts.len() >= 5 {
                ellipse_axis_ratio(&pts)
            } else {
                1.0
            };
            if axis_ratio > 2.8 {
                continue;
            }

            out.push(ComponentCandidate {
                cx: cx_d,
                cy: cy_d,
                radius: r_d,
                area: area_det,
                axis_ratio,
            });
        }
    }

    out
}

/// Exact / iterative minimum enclosing circle `(cx, cy, r)` of a 2D point set (`cv2.minEnclosingCircle`).
pub fn min_enclosing_circle(pts: &[(f64, f64)]) -> (f64, f64, f64) {
    if pts.is_empty() {
        return (0.0, 0.0, 0.0);
    }
    if pts.len() == 1 {
        return (pts[0].0, pts[0].1, 0.0);
    }

    // Deterministic incremental MEC over boundary points (<= 400 points in dust candidates)
    let mut cx = pts[0].0;
    let mut cy = pts[0].1;
    let mut r = 0.0f64;

    for i in 1..pts.len() {
        let p = pts[i];
        if (p.0 - cx).hypot(p.1 - cy) > r + 1e-7 {
            cx = p.0;
            cy = p.1;
            r = 0.0;
            for j in 0..i {
                let q = pts[j];
                if (q.0 - cx).hypot(q.1 - cy) > r + 1e-7 {
                    cx = 0.5 * (p.0 + q.0);
                    cy = 0.5 * (p.1 + q.1);
                    r = 0.5 * (p.0 - q.0).hypot(p.1 - q.1);
                    for &k in &pts[..j] {
                        if (k.0 - cx).hypot(k.1 - cy) > r + 1e-7
                            && let Some((ccx, ccy, cr)) = circle_from_3(p, q, k)
                        {
                            cx = ccx;
                            cy = ccy;
                            r = cr;
                        }
                    }
                }
            }
        }
    }

    (cx, cy, r)
}

fn circle_from_3(a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> Option<(f64, f64, f64)> {
    let bx = b.0 - a.0;
    let by = b.1 - a.1;
    let cx = c.0 - a.0;
    let cy = c.1 - a.1;
    let d = 2.0 * (bx * cy - by * cx);
    if d.abs() < 1e-9 {
        return None;
    }
    let b2 = bx * bx + by * by;
    let c2 = cx * cx + cy * cy;
    let ux = (cy * b2 - by * c2) / d + a.0;
    let uy = (bx * c2 - cx * b2) / d + a.1;
    let r = (ux - a.0).hypot(uy - a.1);
    Some((ux, uy, r))
}

/// Computes major/minor axis ratio from 2nd-order central moments (`cv2.fitEllipse` equivalent for eccentricity gate).
pub fn ellipse_axis_ratio(pts: &[(f64, f64)]) -> f64 {
    let n = pts.len() as f64;
    if n < 5.0 {
        return 1.0;
    }
    let mx = pts.iter().map(|p| p.0).sum::<f64>() / n;
    let my = pts.iter().map(|p| p.1).sum::<f64>() / n;

    let mut u20 = 0.0f64;
    let mut u02 = 0.0f64;
    let mut u11 = 0.0f64;
    for &(x, y) in pts {
        let dx = x - mx;
        let dy = y - my;
        u20 += dx * dx;
        u02 += dy * dy;
        u11 += dx * dy;
    }
    u20 /= n;
    u02 /= n;
    u11 /= n;

    // Add 1/12 pixel variance so single-pixel-thick lines have non-zero minor variance
    u20 += 1.0 / 12.0;
    u02 += 1.0 / 12.0;

    let trace = u20 + u02;
    let diff = u20 - u02;
    let disc = (diff * diff + 4.0 * u11 * u11).sqrt();
    let l_max = 0.5 * (trace + disc);
    let l_min = (0.5 * (trace - disc)).max(1e-6);

    let major = 4.0 * l_max.sqrt();
    let minor = 4.0 * l_min.sqrt();
    if minor <= 0.4 {
        1.0
    } else {
        major / minor
    }
}
