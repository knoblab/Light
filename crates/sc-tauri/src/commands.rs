//! Tauri IPC Command handlers for SensorClean desktop & mobile runtimes.

#![forbid(unsafe_code)]

use sc_color::spaces::ColorSpace;
use sc_core::{CancelToken, DetectionParams, InpaintParams, SessionMetadata};
use sc_detect::detect_from_gray;
use sc_dng::{
    generate_xmp_sidecar_xml, write_cfa_dng, write_rendered_jpeg, write_rendered_png16,
    write_rendered_png8, write_rendered_tiff16,
};
use sc_heal::cfa_inpaint::BayerPattern;
use sc_heal::heal_cfa_image_cancellable;
use sc_session::{
    ingest_image_to_session, read_npy_f32, read_npy_u16, write_npy_u16, SessionStore,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

static ACTIVE_JOBS: Mutex<Option<HashMap<String, CancelToken>>> = Mutex::new(None);

fn with_jobs<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<String, CancelToken>) -> R,
{
    let mut guard = ACTIVE_JOBS.lock().unwrap_or_else(|p| p.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub job_id: String,
    pub session_id: String,
    pub percent: u8,
    pub stage: String,
    pub detail: Option<String>,
}

#[tauri::command]
pub fn cmd_get_system_info() -> serde_json::Value {
    serde_json::json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "isMobile": cfg!(mobile),
        "engine": "sc-tauri-pure-rust",
        "version": env!("CARGO_PKG_VERSION")
    })
}

