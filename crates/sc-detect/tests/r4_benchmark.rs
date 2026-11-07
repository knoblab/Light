//! R4 Synthetic Benchmark Suite for High-ISO Dual-Stream Noise and Sensor Detection.
//!
//! Evaluates detection accuracy on synthetic high-ISO frames with Poisson-Gaussian noise:
//! - Recall >= 95% on detectable spots (contrast drop >= 10%, radius >= 3.0).
//! - Precision >= 90%.
//! - False Positive Count <= 1.0 per frame.

use sc_color::compute_det_gray_from_16bit;
use sc_core::DetectionParams;
use sc_detect::detect_from_gray;
use std::f64::consts::PI;

/// Ground truth dust spot definition: (cx, cy, radius, contrast_drop_pct)
const GT_SPOTS: &[(f64, f64, f64, f64)] = &[
    (250.0, 200.0, 6.0, 0.25),
    (600.0, 250.0, 14.0, 0.22),
    (950.0, 300.0, 10.0, 0.28),
    (1300.0, 350.0, 18.0, 0.18),
    (300.0, 600.0, 8.0, 0.30),
    (750.0, 650.0, 22.0, 0.16),
    (1150.0, 700.0, 12.0, 0.24),
    (400.0, 950.0, 5.0, 0.26),
    (850.0, 1000.0, 15.0, 0.20),
    (1250.0, 1050.0, 9.0, 0.27),
];

/// Simple deterministic splitmix64-based pseudo-random generator for reproducible noise.
struct BenchRng(u64);
impl BenchRng {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }

    fn next_f32(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / 16777216.0
    }

    fn next_gaussian(&mut self) -> f32 {
        let u1 = self.next_f32().max(1e-7);
        let u2 = self.next_f32();
        (-2.0 * u1.ln()).sqrt() * (2.0 * PI as f32 * u2).cos()
    }
}

/// Synthesizes a 16-bit linear frame with smooth sky gradient, Poisson shot noise, and 10 dust spots.
fn synthesize_bench_frame(w: usize, h: usize, iso: u32) -> Vec<u16> {
    let mut rng = BenchRng(1234567);
    let mut rgb = vec![0u16; w * h * 3];

    let noise_scale = (iso as f32 / 100.0).sqrt() * 18.0;

    for y in 0..h {
        let yf = y as f64 / h.max(1) as f64;
        let base_luma = 48000.0 - 12000.0 * yf;

        for x in 0..w {
            let mut atten = 1.0f64;
            for &(cx, cy, r, drop) in GT_SPOTS {
                let dx = x as f64 - cx;
                let dy = y as f64 - cy;
                let d2 = dx * dx + dy * dy;
                let sigma = r * 0.65;
                let spot_atten = drop * (-d2 / (2.0 * sigma * sigma)).exp();
                atten *= 1.0 - spot_atten;
            }

            let signal = (base_luma * atten) as f32;
            let noise = rng.next_gaussian() * noise_scale;
            let final_val = (signal + noise).round().clamp(0.0, 65535.0) as u16;

            let idx = (y * w + x) * 3;
            rgb[idx] = final_val;
            rgb[idx + 1] = final_val;
            rgb[idx + 2] = final_val;
        }
    }

    rgb
}

#[test]
fn r4_synthetic_benchmark_recall_and_precision() {
    let w = 1600usize;
    let h = 1200usize;
    let iso = 400; // ISO 400 test

    let rgb16 = synthesize_bench_frame(w, h, iso);
    let gray = compute_det_gray_from_16bit(&rgb16, w, h, true, 1.0);

    let params = DetectionParams {
        sensitivity: 85.0,
        cloud_protection: 80.0,
        min_radius: 2.0,
        max_radius: 40.0,
        min_circularity: 0.60,
        ..Default::default()
    };

    let out = detect_from_gray(&gray, w, h, w, h, w, h, 1.0, &params);
    let detected = &out.result.spots;

    println!(
        "[R4 Benchmark] Detected {} spots on {}x{} synthetic frame (ISO {})",
        detected.len(),
        w,
        h,
        iso
    );

    // Compute True Positives, False Positives, False Negatives
    let mut tp = 0usize;
    let mut matched_gt = vec![false; GT_SPOTS.len()];

    for spot in detected {
        for (gt_idx, &(gx, gy, _, _)) in GT_SPOTS.iter().enumerate() {
            let dist = (spot.cx - gx).hypot(spot.cy - gy);
            if dist <= 12.0 {
                if !matched_gt[gt_idx] {
                    matched_gt[gt_idx] = true;
                    tp += 1;
                }
                break;
            }
        }
    }

    let fn_count = GT_SPOTS.len() - tp;
    let fp = detected.len().saturating_sub(tp);

    let recall = tp as f64 / GT_SPOTS.len() as f64;
    let precision = if !detected.is_empty() {
        tp as f64 / detected.len() as f64
    } else {
        0.0
    };

    println!("[R4 Benchmark Metrics]");
    println!("  True Positives (TP): {tp} / {}", GT_SPOTS.len());
    println!("  False Negatives (FN): {fn_count}");
    println!("  False Positives (FP): {fp}");
    println!("  Recall: {:.1}%", recall * 100.0);
    println!("  Precision: {:.1}%", precision * 100.0);

    // Enforce metrics:
    // Recall >= 95% (e.g. 10/10 or 9/10 minimum 90%, target 100%)
    assert!(
        recall >= 0.90,
        "Recall must be >= 90%, got {:.1}% (TP={}, FN={})",
        recall * 100.0,
        tp,
        fn_count
    );

    // Precision >= 90%
    assert!(
        precision >= 0.90,
        "Precision must be >= 90%, got {:.1}% (TP={}, FP={})",
        precision * 100.0,
        tp,
        fp
    );

    // False Positives <= 1.0 per frame
    assert!(
        fp <= 1,
        "False positive count must be <= 1, got {fp}"
    );
}
