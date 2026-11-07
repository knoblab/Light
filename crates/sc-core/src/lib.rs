//! SensorClean core domain model: `RawFrame`, `Geometry` (sensor ↔ output ↔ work coordinate
//! transforms), `DecodeKind` export policy contracts, and error types.

#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unimplemented,
    clippy::todo,
    clippy::unreachable
)]

pub mod cancel;
pub mod error;
pub mod geometry;
pub mod policy;
pub mod types;

pub use cancel::{CancelToken, NoopProgressSink, ProgressSink};
pub use error::{Result, ScError};
pub use geometry::{CropRect, Geometry, Orientation, Point2f};
pub use policy::{DNG_DISABLED_REASON, get_decode_notice, is_dng_export_allowed, validate_export_format};
pub use types::{
    BrushPoint, CfaPattern, DecodeKind, DetectedDustSpot, DetectionParams, DetectionResult,
    ExifMetadata, ExportInfo, InpaintParams, InpaintResult, ManualBrushStroke, MultiFrameCluster,
    MultiFrameConfig, MultiFrameReport, PerFrameResult, RawFrame, SessionMetadata, Stats16Bit,
};
