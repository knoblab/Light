//! `sc-wasm`: Production Pure-Rust WebAssembly Engine for SensorClean.
//!
//! Compiles the exact same pure-Rust algorithms (`sc-decode`, `sc-detect`, `sc-heal`, `sc-dng`)
//! to `wasm32-unknown-unknown` for execution in a browser Web Worker.
//! Enables 100% serverless static website deployment (GitHub Pages, Cloudflare Pages, Vercel)
//! with bit-exact RAW decoding, CFA inpainting, and DNG 1.6 / XMP generation.

#![forbid(unsafe_code)]

use base64::Engine;
use sc_color::spaces::ColorSpace;
use sc_core::{
    CancelToken, DetectedDustSpot, DetectionParams, DetectionResult, InpaintParams, InpaintResult,
    MultiFrameConfig, MultiFrameReport, SessionMetadata,
};
use sc_decode::{ingest_bytes, raw_pixels_u16};
use sc_detect::cluster_multi_frame_spots;
use sc_detect::detect_from_gray;
use sc_dng::{
    generate_xmp_sidecar_xml, write_cfa_dng_bytes, write_rendered_jpeg_bytes,
    write_rendered_png16_bytes, write_rendered_png8_bytes, write_rendered_tiff16_bytes,
};
use sc_heal::cfa_inpaint::BayerPattern;
use sc_heal::heal_cfa_image_cancellable;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use wasm_bindgen::prelude::*;

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

/// In-memory WebAssembly session state holding full 16-bit data and previews.
pub struct WasmSession {
    pub id: String,
    pub meta: SessionMetadata,
    pub raw_cfa: Option<Vec<u16>>,
    pub cfa_width: usize,
    pub cfa_height: usize,
    pub healed_cfa: Option<Vec<u16>>,
    pub linear_16bit: Vec<u16>,
    pub healed_linear_16bit: Option<Vec<u16>>,
    pub work_srgb_u8: Vec<u8>,
    pub work_healed_srgb_u8: Option<Vec<u8>>,
    pub det_gray: Vec<f32>,
    pub spots: Vec<DetectedDustSpot>,
    pub multi_confirmed: HashSet<usize>,
    pub cancel_token: CancelToken,
    pub cfa_roi_cache: sc_heal::roi_cache::RoiCache,
}

static SESSIONS: Mutex<Option<HashMap<String, WasmSession>>> = Mutex::new(None);

