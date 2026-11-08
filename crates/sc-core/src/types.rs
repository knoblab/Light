use crate::geometry::Geometry;
use serde::{Deserialize, Serialize};

/// What the pixel data of a session really is (`src/types/sensor.ts::DecodeKind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DecodeKind {
    #[serde(rename = "raw-linear16")]
    RawLinear16,
    #[serde(rename = "raw-developed")]
    RawDeveloped,
    #[serde(rename = "image-16bit")]
    Image16bit,
    #[serde(rename = "image-8bit")]
    Image8bit,
    #[serde(rename = "embedded-preview")]
    EmbeddedPreview,
}

impl DecodeKind {
    pub fn bit_depth_label(self) -> &'static str {
        match self {
            Self::RawLinear16 => "16-bit 원본 CFA RAW 센서 데이터",
            Self::RawDeveloped => "16-bit 선형 RGB (디모자이크 현상)",
            Self::EmbeddedPreview => "8-bit 내장 미리보기 (센서 데이터 아님)",
            Self::Image16bit => "16-bit RGB",
            Self::Image8bit => "8-bit 이미지 (16-bit 선형으로 변환)",
        }
    }

    pub fn color_space_label(self) -> &'static str {
        match self {
            Self::RawLinear16 => "센서 네이티브 CFA (비디모자이크)",
            Self::RawDeveloped => "선형 RGB, sRGB 원색 (gamma 1.0)",
            Self::EmbeddedPreview => "sRGB 추정",
            Self::Image16bit => "16-bit 원본 RGB",
            Self::Image8bit => "sRGB 추정 (선형화)",
        }
    }
}

/// Colour filter array layout (2×2 Bayer or 6×6 X-Trans).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CfaPattern {
    pub width: usize,
    pub height: usize,
    /// `0 = R, 1 = G, 2 = B`, row-major.
    pub pattern: Vec<u8>,
}

impl CfaPattern {
    pub fn rggb() -> Self {
        Self {
            width: 2,
            height: 2,
            pattern: vec![0, 1, 1, 2],
        }
    }

    pub fn name(&self) -> String {
        self.pattern
            .iter()
            .map(|&c| match c {
                0 => 'R',
                1 => 'G',
                2 => 'B',
                _ => '?',
            })
            .collect()
    }

    #[inline]
    pub fn color_at(&self, x: usize, y: usize) -> u8 {
        if self.width == 0 || self.height == 0 || self.pattern.is_empty() {
            return 1;
        }
        let idx = (y % self.height) * self.width + (x % self.width);
        self.pattern.get(idx).copied().unwrap_or(1)
    }
}

/// Decoded sensor frame in memory (CFA mosaic or 3-channel 16-bit linear RGB).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RawFrame {
    pub width: usize,
    pub height: usize,
    /// 1 for CFA mosaic, 3 for RGB.
    pub cpp: usize,
    pub data: Vec<u16>,
    pub cfa: Option<CfaPattern>,
    pub black_level: [f32; 4],
    pub white_level: u32,
    pub wb_coeffs: [f32; 4],
    pub color_matrix: Vec<Vec<f32>>,
    pub geometry: Geometry,
    pub decode_kind: DecodeKind,
    pub is_raw: bool,
    pub exif: ExifMetadata,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifMetadata {
    pub make: String,
    pub model: String,
    pub iso: Option<u32>,
    pub f_number: Option<f64>,
    pub exposure_time: Option<String>,
    pub focal_length: Option<String>,
    pub date_time: Option<String>,
    pub software: String,
    #[serde(default)]
    pub raw_xmp_bytes: Vec<u8>,
}

