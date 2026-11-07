//! R1 HTTP API Contract & Session Isolation Integration Tests (`sc-server`).

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use sc_tiff::tags::{self as t, compression, photometric};
use sc_tiff::{ByteOrder, IfdBuilder, ImageData, TiffWriter, Value as TiffVal};
use sc_server::{AppState, build_app};
use sc_session::SessionStore;
use serde_json::Value;
use tower::ServiceExt;

fn build_synthetic_16bit_tiff_bytes(w: u32, h: u32) -> Vec<u8> {
    let mut rgb = vec![0u16; (w as usize) * (h as usize) * 3];
    for y in 0..h as usize {
        for x in 0..w as usize {
            let dx = x as f64 - (w as f64 * 0.5);
            let dy = y as f64 - (h as f64 * 0.5);
            let d2 = dx * dx + dy * dy;
            let drop = 0.25 * (-d2 / (2.0 * 9.0 * 9.0)).exp();
            let v = (46000.0 * (1.0 - drop)).round() as u16;
            let idx = (y * (w as usize) + x) * 3;
            rgb[idx] = v;
            rgb[idx + 1] = v;
            rgb[idx + 2] = v;
        }
    }
    let mut raw_le = Vec::with_capacity(rgb.len() * 2);
    for &s in &rgb {
        raw_le.extend_from_slice(&s.to_le_bytes());
    }

    let mut ifd = IfdBuilder::new();
    ifd.set(t::IMAGE_WIDTH, TiffVal::Long(vec![w]));
    ifd.set(t::IMAGE_LENGTH, TiffVal::Long(vec![h]));
    ifd.set(t::BITS_PER_SAMPLE, TiffVal::Short(vec![16, 16, 16]));
    ifd.set(t::COMPRESSION, TiffVal::Short(vec![compression::NONE]));
    ifd.set(t::PHOTOMETRIC, TiffVal::Short(vec![photometric::RGB]));
    ifd.set(t::SAMPLES_PER_PIXEL, TiffVal::Short(vec![3]));
    ifd.set(t::PLANAR_CONFIGURATION, TiffVal::Short(vec![1]));
    ifd.set_image(ImageData::Strips {
        rows_per_strip: h,
        strips: vec![raw_le],
    });

    TiffWriter::new(ByteOrder::Little, false)
        .write(&[ifd])
        .expect("write tiff")
}

fn make_multipart_body(
    boundary: &str,
    field_name: &str,
    file_name: &str,
    bytes: &[u8],
) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"{field_name}\"; filename=\"{file_name}\"\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

