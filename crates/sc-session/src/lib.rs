//! SensorClean session store: memmap2-compatible `.npy` session persistence, TTL & client cookie
//! owner isolation, Unicode/Korean file stem sanitizer, and full ingest/detect/inpaint/export pipeline.

#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unimplemented,
    clippy::todo,
    clippy::unreachable
)]

pub mod native_heal;
pub mod npy;

pub use native_heal::{
    build_combined_mask, export_healed_image_native, inpaint_16bit_linear_native,
    inpaint_linear16_and_work_srgb_in_memory, write_jpeg_rgb, write_png_gray, write_png_rgb,
};
pub use npy::{
    read_npy_f32, read_npy_u8, read_npy_u16, write_npy_f32, write_npy_u8, write_npy_u16,
};

use sc_color::compute_det_gray_from_16bit;
use sc_core::{
    DetectedDustSpot, DetectionParams, DetectionResult, MultiFrameConfig, MultiFrameReport, Result,
    ScError, SessionMetadata,
};
use sc_decode::ingest_file;
use sc_detect::{cluster_multi_frame_spots, detect_from_gray};
use sc_imgproc::resize_inter_area_u16_rgb;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const SESSION_TTL: Duration = Duration::from_secs(2 * 60 * 60); // 2 hours
pub const TEMP_FILE_TTL: Duration = Duration::from_secs(30 * 60); // 30 minutes
pub const OWNER_FILE: &str = ".owner";

static SESSION_SEQ: AtomicU64 = AtomicU64::new(1);

