//! SensorClean Axum HTTP Server (`sc-server`).
//! Drop-in replacement for `server.ts`, preserving all 12 `/api/*` endpoints, `sc_client` cookie
//! session isolation, Korean/Unicode RFC 5987 filenames, and 4 MB chunked download streaming.

#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unimplemented,
    clippy::todo,
    clippy::unreachable
)]

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use sc_core::{
    DetectedDustSpot, DetectionParams, InpaintParams, ManualBrushStroke, MultiFrameConfig,
    SessionMetadata, validate_export_format,
};
use sc_session::{
    SessionStore, detect_sensor_dust_in_session, export_healed_image_native,
    ingest_and_detect_session, inpaint_16bit_linear_native, multi_detect_sessions, to_safe_stem,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

pub const CLIENT_COOKIE_NAME: &str = "sc_client";
pub const MAX_SESSIONS_PER_CLIENT: usize = 36;

static CLIENT_ID_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub struct AppState {
    pub store: SessionStore,
    pub project_root: PathBuf,
}

impl AppState {
    pub fn new(store: SessionStore, project_root: PathBuf) -> Self {
        Self {
            store,
            project_root,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ClientId(pub String);

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn generate_client_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seq = CLIENT_ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{nanos:016x}{seq:016x}")
}

fn batch_zip_prefix(client_id: &str) -> String {
    let prefix: String = client_id.chars().take(12).collect();
    format!("batch_{prefix}_")
}

fn extract_cookie_client_id(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let trimmed = part.trim();
        if let Some(val) = trimmed.strip_prefix("sc_client=") {
            let valid = val.len() >= 16
                && val.len() <= 64
                && val.chars().all(|c| c.is_ascii_hexdigit());
            if valid {
                return Some(val.to_string());
            }
        }
    }
    None
}

async fn client_cookie_middleware(mut req: Request, next: Next) -> Response {
    let existing = extract_cookie_client_id(req.headers());
    let (cid, is_new) = match existing {
        Some(id) => (id, false),
        None => (generate_client_id(), true),
    };
    req.extensions_mut().insert(ClientId(cid.clone()));
    let mut resp = next.run(req).await;
    if is_new {
        let cookie_val = format!(
            "{CLIENT_COOKIE_NAME}={cid}; Path=/; Max-Age=86400; SameSite=Lax; HttpOnly"
        );
        if let Ok(hv) = HeaderValue::from_str(&cookie_val) {
            resp.headers_mut().append(header::SET_COOKIE, hv);
        }
    }
    resp
}

fn json_error(status: StatusCode, msg: impl Into<String>) -> Response {
    let body = Json(json!({ "error": msg.into() }));
    (status, body).into_response()
}

fn percent_encode_rfc5987(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for b in input.as_bytes() {
        let ch = *b;
        if ch.is_ascii_alphanumeric() || matches!(ch, b'-' | b'_' | b'.' | b'~') {
            out.push(ch as char);
        } else {
            out.push_str(&format!("%{ch:02X}"));
        }
    }
    out
}

pub fn build_app(state: AppState) -> Router {
    let dist_dir = state.project_root.join("dist");
    let index_html = dist_dir.join("index.html");

    let api_router = Router::new()
        .route("/api/engine-status", get(handle_engine_status))
        .route(
            "/api/session/:session_id/file/:file_name",
            get(handle_session_file),
        )
        .route("/api/upload", post(handle_upload))
        .route("/api/detect", post(handle_detect))
        .route("/api/inpaint", post(handle_inpaint))
        .route("/api/export-prepare", post(handle_export_prepare))
        .route(
            "/api/export-chunk/:session_id/:file_name",
            get(handle_export_chunk),
        )
        .route("/api/export/:session_id/:format", get(handle_export_direct))
        .route("/api/multi-upload", post(handle_multi_upload))
        .route("/api/multi-detect", post(handle_multi_detect))
        .route("/api/multi-export-zip", post(handle_multi_export_zip))
        .route("/api/python-source", get(handle_python_source));

    let app = if dist_dir.is_dir() && index_html.is_file() {
        api_router.fallback_service(
            ServeDir::new(dist_dir).not_found_service(ServeFile::new(index_html)),
        )
    } else {
        api_router
    };

    app.layer(DefaultBodyLimit::max(512 * 1024 * 1024))
        .layer(middleware::from_fn(client_cookie_middleware))
        .layer(CorsLayer::permissive())
        .with_state(Arc::new(state))
}

async fn handle_engine_status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let py_script = state.project_root.join("python").join("raw_pipeline.py");
    Json(json!({
        "available": true,
        "pythonBin": "rust:sc-engine",
        "rawPipelineScript": py_script.to_string_lossy(),
        "sessionsRoot": state.store.sessions_root.to_string_lossy(),
        "nativeRust": true,
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn handle_session_file(
    State(state): State<Arc<AppState>>,
    axum::Extension(ClientId(client_id)): axum::Extension<ClientId>,
    AxumPath((session_id, file_name)): AxumPath<(String, String)>,
) -> Response {
    let safe_file = std::path::Path::new(&file_name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    if safe_file.is_empty() || safe_file == sc_session::OWNER_FILE {
        return json_error(StatusCode::NOT_FOUND, "File not found");
    }

    let Some(session_dir) = state.store.resolve_session_dir(&client_id, &session_id) else {
        return json_error(StatusCode::NOT_FOUND, "세션을 찾을 수 없습니다.");
    };
    let file_path = session_dir.join(&safe_file);
    let Ok(bytes) = std::fs::read(&file_path) else {
        return json_error(StatusCode::NOT_FOUND, "File not found");
    };

    let content_type = if safe_file.ends_with(".png") {
        "image/png"
    } else if safe_file.ends_with(".jpg") || safe_file.ends_with(".jpeg") {
        "image/jpeg"
    } else if safe_file.ends_with(".tiff") || safe_file.ends_with(".tif") {
        "image/tiff"
    } else if safe_file.ends_with(".dng") {
        "image/x-adobe-dng"
    } else {
        "application/octet-stream"
    };

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-cache, must-revalidate"),
    );
    (StatusCode::OK, headers, bytes).into_response()
}

async fn handle_upload(
    State(state): State<Arc<AppState>>,
    axum::Extension(ClientId(client_id)): axum::Extension<ClientId>,
    mut multipart: Multipart,
) -> Response {
    state.store.prune_sessions(Some(&client_id), 2, &[]);

    let mut uploaded_bytes: Option<Vec<u8>> = None;
    let mut original_name = String::from("upload.rw2");
    let mut fields: HashMap<String, String> = HashMap::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            if let Some(fname) = field.file_name() {
                original_name = fname.to_string();
            }
            match field.bytes().await {
                Ok(b) => uploaded_bytes = Some(b.to_vec()),
                Err(e) => {
                    return json_error(
                        StatusCode::BAD_REQUEST,
                        format!("파일 업로드 오류: {e}"),
                    );
                }
            }
        } else if let Ok(txt) = field.text().await {
            if name == "originalFileName" && !txt.trim().is_empty() {
                original_name = txt.trim().to_string();
            }
            fields.insert(name, txt);
        }
    }

    let Some(file_bytes) = uploaded_bytes else {
        return json_error(StatusCode::BAD_REQUEST, "업로드된 파일이 없습니다.");
    };

    let params = DetectionParams {
        method: fields
            .get("method")
            .cloned()
            .unwrap_or_else(|| "dual".into()),
        sensitivity: fields
            .get("sensitivity")
            .and_then(|s| s.parse().ok())
            .unwrap_or(68.0),
        cloud_protection: fields
            .get("cloudProtection")
            .and_then(|s| s.parse().ok())
            .unwrap_or(75.0),
        min_radius: fields
            .get("minRadius")
            .and_then(|s| s.parse().ok())
            .unwrap_or(2.0),
        max_radius: fields
            .get("maxRadius")
            .and_then(|s| s.parse().ok())
            .unwrap_or(40.0),
        min_circularity: fields
            .get("minCircularity")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.60),
        inpaint_radius: 6.0,
        preserve_grain: true,
    };

    let Ok((session_id, session_dir)) = state.store.create_session_dir(&client_id) else {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "세션 디렉터리를 생성할 수 없습니다.",
        );
    };

    let ext = std::path::Path::new(&original_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("rw2");
    let input_file_path = session_dir.join(format!("source_input.{ext}"));
    if let Err(e) = std::fs::write(&input_file_path, &file_bytes) {
        let _ = std::fs::remove_dir_all(&session_dir);
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("임시 파일 저장 실패: {e}"),
        );
    }

    let session_dir_clone = session_dir.clone();
    let input_clone = input_file_path.clone();
    let orig_clone = original_name.clone();
    let res = tokio::task::spawn_blocking(move || {
        ingest_and_detect_session(&input_clone, &session_dir_clone, &params, Some(&orig_clone))
    })
    .await;

    let (meta, detection) = match res {
        Ok(Ok(pair)) => pair,
        Ok(Err(sc_err)) => {
            let _ = std::fs::remove_dir_all(&session_dir);
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, sc_err.to_string());
        }
        Err(join_err) => {
            let _ = std::fs::remove_dir_all(&session_dir);
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("작업 스레드 오류: {join_err}"),
            );
        }
    };

    let ts = now_millis();
    Json(json!({
        "success": true,
        "sessionId": session_id,
        "meta": meta,
        "detection": detection,
        "urls": {
            "previewOriginal": format!("/api/session/{session_id}/file/preview_original.jpg?t={ts}"),
            "vizBwEdge": format!("/api/session/{session_id}/file/viz_bw_edge.jpg?t={ts}"),
            "maskAuto": format!("/api/session/{session_id}/file/mask_auto.png?t={ts}"),
        }
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetectRequest {
    session_id: Option<String>,
    #[serde(default)]
    params: Option<DetectionParams>,
    #[serde(flatten)]
    flat_params: DetectionParams,
}

async fn handle_detect(
    State(state): State<Arc<AppState>>,
    axum::Extension(ClientId(client_id)): axum::Extension<ClientId>,
    Json(req): Json<DetectRequest>,
) -> Response {
    let Some(raw_sid) = req.session_id.as_deref().filter(|s| !s.is_empty()) else {
        return json_error(StatusCode::BAD_REQUEST, "sessionId가 필요합니다.");
    };
    let Some(session_dir) = state.store.resolve_session_dir(&client_id, raw_sid) else {
        return json_error(
            StatusCode::NOT_FOUND,
            "세션을 찾을 수 없습니다. 파일을 다시 업로드해주세요.",
        );
    };

    let params = req.params.unwrap_or(req.flat_params);
    let safe_session = session_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(raw_sid)
        .to_string();

    let s_dir = session_dir.clone();
    let res =
        tokio::task::spawn_blocking(move || detect_sensor_dust_in_session(&s_dir, &params)).await;

    let detection = match res {
        Ok(Ok(d)) => d,
        Ok(Err(e)) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    let ts = now_millis();
    Json(json!({
        "success": true,
        "sessionId": safe_session,
        "detection": detection,
        "urls": {
            "vizBwEdge": format!("/api/session/{safe_session}/file/viz_bw_edge.jpg?t={ts}"),
            "maskAuto": format!("/api/session/{safe_session}/file/mask_auto.png?t={ts}"),
        }
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InpaintRequest {
    session_id: Option<String>,
    #[serde(default)]
    spots: Vec<DetectedDustSpot>,
    #[serde(default)]
    manual_strokes: Vec<ManualBrushStroke>,
    #[serde(default = "default_inpaint_radius")]
    inpaint_radius: f64,
    #[serde(default = "default_true")]
    preserve_grain: bool,
}
fn default_inpaint_radius() -> f64 {
    6.0
}
fn default_true() -> bool {
    true
}

async fn handle_inpaint(
    State(state): State<Arc<AppState>>,
    axum::Extension(ClientId(client_id)): axum::Extension<ClientId>,
    Json(req): Json<InpaintRequest>,
) -> Response {
    let Some(raw_sid) = req.session_id.as_deref().filter(|s| !s.is_empty()) else {
        return json_error(StatusCode::BAD_REQUEST, "sessionId가 필요합니다.");
    };
    let Some(session_dir) = state.store.resolve_session_dir(&client_id, raw_sid) else {
        return json_error(StatusCode::NOT_FOUND, "세션을 찾을 수 없습니다.");
    };
    let safe_session = session_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(raw_sid)
        .to_string();

    let params = InpaintParams {
        spots: req.spots,
        manual_strokes: req.manual_strokes,
        inpaint_radius: req.inpaint_radius,
        preserve_grain: req.preserve_grain,
    };

    let s_dir = session_dir.clone();
    let res =
        tokio::task::spawn_blocking(move || inpaint_16bit_linear_native(&s_dir, &params)).await;

    let inpaint_result = match res {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    let ts = now_millis();
    Json(json!({
        "success": true,
        "sessionId": safe_session,
        "inpaintResult": inpaint_result,
        "urls": {
            "previewInpainted": format!("/api/session/{safe_session}/file/preview_inpainted.jpg?t={ts}"),
            "maskFinal": format!("/api/session/{safe_session}/file/mask_final_work.png?t={ts}"),
        }
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportPrepareRequest {
    session_id: Option<String>,
    #[serde(default = "default_export_format")]
    format: String,
    #[serde(default)]
    spots: Vec<DetectedDustSpot>,
    #[serde(default)]
    manual_strokes: Vec<ManualBrushStroke>,
    #[serde(default = "default_inpaint_radius")]
    inpaint_radius: f64,
    #[serde(default = "default_true")]
    preserve_grain: bool,
}
fn default_export_format() -> String {
    "dng".to_string()
}

fn read_session_meta(session_dir: &std::path::Path) -> Option<SessionMetadata> {
    let s = std::fs::read_to_string(session_dir.join("session_meta.json")).ok()?;
    serde_json::from_str(&s).ok()
}

async fn handle_export_prepare(
    State(state): State<Arc<AppState>>,
    axum::Extension(ClientId(client_id)): axum::Extension<ClientId>,
    Json(req): Json<ExportPrepareRequest>,
) -> Response {
    let Some(raw_sid) = req.session_id.as_deref().filter(|s| !s.is_empty()) else {
        return json_error(StatusCode::BAD_REQUEST, "sessionId가 필요합니다.");
    };
    let Some(session_dir) = state.store.resolve_session_dir(&client_id, raw_sid) else {
        return json_error(
            StatusCode::NOT_FOUND,
            "세션을 찾을 수 없습니다. 사진을 다시 불러와 주세요.",
        );
    };
    let safe_session = session_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(raw_sid)
        .to_string();

    let Some(meta) = read_session_meta(&session_dir) else {
        return json_error(
            StatusCode::NOT_FOUND,
            "세션 메타데이터를 읽을 수 없습니다.",
        );
    };

    let fmt_key = req.format.to_ascii_lowercase();
    let (ext, suffix, mime) = match validate_export_format(&fmt_key, &meta) {
        Ok(v) => v,
        Err(msg) => return json_error(StatusCode::BAD_REQUEST, msg),
    };

    let safe_stem = to_safe_stem(&meta.original_file_name, "sensor_cleaned");
    let download_name = format!("{safe_stem}{suffix}.{ext}");
    let output_path = session_dir.join(&download_name);

    let inpaint_params = InpaintParams {
        spots: req.spots,
        manual_strokes: req.manual_strokes,
        inpaint_radius: req.inpaint_radius,
        preserve_grain: req.preserve_grain,
    };

    let s_dir = session_dir.clone();
    let fk = fmt_key.clone();
    let out_clone = output_path.clone();
    let res = tokio::task::spawn_blocking(move || {
        let ir = inpaint_16bit_linear_native(&s_dir, &inpaint_params)?;
        let ei = export_healed_image_native(&s_dir, &fk, &out_clone)?;
        Ok::<_, sc_core::ScError>((ir, ei))
    })
    .await;

    let (inpaint_result, export_info) = match res {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    let file_size_bytes = export_info.file_size_bytes;
    let chunk_size: u64 = 4 * 1024 * 1024;
    let total_chunks = file_size_bytes.div_ceil(chunk_size).max(1);
    let ts = now_millis();
    let enc_file = percent_encode_rfc5987(&download_name);

    Json(json!({
        "ok": true,
        "success": true,
        "inpaintResult": inpaint_result,
        "urls": {
            "previewInpainted": format!("/api/session/{safe_session}/file/preview_inpainted.jpg?t={ts}"),
            "maskFinal": format!("/api/session/{safe_session}/file/mask_final_work.png?t={ts}"),
        },
        "exportMeta": {
            "sessionId": safe_session,
            "fileName": download_name,
            "mimeType": mime,
            "fileSizeBytes": file_size_bytes,
            "chunkSize": chunk_size,
            "totalChunks": total_chunks,
        },
        "chunkBaseUrl": format!("/api/export-chunk/{safe_session}/{enc_file}"),
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
struct ChunkQuery {
    offset: Option<u64>,
    length: Option<usize>,
}

async fn handle_export_chunk(
    State(state): State<Arc<AppState>>,
    axum::Extension(ClientId(client_id)): axum::Extension<ClientId>,
    AxumPath((session_id, file_name)): AxumPath<(String, String)>,
    Query(query): Query<ChunkQuery>,
    headers: HeaderMap,
) -> Response {
    let safe_file = std::path::Path::new(&file_name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    if safe_file.is_empty() || safe_file == sc_session::OWNER_FILE {
        return json_error(StatusCode::NOT_FOUND, "내보낼 파일을 찾을 수 없습니다.");
    }

    let file_path = if session_id == "__batch__" {
        let prefix = batch_zip_prefix(&client_id);
        if safe_file.starts_with(&prefix) && safe_file.ends_with(".zip") {
            Some(state.store.sessions_root.join(&safe_file))
        } else {
            None
        }
    } else {
        state
            .store
            .resolve_session_dir(&client_id, &session_id)
            .map(|d| d.join(&safe_file))
    };

    let Some(file_path) = file_path else {
        return json_error(StatusCode::NOT_FOUND, "내보낼 파일을 찾을 수 없습니다.");
    };
    let Ok(mut file) = std::fs::File::open(&file_path) else {
        return json_error(StatusCode::NOT_FOUND, "내보낼 파일을 찾을 수 없습니다.");
    };
    let Ok(meta) = file.metadata() else {
        return json_error(StatusCode::NOT_FOUND, "내보낼 파일을 찾을 수 없습니다.");
    };
    let total_size = meta.len();

    let mut offset = query.offset.unwrap_or(0);
    let mut length = query.length.unwrap_or(4 * 1024 * 1024);

    if let Some(range_hv) = headers.get(header::RANGE)
        && let Ok(range_str) = range_hv.to_str()
        && let Some(spec) = range_str.strip_prefix("bytes=")
    {
        let mut parts = spec.splitn(2, '-');
        let start_s = parts.next().unwrap_or("");
        let end_s = parts.next().unwrap_or("");
        if let Ok(s) = start_s.parse::<u64>() {
            offset = s;
            if let Ok(e) = end_s.parse::<u64>()
                && e >= s
            {
                length = (e - s + 1) as usize;
            }
        }
    }

    length = length.clamp(1, 8 * 1024 * 1024);
    if offset >= total_size {
        return json_error(StatusCode::RANGE_NOT_SATISFIABLE, "Offset out of range");
    }

    let actual_len = ((total_size - offset) as usize).min(length);
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "파일 탐색 오류");
    }
    let mut buf = vec![0u8; actual_len];
    if file.read_exact(&mut buf).is_err() {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "파일 청크 전송 중 오류가 발생했습니다.",
        );
    }

    let mut resp_headers = HeaderMap::new();
    resp_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    resp_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-cache, must-revalidate"),
    );
    if let Ok(hv) = HeaderValue::from_str(&actual_len.to_string()) {
        resp_headers.insert(header::CONTENT_LENGTH, hv.clone());
        resp_headers.insert("X-Export-Chunk-Length", hv);
    }
    if let Ok(hv) = HeaderValue::from_str(&total_size.to_string()) {
        resp_headers.insert("X-Export-Total-Size", hv);
    }

    (StatusCode::OK, resp_headers, Body::from(buf)).into_response()
}

async fn handle_export_direct(
    State(state): State<Arc<AppState>>,
    axum::Extension(ClientId(client_id)): axum::Extension<ClientId>,
    AxumPath((session_id, format)): AxumPath<(String, String)>,
) -> Response {
    let Some(session_dir) = state.store.resolve_session_dir(&client_id, &session_id) else {
        return json_error(StatusCode::NOT_FOUND, "세션을 찾을 수 없습니다.");
    };
    let Some(meta) = read_session_meta(&session_dir) else {
        return json_error(
            StatusCode::NOT_FOUND,
            "세션 메타데이터를 읽을 수 없습니다.",
        );
    };

    let fmt_key = format.to_ascii_lowercase();
    let (ext, suffix, mime) = match validate_export_format(&fmt_key, &meta) {
        Ok(v) => v,
        Err(msg) => return json_error(StatusCode::BAD_REQUEST, msg),
    };

    let safe_stem = to_safe_stem(&meta.original_file_name, "sensor_cleaned");
    let download_name = format!("{safe_stem}{suffix}.{ext}");
    let output_path = session_dir.join(&download_name);

    let s_dir = session_dir.clone();
    let fk = fmt_key.clone();
    let out_clone = output_path.clone();
    let res =
        tokio::task::spawn_blocking(move || export_healed_image_native(&s_dir, &fk, &out_clone))
            .await;

    let export_info = match res {
        Ok(Ok(info)) => info,
        Ok(Err(e)) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    let Ok(bytes) = std::fs::read(&export_info.output_path) else {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "파일 전송 중 오류가 발생했습니다.",
        );
    };

    let ascii_fallback: String = download_name
        .chars()
        .map(|c| if c.is_ascii() && c != '"' { c } else { '_' })
        .collect();
    let encoded_utf8 = percent_encode_rfc5987(&download_name);
    let disp =
        format!("attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{encoded_utf8}");

    let mut headers = HeaderMap::new();
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Disposition, X-File-Name"),
    );
    if let Ok(hv) = HeaderValue::from_str(&encoded_utf8) {
        headers.insert("X-File-Name", hv);
    }
    if let Ok(hv) = HeaderValue::from_str(mime) {
        headers.insert(header::CONTENT_TYPE, hv);
    }
    if let Ok(hv) = HeaderValue::from_str(&disp) {
        headers.insert(header::CONTENT_DISPOSITION, hv);
    }
    if let Ok(hv) = HeaderValue::from_str(&bytes.len().to_string()) {
        headers.insert(header::CONTENT_LENGTH, hv);
    }

    (StatusCode::OK, headers, Body::from(bytes)).into_response()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MultiSessionItem {
    session_id: String,
    meta: SessionMetadata,
    detection: sc_core::DetectionResult,
    urls: Value,
}

async fn handle_multi_upload(
    State(state): State<Arc<AppState>>,
    axum::Extension(ClientId(client_id)): axum::Extension<ClientId>,
    mut multipart: Multipart,
) -> Response {
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if name == "files" || name == "file" {
            let fname = field.file_name().unwrap_or("frame.rw2").to_string();
            match field.bytes().await {
                Ok(b) => files.push((fname, b.to_vec())),
                Err(e) => {
                    return json_error(
                        StatusCode::BAD_REQUEST,
                        format!("다중 파일 업로드에 실패했습니다: {e}"),
                    );
                }
            }
        }
    }

    if files.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "업로드할 파일이 없습니다.");
    }

    state.store.prune_sessions(Some(&client_id), 0, &[]);

    let mut session_dirs: Vec<String> = Vec::with_capacity(files.len());
    let mut session_list: Vec<MultiSessionItem> = Vec::with_capacity(files.len());
    let default_params = DetectionParams::default();

    for (orig_name, bytes) in files {
        let Ok((session_id, session_dir)) = state.store.create_session_dir(&client_id) else {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "세션 생성 오류");
        };
        let ext = std::path::Path::new(&orig_name)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("rw2");
        let input_path = session_dir.join(format!("source_input.{ext}"));
        if let Err(e) = std::fs::write(&input_path, &bytes) {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }

        let s_dir = session_dir.clone();
        let ip = input_path.clone();
        let oname = orig_name.clone();
        let p_clone = default_params.clone();
        let res = tokio::task::spawn_blocking(move || {
            ingest_and_detect_session(&ip, &s_dir, &p_clone, Some(&oname))
        })
        .await;

        let (meta, detection) = match res {
            Ok(Ok(pair)) => pair,
            Ok(Err(e)) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };

        let ts = now_millis();
        session_dirs.push(session_dir.to_string_lossy().into_owned());
        session_list.push(MultiSessionItem {
            session_id: session_id.clone(),
            meta,
            detection,
            urls: json!({
                "previewOriginal": format!("/api/session/{session_id}/file/preview_original.jpg?t={ts}"),
                "vizBwEdge": format!("/api/session/{session_id}/file/viz_bw_edge.jpg?t={ts}"),
                "maskAuto": format!("/api/session/{session_id}/file/mask_auto.png?t={ts}"),
            }),
        });
    }

    let cfg = MultiFrameConfig {
        session_dirs,
        tolerance_px: 14.0,
        min_frames_match: 2,
        detection_params: default_params,
        force_redetect: false,
    };

    let multi_report = match tokio::task::spawn_blocking(move || multi_detect_sessions(&cfg)).await
    {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    for item in &mut session_list {
        if let Some(pf) = multi_report
            .per_frame
            .iter()
            .find(|pf| pf.session_id == item.session_id)
        {
            item.detection.spots = pf.spots.clone();
            item.detection.total_detected = pf.total_detected;
            item.detection.multi_confirmed_count = Some(pf.multi_confirmed_count);
            item.detection.single_frame_count = Some(pf.single_frame_count);
            item.detection.projected_count = Some(pf.projected_count);
        }
    }

    Json(json!({
        "sessions": session_list,
        "multiReport": {
            "totalFrames": multi_report.total_frames,
            "totalClusters": multi_report.total_clusters,
            "multiConfirmedClusters": multi_report.multi_confirmed_clusters,
            "clusters": multi_report.clusters,
        }
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MultiDetectRequest {
    #[serde(default)]
    session_ids: Vec<String>,
    #[serde(default)]
    params: DetectionParams,
    #[serde(default = "default_tolerance_px")]
    tolerance_px: f64,
    #[serde(default = "default_min_frames_match")]
    min_frames_match: usize,
}
fn default_tolerance_px() -> f64 {
    14.0
}
fn default_min_frames_match() -> usize {
    2
}

async fn handle_multi_detect(
    State(state): State<Arc<AppState>>,
    axum::Extension(ClientId(client_id)): axum::Extension<ClientId>,
    Json(req): Json<MultiDetectRequest>,
) -> Response {
    if req.session_ids.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "sessionIds 배열이 필요합니다.");
    }

    let session_dirs: Vec<String> = req
        .session_ids
        .iter()
        .filter_map(|sid| state.store.resolve_session_dir(&client_id, sid))
        .map(|d| d.to_string_lossy().into_owned())
        .collect();

    if session_dirs.is_empty() {
        return json_error(
            StatusCode::NOT_FOUND,
            "세션을 찾을 수 없습니다. 파일을 다시 업로드해주세요.",
        );
    }

    let cfg = MultiFrameConfig {
        session_dirs,
        tolerance_px: req.tolerance_px,
        min_frames_match: req.min_frames_match,
        detection_params: req.params,
        force_redetect: true,
    };

    match tokio::task::spawn_blocking(move || multi_detect_sessions(&cfg)).await {
        Ok(Ok(report)) => Json(report).into_response(),
        Ok(Err(e)) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZipItemParams {
    #[serde(default = "default_inpaint_radius")]
    inpaint_radius: f64,
    #[serde(default = "default_true")]
    preserve_grain: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZipBatchItem {
    session_id: String,
    #[serde(default)]
    spots: Vec<DetectedDustSpot>,
    #[serde(default)]
    manual_strokes: Vec<ManualBrushStroke>,
    #[serde(default)]
    params: ZipItemParams,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MultiExportZipRequest {
    #[serde(default)]
    items: Vec<ZipBatchItem>,
    #[serde(default = "default_export_format")]
    format: String,
    #[serde(default)]
    prepare_only: bool,
}

async fn handle_multi_export_zip(
    State(state): State<Arc<AppState>>,
    axum::Extension(ClientId(client_id)): axum::Extension<ClientId>,
    Json(req): Json<MultiExportZipRequest>,
) -> Response {
    if req.items.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "내보낼 항목 목록이 비어있습니다.");
    }

    let fmt = req.format.to_ascii_lowercase();
    let state_clone = state.clone();
    let cid = client_id.clone();

    let res = tokio::task::spawn_blocking(move || {
        let mut exported_files: Vec<(PathBuf, String)> = Vec::new();

        for (idx, item) in req.items.iter().enumerate() {
            let Some(session_dir) = state_clone.store.resolve_session_dir(&cid, &item.session_id)
            else {
                continue;
            };
            let Some(frame_meta) = read_session_meta(&session_dir) else {
                continue;
            };

            let (ext, _, _) = match validate_export_format(&fmt, &frame_meta) {
                Ok(v) => v,
                Err(msg) => {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        format!("{}: {msg}", frame_meta.original_file_name),
                    ));
                }
            };

            let inpaint_params = InpaintParams {
                spots: item.spots.clone(),
                manual_strokes: item.manual_strokes.clone(),
                inpaint_radius: item.params.inpaint_radius,
                preserve_grain: item.params.preserve_grain,
            };

            inpaint_16bit_linear_native(&session_dir, &inpaint_params)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            let base_stem =
                to_safe_stem(&frame_meta.original_file_name, &format!("photo_{}", idx + 1));
            let out_name = format!("{:02}_{base_stem}_cleaned.{ext}", idx + 1);
            let out_path = session_dir.join(&out_name);

            export_healed_image_native(&session_dir, &fmt, &out_path)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            exported_files.push((out_path, out_name));
        }

        if exported_files.is_empty() {
            return Err((
                StatusCode::NOT_FOUND,
                "내보낼 수 있는 세션이 없습니다. 파일을 다시 업로드해주세요.".to_string(),
            ));
        }

        let zip_file_name = format!(
            "{}SensorClean_{}_Sequence_{}.zip",
            batch_zip_prefix(&cid),
            fmt.to_ascii_uppercase(),
            now_millis()
        );
        let zip_path = state_clone.store.sessions_root.join(&zip_file_name);
        let zip_file = std::fs::File::create(&zip_path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let mut zip_writer = zip::ZipWriter::new(zip_file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for (src_path, arc_name) in &exported_files {
            if let Ok(bytes) = std::fs::read(src_path) {
                zip_writer
                    .start_file(arc_name, options)
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                zip_writer
                    .write_all(&bytes)
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            }
            let _ = std::fs::remove_file(src_path);
        }
        zip_writer
            .finish()
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let file_size_bytes = std::fs::metadata(&zip_path)
            .map(|m| m.len())
            .unwrap_or(0);
        Ok((zip_file_name, zip_path, file_size_bytes, fmt))
    })
    .await;

    match res {
        Ok(Ok((zip_file_name, zip_path, file_size_bytes, fmt_upper))) => {
            if req.prepare_only {
                let chunk_size: u64 = 4 * 1024 * 1024;
                let total_chunks = file_size_bytes.div_ceil(chunk_size).max(1);
                return Json(json!({
                    "ok": true,
                    "exportMeta": {
                        "sessionId": "__batch__",
                        "fileName": zip_file_name,
                        "downloadName": format!("SensorClean_{}_Sequence.zip", fmt_upper.to_ascii_uppercase()),
                        "mimeType": "application/zip",
                        "fileSizeBytes": file_size_bytes,
                        "chunkSize": chunk_size,
                        "totalChunks": total_chunks,
                    }
                }))
                .into_response();
            }

            let Ok(bytes) = std::fs::read(&zip_path) else {
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, "ZIP 전송 실패");
            };
            let _ = std::fs::remove_file(&zip_path);

            let mut headers = HeaderMap::new();
            headers.insert(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                HeaderValue::from_static("Content-Disposition, X-File-Name"),
            );
            headers.insert(
                "X-File-Name",
                HeaderValue::from_static("SensorClean_Cleaned_Photos.zip"),
            );
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/zip"),
            );
            headers.insert(
                header::CONTENT_DISPOSITION,
                HeaderValue::from_static("attachment; filename=\"SensorClean_Cleaned_Photos.zip\""),
            );
            (StatusCode::OK, headers, Body::from(bytes)).into_response()
        }
        Ok(Err((status, msg))) => json_error(status, msg),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn handle_python_source(State(state): State<Arc<AppState>>) -> Response {
    let py_dir = state.project_root.join("python");
    let streamlit_app = std::fs::read_to_string(py_dir.join("app.py")).unwrap_or_default();
    let raw_pipeline = std::fs::read_to_string(py_dir.join("raw_pipeline.py")).unwrap_or_default();
    let requirements = std::fs::read_to_string(py_dir.join("requirements.txt")).unwrap_or_default();

    Json(json!({
        "streamlitApp": streamlit_app,
        "rawPipeline": raw_pipeline,
        "requirements": requirements,
    }))
    .into_response()
}
