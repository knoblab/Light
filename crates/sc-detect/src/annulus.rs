use sc_color::percentile_f32;
use std::f64::consts::PI;

pub const GRID_HALF: isize = 150;
pub const GRID_DIM: usize = (GRID_HALF * 2 + 1) as usize; // 301

/// Precomputed 301×301 radial distance, coordinate, and 8-sector lookup grids centered at `(150, 150)`,
/// matching `_GX, _GY, _GDIST, _GSECTOR` in `raw_pipeline.py:463-467`.
pub struct AnnulusGrids {
    pub gx: Vec<f32>,
    pub gy: Vec<f32>,
    pub gdist: Vec<f32>,
    pub gsector: Vec<u8>,
}

impl Default for AnnulusGrids {
    fn default() -> Self {
        Self::new()
    }
}

impl AnnulusGrids {
    pub fn new() -> Self {
        let total = GRID_DIM * GRID_DIM;
        let mut gx = Vec::with_capacity(total);
        let mut gy = Vec::with_capacity(total);
        let mut gdist = Vec::with_capacity(total);
        let mut gsector = Vec::with_capacity(total);

        for dy in -GRID_HALF..=GRID_HALF {
            for dx in -GRID_HALF..=GRID_HALF {
                let fx = dx as f32;
                let fy = dy as f32;
                let dist = fx.hypot(fy);
                let angle = (fy as f64).atan2(fx as f64);
                let sec = (((angle + PI) / (2.0 * PI) * 8.0).floor() as i32).clamp(0, 7) as u8;
                gx.push(fx);
                gy.push(fy);
                gdist.push(dist);
                gsector.push(sec);
            }
        }

        Self {
            gx,
            gy,
            gdist,
            gsector,
        }
    }
}

/// Solves 3×3 normal equations for 1st-order plane `a*x + b*y + c` matching `_fast_fit_plane`
/// in `raw_pipeline.py:470-487`.
pub fn fast_fit_plane(ax: &[f32], ay: &[f32], av: &[f32]) -> [f64; 3] {
    let n = ax.len() as f64;
    if ax.is_empty() {
        return [0.0, 0.0, 0.0];
    }
    let mut sx = 0.0f64;
    let mut sy = 0.0f64;
    let mut sxx = 1e-5f64;
    let mut syy = 1e-5f64;
    let mut sxy = 0.0f64;
    let mut sv = 0.0f64;
    let mut sxv = 0.0f64;
    let mut syv = 0.0f64;

    for i in 0..ax.len() {
        let x = ax[i] as f64;
        let y = ay[i] as f64;
        let v = av[i] as f64;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
        sv += v;
        sxv += x * v;
        syv += y * v;
    }

    solve_3x3(
        [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n + 1e-5]],
        [sxv, syv, sv],
    )
}

/// Solves a 3×3 linear system `m * x = rhs` via Gaussian elimination with partial pivoting.
pub fn solve_3x3(mut m: [[f64; 3]; 3], mut rhs: [f64; 3]) -> [f64; 3] {
    for col in 0..3 {
        let mut pivot_row = col;
        let mut max_abs = m[col][col].abs();
        for (r, row) in m.iter().enumerate().skip(col + 1) {
            if row[col].abs() > max_abs {
                max_abs = row[col].abs();
                pivot_row = r;
            }
        }
        if max_abs < 1e-12 {
            return [0.0, 0.0, 0.0];
        }
        if pivot_row != col {
            m.swap(col, pivot_row);
            rhs.swap(col, pivot_row);
        }
        let pivot = m[col][col];
        #[allow(clippy::needless_range_loop)]
        for r in (col + 1)..3 {
            let factor = m[r][col] / pivot;
            rhs[r] -= factor * rhs[col];
            for c in col..3 {
                m[r][c] -= factor * m[col][c];
            }
        }
    }

    let mut x = [0.0f64; 3];
    for i in (0..3).rev() {
        let mut sum = rhs[i];
        for j in (i + 1)..3 {
            sum -= m[i][j] * x[j];
        }
        x[i] = if m[i][i].abs() > 1e-12 {
            sum / m[i][i]
        } else {
            0.0
        };
    }
    x
}

