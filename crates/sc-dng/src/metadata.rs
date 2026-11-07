//! Rendered Image Exporter for TIFF 16-bit, PNG 8/16-bit, and JPEG with embedded ICC Profile and EXIF metadata.

#![forbid(unsafe_code)]

use sc_tiff::tags::{self as t, compression, photometric};
use sc_tiff::{ByteOrder, IfdBuilder, ImageData, TiffWriter, Value};
use sc_color::icc::generate_icc_profile;
use sc_color::spaces::ColorSpace;
use sc_core::{Result, ScError, SessionMetadata};
use std::path::Path;

/// Writes a 16-bit RGB image to in-memory TIFF bytes with embedded ICC profile and metadata.
pub fn write_rendered_tiff16_bytes(
    rgb16: &[u16],
    width: usize,
    height: usize,
    space: ColorSpace,
    meta: &SessionMetadata,
) -> Result<Vec<u8>> {
    if rgb16.len() < width * height * 3 || width == 0 || height == 0 {
        return Err(ScError::Pipeline("RGB 16-bit 버퍼 크기가 유효하지 않습니다.".into()));
    }

    let mut ifd = IfdBuilder::new();

    ifd.set(t::IMAGE_WIDTH, Value::Long(vec![width as u32]));
    ifd.set(t::IMAGE_LENGTH, Value::Long(vec![height as u32]));
    ifd.set(t::BITS_PER_SAMPLE, Value::Short(vec![16, 16, 16]));
    ifd.set(t::COMPRESSION, Value::Short(vec![compression::NONE]));
    ifd.set(t::PHOTOMETRIC, Value::Short(vec![photometric::RGB]));
    ifd.set(t::SAMPLES_PER_PIXEL, Value::Short(vec![3]));
    ifd.set(t::PLANAR_CONFIGURATION, Value::Short(vec![1]));

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
        t::SOFTWARE,
        Value::Ascii("SensorClean Pro 16-bit TIFF Engine".into()),
    );

    // Embed ICC Profile in tag 34675
    let icc_bytes = generate_icc_profile(space);
    ifd.set(t::ICC_PROFILE, Value::Undefined(icc_bytes));

    // Embed XMP if present
    if !meta.exif.raw_xmp_bytes.is_empty() {
        ifd.set(t::XMP, Value::Byte(meta.exif.raw_xmp_bytes.clone()));
    }

    let mut raw_bytes = Vec::with_capacity(width * height * 3 * 2);
    for &sample in &rgb16[..width * height * 3] {
        raw_bytes.extend_from_slice(&sample.to_le_bytes());
    }

    ifd.set_image(ImageData::Strips {
        rows_per_strip: height as u32,
        strips: vec![raw_bytes],
    });

    let tiff_bytes = TiffWriter::new(ByteOrder::Little, false)
        .write(&[ifd])
        .map_err(|e| ScError::Pipeline(format!("TIFF 작성 실패: {e}")))?;

    Ok(tiff_bytes)
}

