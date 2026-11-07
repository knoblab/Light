//! Selective 256x256 CFA Tile Patching.
//!
//! Only tiles that intersect modified dust spot / stroke bounding boxes are recomputed,
//! while unaffected tiles are preserved bit-for-bit.

#![forbid(unsafe_code)]

use sc_heal::BBox;

pub const DEFAULT_DNG_TILE_SIZE: usize = 256;

/// Bounding box of a tile in sensor pixel coordinates.
#[inline]
pub fn tile_bbox(tx: usize, ty: usize, tile_size: usize, width: usize, height: usize) -> BBox {
    BBox {
        x0: tx * tile_size,
        y0: ty * tile_size,
        x1: ((tx + 1) * tile_size).min(width),
        y1: ((ty + 1) * tile_size).min(height),
    }
}

/// Identifies the list of linear tile indices that intersect any dirty ROI bounding box.
pub fn find_dirty_tile_indices(
    width: usize,
    height: usize,
    tile_size: usize,
    dirty_rois: &[BBox],
) -> Vec<usize> {
    if dirty_rois.is_empty() || width == 0 || height == 0 || tile_size == 0 {
        return Vec::new();
    }

    let tiles_x = width.div_ceil(tile_size);
    let tiles_y = height.div_ceil(tile_size);
    let mut dirty = Vec::new();

    for ty in 0..tiles_y {
        for tx in 0..tiles_x {
            let t_box = tile_bbox(tx, ty, tile_size, width, height);
            let intersects = dirty_rois.iter().any(|r| r.intersects(&t_box));
            if intersects {
                dirty.push(ty * tiles_x + tx);
            }
        }
    }

    dirty
}

/// Selectively patches modified tiles from `healed_cfa` into `base_cfa`.
/// Non-dirty tiles remain 100% bit-identical.
pub fn patch_cfa_tiles(
    base_cfa: &[u16],
    healed_cfa: &[u16],
    width: usize,
    height: usize,
    tile_size: usize,
    dirty_rois: &[BBox],
) -> Vec<u16> {
    let mut result = base_cfa.to_vec();
    let dirty_indices = find_dirty_tile_indices(width, height, tile_size, dirty_rois);

    let tiles_x = width.div_ceil(tile_size);

    for &idx in &dirty_indices {
        let tx = idx % tiles_x;
        let ty = idx / tiles_x;
        let t_box = tile_bbox(tx, ty, tile_size, width, height);

        for y in t_box.y0..t_box.y1 {
            let row_start = y * width;
            result[row_start + t_box.x0..row_start + t_box.x1]
                .copy_from_slice(&healed_cfa[row_start + t_box.x0..row_start + t_box.x1]);
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patches_only_intersecting_tiles() {
        let w = 512usize;
        let h = 512usize;
        let tile_size = 256usize;

        let base = vec![1000u16; w * h];
        let mut healed = vec![1000u16; w * h];

        // Heal a spot in top-left tile (100, 100)
        healed[100 * w + 100] = 9999;

        let dirty_rois = [BBox {
            x0: 90,
            y0: 90,
            x1: 110,
            y1: 110,
        }];

        let dirty_indices = find_dirty_tile_indices(w, h, tile_size, &dirty_rois);
        assert_eq!(dirty_indices, vec![0]); // Tile (0, 0) only

        let patched = patch_cfa_tiles(&base, &healed, w, h, tile_size, &dirty_rois);

        // Tile 0 pixel changed
        assert_eq!(patched[100 * w + 100], 9999);
        // Tile 1, 2, 3 must be untouched
        assert_eq!(patched[100 * w + 300], 1000);
        assert_eq!(patched[300 * w + 100], 1000);
        assert_eq!(patched[300 * w + 300], 1000);
    }
}