/// Preserves Unicode letters and digits (including Korean Hangul) while replacing filesystem-unsafe
/// punctuation with `_`, matching `toSafeStem` in `server.ts:330-337`.
pub fn to_safe_stem(original_file_name: &str, fallback: &str) -> String {
    let base = Path::new(original_file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(original_file_name);

    let mapped: String = base
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();

    let trimmed = mapped.trim_matches(|c| c == '_' || c == '.');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

#[derive(Clone, Debug)]
pub struct SessionStore {
    pub sessions_root: PathBuf,
    pub uploads_root: PathBuf,
}

impl Default for SessionStore {
    fn default() -> Self {
        let tmp = std::env::temp_dir();
        Self::new(
            tmp.join("sensorclean_sessions"),
            tmp.join("sensorclean_uploads"),
        )
    }
}

impl SessionStore {
    pub fn new(sessions_root: PathBuf, uploads_root: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&sessions_root);
        let _ = std::fs::create_dir_all(&uploads_root);
        Self {
            sessions_root,
            uploads_root,
        }
    }

    pub fn read_session_owner(session_dir: &Path) -> Option<String> {
        std::fs::read_to_string(session_dir.join(OWNER_FILE))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    pub fn create_session_dir(&self, client_id: &str) -> Result<(String, PathBuf)> {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let seq = SESSION_SEQ.fetch_add(1, Ordering::Relaxed);
        let session_id = format!("sc_{now_ms}_{seq:08x}");
        let session_dir = self.sessions_root.join(&session_id);
        std::fs::create_dir_all(&session_dir)?;
        std::fs::write(session_dir.join(OWNER_FILE), client_id)?;
        Ok((session_id, session_dir))
    }

    /// Resolves a session directory for the calling client. Returns `None` if the session does not
    /// exist or belongs to another client (`server.ts:145-157`).
    pub fn resolve_session_dir(&self, client_id: &str, raw_session_id: &str) -> Option<PathBuf> {
        let safe_session: String = raw_session_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        if !safe_session.starts_with("sc_") {
            return None;
        }
        let session_dir = self.sessions_root.join(&safe_session);
        if !session_dir.is_dir() {
            return None;
        }
        if let Some(owner) = Self::read_session_owner(&session_dir)
            && owner != client_id
        {
            return None;
        }
        // Touch the owner file so active sessions stay alive past TTL
        if !client_id.is_empty() {
            let _ = std::fs::write(session_dir.join(OWNER_FILE), client_id);
        }
        Some(session_dir)
    }

    /// Removes expired sessions and temp files. When `client_id` is given, also trims that client's
    /// own older sessions down to `keep_for_client`; other clients' sessions are never touched (`server.ts:89-126`).
    pub fn prune_sessions(
        &self,
        client_id: Option<&str>,
        keep_for_client: usize,
        protect_session_ids: &[String],
    ) {
        let now = SystemTime::now();

        if let Ok(entries) = std::fs::read_dir(&self.uploads_root) {
            for entry in entries.flatten() {
                let p = entry.path();
                if let Ok(meta) = entry.metadata()
                    && let Ok(mtime) = meta.modified()
                    && now.duration_since(mtime).unwrap_or_default() > TEMP_FILE_TTL
                {
                    let _ = if meta.is_dir() {
                        std::fs::remove_dir_all(&p)
                    } else {
                        std::fs::remove_file(&p)
                    };
                }
            }
        }

        let protect_set: HashSet<&str> = protect_session_ids.iter().map(|s| s.as_str()).collect();
        let mut own_dirs: Vec<(PathBuf, SystemTime)> = Vec::new();

        if let Ok(entries) = std::fs::read_dir(&self.sessions_root) {
            for entry in entries.flatten() {
                let p = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
                let age = now.duration_since(mtime).unwrap_or_default();

                if meta.is_dir() && name.starts_with("sc_") {
                    if protect_set.contains(name.as_str()) {
                        continue;
                    }
                    if age > SESSION_TTL {
                        let _ = std::fs::remove_dir_all(&p);
                    } else if let Some(cid) = client_id
                        && Self::read_session_owner(&p).as_deref() == Some(cid)
                    {
                        own_dirs.push((p, mtime));
                    }
                } else if meta.is_file()
                    && (name.ends_with(".zip") || name.starts_with("multi_cfg_"))
                    && age > TEMP_FILE_TTL
                {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }

        own_dirs.sort_by_key(|a| std::cmp::Reverse(a.1));
        for (p, _) in own_dirs.into_iter().skip(keep_for_client) {
            let _ = std::fs::remove_dir_all(p);
        }
    }
}

/// Ingests an image/RAW file into `session_dir`, saving `.npy` buffers, `preview_original.jpg`,
/// and `session_meta.json`, matching `ingest_image` in `raw_pipeline.py:257-460`.
pub fn ingest_image_to_session(
    input_path: &Path,
    session_dir: &Path,
    original_file_name_override: Option<&str>,
) -> Result<SessionMetadata> {
    std::fs::create_dir_all(session_dir)?;
    let ingested = ingest_file(input_path, original_file_name_override)?;

    let fw = ingested.meta.full_width;
    let fh = ingested.meta.full_height;
    let ww = ingested.meta.work_width;
    let wh = ingested.meta.work_height;

    write_npy_u16(
        &session_dir.join("linear_16bit.npy"),
        &[fh, fw, 3],
        &ingested.linear_16bit,
    )?;
    write_npy_u16(
        &session_dir.join("work_linear_16bit.npy"),
        &[wh, ww, 3],
        &ingested.work_linear_16bit,
    )?;
    write_npy_u8(
        &session_dir.join("work_srgb_u8.npy"),
        &[wh, ww, 3],
        &ingested.work_srgb_u8,
    )?;
    write_npy_f32(
        &session_dir.join("det_gray.npy"),
        &[wh, ww],
        &ingested.det_gray,
    )?;
    write_jpeg_rgb(
        &session_dir.join("preview_original.jpg"),
        &ingested.work_srgb_u8,
        ww,
        wh,
        96,
    )?;

    if let Some(ref raw) = ingested.raw_image
        && raw.cfa.is_some()
        && raw.cpp == 1
        && let Ok(cfa_data) = sc_decode::raw_pixels_u16(raw)
    {
        write_npy_u16(&session_dir.join("cfa_raw.npy"), &[raw.height, raw.width], cfa_data)?;
    }

    std::fs::write(
        session_dir.join("session_meta.json"),
        serde_json::to_string_pretty(&ingested.meta)?,
    )?;

    Ok(ingested.meta)
}

/// Ingests in-memory image/RAW bytes into `session_dir`, saving `.npy` buffers, `preview_original.jpg`,
/// and `session_meta.json`.
pub fn ingest_bytes_to_session(
    bytes: &[u8],
    file_name: &str,
    session_dir: &Path,
) -> Result<SessionMetadata> {
    std::fs::create_dir_all(session_dir)?;
    let ext = Path::new(file_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("rw2")
        .to_ascii_lowercase();
    let ingested = sc_decode::ingest_bytes(bytes, file_name, &ext)?;

    let fw = ingested.meta.full_width;
    let fh = ingested.meta.full_height;
    let ww = ingested.meta.work_width;
    let wh = ingested.meta.work_height;

    write_npy_u16(
        &session_dir.join("linear_16bit.npy"),
        &[fh, fw, 3],
        &ingested.linear_16bit,
    )?;
    write_npy_u16(
        &session_dir.join("work_linear_16bit.npy"),
        &[wh, ww, 3],
        &ingested.work_linear_16bit,
    )?;
    write_npy_u8(
        &session_dir.join("work_srgb_u8.npy"),
        &[wh, ww, 3],
        &ingested.work_srgb_u8,
    )?;
    write_npy_f32(
        &session_dir.join("det_gray.npy"),
        &[wh, ww],
        &ingested.det_gray,
    )?;
    write_jpeg_rgb(
        &session_dir.join("preview_original.jpg"),
        &ingested.work_srgb_u8,
        ww,
        wh,
        96,
    )?;

    if let Some(ref raw) = ingested.raw_image
        && raw.cfa.is_some()
        && raw.cpp == 1
        && let Ok(cfa_data) = sc_decode::raw_pixels_u16(raw)
    {
        write_npy_u16(&session_dir.join("cfa_raw.npy"), &[raw.height, raw.width], cfa_data)?;
    }

    std::fs::write(
        session_dir.join("session_meta.json"),
        serde_json::to_string_pretty(&ingested.meta)?,
    )?;

    Ok(ingested.meta)
}

/// Runs dust detection on an existing `session_dir`, saving `mask_auto.png`, `viz_bw_edge.jpg`,
/// and `detection_result.json`, matching `detect_sensor_dust` in `raw_pipeline.py:677-1020`.
pub fn detect_sensor_dust_in_session(
    session_dir: &Path,
    params: &DetectionParams,
) -> Result<DetectionResult> {
    let meta_str = std::fs::read_to_string(session_dir.join("session_meta.json"))
        .map_err(|_| ScError::SessionNotFound(session_dir.to_string_lossy().into_owned()))?;
    let meta: SessionMetadata = serde_json::from_str(&meta_str)?;

    let full_w = meta.full_width;
    let full_h = meta.full_height;
    let work_w = meta.work_width;
    let work_h = meta.work_height;
    let work_scale = meta.work_scale;

    let det_gray_path = session_dir.join("det_gray.npy");
    let (det_w, det_h, gray_det) = if det_gray_path.exists() {
        let (dims, data) = read_npy_f32(&det_gray_path)?;
        let dh = dims.first().copied().unwrap_or(work_h);
        let dw = dims.get(1).copied().unwrap_or(work_w);
        (dw, dh, data)
    } else {
        let max_det_dim = 2304usize;
        let det_scale = (max_det_dim as f64 / full_w.max(full_h).max(1) as f64).min(1.0);
        let dw = ((full_w as f64 * det_scale).round() as usize).max(1);
        let dh = ((full_h as f64 * det_scale).round() as usize).max(1);
        let work_16_path = session_dir.join("work_linear_16bit.npy");
        let det_16 = if work_16_path.exists() && (work_w, work_h) == (dw, dh) {
            read_npy_u16(&work_16_path)?.1
        } else {
            let (_, full_16) = read_npy_u16(&session_dir.join("linear_16bit.npy"))?;
            if det_scale < 1.0 {
                resize_inter_area_u16_rgb(&full_16, full_w, full_h, dw, dh)
            } else {
                full_16
            }
        };
        let gd = compute_det_gray_from_16bit(&det_16, dw, dh, meta.is_raw, meta.exposure_scale);
        write_npy_f32(&det_gray_path, &[dh, dw], &gd)?;
        (dw, dh, gd)
    };

    let out = detect_from_gray(
        &gray_det, det_w, det_h, full_w, full_h, work_w, work_h, work_scale, params,
    );

    write_png_gray(
        &session_dir.join("mask_auto.png"),
        &out.mask_auto_u8,
        work_w,
        work_h,
    )?;
    write_jpeg_rgb(
        &session_dir.join("viz_bw_edge.jpg"),
        &out.viz_bw_edge_rgb,
        work_w,
        work_h,
        94,
    )?;
    std::fs::write(
        session_dir.join("detection_result.json"),
        serde_json::to_string_pretty(&out.result)?,
    )?;

    Ok(out.result)
}

/// Combined ingest + initial dust detection (`ingest_and_detect`).
pub fn ingest_and_detect_session(
    input_path: &Path,
    session_dir: &Path,
    params: &DetectionParams,
    original_file_name_override: Option<&str>,
) -> Result<(SessionMetadata, DetectionResult)> {
    let meta = ingest_image_to_session(input_path, session_dir, original_file_name_override)?;
    let detection = detect_sensor_dust_in_session(session_dir, params)?;
    Ok((meta, detection))
}

/// Runs multi-frame temporal clustering across uploaded sessions (`multi_detect`).
pub fn multi_detect_sessions(config: &MultiFrameConfig) -> Result<MultiFrameReport> {
    let mut frames_input: Vec<(String, String, SessionMetadata, Vec<DetectedDustSpot>)> =
        Vec::with_capacity(config.session_dirs.len());

    for s_dir_str in &config.session_dirs {
        let s_dir = Path::new(s_dir_str);
        let meta_str = std::fs::read_to_string(s_dir.join("session_meta.json"))?;
        let meta: SessionMetadata = serde_json::from_str(&meta_str)?;

        let det_path = s_dir.join("detection_result.json");
        let det: DetectionResult = if config.force_redetect || !det_path.exists() {
            detect_sensor_dust_in_session(s_dir, &config.detection_params)?
        } else {
            let det_str = std::fs::read_to_string(&det_path)?;
            serde_json::from_str(&det_str)?
        };

        let session_id = s_dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        frames_input.push((s_dir_str.clone(), session_id, meta, det.spots));
    }

    let report = cluster_multi_frame_spots(
        frames_input,
        config.tolerance_px,
        config.min_frames_match,
    );

    // Persist updated detection_result.json in each session folder
    for pf in &report.per_frame {
        let s_dir = Path::new(&pf.session_dir);
        let det_path = s_dir.join("detection_result.json");
        let updated = serde_json::json!({
            "spots": pf.spots,
            "totalDetected": pf.total_detected,
            "multiConfirmedCount": pf.multi_confirmed_count,
            "singleFrameCount": pf.single_frame_count,
            "projectedCount": pf.projected_count,
        });
        let _ = std::fs::write(det_path, serde_json::to_string_pretty(&updated)?);
    }

    Ok(report)
}
