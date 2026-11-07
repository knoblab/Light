//! Android Mobile optimizations and memory budgeting.
//!
//! Enforces peak RAM <= 512MB by streaming CFA tiles on-demand and avoiding
//! unnecessary 3-channel RGB u16 in-memory copies on mobile devices.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceClass {
    Desktop,
    Tablet,
    MobilePhone,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileMemoryBudget {
    pub max_preview_dimension: usize,
    pub max_in_memory_tiles: usize,
    pub tile_size: usize,
    pub use_half_cfa_stream: bool,
}

impl Default for MobileMemoryBudget {
    fn default() -> Self {
        #[cfg(mobile)]
        {
            Self {
                max_preview_dimension: 1920,
                max_in_memory_tiles: 16,
                tile_size: 256,
                use_half_cfa_stream: true,
            }
        }
        #[cfg(not(mobile))]
        {
            Self {
                max_preview_dimension: 2304,
                max_in_memory_tiles: 64,
                tile_size: 256,
                use_half_cfa_stream: false,
            }
        }
    }
}

/// Helper for Android Storage Access Framework (SAF) URI conversion.
pub fn is_android_content_uri(path_or_uri: &str) -> bool {
    path_or_uri.starts_with("content://")
}
