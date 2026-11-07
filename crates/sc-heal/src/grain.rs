//! Deterministic Sensor Grain Synthesis & Local Noise Estimation.
//!
//! Replaces random PRNGs with coordinate-hashed SplitMix64 PRNG:
//! `(sensor_x, sensor_y, channel, seed)` produces bit-identical grain regardless
//! of ROI processing order or tile partitioning.

#![forbid(unsafe_code)]

use sc_color::median_f32;
use sc_imgproc::gaussian_blur_f32;
use std::f32::consts::TAU;

/// Computes SplitMix64 hash of a 64-bit integer.
#[inline]
pub fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

/// Generates a deterministic unit float $[0, 1)$ from `(sensor_x, sensor_y, phase, seed, stream)`.
#[inline]
pub fn deterministic_unit_f32(
    sensor_x: usize,
    sensor_y: usize,
    phase: usize,
    seed: u64,
    stream: u64,
) -> f32 {
    let mut key = seed;
    key ^= (sensor_x as u64) << 32 | (sensor_y as u64 & 0xFFFF_FFFF);
    key = splitmix64(key.wrapping_add((phase as u64) << 16));
    key = splitmix64(key.wrapping_add(stream));
    ((key >> 40) as f32) * (1.0 / (1u32 << 24) as f32)
}

/// Generates standard normal $\mathcal{N}(0, 1)$ noise for a specific sensor pixel coordinate.
#[inline]
pub fn deterministic_gaussian(
    sensor_x: usize,
    sensor_y: usize,
    phase: usize,
    seed: u64,
) -> f32 {
    let u1 = deterministic_unit_f32(sensor_x, sensor_y, phase, seed, 0).clamp(1e-7, 1.0 - 1e-7);
    let u2 = deterministic_unit_f32(sensor_x, sensor_y, phase, seed, 1);
    (-2.0 * u1.ln()).sqrt() * (TAU * u2).cos()
}

/// Estimates local noise standard deviation $\sigma_{\text{MAD}}$ per phase on clean ring pixels.
pub fn estimate_4phase_ring_noise(
    cfa: &[u16],
    ring_mask: &[u8],
    rw: usize,
    rh: usize,
) -> [f32; 4] {
    let half_rw = rw.div_ceil(2);
    let half_rh = rh.div_ceil(2);
    let mut phase_std = [0.0f32; 4];

    for (p, slot) in phase_std.iter_mut().enumerate() {
        let py = p / 2;
        let px = p % 2;

        let mut sub_img = vec![0.0f32; half_rw * half_rh];
        let mut sub_ring = vec![false; half_rw * half_rh];
        let mut count = 0usize;

        for sy in 0..half_rh {
            let y = sy * 2 + py;
            if y >= rh {
                continue;
            }
            for sx in 0..half_rw {
                let x = sx * 2 + px;
                if x >= rw {
                    continue;
                }
                let idx = y * rw + x;
                sub_img[sy * half_rw + sx] = cfa[idx] as f32;
                if ring_mask[idx] != 0 {
                    sub_ring[sy * half_rw + sx] = true;
                    count += 1;
                }
            }
        }

        if count < 10 {
            *slot = 0.0;
            continue;
        }

        let blurred = gaussian_blur_f32(&sub_img, half_rw, half_rh, 1.2);
        let mut hf_residuals: Vec<f32> = Vec::with_capacity(count);

        for sy in 0..half_rh {
            for sx in 0..half_rw {
                let s_idx = sy * half_rw + sx;
                if sub_ring[s_idx] {
                    let diff = (sub_img[s_idx] - blurred[s_idx]).abs();
                    hf_residuals.push(diff);
                }
            }
        }

        let med = median_f32(&mut hf_residuals) as f32;
        let sigma = (med * 1.4826).clamp(0.0, 500.0);
        *slot = sigma;
    }

    phase_std
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_noise_is_repeatable_and_zero_mean() {
        let n1 = deterministic_gaussian(100, 200, 1, 42);
        let n2 = deterministic_gaussian(100, 200, 1, 42);
        assert_eq!(n1, n2, "Deterministic noise must be bit-identical for same coords and seed");

        let n3 = deterministic_gaussian(101, 200, 1, 42);
        assert_ne!(n1, n3, "Different coordinate must produce independent sample");

        // Monte Carlo mean and variance test
        let mut sum = 0.0f64;
        let mut sum_sq = 0.0f64;
        let samples = 10_000usize;
        for i in 0..samples {
            let val = deterministic_gaussian(i, 42, 0, 12345) as f64;
            sum += val;
            sum_sq += val * val;
        }
        let mean = sum / samples as f64;
        let var = (sum_sq / samples as f64) - mean * mean;
        assert!(mean.abs() < 0.05, "Mean should be ~0.0, got {mean}");
        assert!((var - 1.0).abs() < 0.08, "Variance should be ~1.0, got {var}");
    }
}