impl Default for ExifMetadata {
    fn default() -> Self {
        Self {
            make: "Unknown".into(),
            model: "Camera Sensor".into(),
            iso: None,
            f_number: None,
            exposure_time: None,
            focal_length: None,
            date_time: None,
            software: "SensorClean Pro 16-bit Pipeline".into(),
            raw_xmp_bytes: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats16Bit {
    pub min_code_value: u32,
    pub max_code_value: u32,
    pub mean_code_value: f64,
    pub estimated_dynamic_range_ev: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub original_file_name: String,
    pub extension: String,
    pub is_raw: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decode_kind: Option<DecodeKind>,
    #[serde(default)]
    pub is_input_16_bit: bool,
    #[serde(default)]
    pub is_linear16: bool,
    pub full_width: usize,
    pub full_height: usize,
    pub work_width: usize,
    pub work_height: usize,
    pub work_scale: f64,
    pub exposure_scale: f64,
    pub bit_depth: String,
    pub color_space: String,
    pub camera_wb: Vec<f64>,
    pub color_matrix: Vec<Vec<f64>>,
    pub black_level: Vec<i64>,
    pub white_level: u32,
    pub bayer_pattern: String,
    pub stats_16_bit: Stats16Bit,
    pub exif: ExifMetadata,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_crop: Option<[usize; 4]>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionParams {
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default = "default_sensitivity")]
    pub sensitivity: f64,
    #[serde(default = "default_cloud_protection")]
    pub cloud_protection: f64,
    #[serde(default = "default_min_radius")]
    pub min_radius: f64,
    #[serde(default = "default_max_radius")]
    pub max_radius: f64,
    #[serde(default = "default_min_circularity")]
    pub min_circularity: f64,
    #[serde(default = "default_inpaint_radius")]
    pub inpaint_radius: f64,
    #[serde(default = "default_true")]
    pub preserve_grain: bool,
}

fn default_method() -> String {
    "dual".into()
}
fn default_sensitivity() -> f64 {
    68.0
}
fn default_cloud_protection() -> f64 {
    75.0
}
fn default_min_radius() -> f64 {
    2.0
}
fn default_max_radius() -> f64 {
    44.0
}
fn default_min_circularity() -> f64 {
    0.60
}
fn default_inpaint_radius() -> f64 {
    6.0
}
fn default_true() -> bool {
    true
}

impl Default for DetectionParams {
    fn default() -> Self {
        Self {
            method: default_method(),
            sensitivity: default_sensitivity(),
            cloud_protection: default_cloud_protection(),
            min_radius: default_min_radius(),
            max_radius: default_max_radius(),
            min_circularity: default_min_circularity(),
            inpaint_radius: default_inpaint_radius(),
            preserve_grain: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedDustSpot {
    pub id: String,
    pub index: usize,
    pub cx: f64,
    pub cy: f64,
    pub work_cx: f64,
    pub work_cy: f64,
    pub radius: f64,
    pub work_radius: f64,
    pub area: f64,
    pub perimeter: f64,
    pub circularity: f64,
    pub contrast_drop_pct: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spot_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub is_manual: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_multi_confirmed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_projected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster_id: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_frames: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionResult {
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default = "default_sensitivity")]
    pub sensitivity: f64,
    #[serde(default = "default_cloud_protection")]
    pub cloud_protection: f64,
    #[serde(default = "default_min_radius")]
    pub min_radius: f64,
    #[serde(default = "default_max_radius")]
    pub max_radius: f64,
    #[serde(default = "default_min_circularity")]
    pub min_circularity: f64,
    pub total_detected: usize,
    #[serde(default)]
    pub sharp_count: usize,
    #[serde(default)]
    pub bokeh_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multi_confirmed_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub single_frame_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projected_count: Option<usize>,
    pub spots: Vec<DetectedDustSpot>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct BrushPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualBrushStroke {
    pub id: String,
    pub mode: String,
    pub radius: f64,
    pub points: Vec<BrushPoint>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InpaintParams {
    #[serde(default)]
    pub spots: Vec<DetectedDustSpot>,
    #[serde(default)]
    pub manual_strokes: Vec<ManualBrushStroke>,
    #[serde(default = "default_inpaint_radius")]
    pub inpaint_radius: f64,
    #[serde(default = "default_true")]
    pub preserve_grain: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InpaintResult {
    pub healed_spots_count: usize,
    pub inpainted_pixels: usize,
    pub inpainted_area_pct: f64,
    pub bit_depth: String,
    pub inpaint_method: String,
    pub inpaint_radius: f64,
    pub full_width: usize,
    pub full_height: usize,
    #[serde(default)]
    pub from_cache: bool,
    #[serde(default)]
    pub incremental_rois: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportInfo {
    pub output_path: String,
    pub format: String,
    pub mime_type: String,
    pub file_size_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiFrameCluster {
    pub cluster_id: usize,
    pub match_count: usize,
    pub total_frames: usize,
    pub match_ratio: f64,
    pub is_multi_confirmed: bool,
    pub mean_cx: f64,
    pub mean_cy: f64,
    pub mean_radius: f64,
    pub mean_confidence: f64,
    pub frames_present: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerFrameResult {
    pub session_dir: String,
    pub session_id: String,
    pub original_file_name: String,
    pub spots: Vec<DetectedDustSpot>,
    pub total_detected: usize,
    pub multi_confirmed_count: usize,
    pub single_frame_count: usize,
    pub projected_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiFrameReport {
    pub total_frames: usize,
    pub total_clusters: usize,
    pub multi_confirmed_clusters: usize,
    pub clusters: Vec<MultiFrameCluster>,
    #[serde(default)]
    pub per_frame: Vec<PerFrameResult>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiFrameConfig {
    pub session_dirs: Vec<String>,
    #[serde(default = "default_tolerance_px")]
    pub tolerance_px: f64,
    #[serde(default = "default_min_frames_match")]
    pub min_frames_match: usize,
    #[serde(default)]
    pub detection_params: DetectionParams,
    #[serde(default)]
    pub force_redetect: bool,
}

fn default_tolerance_px() -> f64 {
    14.0
}
fn default_min_frames_match() -> usize {
    2
}