fn with_sessions<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<String, WasmSession>) -> R,
{
    let mut guard = SESSIONS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

fn to_js_err(e: impl ToString) -> JsValue {
    JsValue::from_str(&e.to_string())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestDetectResponse {
    pub success: bool,
    pub session_id: String,
    pub meta: SessionMetadata,
    pub detection: DetectionResult,
    pub preview_jpg_base64: String,
    pub viz_edge_jpg_base64: String,
    pub mask_auto_png_base64: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectResponse {
    pub success: bool,
    pub detection: DetectionResult,
    pub viz_edge_jpg_base64: String,
    pub mask_auto_png_base64: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InpaintResponse {
    pub success: bool,
    pub result: InpaintResult,
    pub preview_healed_base64: String,
    pub mask_final_png_base64: String,
}

#[wasm_bindgen]
pub fn wasm_init() {
    // WebAssembly initialization hook
}

// -------------------------------------------------------------------------
// Core Rust implementations (callable natively and from wasm-bindgen)
// -------------------------------------------------------------------------

pub fn wasm_ingest_and_detect_core(
    file_name: &str,
    bytes: &[u8],
    params: DetectionParams,
) -> Result<IngestDetectResponse, String> {
    let ext = std::path::Path::new(file_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("rw2")
        .to_ascii_lowercase();

    let ingested = ingest_bytes(bytes, file_name, &ext)
        .map_err(|e| format!("Ingest failed: {e}"))?;

    let meta = ingested.meta.clone();
    let ww = meta.work_width;
    let wh = meta.work_height;
    let fw = meta.full_width;
    let fh = meta.full_height;
    let scale = meta.work_scale;

    let det_output = detect_from_gray(
        &ingested.det_gray,
        ww,
        wh,
        fw,
        fh,
        ww,
        wh,
        scale,
        &params,
    );
    let det_result = det_output.result;

    let (raw_cfa, cfa_w, cfa_h) = if let Some(ref raw) = ingested.raw_image {
        (
            raw_pixels_u16(raw).ok().map(|s| s.to_vec()),
            raw.width,
            raw.height,
        )
    } else {
        (None, fw, fh)
    };

    let mut jpeg_bytes = Vec::new();
    let enc = jpeg_encoder::Encoder::new(&mut jpeg_bytes, 92);
    let _ = enc.encode(&ingested.work_srgb_u8, ww as u16, wh as u16, jpeg_encoder::ColorType::Rgb);
    let preview_jpg_base64 = base64::engine::general_purpose::STANDARD.encode(&jpeg_bytes);

    let mut viz_bytes = Vec::new();
    let enc_viz = jpeg_encoder::Encoder::new(&mut viz_bytes, 92);
    let _ = enc_viz.encode(&det_output.viz_bw_edge_rgb, ww as u16, wh as u16, jpeg_encoder::ColorType::Rgb);
    let viz_edge_jpg_base64 = base64::engine::general_purpose::STANDARD.encode(&viz_bytes);

    let mut mask_bytes = Vec::new();
    let enc_mask = jpeg_encoder::Encoder::new(&mut mask_bytes, 92);
    let _ = enc_mask.encode(&det_output.mask_auto_u8, ww as u16, wh as u16, jpeg_encoder::ColorType::Luma);
    let mask_auto_png_base64 = base64::engine::general_purpose::STANDARD.encode(&mask_bytes);

    let session_id = format!("wasm_{}_{}", now_secs(), SESSION_COUNTER.fetch_add(1, Ordering::SeqCst));

    let session = WasmSession {
        id: session_id.clone(),
        meta: meta.clone(),
        raw_cfa,
        cfa_width: cfa_w,
        cfa_height: cfa_h,
        healed_cfa: None,
        linear_16bit: ingested.linear_16bit,
        healed_linear_16bit: None,
        work_srgb_u8: ingested.work_srgb_u8,
        work_healed_srgb_u8: None,
        det_gray: ingested.det_gray,
        spots: det_result.spots.clone(),
        multi_confirmed: HashSet::new(),
        cancel_token: CancelToken::new(),
        cfa_roi_cache: sc_heal::roi_cache::RoiCache::new(),
    };

    with_sessions(|s| {
        s.insert(session_id.clone(), session);
    });

    Ok(IngestDetectResponse {
        success: true,
        session_id,
        meta,
        detection: det_result,
        preview_jpg_base64,
        viz_edge_jpg_base64,
        mask_auto_png_base64,
    })
}

pub fn wasm_detect_core(session_id: &str, params: DetectionParams) -> Result<DetectResponse, String> {
    with_sessions(|sessions| {
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        let ww = session.meta.work_width;
        let wh = session.meta.work_height;
        let fw = session.meta.full_width;
        let fh = session.meta.full_height;
        let scale = session.meta.work_scale;

        let det_output = detect_from_gray(
            &session.det_gray,
            ww,
            wh,
            fw,
            fh,
            ww,
            wh,
            scale,
            &params,
        );
        let det = det_output.result;
        session.spots = det.spots.clone();

        let mut viz_bytes = Vec::new();
        let enc_viz = jpeg_encoder::Encoder::new(&mut viz_bytes, 92);
        let _ = enc_viz.encode(&det_output.viz_bw_edge_rgb, ww as u16, wh as u16, jpeg_encoder::ColorType::Rgb);
        let viz_edge_jpg_base64 = base64::engine::general_purpose::STANDARD.encode(&viz_bytes);

        let mut mask_bytes = Vec::new();
        let enc_mask = jpeg_encoder::Encoder::new(&mut mask_bytes, 92);
        let _ = enc_mask.encode(&det_output.mask_auto_u8, ww as u16, wh as u16, jpeg_encoder::ColorType::Luma);
        let mask_auto_png_base64 = base64::engine::general_purpose::STANDARD.encode(&mask_bytes);

        Ok(DetectResponse {
            success: true,
            detection: det,
            viz_edge_jpg_base64,
            mask_auto_png_base64,
        })
    })
}

fn encode_png_gray_bytes(gray: &[u8], w: usize, h: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, w as u32, h as u32);
    encoder.set_color(png::ColorType::Grayscale);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| format!("PNG header error: {e}"))?;
    writer.write_image_data(gray).map_err(|e| format!("PNG write error: {e}"))?;
    drop(writer);
    Ok(out)
}

pub fn wasm_inpaint_core(session_id: &str, params: InpaintParams) -> Result<InpaintResponse, String> {
    with_sessions(|sessions| {
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        let fw = session.meta.full_width;
        let fh = session.meta.full_height;
        let ww = session.meta.work_width;
        let wh = session.meta.work_height;

        let enabled_spots_count = params.spots.iter().filter(|s| s.enabled).count();
        let active_strokes_count = params
            .manual_strokes
            .iter()
            .filter(|st| st.mode != "erase" && !st.points.is_empty())
            .count();

        if enabled_spots_count == 0 && active_strokes_count == 0 {
            session.healed_linear_16bit = None;
            session.work_healed_srgb_u8 = None;
            session.healed_cfa = None;

            let mut jpeg_bytes = Vec::new();
            let enc = jpeg_encoder::Encoder::new(&mut jpeg_bytes, 92);
            let _ = enc.encode(&session.work_srgb_u8, ww as u16, wh as u16, jpeg_encoder::ColorType::Rgb);
            let preview_healed_base64 = base64::engine::general_purpose::STANDARD.encode(&jpeg_bytes);

            let empty_mask = vec![0u8; ww * wh];
            let mask_png = encode_png_gray_bytes(&empty_mask, ww, wh)?;
            let mask_final_png_base64 = base64::engine::general_purpose::STANDARD.encode(&mask_png);

            let res = InpaintResult {
                healed_spots_count: 0,
                inpainted_pixels: 0,
                inpainted_area_pct: 0.0,
                bit_depth: session.meta.bit_depth.clone(),
                inpaint_method: "16-bit Plane-Detrended Harmonic Telea (WASM)".into(),
                inpaint_radius: params.inpaint_radius,
                full_width: fw,
                full_height: fh,
                from_cache: false,
                incremental_rois: 0,
            };

            return Ok(InpaintResponse {
                success: true,
                result: res,
                preview_healed_base64,
                mask_final_png_base64,
            });
        }

        let (healed_16bit, healed_work_u8, work_mask, inpainted_pixels, roi_count) =
            sc_session::inpaint_linear16_and_work_srgb_in_memory(
                &session.linear_16bit,
                &session.work_srgb_u8,
                &session.meta,
                &params,
            );

        session.healed_linear_16bit = Some(healed_16bit);
        session.work_healed_srgb_u8 = Some(healed_work_u8.clone());
        session.healed_cfa = None;

        let mut jpeg_bytes = Vec::new();
        let enc = jpeg_encoder::Encoder::new(&mut jpeg_bytes, 92);
        let _ = enc.encode(&healed_work_u8, ww as u16, wh as u16, jpeg_encoder::ColorType::Rgb);
        let preview_healed_base64 = base64::engine::general_purpose::STANDARD.encode(&jpeg_bytes);

        let mask_png = encode_png_gray_bytes(&work_mask, ww, wh)?;
        let mask_final_png_base64 = base64::engine::general_purpose::STANDARD.encode(&mask_png);

        let total_pixels = fw * fh;
        let area_pct = if total_pixels > 0 {
            ((inpainted_pixels as f64 / total_pixels as f64) * 100.0 * 10000.0).round() / 10000.0
        } else {
            0.0
        };

        let res = InpaintResult {
            healed_spots_count: enabled_spots_count + active_strokes_count,
            inpainted_pixels,
            inpainted_area_pct: area_pct,
            bit_depth: session.meta.bit_depth.clone(),
            inpaint_method: "16-bit Plane-Detrended Harmonic Telea (WASM)".into(),
            inpaint_radius: params.inpaint_radius,
            full_width: fw,
            full_height: fh,
            from_cache: false,
            incremental_rois: roi_count,
        };

        Ok(InpaintResponse {
            success: true,
            result: res,
            preview_healed_base64,
            mask_final_png_base64,
        })
    })
}

pub fn wasm_render_tile_core(
    session_id: &str,
    layer: &str,
    level: u32,
    tx: u32,
    ty: u32,
) -> Result<Vec<u8>, String> {
    with_sessions(|sessions| {
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        let fw = session.meta.full_width;
        let fh = session.meta.full_height;
        let tile_size = 256usize;
        let step = 1usize << level;

        let start_x = tx as usize * tile_size * step;
        let start_y = ty as usize * tile_size * step;

        let mut rgba = vec![0u8; tile_size * tile_size * 4];

        let use_healed = layer == "healed";
        let source_16 = if use_healed {
            session.healed_linear_16bit.as_deref().unwrap_or(&session.linear_16bit)
        } else {
            &session.linear_16bit
        };

        let lut_u8 = if !session.meta.is_input_16_bit {
            Some(sc_color::build_srgb_u8_lut(session.meta.exposure_scale))
        } else {
            None
        };

        for y in 0..tile_size {
            let img_y = start_y + y * step;
            if img_y >= fh {
                continue;
            }
            for x in 0..tile_size {
                let img_x = start_x + x * step;
                if img_x >= fw {
                    continue;
                }
                let out_idx = (y * tile_size + x) * 4;

                if !source_16.is_empty() {
                    let in_idx = (img_y * fw + img_x) * 3;
                    if let Some(ref lut) = lut_u8 {
                        rgba[out_idx] = lut[source_16[in_idx] as usize];
                        rgba[out_idx + 1] = lut[source_16[in_idx + 1] as usize];
                        rgba[out_idx + 2] = lut[source_16[in_idx + 2] as usize];
                    } else {
                        rgba[out_idx] = (source_16[in_idx] as f32 / 257.0).round().clamp(0.0, 255.0) as u8;
                        rgba[out_idx + 1] = (source_16[in_idx + 1] as f32 / 257.0).round().clamp(0.0, 255.0) as u8;
                        rgba[out_idx + 2] = (source_16[in_idx + 2] as f32 / 257.0).round().clamp(0.0, 255.0) as u8;
                    }
                    rgba[out_idx + 3] = 255;
                }
            }
        }

        Ok(rgba)
    })
}

pub fn wasm_export_file_core(
    session_id: &str,
    format: &str,
    color_space: Option<String>,
) -> Result<Vec<u8>, String> {
    with_sessions(|sessions| {
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        let space = match color_space.as_deref().unwrap_or("srgb").to_ascii_lowercase().as_str() {
            "adobe" | "adobergb" => ColorSpace::AdobeRgb1998,
            "prophoto" => ColorSpace::ProPhotoRgb,
            "displayp3" | "p3" => ColorSpace::DisplayP3,
            _ => ColorSpace::Srgb,
        };

        let fw = session.meta.full_width;
        let fh = session.meta.full_height;

        let source_16 = session
            .healed_linear_16bit
            .as_deref()
            .unwrap_or(&session.linear_16bit);

        match format.to_ascii_lowercase().as_str() {
            "dng" => {
                if let Some(ref raw_cfa) = session.raw_cfa {
                    let (cw, ch) = (session.cfa_width, session.cfa_height);
                    let (crop_x, crop_y) = if let Some([cx, cy, _, _]) = session.meta.raw_crop {
                        (cx, cy)
                    } else if cw > fw && ch > fh {
                        (((cw - fw) / 2) & !1, ((ch - fh) / 2) & !1)
                    } else {
                        (0, 0)
                    };
                    let pattern = match session.meta.bayer_pattern.to_ascii_uppercase().as_str() {
                        "BGGR" => BayerPattern::BgGr,
                        "GRBG" => BayerPattern::GrBg,
                        "GBRG" => BayerPattern::GbRg,
                        _ => BayerPattern::RgGb,
                    };
                    let cfa_spots: Vec<DetectedDustSpot> = if crop_x > 0 || crop_y > 0 {
                        session.spots
                            .iter()
                            .filter(|s| s.enabled)
                            .map(|s| {
                                let mut s2 = s.clone();
                                s2.cx += crop_x as f64;
                                s2.cy += crop_y as f64;
                                s2
                            })
                            .collect()
                    } else {
                        session.spots.iter().filter(|s| s.enabled).cloned().collect()
                    };

                    let (healed, _) = heal_cfa_image_cancellable(
                        raw_cfa,
                        cw,
                        ch,
                        &cfa_spots,
                        &[],
                        pattern,
                        6.0,
                        true,
                        42,
                        Some(&mut session.cfa_roi_cache),
                        Some(&session.cancel_token),
                    )
                    .map_err(|e| format!("CFA heal failed: {e}"))?;

                    session.healed_cfa = Some(healed.clone());

                    write_cfa_dng_bytes(&healed, session.cfa_width, session.cfa_height, &session.meta)
                        .map_err(|e| format!("DNG export failed: {e}"))
                } else {
                    let srgb16 = if session.meta.is_input_16_bit {
                        source_16.to_vec()
                    } else {
                        sc_color::linear_16bit_to_srgb_16bit(source_16, fw, fh, Some(session.meta.exposure_scale)).0
                    };
                    write_rendered_tiff16_bytes(
                        &srgb16,
                        fw,
                        fh,
                        space,
                        &session.meta,
                    )
                    .map_err(|e| format!("DNG linear fallback failed: {e}"))
                }
            }
            "xmp" => {
                let dummy_cfa = vec![0u16; 64];
                let cfa = session
                    .healed_cfa
                    .as_deref()
                    .or(session.raw_cfa.as_deref())
                    .unwrap_or(&dummy_cfa);
                let xml = generate_xmp_sidecar_xml(
                    cfa,
                    fw,
                    fh,
                    &session.spots,
                    &[],
                );
                Ok(xml.into_bytes())
            }
            "tiff16" | "tiff" => {
                let srgb16 = if session.meta.is_input_16_bit {
                    source_16.to_vec()
                } else {
                    sc_color::linear_16bit_to_srgb_16bit(source_16, fw, fh, Some(session.meta.exposure_scale)).0
                };
                write_rendered_tiff16_bytes(
                    &srgb16,
                    fw,
                    fh,
                    space,
                    &session.meta,
                )
                .map_err(|e| format!("TIFF16 export failed: {e}"))
            }
            "png16" => {
                let srgb16 = if session.meta.is_input_16_bit {
                    source_16.to_vec()
                } else {
                    sc_color::linear_16bit_to_srgb_16bit(source_16, fw, fh, Some(session.meta.exposure_scale)).0
                };
                write_rendered_png16_bytes(
                    &srgb16,
                    fw,
                    fh,
                    space,
                    &session.meta,
                )
                .map_err(|e| format!("PNG16 export failed: {e}"))
            }
            "png" | "png8" => {
                let srgb8 = if session.meta.is_input_16_bit {
                    source_16
                        .iter()
                        .map(|&v| (v as f32 / 257.0).round().clamp(0.0, 255.0) as u8)
                        .collect()
                } else {
                    sc_color::linear_16bit_to_srgb_8bit(source_16, fw, fh, Some(session.meta.exposure_scale)).0
                };
                write_rendered_png8_bytes(&srgb8, fw, fh, space, &session.meta)
                    .map_err(|e| format!("PNG export failed: {e}"))
            }
            "jpeg" | "jpg" => {
                let srgb8 = if session.meta.is_input_16_bit {
                    source_16
                        .iter()
                        .map(|&v| (v as f32 / 257.0).round().clamp(0.0, 255.0) as u8)
                        .collect()
                } else {
                    sc_color::linear_16bit_to_srgb_8bit(source_16, fw, fh, Some(session.meta.exposure_scale)).0
                };
                write_rendered_jpeg_bytes(&srgb8, fw, fh, 98, space, &session.meta)
                    .map_err(|e| format!("JPEG export failed: {e}"))
            }
            other => Err(format!("Unsupported export format: {other}")),
        }
    })
}

pub fn wasm_multi_detect_core(config: MultiFrameConfig) -> Result<MultiFrameReport, String> {
    with_sessions(|sessions| {
        let mut frames = Vec::new();
        for sid in &config.session_dirs {
            if let Some(sess) = sessions.get(sid) {
                frames.push((
                    sess.id.clone(),
                    sess.meta.original_file_name.clone(),
                    sess.meta.clone(),
                    sess.spots.clone(),
                ));
            }
        }

        let report = cluster_multi_frame_spots(frames, config.tolerance_px, config.min_frames_match);
        Ok(report)
    })
}

// -------------------------------------------------------------------------
// wasm-bindgen JS Exports
// -------------------------------------------------------------------------

#[wasm_bindgen]
pub fn wasm_ingest_and_detect(
    file_name: &str,
    bytes: &[u8],
    params_js: JsValue,
) -> Result<JsValue, JsValue> {
    let params: DetectionParams = serde_wasm_bindgen::from_value(params_js)
        .map_err(|e| to_js_err(format!("Invalid DetectionParams: {e}")))?;
    let resp = wasm_ingest_and_detect_core(file_name, bytes, params).map_err(to_js_err)?;
    serde_wasm_bindgen::to_value(&resp).map_err(|e| to_js_err(e.to_string()))
}

#[wasm_bindgen]
pub fn wasm_ingest_and_detect_json(
    file_name: &str,
    bytes: &[u8],
    params_json: &str,
) -> Result<String, JsValue> {
    let params: DetectionParams = serde_json::from_str(params_json)
        .map_err(|e| to_js_err(format!("Invalid DetectionParams JSON: {e}")))?;
    let resp = wasm_ingest_and_detect_core(file_name, bytes, params).map_err(to_js_err)?;
    serde_json::to_string(&resp).map_err(|e| to_js_err(e.to_string()))
}

#[wasm_bindgen]
pub fn wasm_detect(session_id: &str, params_js: JsValue) -> Result<JsValue, JsValue> {
    let params: DetectionParams = serde_wasm_bindgen::from_value(params_js)
        .map_err(|e| to_js_err(format!("Invalid DetectionParams: {e}")))?;
    let det = wasm_detect_core(session_id, params).map_err(to_js_err)?;
    serde_wasm_bindgen::to_value(&det).map_err(|e| to_js_err(e.to_string()))
}

#[wasm_bindgen]
pub fn wasm_inpaint(session_id: &str, params_js: JsValue) -> Result<JsValue, JsValue> {
    let params: InpaintParams = serde_wasm_bindgen::from_value(params_js)
        .map_err(|e| to_js_err(format!("Invalid InpaintParams: {e}")))?;
    let resp = wasm_inpaint_core(session_id, params).map_err(to_js_err)?;
    serde_wasm_bindgen::to_value(&resp).map_err(|e| to_js_err(e.to_string()))
}

#[wasm_bindgen]
pub fn wasm_render_tile(
    session_id: &str,
    layer: &str,
    level: u32,
    tx: u32,
    ty: u32,
) -> Result<Vec<u8>, JsValue> {
    wasm_render_tile_core(session_id, layer, level, tx, ty).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn wasm_export_file(
    session_id: &str,
    format: &str,
    color_space: Option<String>,
) -> Result<Vec<u8>, JsValue> {
    wasm_export_file_core(session_id, format, color_space).map_err(to_js_err)
}

#[wasm_bindgen]
pub fn wasm_multi_detect(config_js: JsValue) -> Result<JsValue, JsValue> {
    let config: MultiFrameConfig = serde_wasm_bindgen::from_value(config_js)
        .map_err(|e| to_js_err(format!("Invalid MultiFrameConfig: {e}")))?;
    let report = wasm_multi_detect_core(config).map_err(to_js_err)?;
    serde_wasm_bindgen::to_value(&report).map_err(|e| to_js_err(e.to_string()))
}

#[wasm_bindgen]
pub fn wasm_cancel_session(session_id: &str) -> bool {
    with_sessions(|sessions| {
        if let Some(session) = sessions.get(session_id) {
            session.cancel_token.cancel();
            true
        } else {
            false
        }
    })
}

#[wasm_bindgen]
pub fn wasm_drop_session(session_id: &str) -> bool {
    with_sessions(|sessions| sessions.remove(session_id).is_some())
}

fn now_secs() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        (js_sys::Date::now() / 1000.0) as u64
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }
}
