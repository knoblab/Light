//! R2 Verification Suite:
//! - Synthetic sky + 4 dust spots detection equivalence (`python/tests/test_pipeline.py`)
//! - Annulus plane-detrended SNR verification under steep background gradient
//! - Multi-frame temporal dust clustering across 3 frames

use sc_color::compute_det_gray_from_16bit;
use sc_core::{DetectedDustSpot, DetectionParams, ExifMetadata, SessionMetadata, Stats16Bit};
use sc_detect::{
    annulus::{AnnulusGrids, verify_annulus_plane_snr},
    cluster_multi_frame_spots, detect_from_gray,
};

const DUST_GROUND_TRUTH: &[(f64, f64, f64)] = &[
    (400.0, 300.0, 14.0),
    (900.0, 500.0, 22.0),
    (1400.0, 800.0, 9.0),
    (700.0, 900.0, 30.0),
];

/// Generates the exact synthetic 16-bit sky image with 4 Gaussian dust spots from `test_pipeline.py:21-40`.
fn make_synthetic_16bit_sky_with_dust(w: usize, h: usize) -> Vec<u16> {
    let mut rgb = vec![0u16; w * h * 3];
    for y in 0..h {
        let yf = y as f64 / (h.saturating_sub(1).max(1)) as f64;
        let grad_r = 46000.0 - 8000.0 * yf;
        let grad_g = 48000.0 - 8000.0 * yf;
        let grad_b = 52000.0 - 8000.0 * yf;

        for x in 0..w {
            let mut atten = 1.0f64;
            for &(cx, cy, r) in DUST_GROUND_TRUTH {
                let dx = x as f64 - cx;
                let dy = y as f64 - cy;
                let d2 = dx * dx + dy * dy;
                let sigma = r * 0.65;
                let drop = 0.22 * (-d2 / (2.0 * sigma * sigma)).exp();
                atten *= 1.0 - drop;
            }
            let idx = (y * w + x) * 3;
            rgb[idx] = (grad_r * atten).round().clamp(0.0, 65535.0) as u16;
            rgb[idx + 1] = (grad_g * atten).round().clamp(0.0, 65535.0) as u16;
            rgb[idx + 2] = (grad_b * atten).round().clamp(0.0, 65535.0) as u16;
        }
    }
    rgb
}

#[test]
fn r2_synthetic_4_dust_spots_detected_accurately() {
    let w = 1800usize;
    let h = 1200usize;
    let img16 = make_synthetic_16bit_sky_with_dust(w, h);
    let gray = compute_det_gray_from_16bit(&img16, w, h, true, 1.0);

    let params = DetectionParams::default();
    let out = detect_from_gray(&gray, w, h, w, h, w, h, 1.0, &params);

    println!(
        "[R2] Detected {} spots on 1800x1200 synthetic sky",
        out.result.total_detected
    );
    for s in &out.result.spots {
        println!(
            "  Spot {}: center=({:.1}, {:.1}), r={:.1}, contrast_drop={:.1}%, conf={:?}, type={:?}",
            s.id, s.cx, s.cy, s.radius, s.contrast_drop_pct, s.confidence, s.spot_type
        );
    }

    let mut matched_gt = 0usize;
    let mut max_center_err = 0.0f64;
    for &(gx, gy, _gr) in DUST_GROUND_TRUTH {
        if let Some(best_dist) = out
            .result
            .spots
            .iter()
            .map(|s| ((s.cx - gx).powi(2) + (s.cy - gy).powi(2)).sqrt())
            .min_by(|a, b| a.total_cmp(b))
            && best_dist < 8.0
        {
            matched_gt += 1;
            max_center_err = max_center_err.max(best_dist);
        }
    }

    println!(
        "[R2] Matched {}/{} ground-truth spots (max center error = {:.2} px)",
        matched_gt,
        DUST_GROUND_TRUTH.len(),
        max_center_err
    );
    assert_eq!(
        matched_gt,
        DUST_GROUND_TRUTH.len(),
        "Expected all 4 ground-truth dust spots to be detected within 8 px"
    );
    assert!(
        out.result.total_detected <= 10,
        "Expected <= 10 total spots (no excessive false positives), got {}",
        out.result.total_detected
    );
}

