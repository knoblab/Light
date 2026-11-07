use crate::types::{DecodeKind, SessionMetadata};

pub const DNG_DISABLED_REASON: &str =
    "RAW 센서 데이터가 아닌 이미지는 DNG로 내보낼 수 없습니다. TIFF 또는 PNG를 사용해 주세요.";

/// DNG output is only offered when the session holds real RAW-derived 16-bit data.
/// Matches `src/engine/exportPolicy.ts::isDngExportAllowed` and `server.ts::validateExportFormat`.
pub fn is_dng_export_allowed(meta: &SessionMetadata) -> bool {
    match meta.decode_kind {
        Some(DecodeKind::RawLinear16 | DecodeKind::RawDeveloped) => true,
        None => meta.is_raw,
        Some(DecodeKind::Image16bit | DecodeKind::Image8bit | DecodeKind::EmbeddedPreview) => false,
    }
}

/// User-facing notice about how the file was decoded, matching `src/engine/exportPolicy.ts::getDecodeNotice`.
pub fn get_decode_notice(meta: &SessionMetadata) -> Option<&'static str> {
    match meta.decode_kind {
        Some(DecodeKind::EmbeddedPreview) => Some(
            "이 RAW의 센서 데이터를 읽지 못해 카메라 내장 미리보기(8-bit JPEG)로 열렸습니다. 검출·복원은 미리보기 화질 기준이며 DNG 내보내기는 사용할 수 없습니다. 전체 RAW 처리는 Python 엔진(npm run setup:python)이 필요합니다.",
        ),
        Some(DecodeKind::RawDeveloped) => Some(
            "RAW를 LibRaw로 현상(디모자이크)한 선형 RGB 데이터로 작업 중입니다. 내보낸 DNG는 원본 RAW가 아니라 현상된 선형 RGB 이미지입니다.",
        ),
        _ => None,
    }
}

/// Validates export format string (`dng`, `tiff16`, `png`, `jpg`, `xmp`) against session metadata.
/// Returns `Ok((ext, suffix, mime_type))` or an `Err(user_message)` matching `server.ts::validateExportFormat`.
pub fn validate_export_format(
    fmt_key: &str,
    meta: &SessionMetadata,
) -> std::result::Result<(&'static str, &'static str, &'static str), String> {
    let spec = match fmt_key.to_ascii_lowercase().as_str() {
        "dng" => ("dng", "_cleaned_linear16", "image/x-adobe-dng"),
        "tiff16" => ("tiff", "_cleaned_16bit", "image/tiff"),
        "png" => ("png", "_cleaned_srgb", "image/png"),
        "jpg" => ("jpg", "_cleaned_srgb", "image/jpeg"),
        "xmp" => ("xmp", "", "application/rdf+xml"),
        other => return Err(format!("지원하지 않는 내보내기 형식입니다: {other}")),
    };

    if spec.0 == "dng" && !is_dng_export_allowed(meta) {
        return Err(DNG_DISABLED_REASON.to_string());
    }

    Ok(spec)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ExifMetadata, Stats16Bit};

    fn dummy_meta(is_raw: bool, decode_kind: Option<DecodeKind>) -> SessionMetadata {
        SessionMetadata {
            original_file_name: "test.rw2".into(),
            extension: "RW2".into(),
            is_raw,
            decode_kind,
            is_input_16_bit: false,
            is_linear16: true,
            full_width: 1800,
            full_height: 1200,
            work_width: 1800,
            work_height: 1200,
            work_scale: 1.0,
            exposure_scale: 1.0,
            bit_depth: "16-bit".into(),
            color_space: "RGB".into(),
            camera_wb: vec![1.0, 1.0, 1.0, 1.0],
            color_matrix: vec![],
            black_level: vec![0, 0, 0, 0],
            white_level: 65535,
            bayer_pattern: "RGGB".into(),
            stats_16_bit: Stats16Bit::default(),
            exif: ExifMetadata::default(),
        }
    }

    #[test]
    fn dng_export_policy_matches_ts_and_server() {
        assert!(is_dng_export_allowed(&dummy_meta(true, Some(DecodeKind::RawLinear16))));
        assert!(is_dng_export_allowed(&dummy_meta(true, Some(DecodeKind::RawDeveloped))));
        assert!(is_dng_export_allowed(&dummy_meta(true, None)));

        assert!(!is_dng_export_allowed(&dummy_meta(true, Some(DecodeKind::EmbeddedPreview))));
        assert!(!is_dng_export_allowed(&dummy_meta(false, Some(DecodeKind::Image8bit))));
        assert!(!is_dng_export_allowed(&dummy_meta(false, Some(DecodeKind::Image16bit))));

        let preview_meta = dummy_meta(true, Some(DecodeKind::EmbeddedPreview));
        assert_eq!(
            validate_export_format("dng", &preview_meta),
            Err(DNG_DISABLED_REASON.to_string())
        );
        assert!(validate_export_format("tiff16", &preview_meta).is_ok());
        assert!(validate_export_format("png", &preview_meta).is_ok());
        assert!(validate_export_format("jpg", &preview_meta).is_ok());
        assert!(validate_export_format("gif", &preview_meta).is_err());
    }
}