#[tokio::test]
async fn r1_full_api_contract_and_cookie_session_isolation() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = SessionStore::new(tmp.path().join("sessions"), tmp.path().join("uploads"));
    let state = AppState::new(store, tmp.path().to_path_buf());
    let app = build_app(state);

    // 1. GET /api/engine-status
    let req = Request::builder()
        .uri("/api/engine-status")
        .body(Body::empty())
        .expect("req");
    let resp = app.clone().oneshot(req).await.expect("resp");
    assert_eq!(resp.status(), StatusCode::OK);

    let set_cookie = resp
        .headers()
        .get(header::SET_COOKIE)
        .expect("set-cookie header")
        .to_str()
        .expect("cookie str")
        .to_string();
    let client_a_cookie = set_cookie
        .split(';')
        .next()
        .expect("sc_client=...")
        .to_string();
    assert!(client_a_cookie.starts_with("sc_client="));

    let body_bytes = to_bytes(resp.into_body(), 1024 * 1024).await.expect("bytes");
    let status_json: Value = serde_json::from_slice(&body_bytes).expect("json");
    assert_eq!(status_json["available"], Value::Bool(true));
    assert_eq!(status_json["nativeRust"], Value::Bool(true));

    // 2. POST /api/upload with Korean filename
    let tiff_bytes = build_synthetic_16bit_tiff_bytes(320, 240);
    let boundary = "----ScBoundary123456";
    let mp_body = make_multipart_body(boundary, "file", "하늘_먼지_샘플 #1.tiff", &tiff_bytes);

    let upload_req = Request::builder()
        .method("POST")
        .uri("/api/upload")
        .header(header::COOKIE, &client_a_cookie)
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(mp_body))
        .expect("upload req");

    let upload_resp = app.clone().oneshot(upload_req).await.expect("upload resp");
    assert_eq!(upload_resp.status(), StatusCode::OK);
    let upload_json: Value = serde_json::from_slice(
        &to_bytes(upload_resp.into_body(), 10 * 1024 * 1024)
            .await
            .expect("bytes"),
    )
    .expect("json");
    assert_eq!(upload_json["success"], Value::Bool(true));
    let session_id = upload_json["sessionId"]
        .as_str()
        .expect("sessionId")
        .to_string();
    assert_eq!(upload_json["meta"]["decodeKind"], "image-16bit");

    // 3. Session isolation check: another client (client B) cannot read client A's session files
    let client_b_cookie = "sc_client=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let file_req_b = Request::builder()
        .uri(format!("/api/session/{session_id}/file/preview_original.jpg"))
        .header(header::COOKIE, client_b_cookie)
        .body(Body::empty())
        .expect("req b");
    let file_resp_b = app.clone().oneshot(file_req_b).await.expect("resp b");
    assert_eq!(file_resp_b.status(), StatusCode::NOT_FOUND);

    // Client A CAN read its own session file
    let file_req_a = Request::builder()
        .uri(format!("/api/session/{session_id}/file/preview_original.jpg"))
        .header(header::COOKIE, &client_a_cookie)
        .body(Body::empty())
        .expect("req a");
    let file_resp_a = app.clone().oneshot(file_req_a).await.expect("resp a");
    assert_eq!(file_resp_a.status(), StatusCode::OK);

    // 4. POST /api/inpaint
    let inpaint_req = Request::builder()
        .method("POST")
        .uri("/api/inpaint")
        .header(header::COOKIE, &client_a_cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "sessionId": session_id,
                "spots": upload_json["detection"]["spots"],
                "inpaintRadius": 6.0,
                "preserveGrain": true
            }))
            .expect("json vec"),
        ))
        .expect("inpaint req");
    let inpaint_resp = app.clone().oneshot(inpaint_req).await.expect("inpaint resp");
    assert_eq!(inpaint_resp.status(), StatusCode::OK);

    // 5. POST /api/export-prepare: DNG must be rejected for non-RAW image_16bit
    let exp_dng_req = Request::builder()
        .method("POST")
        .uri("/api/export-prepare")
        .header(header::COOKIE, &client_a_cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "sessionId": session_id,
                "format": "dng"
            }))
            .expect("json"),
        ))
        .expect("req");
    let exp_dng_resp = app.clone().oneshot(exp_dng_req).await.expect("resp");
    assert_eq!(exp_dng_resp.status(), StatusCode::BAD_REQUEST);

    // 6. POST /api/export-prepare: TIFF16 must succeed and preserve Korean filename stem
    let exp_tiff_req = Request::builder()
        .method("POST")
        .uri("/api/export-prepare")
        .header(header::COOKIE, &client_a_cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "sessionId": session_id,
                "format": "tiff16"
            }))
            .expect("json"),
        ))
        .expect("req");
    let exp_tiff_resp = app.clone().oneshot(exp_tiff_req).await.expect("resp");
    assert_eq!(exp_tiff_resp.status(), StatusCode::OK);
    let exp_json: Value = serde_json::from_slice(
        &to_bytes(exp_tiff_resp.into_body(), 1024 * 1024)
            .await
            .expect("bytes"),
    )
    .expect("json");
    let download_file_name = exp_json["exportMeta"]["fileName"]
        .as_str()
        .expect("exportMeta.fileName");
    assert!(
        download_file_name.contains("하늘_먼지_샘플"),
        "Korean stem should be preserved in '{download_file_name}'"
    );
    let chunk_url = exp_json["chunkBaseUrl"].as_str().expect("chunkBaseUrl");

    // 7. GET /api/export-chunk/:sessionId/:fileName
    let chunk_req = Request::builder()
        .uri(format!("{chunk_url}?offset=0&length=4096"))
        .header(header::COOKIE, &client_a_cookie)
        .body(Body::empty())
        .expect("chunk req");
    let chunk_resp = app.oneshot(chunk_req).await.expect("chunk resp");
    assert_eq!(chunk_resp.status(), StatusCode::OK);
    assert!(chunk_resp.headers().contains_key("X-Export-Total-Size"));
    assert!(chunk_resp.headers().contains_key("X-Export-Chunk-Length"));
}
