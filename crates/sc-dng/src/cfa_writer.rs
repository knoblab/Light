//! Pure-Rust CFA DNG 1.6 Writer using `lightcraft-tiff`.
//!
//! Writes non-demosaiced CFA sensor RAW data into standards-compliant DNG 1.6 files
//! with full camera color matrices, black/white levels, and metadata preservation.

#![forbid(unsafe_code)]

use lightcraft_tiff::tags::{self as t, compression, photometric};
use lightcraft_tiff::{ByteOrder, IfdBuilder, ImageData, TiffWriter, Value};
use sc_core::{Result, ScError, SessionMetadata};
use std::path::Path;

/// Writes a 16-bit CFA mosaic buffer to in-memory DNG 1.6 bytes.
pub fn write_cfa_dng_bytes(
    cfa: &[u16],
    width: usize,
    height: usize,
    meta: &SessionMetadata,
) -> Result<Vec<u8>> {
    if cfa.len() < width * height || width == 0 || height == 0 {
        return Err(ScError::Pipeline("CFA 버퍼 크기가 유효하지 않습니다.".into()));
    }

    let mut ifd = IfdBuilder::new();

    // Basic Image Dimensions & Structure
    ifd.set(t::IMAGE_WIDTH, Value::Long(vec![width as u32]));
    ifd.set(t::IMAGE_LENGTH, Value::Long(vec![height as u32]));
    ifd.set(t::BITS_PER_SAMPLE, Value::Short(vec![16]));
    ifd.set(t::COMPRESSION, Value::Short(vec![compression::NONE]));
    ifd.set(
        t::PHOTOMETRIC,
        Value::Short(vec![photometric::CFA]),
    );
    ifd.set(t::SAMPLES_PER_PIXEL, Value::Short(vec![1]));
    ifd.set(t::PLANAR_CONFIGURATION, Value::Short(vec![1]));
    ifd.set(t::NEW_SUBFILE_TYPE, Value::Long(vec![0]));

    // DNG Specification Versions (DNG 1.6.0.0, backwards compatible to 1.3.0.0)
    ifd.set(t::DNG_VERSION, Value::Byte(vec![1, 6, 0, 0]));
    ifd.set(t::DNG_BACKWARD_VERSION, Value::Byte(vec![1, 3, 0, 0]));

    // CFA Pattern (2x2 Bayer)
    ifd.set(t::CFA_REPEAT_PATTERN_DIM, Value::Short(vec![2, 2]));
    // Map bayer pattern string to DNG pattern bytes: 0=R, 1=G, 2=B
    let cfa_pattern_bytes = match meta.bayer_pattern.to_ascii_uppercase().as_str() {
        "BGGR" => vec![2, 1, 1, 0],
        "GRBG" => vec![1, 0, 2, 1],
        "GBRG" => vec![1, 2, 0, 1],
        _ => vec![0, 1, 1, 2], // RGGB default
    };
    ifd.set(t::CFA_PATTERN_EP, Value::Byte(cfa_pattern_bytes));
    ifd.set(t::CFA_PLANE_COLOR, Value::Byte(vec![0, 1, 2]));
    ifd.set(t::CFA_LAYOUT, Value::Short(vec![1])); // 1 = Rectangular

    // Camera Make / Model / Unique Model
    let make = if meta.exif.make.is_empty() {
        "SensorClean"
    } else {
        &meta.exif.make
    };
    let model = if meta.exif.model.is_empty() {
        "Camera Sensor"
    } else {
        &meta.exif.model
    };
    ifd.set(t::MAKE, Value::Ascii(make.into()));
    ifd.set(t::MODEL, Value::Ascii(model.into()));
    ifd.set(
        t::UNIQUE_CAMERA_MODEL,
        Value::Ascii(format!("{make} {model}")),
    );
    ifd.set(
        t::SOFTWARE,
        Value::Ascii("SensorClean Pro CFA Raw Engine".into()),
    );

    // Black & White Levels
    let bl = if meta.black_level.is_empty() {
        vec![0, 0, 0, 0]
    } else {
        meta.black_level.iter().map(|&v| v as u32).collect()
    };
    ifd.set(t::BLACK_LEVEL, Value::Long(bl));

    let wl = if meta.white_level == 0 {
        65535
    } else {
        meta.white_level
    };
    ifd.set(t::WHITE_LEVEL, Value::Long(vec![wl]));

    // White Balance & Color Matrices
    if meta.camera_wb.len() >= 3 {
        let wb_num: Vec<u32> = meta
            .camera_wb
            .iter()
            .take(3)
            .map(|&v| (v * 10000.0).round() as u32)
            .collect();
        let mut wb_rats = Vec::new();
        for &num in &wb_num {
            wb_rats.push((num, 10000));
        }
        ifd.set(t::AS_SHOT_NEUTRAL, Value::Rational(wb_rats));
    }

    if meta.color_matrix.len() >= 3 && meta.color_matrix[0].len() >= 3 {
        let mut cm_rats = Vec::new();
        for row in meta.color_matrix.iter().take(3) {
            for &val in row.iter().take(3) {
                let fixed = (val * 10000.0).round() as i32;
                cm_rats.push((fixed, 10000));
            }
        }
        ifd.set(t::COLOR_MATRIX_1, Value::SRational(cm_rats));
        ifd.set(t::CALIBRATION_ILLUMINANT_1, Value::Short(vec![17])); // 17 = Standard Light A
    }

    // Default Crop Area
    ifd.set(t::DEFAULT_CROP_ORIGIN, Value::Short(vec![0, 0]));
    ifd.set(
        t::DEFAULT_CROP_SIZE,
        Value::Short(vec![width as u16, height as u16]),
    );

    // Embed XMP metadata if provided
    if !meta.exif.raw_xmp_bytes.is_empty() {
        ifd.set(t::XMP, Value::Byte(meta.exif.raw_xmp_bytes.clone()));
    }

    // Convert raw 16-bit CFA to little-endian bytes
    let mut raw_bytes = Vec::with_capacity(width * height * 2);
    for &sample in cfa {
        raw_bytes.extend_from_slice(&sample.to_le_bytes());
    }

    // Set strip data (single strip for CFA RAW image)
    ifd.set_image(ImageData::Strips {
        rows_per_strip: height as u32,
        strips: vec![raw_bytes],
    });

    let tiff_bytes = TiffWriter::new(ByteOrder::Little, false)
        .write(&[ifd])
        .map_err(|e| ScError::Pipeline(format!("DNG 작성 실패: {e}")))?;

    Ok(tiff_bytes)
}