#[inline]
fn pop_std(vals: &[f32]) -> f64 {
    if vals.is_empty() {
        return 0.0;
    }
    let n = vals.len() as f64;
    let mean = vals.iter().map(|&v| v as f64).sum::<f64>() / n;
    let var = vals
        .iter()
        .map(|&v| {
            let d = v as f64 - mean;
            d * d
        })
        .sum::<f64>()
        / n;
    var.max(0.0).sqrt()
}

#[derive(Clone, Copy, Debug)]
pub struct AnnulusEval {
    pub best_r_det: f64,
    pub contrast_drop_pct: f64,
    pub isotropy: f64,
    pub snr: f64,
    pub depth: f64,
}

#[allow(clippy::too_many_arguments)]
pub fn eval_single_radius_annulus(
    grids: &AnnulusGrids,
    img_gray: &[f32],
    grad_map: &[f32],
    bg_std_map: &[f32],
    hf_tex_map: &[f32],
    w: usize,
    h: usize,
    cx_det: f64,
    cy_det: f64,
    r_det: f64,
    is_sharp_branch: bool,
    cloud_protection: f64,
    sensitivity: f64,
) -> Option<AnnulusEval> {
    let ix = cx_det.round() as isize;
    let iy = cy_det.round() as isize;
    let r_out = ((r_det * 2.28).max(r_det + 5.0).round() as isize).min(GRID_HALF);

    let min_border = (r_det * 1.15).max(4.0).round() as isize;
    if ix < min_border
        || ix >= w as isize - min_border
        || iy < min_border
        || iy >= h as isize - min_border
    {
        return None;
    }

    let prot = 0.55 + (cloud_protection / 100.0) * 0.60;
    let center_idx = iy as usize * w + ix as usize;
    let local_bg_std = bg_std_map[center_idx] as f64;
    let local_hf_tex = hf_tex_map[center_idx] as f64;

    let max_bg_std = (if is_sharp_branch { 3.45 } else { 2.75 }) / prot;
    if local_bg_std > max_bg_std || local_hf_tex > (1.55 / prot) {
        return None;
    }

    let y0 = (iy - r_out).max(0) as usize;
    let y1 = ((iy + r_out + 1).min(h as isize)).max(0) as usize;
    let x0 = (ix - r_out).max(0) as usize;
    let x1 = ((ix + r_out + 1).min(w as isize)).max(0) as usize;

    let r_core = (r_det * if is_sharp_branch { 0.52 } else { 0.48 }).max(1.2) as f32;
    let r_ann_in = (r_det * 1.32).max(r_det + 1.8) as f32;
    let r_out_f = r_out as f32;

    let mut core_pixels = Vec::with_capacity(64);
    let mut ax = Vec::with_capacity(256);
    let mut ay = Vec::with_capacity(256);
    let mut av = Vec::with_capacity(256);
    let mut asec = Vec::with_capacity(256);

    for py in y0..y1 {
        let gy = (GRID_HALF + (py as isize - iy)) as usize;
        let img_row = &img_gray[py * w..(py + 1) * w];
        let grid_row_base = gy * GRID_DIM;
        for (px, &p_val) in img_row.iter().enumerate().take(x1).skip(x0) {
            if p_val < 8.0 {
                continue;
            }
            let gx = (GRID_HALF + (px as isize - ix)) as usize;
            let g_idx = grid_row_base + gx;
            let d = grids.gdist[g_idx];
            if d <= r_core {
                core_pixels.push(p_val);
            } else if d >= r_ann_in && d <= r_out_f {
                ax.push(grids.gx[g_idx]);
                ay.push(grids.gy[g_idx]);
                av.push(p_val);
                asec.push(grids.gsector[g_idx]);
            }
        }
    }

    let n_ann = av.len();
    if n_ann < 16 || core_pixels.is_empty() {
        return None;
    }

    let sens_factor = 1.32 - (sensitivity / 100.0) * 0.52;
    let min_depth = (if is_sharp_branch { 2.10 } else { 1.08 }) * sens_factor;

    let approx_bg = av.iter().map(|&v| v as f64).sum::<f64>() / n_ann as f64;
    if approx_bg < 84.0 {
        return None;
    }

    let core_val = if is_sharp_branch {
        percentile_f32(&mut core_pixels, 25.0)
    } else {
        core_pixels.iter().map(|&v| v as f64).sum::<f64>() / core_pixels.len() as f64
    };

    if approx_bg - core_val < min_depth * 0.72 {
        return None;
    }

    // Step 1: Initial 1st-order plane fit on ALL outer annulus pixels
    let coeffs1 = fast_fit_plane(&ax, &ay, &av);
    let mut res1 = Vec::with_capacity(n_ann);
    for i in 0..n_ann {
        let fitted =
            coeffs1[0] * ax[i] as f64 + coeffs1[1] * ay[i] as f64 + coeffs1[2];
        res1.push((av[i] as f64 - fitted) as f32);
    }
    let ann_all_std = pop_std(&res1);

    let mut res_sorted = res1.clone();
    res_sorted.sort_by(|a, b| a.total_cmp(b));
    let p05_res = res_sorted[(n_ann as f64 * 0.05) as usize] as f64;
    let p95_res = res_sorted[((n_ann as f64 * 0.95) as usize).min(n_ann - 1)] as f64;
    let ann_span = p95_res - p05_res;

    let max_ann_all_std = (if is_sharp_branch { 1.85 } else { 1.48 }) / prot;
    let max_ann_span = (if is_sharp_branch { 5.20 } else { 4.30 }) / prot;
    if ann_all_std > max_ann_all_std || ann_span > max_ann_span {
        return None;
    }

    // Step 2: Symmetric [18%, 82%] percentile trimming
    let lo_p = res_sorted[(n_ann as f64 * 0.18) as usize];
    let hi_p = res_sorted[((n_ann as f64 * 0.82) as usize).min(n_ann - 1)];

    let mut ax_c = Vec::with_capacity(n_ann);
    let mut ay_c = Vec::with_capacity(n_ann);
    let mut av_c = Vec::with_capacity(n_ann);
    for i in 0..n_ann {
        let r = res1[i];
        if r >= lo_p && r <= hi_p {
            ax_c.push(ax[i]);
            ay_c.push(ay[i]);
            av_c.push(av[i]);
        }
    }

    let (coeffs, ann_clean_std) = if av_c.len() >= 10 {
        let c = fast_fit_plane(&ax_c, &ay_c, &av_c);
        let mut res_clean = Vec::with_capacity(av_c.len());
        for i in 0..av_c.len() {
            let fitted = c[0] * ax_c[i] as f64 + c[1] * ay_c[i] as f64 + c[2];
            res_clean.push((av_c[i] as f64 - fitted) as f32);
        }
        (c, pop_std(&res_clean))
    } else {
        (coeffs1, ann_all_std)
    };

    let plane_center = coeffs[2];
    if plane_center < 86.0 {
        return None;
    }

    let depth = plane_center - core_val;
    if depth < min_depth {
        return None;
    }

    let eff_noise = (ann_clean_std * 1.35).max(ann_all_std * 0.72).max(0.25);
    let snr = depth / eff_noise;
    let min_snr =
        (if is_sharp_branch { 3.15 } else { 2.40 }) * sens_factor * (0.82 + 0.18 * prot);
    if snr < min_snr {
        return None;
    }

    // Step 3 (Bokeh only): inner gradient 90th percentile check
    if !is_sharp_branch {
        let r_inner = (r_det * 1.35) as f32;
        let mut inner_grad = Vec::with_capacity(64);
        for py in y0..y1 {
            let gy = (GRID_HALF + (py as isize - iy)) as usize;
            let grad_row = &grad_map[py * w..(py + 1) * w];
            let grid_row_base = gy * GRID_DIM;
            for (px, &g_val) in grad_row.iter().enumerate().take(x1).skip(x0) {
                let gx = (GRID_HALF + (px as isize - ix)) as usize;
                if grids.gdist[grid_row_base + gx] <= r_inner {
                    inner_grad.push(g_val);
                }
            }
        }
        if !inner_grad.is_empty() {
            inner_grad.sort_by(|a, b| a.total_cmp(b));
            let idx90 = ((inner_grad.len() as f64 * 0.90) as usize).min(inner_grad.len() - 1);
            let inner_grad_p90 = inner_grad[idx90] as f64;
            if inner_grad_p90 > (depth * 1.35).max(3.4) {
                return None;
            }
        }
    }

    // Step 4: Fast 8-Sector Angular Enclosure Check
    let mut sec_counts = [0usize; 8];
    let mut sec_sums = [0.0f64; 8];
    for i in 0..n_ann {
        let s = asec[i] as usize;
        sec_counts[s] += 1;
        sec_sums[s] += res1[i] as f64 + plane_center;
    }

    let mut valid_sectors = 0usize;
    let mut brighter_sectors = 0usize;
    let req_margin = depth * 0.20;
    for s in 0..8 {
        if sec_counts[s] >= 2 {
            valid_sectors += 1;
            let sec_mean = sec_sums[s] / sec_counts[s] as f64;
            if (sec_mean - core_val) >= req_margin {
                brighter_sectors += 1;
            }
        }
    }
    if valid_sectors < 6 || brighter_sectors < 6.max(valid_sectors.saturating_sub(1)) {
        return None;
    }

    let contrast_drop_pct = (depth / plane_center.max(20.0)) * 100.0;
    let isotropy = (1.0 - (eff_noise / (depth * 1.5 + 0.35))).clamp(0.62, 0.98);

    Some(AnnulusEval {
        best_r_det: r_det,
        contrast_drop_pct,
        isotropy,
        snr,
        depth,
    })
}

