//! Test suite for sc-wasm engine methods.

#![forbid(unsafe_code)]

use sc_core::{DetectionParams, InpaintParams, SessionMetadata};
use sc_wasm::{
    wasm_cancel_session, wasm_detect_core, wasm_drop_session, wasm_export_file_core,
    wasm_ingest_and_detect_core, wasm_inpaint_core, wasm_render_tile_core,
};

#[test]
fn test_wasm_session_lifecycle() {
    let w = 64usize;
    let h = 64usize;
    // Generate a minimal mock RAW / 16-bit TIFF image
    let cfa = vec![2048u16; w * h];
    let meta = SessionMetadata {
        original_file_name: "test_sample.rw2".into(),
        extension: "RW2".into(),
        is_raw: true,
        decode_kind: None,
        is_input_16_bit: true,
        is_linear16: true,
        full_width: w,
        full_height: h,
        work_width: w,
        work_height: h,
        work_scale: 1.0,
        exposure_scale: 1.0,
        bit_depth: "16-bit".into(),
        color_space: "sRGB".into(),
        camera_wb: vec![1.0, 1.0, 1.0],
        color_matrix: vec![vec![1.0, 0.0, 0.0], vec![0.0, 1.0, 0.0], vec![0.0, 0.0, 1.0]],
        black_level: vec![0, 0, 0, 0],
        white_level: 65535,
        bayer_pattern: "RGGB".into(),
        stats_16_bit: Default::default(),
        exif: Default::default(),
        raw_crop: None,
    };

    let dng_bytes = sc_dng::write_cfa_dng_bytes(&cfa, w, h, &meta).unwrap();
    let params = DetectionParams::default();

    let res = wasm_ingest_and_detect_core("test_sample.dng", &dng_bytes, params.clone()).unwrap();
    assert!(res.success);
    let session_id = &res.session_id;

    // Re-detect
    let det = wasm_detect_core(session_id, params).unwrap();
    assert_eq!(det.detection.method, "dual");

    // Inpaint
    let inpaint_params = InpaintParams::default();
    let heal = wasm_inpaint_core(session_id, inpaint_params).unwrap();
    assert!(heal.success);

    // Render tile
    let tile_bytes = wasm_render_tile_core(session_id, "original", 0, 0, 0).unwrap();
    assert_eq!(tile_bytes.len(), 256 * 256 * 4);

    // Inpaint with manual brush stroke
    let stroke = sc_core::ManualBrushStroke {
        id: "stroke_1".into(),
        mode: "heal".into(),
        radius: 4.0,
        points: vec![
            sc_core::BrushPoint { x: 10.0, y: 10.0 },
            sc_core::BrushPoint { x: 12.0, y: 12.0 },
        ],
    };
    let inpaint_params_stroke = InpaintParams {
        spots: vec![],
        manual_strokes: vec![stroke],
        inpaint_radius: 5.0,
        preserve_grain: true,
    };
    let heal_stroke = wasm_inpaint_core(session_id, inpaint_params_stroke).unwrap();
    assert!(heal_stroke.success);
    assert_eq!(heal_stroke.result.healed_spots_count, 1);
    assert!(heal_stroke.result.inpainted_pixels > 0);

    // Render tile of healed layer
    let tile_healed = wasm_render_tile_core(session_id, "healed", 0, 0, 0).unwrap();
    assert_eq!(tile_healed.len(), 256 * 256 * 4);

    // Export formats (TIFF16, PNG, JPEG)
    let exported_tiff = wasm_export_file_core(session_id, "tiff16", None).unwrap();
    assert!(!exported_tiff.is_empty());
    let exported_png = wasm_export_file_core(session_id, "png", None).unwrap();
    assert_eq!(&exported_png[0..8], b"\x89PNG\r\n\x1a\n");
    let exported_jpg = wasm_export_file_core(session_id, "jpeg", None).unwrap();
    assert_eq!(&exported_jpg[0..2], b"\xff\xd8");

    // Export DNG
    let exported_dng = wasm_export_file_core(session_id, "dng", None).unwrap();
    assert!(!exported_dng.is_empty());
    assert_eq!(&exported_dng[0..4], b"II\x2a\x00");

    // Export XMP
    let exported_xmp = wasm_export_file_core(session_id, "xmp", None).unwrap();
    assert!(!exported_xmp.is_empty());
    let xmp_str = String::from_utf8(exported_xmp).unwrap();
    assert!(xmp_str.contains("<x:xmpmeta"));

    // Cancel & Drop
    assert!(!wasm_cancel_session("non_existent"));
    assert!(wasm_cancel_session(session_id));
    assert!(wasm_drop_session(session_id));
}