/// Writes a 16-bit CFA mosaic buffer to a DNG 1.6 file.
pub fn write_cfa_dng(
    path: &Path,
    cfa: &[u16],
    width: usize,
    height: usize,
    meta: &SessionMetadata,
) -> Result<()> {
    let bytes = write_cfa_dng_bytes(cfa, width, height, meta)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sc_core::{ExifMetadata, Stats16Bit};

    #[test]
    fn writes_valid_cfa_dng_file() {
        let temp_dir = tempfile::tempdir().unwrap();
        let dng_path = temp_dir.path().join("test_cfa.dng");

        let w = 64usize;
        let h = 64usize;
        let cfa = vec![2048u16; w * h];

        let meta = SessionMetadata {
            original_file_name: "test.raw".into(),
            extension: "dng".into(),
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
            color_space: "Raw".into(),
            camera_wb: vec![2.0, 1.0, 1.5],
            color_matrix: vec![
                vec![1.0, 0.0, 0.0],
                vec![0.0, 1.0, 0.0],
                vec![0.0, 0.0, 1.0],
            ],
            black_level: vec![512, 512, 512, 512],
            white_level: 16383,
            bayer_pattern: "RGGB".into(),
            stats_16_bit: Stats16Bit {
                min_code_value: 512,
                max_code_value: 16383,
                mean_code_value: 2048.0,
                estimated_dynamic_range_ev: 12.0,
            },
            exif: ExifMetadata::default(),
        };

        write_cfa_dng(&dng_path, &cfa, w, h, &meta).expect("write_cfa_dng should succeed");

        assert!(dng_path.exists());
        let data = std::fs::read(&dng_path).unwrap();
        assert!(data.len() > w * h * 2);
        // TIFF magic header: "II\x2a\x00" (little endian)
        assert_eq!(&data[0..4], b"II\x2a\x00");
    }
}