#[test]
fn r2_annulus_plane_snr_handles_steep_gradient() {
    let w = 240usize;
    let h = 240usize;
    let mut gray = vec![0.0f32; w * h];
    let grad_map = vec![0.2f32; w * h];
    let bg_std_map = vec![0.4f32; w * h];
    let hf_tex_map = vec![0.2f32; w * h];
    let cx = 120.0f64;
    let cy = 120.0f64;
    let r = 12.0f64;

    for y in 0..h {
        for x in 0..w {
            // Steep linear plane gradient + deterministic micro-texture
            let plane = 180.0 + 0.25 * (x as f64 - cx) - 0.18 * (y as f64 - cy);
            let micro = (((x * 17 + y * 31) % 5) as f64 - 2.0) * 0.15;
            let dx = x as f64 - cx;
            let dy = y as f64 - cy;
            let d2 = dx * dx + dy * dy;
            let sigma = r * 0.65;
            let drop = 28.0 * (-d2 / (2.0 * sigma * sigma)).exp();
            gray[y * w + x] = (plane + micro - drop) as f32;
        }
    }

    let grids = AnnulusGrids::new();
    let eval = verify_annulus_plane_snr(
        &grids,
        &gray,
        &grad_map,
        &bg_std_map,
        &hf_tex_map,
        w,
        h,
        cx,
        cy,
        r,
        true,
        75.0,
        68.0,
    )
    .expect("Annulus verification should succeed on steep linear gradient");

    assert!(
        eval.snr > 8.0,
        "Plane-detrended SNR should be high (> 8.0), got {}",
        eval.snr
    );
    assert!(
        eval.isotropy >= 0.70,
        "Isotropy should be >= 0.70, got {}",
        eval.isotropy
    );
}

#[test]
fn r2_multi_frame_temporal_clustering() {
    let dummy_meta = SessionMetadata {
        original_file_name: "frame.rw2".into(),
        extension: "RW2".into(),
        is_raw: true,
        decode_kind: None,
        is_input_16_bit: true,
        is_linear16: true,
        full_width: 1800,
        full_height: 1200,
        work_width: 1800,
        work_height: 1200,
        work_scale: 1.0,
        exposure_scale: 1.0,
        bit_depth: "16-bit".into(),
        color_space: "Linear RGB".into(),
        camera_wb: vec![1.0, 1.0, 1.0, 1.0],
        color_matrix: vec![],
        black_level: vec![0, 0, 0, 0],
        white_level: 65535,
        bayer_pattern: "RGGB".into(),
        stats_16_bit: Stats16Bit::default(),
        exif: ExifMetadata::default(),
        raw_crop: None,
    };

    let make_spot = |idx: usize, cx: f64, cy: f64, r: f64| DetectedDustSpot {
        id: format!("spot-{idx}"),
        index: idx,
        cx,
        cy,
        work_cx: cx,
        work_cy: cy,
        radius: r,
        work_radius: r,
        area: std::f64::consts::PI * r * r,
        perimeter: 2.0 * std::f64::consts::PI * r,
        circularity: 0.85,
        contrast_drop_pct: 18.0,
        spot_type: Some("sharp".into()),
        confidence: Some(0.85),
        enabled: true,
        is_manual: false,
        tier: Some("confirmed".into()),
        is_multi_confirmed: None,
        is_projected: None,
        cluster_id: None,
        match_count: None,
        total_frames: None,
    };

    let frames = vec![
        (
            "dir1".to_string(),
            "sc_1".to_string(),
            dummy_meta.clone(),
            vec![
                make_spot(1, 400.0, 300.0, 14.0),
                make_spot(2, 100.0, 100.0, 8.0),
            ],
        ),
        (
            "dir2".to_string(),
            "sc_2".to_string(),
            dummy_meta.clone(),
            vec![make_spot(1, 401.5, 299.0, 14.5)],
        ),
        (
            "dir3".to_string(),
            "sc_3".to_string(),
            dummy_meta,
            vec![], // Frame 3 missed (400, 300) initially -> should receive projected spot!
        ),
    ];

    let report = cluster_multi_frame_spots(frames, 18.0, 2);
    assert_eq!(report.multi_confirmed_clusters, 1);
    assert_eq!(report.per_frame.len(), 3);
    assert_eq!(report.per_frame[0].multi_confirmed_count, 1);
    assert_eq!(report.per_frame[1].multi_confirmed_count, 1);
    // Frame 3 should have 1 projected spot from the confirmed cluster
    assert_eq!(report.per_frame[2].projected_count, 1);
}
