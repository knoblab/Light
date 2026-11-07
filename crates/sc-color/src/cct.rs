//! Correlated colour temperature, tint, and white-balance adaptation.

use crate::spaces::{Mat3, RgbSpace, Xy, bradford};

/// Tint units per unit of Duv.
pub const TINT_SCALE: f64 = 3000.0;
pub const MIN_K: f64 = 1667.0;
pub const MAX_K: f64 = 25000.0;

fn kim_xy(t: f64) -> Xy {
    let t = t.clamp(MIN_K, MAX_K);
    let (t2, t3) = (t * t, t * t * t);
    let x = if t <= 4000.0 {
        -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.179910
    } else {
        -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.240390
    };
    let (x2, x3) = (x * x, x * x * x);
    let y = if t <= 2222.0 {
        -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683
    } else if t <= 4000.0 {
        -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
    } else {
        3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483
    };
    Xy::new(x, y)
}

pub fn xy_to_uv(p: Xy) -> (f64, f64) {
    let d = -2.0 * p.x + 12.0 * p.y + 3.0;
    (4.0 * p.x / d, 6.0 * p.y / d)
}

pub fn uv_to_xy(u: f64, v: f64) -> Xy {
    let d = 2.0 * u - 8.0 * v + 4.0;
    Xy::new(3.0 * u / d, 2.0 * v / d)
}

fn locus_uv(t: f64) -> (f64, f64) {
    let t = t.max(1000.0);
    if (MIN_K..=MAX_K).contains(&t) {
        return xy_to_uv(kim_xy(t));
    }
    let (a, b) = if t < MIN_K {
        (MIN_K, MIN_K + 50.0)
    } else {
        (MAX_K - 500.0, MAX_K)
    };
    let (ua, va) = xy_to_uv(kim_xy(a));
    let (ub, vb) = xy_to_uv(kim_xy(b));
    let (ma, mb, m) = (1e6 / a, 1e6 / b, 1e6 / t);
    let s = (m - ma) / (mb - ma);
    (ua + (ub - ua) * s, va + (vb - va) * s)
}

fn locus_normal(t: f64) -> (f64, f64) {
    let m = 1e6 / t;
    let (u0, v0) = locus_uv(1e6 / (m + 1.0));
    let (u1, v1) = locus_uv(1e6 / (m - 1.0).max(1.0));
    let (du, dv) = (u1 - u0, v1 - v0);
    let l = du.hypot(dv).max(1e-12);
    let (nx, ny) = (-dv / l, du / l);
    if ny < 0.0 { (-nx, -ny) } else { (nx, ny) }
}

pub fn temp_tint_to_xy(t: f64, tint: f64) -> Xy {
    let (u, v) = locus_uv(t);
    let (nu, nv) = locus_normal(t);
    let duv = tint / TINT_SCALE;
    uv_to_xy(u + nu * duv, v + nv * duv)
}

pub fn xy_to_temp_tint(p: Xy) -> (f64, f64) {
    let (u, v) = xy_to_uv(p);
    let dist = |m: f64| {
        let (lu, lv) = locus_uv(1e6 / m);
        (u - lu).powi(2) + (v - lv).powi(2)
    };
    let mut best = 20.0;
    let mut bd = f64::MAX;
    let mut m = 20.0;
    while m <= 1000.0 {
        let d = dist(m);
        if d < bd {
            bd = d;
            best = m;
        }
        m += 5.0;
    }
    let (mut a, mut b) = ((best - 5.0).max(20.0), (best + 5.0).min(1000.0));
    let g = 0.618_033_988_75;
    for _ in 0..60 {
        let c = b - g * (b - a);
        let d = a + g * (b - a);
        if dist(c) < dist(d) {
            b = d
        } else {
            a = c
        }
    }
    let m = (a + b) / 2.0;
    let t = 1e6 / m;
    let (lu, lv) = locus_uv(t);
    let (nu, nv) = locus_normal(t);
    let duv = (u - lu) * nu + (v - lv) * nv;
    (t, duv * TINT_SCALE)
}

pub fn wb_matrix(space: &RgbSpace, src: Xy) -> Mat3 {
    let adapt = bradford(src, space.white);
    space.from_xyz().mul(&adapt).mul(&space.to_xyz())
}