/// Multi-radius local contrast optimizer around `r_det` matching `verify_annulus_plane_snr`
/// in `raw_pipeline.py:637-674`.
#[allow(clippy::too_many_arguments)]
pub fn verify_annulus_plane_snr(
    grids: &AnnulusGrids,
    img_gray: &[f32],
    grad_map: &[f32],
    bg_std_map: &[f32],
    hf_tex_map: &[f32],
    w: usize,
    h: usize,
    cx_det: f64,
    cy_det: f64,
    r_det: f64,
    is_sharp_branch: bool,
    cloud_protection: f64,
    sensitivity: f64,
) -> Option<AnnulusEval> {
    let multipliers: &[f64] = if is_sharp_branch {
        &[0.90, 1.0, 1.25, 1.55]
    } else {
        &[0.88, 1.0, 1.15, 1.28]
    };

    let mut best: Option<(f64, AnnulusEval)> = None;
    for &mult in multipliers {
        let cand_r = (r_det * mult).max(1.4);
        if let Some(eval) = eval_single_radius_annulus(
            grids,
            img_gray,
            grad_map,
            bg_std_map,
            hf_tex_map,
            w,
            h,
            cx_det,
            cy_det,
            cand_r,
            is_sharp_branch,
            cloud_protection,
            sensitivity,
        ) {
            let score = eval.depth * eval.snr.sqrt();
            if best.is_none_or(|(bs, _)| score > bs) {
                best = Some((score, eval));
            }
        }
    }

    best.map(|(_, eval)| eval)
}
