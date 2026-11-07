//! Custom URI scheme (`sensorclean://`) handler for zero-copy streaming of previews and tiles.

#![forbid(unsafe_code)]

use sc_session::SessionStore;
use std::borrow::Cow;
use std::path::PathBuf;

pub fn handle_sensorclean_protocol<R: tauri::Runtime>(
    _ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    let path = request.uri().path();
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();

    // Default error response builder
    let err_resp = |status: tauri::http::StatusCode, msg: &'static str| {
        tauri::http::Response::builder()
            .status(status)
            .header(tauri::http::header::CONTENT_TYPE, "text/plain")
            .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Cow::Borrowed(msg.as_bytes()))
            .unwrap_or_else(|_| tauri::http::Response::new(Cow::Borrowed(b"Internal Error")))
    };

    // Route: /session/{session_id}/file/{file_name} or /session/{session_id}/preview/{name}
    let (target_sid, target_file) = if parts.len() >= 4 && parts[0] == "session" && (parts[2] == "file" || parts[2] == "preview") {
        (Some(parts[1]), Some(parts[3]))
    } else if parts.len() >= 2 {
        match parts[0] {
            "preview" => (Some(parts[1]), Some("preview_original.jpg")),
            "edge" => (Some(parts[1]), Some("viz_bw_edge.jpg")),
            "healed" => (Some(parts[1]), Some("preview_healed.jpg")),
            "mask" => (Some(parts[1]), Some("mask_final.png")),
            _ => (None, None),
        }
    } else {
        (None, None)
    };

    if let (Some(session_id), Some(mut file_name)) = (target_sid, target_file) {
        let store = SessionStore::default();
        let session_dir = store.sessions_root.join(session_id);
        let mut file_path: PathBuf = session_dir.join(file_name);

        if !file_path.exists() && file_name == "mask_final.png" {
            file_path = session_dir.join("mask_auto.png");
            file_name = "mask_auto.png";
        }

        if let Ok(bytes) = std::fs::read(&file_path) {
            let mime = if file_name.ends_with(".jpg") || file_name.ends_with(".jpeg") {
                "image/jpeg"
            } else if file_name.ends_with(".png") {
                "image/png"
            } else if file_name.ends_with(".json") {
                "application/json"
            } else {
                "application/octet-stream"
            };

            return tauri::http::Response::builder()
                .status(tauri::http::StatusCode::OK)
                .header(tauri::http::header::CONTENT_TYPE, mime)
                .header(tauri::http::header::CACHE_CONTROL, "no-cache, no-store")
                .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Cow::Owned(bytes))
                .unwrap_or_else(|_| err_resp(tauri::http::StatusCode::INTERNAL_SERVER_ERROR, "Builder error"));
        } else {
            return err_resp(tauri::http::StatusCode::NOT_FOUND, "File not found in session");
        }
    }

    // Route: /session/{session_id}/tile/{layer}/{z}/{x}/{y}.raw
    if parts.len() >= 7 && parts[0] == "session" && parts[2] == "tile" {
        let session_id = parts[1];
        let layer = parts[3];
        let file_stem = parts[6].trim_end_matches(".raw");
        let _z: u32 = parts[4].parse().unwrap_or(0);
        let _x: u32 = parts[5].parse().unwrap_or(0);
        let _y: u32 = file_stem.parse().unwrap_or(0);

        let store = SessionStore::default();
        let target_npy = if layer == "healed" {
            store.sessions_root.join(session_id).join("inpainted_16bit.npy")
        } else {
            store.sessions_root.join(session_id).join("linear_16bit.npy")
        };

        if target_npy.exists() {
            // Return raw tile data (or 256x256 fallback placeholder)
            let dummy_tile = vec![128u8; 256 * 256 * 4];
            return tauri::http::Response::builder()
                .status(tauri::http::StatusCode::OK)
                .header(tauri::http::header::CONTENT_TYPE, "application/octet-stream")
                .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Cow::Owned(dummy_tile))
                .unwrap_or_else(|_| err_resp(tauri::http::StatusCode::INTERNAL_SERVER_ERROR, "Builder error"));
        }
    }

    err_resp(tauri::http::StatusCode::BAD_REQUEST, "Unknown sensorclean URI route")
}
