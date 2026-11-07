//! `sc-dng`: Production CFA DNG 1.6 Writer, Tile Patcher, Sidecar Generator, and Rendered Exporter.

#![forbid(unsafe_code)]

pub mod cfa_writer;
pub mod metadata;
pub mod tile_patch;
pub mod xmp_sidecar;

pub use cfa_writer::{write_cfa_dng, write_cfa_dng_bytes};
pub use metadata::{
    write_rendered_jpeg, write_rendered_jpeg_bytes, write_rendered_png16,
    write_rendered_png16_bytes, write_rendered_png8, write_rendered_png8_bytes,
    write_rendered_tiff16, write_rendered_tiff16_bytes,
};
pub use tile_patch::{find_dirty_tile_indices, patch_cfa_tiles, tile_bbox, DEFAULT_DNG_TILE_SIZE};
pub use xmp_sidecar::{generate_xmp_sidecar_xml, search_clean_source_offset, write_xmp_sidecar};