#[tauri::command]
pub async fn cmd_ingest_and_detect(
    app: AppHandle,
    file_name: Option<String>,
    path: Option<String>,
    bytes: Option<Vec<u8>>,
    params: DetectionParams,
    job_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let jid = job_id.unwrap_or_else(|| "job_default".into());
    let token = CancelToken::new();
    with_jobs(|jobs| {
        jobs.insert(jid.clone(), token.clone());
    });

    let _ = app.emit(
        "sc://progress",
        ProgressEvent {
            job_id: jid.clone(),
            session_id: "".into(),
            percent: 10,
            stage: "ingest".into(),
            detail: Some("Decoding RAW image".into()),
        },
    );

    let store = SessionStore::default();
    let session_id = format!("sc_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
    let session_dir = store.sessions_root.join(&session_id);
    std::fs::create_dir_all(&session_dir).map_err(|e| e.to_string())?;

    let meta = if let Some(raw_bytes) = bytes {
        let fname = file_name.as_deref().unwrap_or("image.rw2");
        sc_session::ingest_bytes_to_session(&raw_bytes, fname, &session_dir)
            .map_err(|e| format!("Ingest bytes failed: {e}"))?
    } else if let Some(p) = path {
        let file_path = PathBuf::from(&p);
        ingest_image_to_session(&file_path, &session_dir, file_name.as_deref())
            .map_err(|e| format!("Ingest path failed: {e}"))?
    } else {
        return Err("Neither path nor bytes provided for ingest".into());
    };

    let _ = app.emit(
        "sc://progress",
        ProgressEvent {
            job_id: jid.clone(),
            session_id: session_id.clone(),
            percent: 50,
            stage: "detect".into(),
            detail: Some("Detecting sensor dust spots".into()),
        },
    );

    let ww = meta.work_width;
    let wh = meta.work_height;
    let fw = meta.full_width;
    let fh = meta.full_height;
    let scale = meta.work_scale;

    let det_gray = read_npy_f32(&session_dir.join("det_gray.npy"))
        .map_err(|e| format!("Failed to read det_gray: {e}"))?;

    let det_output = detect_from_gray(&det_gray.1, ww, wh, fw, fh, ww, wh, scale, &params);
    let det_result = det_output.result;

    let spots_json = serde_json::to_string_pretty(&det_result.spots)
        .unwrap_or_else(|_| "[]".into());
    let _ = std::fs::write(session_dir.join("spots.json"), spots_json);

    let _ = app.emit(
        "sc://progress",
        ProgressEvent {
            job_id: jid.clone(),
            session_id: session_id.clone(),
            percent: 100,
            stage: "complete".into(),
            detail: Some("Ready".into()),
        },
    );

    with_jobs(|jobs| {
        jobs.remove(&jid);
    });

    Ok(serde_json::json!({
        "success": true,
        "sessionId": session_id,
        "meta": meta,
        "detection": det_result,
        "urls": {
            "previewOriginal": format!("sensorclean://preview/{session_id}"),
            "vizBwEdge": format!("sensorclean://edge/{session_id}"),
            "maskAuto": format!("sensorclean://mask/{session_id}"),
        }
    }))
}

#[tauri::command]
pub async fn cmd_detect(
    _app: AppHandle,
    session_id: String,
    params: DetectionParams,
) -> Result<serde_json::Value, String> {
    let store = SessionStore::default();
    let session_dir = store.sessions_root.join(&session_id);

    let meta_json = std::fs::read_to_string(session_dir.join("session_meta.json"))
        .map_err(|e| format!("Metadata not found: {e}"))?;
    let meta: SessionMetadata = serde_json::from_str(&meta_json)
        .map_err(|e| format!("Invalid metadata: {e}"))?;

    let det_gray = read_npy_f32(&session_dir.join("det_gray.npy"))
        .map_err(|e| format!("Failed to read det_gray: {e}"))?;

    let ww = meta.work_width;
    let wh = meta.work_height;
    let fw = meta.full_width;
    let fh = meta.full_height;
    let scale = meta.work_scale;

    let det_output = detect_from_gray(&det_gray.1, ww, wh, fw, fh, ww, wh, scale, &params);
    let det_result = det_output.result;

    let spots_json = serde_json::to_string_pretty(&det_result.spots)
        .unwrap_or_else(|_| "[]".into());
    let _ = std::fs::write(session_dir.join("spots.json"), spots_json);

    Ok(serde_json::json!(det_result))
}

#[tauri::command]
pub async fn cmd_inpaint(
    _app: AppHandle,
    session_id: String,
    params: Option<InpaintParams>,
    spots: Option<Vec<sc_core::DetectedDustSpot>>,
    manual_strokes: Option<Vec<sc_core::ManualBrushStroke>>,
    inpaint_radius: Option<f64>,
    preserve_grain: Option<bool>,
) -> Result<serde_json::Value, String> {
    let store = SessionStore::default();
    let session_dir = store.sessions_root.join(&session_id);

    let meta_json = std::fs::read_to_string(session_dir.join("session_meta.json"))
        .map_err(|e| format!("Metadata not found: {e}"))?;
    let meta: SessionMetadata = serde_json::from_str(&meta_json)
        .map_err(|e| format!("Invalid metadata: {e}"))?;

    let fw = meta.full_width;
    let fh = meta.full_height;

    let spots_vec = if let Some(ref p) = params {
        p.spots.clone()
    } else if let Some(s) = spots {
        s
    } else {
        let spots_file = session_dir.join("spots.json");
        if spots_file.exists() {
            let s = std::fs::read_to_string(spots_file).unwrap_or_else(|_| "[]".into());
            serde_json::from_str(&s).unwrap_or_default()
        } else {
            Vec::new()
        }
    };

    let strokes_vec = if let Some(ref p) = params {
        p.manual_strokes.clone()
    } else {
        manual_strokes.unwrap_or_default()
    };

    let inpaint_r = if let Some(ref p) = params {
        p.inpaint_radius
    } else {
        inpaint_radius.unwrap_or(7.0)
    };

    let preserve_g = if let Some(ref p) = params {
        p.preserve_grain
    } else {
        preserve_grain.unwrap_or(true)
    };

    let inpaint_params = InpaintParams {
        spots: spots_vec.clone(),
        manual_strokes: strokes_vec.clone(),
        inpaint_radius: inpaint_r,
        preserve_grain: preserve_g,
    };

    // 1. Full 16-bit plane-detrended harmonic inpainting on linear RGB (for UI preview & TIFF/PNG/JPEG export)
    let inpaint_res = sc_session::inpaint_16bit_linear_native(&session_dir, &inpaint_params)
        .map_err(|e| format!("Linear 16-bit inpainting failed: {e}"))?;

    // 2. Pure CFA Bayer mosaic healing (for bit-exact DNG 1.6 export)
    let cfa_path = session_dir.join("cfa_raw.npy");
    if cfa_path.exists() {
        let pattern = match meta.bayer_pattern.to_ascii_uppercase().as_str() {
            "BGGR" => BayerPattern::BgGr,
            "GRBG" => BayerPattern::GrBg,
            "GBRG" => BayerPattern::GbRg,
            _ => BayerPattern::RgGb,
        };
        let cfa_data = read_npy_u16(&cfa_path)
            .map_err(|e| format!("Failed to read cfa_raw: {e}"))?;
        let (cfa_w, cfa_h) = if cfa_data.0.len() >= 2 {
            (cfa_data.0[1], cfa_data.0[0])
        } else {
            (fw, fh)
        };
        let (crop_x, crop_y) = if let Some([cx, cy, _, _]) = meta.raw_crop {
            (cx, cy)
        } else if cfa_w > fw && cfa_h > fh {
            (((cfa_w - fw) / 2) & !1, ((cfa_h - fh) / 2) & !1)
        } else {
            (0, 0)
        };
        let cfa_spots: Vec<DetectedDustSpot> = if crop_x > 0 || crop_y > 0 {
            spots_vec
                .iter()
                .map(|s| {
                    let mut s2 = s.clone();
                    s2.cx += crop_x as f64;
                    s2.cy += crop_y as f64;
                    s2
                })
                .collect()
        } else {
            spots_vec.clone()
        };
        let cfa_strokes: Vec<ManualBrushStroke> = if crop_x > 0 || crop_y > 0 {
            strokes_vec
                .iter()
                .map(|st| {
                    let mut st2 = st.clone();
                    for pt in &mut st2.points {
                        pt.x += crop_x as f64;
                        pt.y += crop_y as f64;
                    }
                    st2
                })
                .collect()
        } else {
            strokes_vec.clone()
        };
        let (healed, _) = heal_cfa_image_cancellable(
            &cfa_data.1,
            cfa_w,
            cfa_h,
            &cfa_spots,
            &cfa_strokes,
            pattern,
            inpaint_r,
            preserve_g,
            42,
            None,
            None,
        )
        .map_err(|e| format!("CFA heal failed: {e}"))?;
        write_npy_u16(&session_dir.join("healed_cfa.npy"), &[cfa_h, cfa_w], &healed)
            .map_err(|e| format!("Write healed_cfa failed: {e}"))?;
    }

    Ok(serde_json::json!({
        "success": true,
        "healedSpotsCount": inpaint_res.healed_spots_count,
        "inpaintedPixels": inpaint_res.inpainted_pixels,
        "inpaintedAreaPct": inpaint_res.inpainted_area_pct,
        "bitDepth": inpaint_res.bit_depth,
        "inpaintMethod": inpaint_res.inpaint_method,
        "inpaintRadius": inpaint_res.inpaint_radius,
        "urls": {
            "previewInpainted": format!("sensorclean://healed/{session_id}"),
            "maskFinal": format!("sensorclean://mask/{session_id}"),
        }
    }))
}

#[tauri::command]
pub async fn cmd_export_file(
    _app: AppHandle,
    session_id: String,
    format: String,
    dest_path: Option<String>,
    color_space: Option<String>,
) -> Result<serde_json::Value, String> {
    let store = SessionStore::default();
    let session_dir = store.sessions_root.join(&session_id);

    let meta_json = std::fs::read_to_string(session_dir.join("session_meta.json"))
        .map_err(|e| format!("Metadata not found: {e}"))?;
    let meta: SessionMetadata = serde_json::from_str(&meta_json)
        .map_err(|e| format!("Invalid metadata: {e}"))?;

    let space = match color_space.as_deref().unwrap_or("srgb").to_ascii_lowercase().as_str() {
        "adobe" | "adobergb" => ColorSpace::AdobeRgb1998,
        "prophoto" => ColorSpace::ProPhotoRgb,
        "displayp3" | "p3" => ColorSpace::DisplayP3,
        _ => ColorSpace::Srgb,
    };

    let fw = meta.full_width;
    let fh = meta.full_height;

    let target_path = if let Some(p) = dest_path {
        PathBuf::from(p)
    } else {
        session_dir.join(format!("export_{}.{}", session_id, format))
    };

    match format.to_ascii_lowercase().as_str() {
        "dng" => {
            let healed_cfa = session_dir.join("healed_cfa.npy");
            let cfa_path = if healed_cfa.exists() {
                healed_cfa
            } else {
                session_dir.join("cfa_raw.npy")
            };
            let cfa_data = read_npy_u16(&cfa_path)
                .map_err(|e| format!("Failed to read CFA buffer: {e}"))?;
            let (cfa_w, cfa_h) = if cfa_data.0.len() >= 2 {
                (cfa_data.0[1], cfa_data.0[0])
            } else {
                (fw, fh)
            };
            write_cfa_dng(&target_path, &cfa_data.1, cfa_w, cfa_h, &meta)
                .map_err(|e| format!("DNG write failed: {e}"))?;
        }
        "xmp" => {
            let spots_file = session_dir.join("spots.json");
            let spots = if spots_file.exists() {
                let s = std::fs::read_to_string(spots_file).unwrap_or_else(|_| "[]".into());
                serde_json::from_str(&s).unwrap_or_default()
            } else {
                Vec::new()
            };
            let dummy = vec![0u16; 64];
            let xml = generate_xmp_sidecar_xml(&dummy, fw, fh, &spots, &[]);
            std::fs::write(&target_path, xml).map_err(|e| format!("XMP write failed: {e}"))?;
        }
        "tiff16" | "tiff" => {
            let healed_path = session_dir.join("inpainted_16bit.npy");
            let lin_path = if healed_path.exists() {
                healed_path
            } else {
                session_dir.join("linear_16bit.npy")
            };
            let lin_data = read_npy_u16(&lin_path)
                .map_err(|e| format!("Failed to read 16-bit linear data: {e}"))?;
            write_rendered_tiff16(&target_path, &lin_data.1, fw, fh, space, &meta)
                .map_err(|e| format!("TIFF write failed: {e}"))?;
        }
        "png16" => {
            let healed_path = session_dir.join("inpainted_16bit.npy");
            let lin_path = if healed_path.exists() {
                healed_path
            } else {
                session_dir.join("linear_16bit.npy")
            };
            let lin_data = read_npy_u16(&lin_path)
                .map_err(|e| format!("Failed to read 16-bit linear data: {e}"))?;
            write_rendered_png16(&target_path, &lin_data.1, fw, fh, space, &meta)
                .map_err(|e| format!("PNG16 write failed: {e}"))?;
        }
        "png" | "png8" => {
            let healed_path = session_dir.join("inpainted_16bit.npy");
            let lin_path = if healed_path.exists() {
                healed_path
            } else {
                session_dir.join("linear_16bit.npy")
            };
            let lin_data = read_npy_u16(&lin_path)
                .map_err(|e| format!("Failed to read 16-bit linear data: {e}"))?;
            let rgb8: Vec<u8> = lin_data.1.iter().map(|&v| (v >> 8) as u8).collect();
            write_rendered_png8(&target_path, &rgb8, fw, fh, space, &meta)
                .map_err(|e| format!("PNG write failed: {e}"))?;
        }
        "jpeg" | "jpg" => {
            let healed_path = session_dir.join("inpainted_16bit.npy");
            let lin_path = if healed_path.exists() {
                healed_path
            } else {
                session_dir.join("linear_16bit.npy")
            };
            let lin_data = read_npy_u16(&lin_path)
                .map_err(|e| format!("Failed to read 16-bit linear data: {e}"))?;
            let rgb8: Vec<u8> = lin_data.1.iter().map(|&v| (v >> 8) as u8).collect();
            write_rendered_jpeg(&target_path, &rgb8, fw, fh, 95, space, &meta)
                .map_err(|e| format!("JPEG write failed: {e}"))?;
        }
        other => return Err(format!("Unsupported format: {other}")),
    }

    let file_size = std::fs::metadata(&target_path).map(|m| m.len()).unwrap_or(0);
    let bytes = std::fs::read(&target_path).unwrap_or_default();

    Ok(serde_json::json!({
        "success": true,
        "format": format,
        "outputPath": target_path.to_string_lossy(),
        "fileSizeBytes": file_size,
        "bytes": bytes,
    }))
}

#[tauri::command]
pub fn cmd_cancel_job(job_id: String) -> bool {
    with_jobs(|jobs| {
        if let Some(token) = jobs.get(&job_id) {
            token.cancel();
            true
        } else {
            false
        }
    })
}