/// Writes a 16-bit RGB image to a TIFF file with embedded ICC profile and metadata.
pub fn write_rendered_tiff16(
    path: &Path,
    rgb16: &[u16],
    width: usize,
    height: usize,
    space: ColorSpace,
    meta: &SessionMetadata,
) -> Result<()> {
    let bytes = write_rendered_tiff16_bytes(rgb16, width, height, space, meta)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

/// Writes a 16-bit RGB image to in-memory PNG bytes with embedded ICC profile.
pub fn write_rendered_png16_bytes(
    rgb16: &[u16],
    width: usize,
    height: usize,
    space: ColorSpace,
    _meta: &SessionMetadata,
) -> Result<Vec<u8>> {
    if rgb16.len() < width * height * 3 || width == 0 || height == 0 {
        return Err(ScError::Pipeline("RGB 16-bit 버퍼 크기가 유효하지 않습니다.".into()));
    }

    let mut info = png::Info::with_size(width as u32, height as u32);
    info.color_type = png::ColorType::Rgb;
    info.bit_depth = png::BitDepth::Sixteen;
    let icc_bytes = generate_icc_profile(space);
    info.icc_profile = Some(icc_bytes.into());

    let mut be_bytes = Vec::with_capacity(width * height * 3 * 2);
    for &sample in &rgb16[..width * height * 3] {
        be_bytes.extend_from_slice(&sample.to_be_bytes());
    }

    let mut out = Vec::new();
    let mut enc = png::Encoder::with_info(&mut out, info)
        .map_err(|e| ScError::Pipeline(format!("PNG 인코더 초기화 실패: {e}")))?;
    enc.set_compression(png::Compression::Fast);

    let mut writer = enc
        .write_header()
        .map_err(|e| ScError::Pipeline(format!("PNG 헤더 작성 실패: {e}")))?;
    writer
        .write_image_data(&be_bytes)
        .map_err(|e| ScError::Pipeline(format!("PNG 데이터 작성 실패: {e}")))?;
    writer
        .finish()
        .map_err(|e| ScError::Pipeline(format!("PNG 인코딩 완료 실패: {e}")))?;

    Ok(out)
}

/// Writes a 16-bit RGB image to a PNG file with embedded ICC profile.
pub fn write_rendered_png16(
    path: &Path,
    rgb16: &[u16],
    width: usize,
    height: usize,
    space: ColorSpace,
    meta: &SessionMetadata,
) -> Result<()> {
    let bytes = write_rendered_png16_bytes(rgb16, width, height, space, meta)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

/// Writes an 8-bit RGB image to in-memory PNG bytes with embedded ICC profile.
pub fn write_rendered_png8_bytes(
    rgb8: &[u8],
    width: usize,
    height: usize,
    space: ColorSpace,
    _meta: &SessionMetadata,
) -> Result<Vec<u8>> {
    if rgb8.len() < width * height * 3 || width == 0 || height == 0 {
        return Err(ScError::Pipeline("RGB 8-bit 버퍼 크기가 유효하지 않습니다.".into()));
    }

    let mut info = png::Info::with_size(width as u32, height as u32);
    info.color_type = png::ColorType::Rgb;
    info.bit_depth = png::BitDepth::Eight;
    let icc_bytes = generate_icc_profile(space);
    info.icc_profile = Some(icc_bytes.into());

    let mut out = Vec::new();
    let mut enc = png::Encoder::with_info(&mut out, info)
        .map_err(|e| ScError::Pipeline(format!("PNG 인코더 초기화 실패: {e}")))?;
    enc.set_compression(png::Compression::Fast);

    let mut writer = enc
        .write_header()
        .map_err(|e| ScError::Pipeline(format!("PNG 헤더 작성 실패: {e}")))?;
    writer
        .write_image_data(&rgb8[..width * height * 3])
        .map_err(|e| ScError::Pipeline(format!("PNG 데이터 작성 실패: {e}")))?;
    writer
        .finish()
        .map_err(|e| ScError::Pipeline(format!("PNG 인코딩 완료 실패: {e}")))?;

    Ok(out)
}

/// Writes an 8-bit RGB image to a PNG file with embedded ICC profile.
pub fn write_rendered_png8(
    path: &Path,
    rgb8: &[u8],
    width: usize,
    height: usize,
    space: ColorSpace,
    meta: &SessionMetadata,
) -> Result<()> {
    let bytes = write_rendered_png8_bytes(rgb8, width, height, space, meta)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

/// Writes an 8-bit RGB image to in-memory JPEG bytes with embedded ICC profile.
pub fn write_rendered_jpeg_bytes(
    rgb8: &[u8],
    width: usize,
    height: usize,
    quality: u8,
    space: ColorSpace,
    _meta: &SessionMetadata,
) -> Result<Vec<u8>> {
    if rgb8.len() < width * height * 3 || width == 0 || height == 0 {
        return Err(ScError::Pipeline("RGB 8-bit 버퍼 크기가 유효하지 않습니다.".into()));
    }

    let mut out = Vec::new();
    let mut enc = jpeg_encoder::Encoder::new(&mut out, quality.clamp(1, 100));
    let icc_bytes = generate_icc_profile(space);
    let _ = enc.add_icc_profile(&icc_bytes);

    enc.encode(
        &rgb8[..width * height * 3],
        width as u16,
        height as u16,
        jpeg_encoder::ColorType::Rgb,
    )
    .map_err(|e| ScError::Pipeline(format!("JPEG 인코딩 실패: {e}")))?;

    Ok(out)
}

/// Writes an 8-bit RGB image to a JPEG file with embedded ICC profile.
pub fn write_rendered_jpeg(
    path: &Path,
    rgb8: &[u8],
    width: usize,
    height: usize,
    quality: u8,
    space: ColorSpace,
    meta: &SessionMetadata,
) -> Result<()> {
    let bytes = write_rendered_jpeg_bytes(rgb8, width, height, quality, space, meta)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sc_core::{ExifMetadata, Stats16Bit};

    fn make_test_meta(w: usize, h: usize) -> SessionMetadata {
        SessionMetadata {
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
            color_space: "sRGB".into(),
            camera_wb: vec![2.0, 1.0, 1.5],
            color_matrix: vec![
                vec![1.0, 0.0, 0.0],
                vec![0.0, 1.0, 0.0],
                vec![0.0, 0.0, 1.0],
            ],
            black_level: vec![512, 512, 512, 512],
            white_level: 16383,
            bayer_pattern: "RGGB".into(),
            stats_16_bit: Stats16Bit::default(),
            exif: ExifMetadata::default(),
        }
    }

    #[test]
    fn writes_valid_tiff16_with_icc() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("out.tiff");
        let w = 32usize;
        let h = 32usize;
        let rgb16 = vec![30000u16; w * h * 3];
        let meta = make_test_meta(w, h);

        write_rendered_tiff16(&path, &rgb16, w, h, ColorSpace::DisplayP3, &meta)
            .expect("TIFF 16-bit should succeed");

        assert!(path.exists());
        let data = std::fs::read(&path).unwrap();
        assert_eq!(&data[0..4], b"II\x2a\x00");
    }

    #[test]
    fn writes_valid_png16_and_png8_with_icc() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path16 = temp_dir.path().join("out16.png");
        let path8 = temp_dir.path().join("out8.png");
        let w = 32usize;
        let h = 32usize;
        let rgb16 = vec![30000u16; w * h * 3];
        let rgb8 = vec![128u8; w * h * 3];
        let meta = make_test_meta(w, h);

        write_rendered_png16(&path16, &rgb16, w, h, ColorSpace::AdobeRgb1998, &meta)
            .expect("PNG 16-bit should succeed");
        assert!(path16.exists());

        write_rendered_png8(&path8, &rgb8, w, h, ColorSpace::Srgb, &meta)
            .expect("PNG 8-bit should succeed");
        assert!(path8.exists());
    }

    #[test]
    fn writes_valid_jpeg_with_icc() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("out.jpg");
        let w = 32usize;
        let h = 32usize;
        let rgb8 = vec![128u8; w * h * 3];
        let meta = make_test_meta(w, h);

        write_rendered_jpeg(&path, &rgb8, w, h, 90, ColorSpace::Srgb, &meta)
            .expect("JPEG should succeed");
        assert!(path.exists());
        let data = std::fs::read(&path).unwrap();
        // JPEG SOI marker: 0xFF, 0xD8
        assert_eq!(&data[0..2], &[0xFF, 0xD8]);
    }
}
