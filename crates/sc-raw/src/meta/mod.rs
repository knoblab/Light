//! EXIF and TIFF metadata extraction for SensorClean.

use sc_core::ExifMetadata;
use sc_tiff::{Ifd, Tiff, tags as t};

pub mod cr3;
pub mod mrw;

pub fn write_xmp(_meta: &Metadata, _xmp: Option<&str>) -> String {
    String::new()
}

fn text(ifd: Option<&Ifd>, tag: u16) -> Option<String> {
    let s = ifd?.string(tag)?;
    let s = s.trim().to_string();
    (!s.is_empty() && !s.bytes().all(|b| b == b' ' || b == 0)).then_some(s)
}

fn pos(v: Option<f64>) -> Option<f64> {
    v.filter(|x| x.is_finite() && *x > 0.0)
}

use sc_core::Orientation;
use serde::{Deserialize, Serialize};

/// Simple metadata struct matching raw decoding requirements.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Metadata {
    pub make: Option<String>,
    pub model: Option<String>,
    pub serial_number: Option<String>,
    pub software: Option<String>,
    pub lens_make: Option<String>,
    pub lens_model: Option<String>,
    pub lens_serial_number: Option<String>,
    pub capture_time: Option<String>,
    pub exposure_time: Option<f64>,
    pub f_number: Option<f64>,
    pub iso: Option<u32>,
    pub focal_length: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub orientation: Option<Orientation>,
}

impl Metadata {
    pub fn to_exif_metadata(&self) -> ExifMetadata {
        let exposure_time = self.exposure_time.map(|et| {
            if et > 0.0 && et < 1.0 {
                format!("1/{}s", (1.0 / et).round() as u32)
            } else {
                format!("{:.2}s", et)
            }
        });
        let focal_length = self.focal_length.map(|fl| format!("{:.1}mm", fl));
        let f_number = self.f_number.map(|fn_val| (fn_val * 10.0).round() / 10.0);

        ExifMetadata {
            make: self.make.clone().unwrap_or_else(|| "Unknown".into()),
            model: self.model.clone().unwrap_or_else(|| "Camera Sensor".into()),
            iso: self.iso,
            f_number,
            exposure_time,
            focal_length,
            date_time: self.capture_time.clone(),
            software: self
                .software
                .clone()
                .unwrap_or_else(|| "SensorClean Pro".into()),
            raw_xmp_bytes: Vec::new(),
        }
    }
}

/// Extract metadata from a parsed TIFF stream.
pub fn from_tiff(tiff: &Tiff) -> Metadata {
    let ifd0 = tiff.ifds.first();
    let exif = tiff.exif();
    let either = |tag: u16| exif.and_then(|e| e.value(tag)).or_else(|| ifd0.and_then(|i| i.value(tag)));

    let exposure_time = pos(either(t::EXPOSURE_TIME).and_then(|v| v.get_f64(0)))
        .or_else(|| exif.and_then(|e| e.f64(t::SHUTTER_SPEED_VALUE)).filter(|v| v.abs() < 64.0).map(|tv| 2f64.powf(-tv)));
    let f_number = pos(either(t::F_NUMBER).and_then(|v| v.get_f64(0)))
        .or_else(|| exif.and_then(|e| e.f64(t::APERTURE_VALUE)).filter(|v| v.abs() < 64.0).map(|av| 2f64.powf(av / 2.0)));
    let iso = either(t::ISO_SPEED).and_then(|v| v.get_u64(0)).filter(|&v| v > 0);
    let iso_ext = exif.and_then(|e| e.u64(t::RECOMMENDED_EXPOSURE_INDEX).or_else(|| e.u64(t::ISO_SPEED_RATINGS_EXT))).filter(|&v| v > 0);
    let iso = match (iso, iso_ext) {
        (Some(65535), Some(x)) | (None, Some(x)) => Some(x),
        (Some(v), _) => Some(v),
        _ => None,
    }
    .map(|v| v.min(u32::MAX as u64) as u32);
    let focal_length = pos(either(t::FOCAL_LENGTH).and_then(|v| v.get_f64(0)));

    let capture_time = text(exif, t::DATE_TIME_ORIGINAL)
        .or_else(|| text(exif, t::DATE_TIME_DIGITIZED))
        .or_else(|| text(ifd0, t::DATE_TIME));

    Metadata {
        make: text(ifd0, t::MAKE),
        model: text(ifd0, t::MODEL).or_else(|| text(ifd0, t::UNIQUE_CAMERA_MODEL)),
        software: text(ifd0, t::SOFTWARE),
        serial_number: text(exif, t::BODY_SERIAL_NUMBER).or_else(|| text(ifd0, t::CAMERA_SERIAL_NUMBER)),
        lens_make: text(exif, t::LENS_MAKE),
        lens_model: text(exif, t::LENS_MODEL),
        lens_serial_number: text(exif, t::LENS_SERIAL_NUMBER),
        capture_time,
        exposure_time,
        f_number,
        iso,
        focal_length,
        width: exif.and_then(|e| e.u32(t::PIXEL_X_DIMENSION)).or_else(|| ifd0.and_then(|i| i.u32(t::IMAGE_WIDTH))),
        height: exif.and_then(|e| e.u32(t::PIXEL_Y_DIMENSION)).or_else(|| ifd0.and_then(|i| i.u32(t::IMAGE_LENGTH))),
        orientation: ifd0.and_then(|i| i.u16(t::ORIENTATION)).filter(|v| (1..=8).contains(v)).map(Orientation::from_exif),
    }
}

/// Extract metadata from raw bytes (TIFF / EXIF / CR3 / MRW).
pub fn extract(bytes: &[u8]) -> Metadata {
    if let Some(c) = cr3::parse_cr3(bytes) {
        if let Some(exif_bytes) = cr3::merged_exif(&c) {
            if let Ok(tiff) = Tiff::parse(&exif_bytes) {
                return from_tiff(&tiff);
            }
        }
    }
    if let Some(m) = mrw::parse(bytes) {
        if let Some(ttw) = m.block(b"TTW") {
            if let Ok(tiff) = Tiff::parse(ttw) {
                return from_tiff(&tiff);
            }
        }
    }
    if let Ok(tiff) = Tiff::parse(bytes) {
        from_tiff(&tiff)
    } else {
        Metadata::default()
    }
}
