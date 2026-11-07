//! Rayon Parallel 1024x1024 Tile Detection with 64px Halo and Scratch Buffer Pool.
//!
//! Enables high-throughput, low-memory dust detection on ultra-high resolution
//! sensors (45MP–100MP+) while eliminating tile boundary artifacts via halo overlap and NMS.

#![forbid(unsafe_code)]

use sc_core::DetectedDustSpot;

pub const DEFAULT_TILE_SIZE: usize = 1024;
pub const DEFAULT_HALO: usize = 64;

/// Specification of a single tiled region with halo margin.
#[derive(Clone, Copy, Debug)]
pub struct TileSpec {
    pub tile_idx: usize,
    /// Absolute top-left coordinate including halo.
    pub x0: usize,
    pub y0: usize,
    /// Absolute bottom-right coordinate including halo (exclusive).
    pub x1: usize,
    pub y1: usize,
    /// Core boundary (where detections are authoritative without halo duplication).
    pub core_x0: usize,
    pub core_y0: usize,
    pub core_x1: usize,
    pub core_y1: usize,
}

/// Generates tile specifications covering a $W \times H$ sensor image.
pub fn generate_tile_specs(
    width: usize,
    height: usize,
    tile_size: usize,
    halo: usize,
) -> Vec<TileSpec> {
    if width == 0 || height == 0 || tile_size == 0 {
        return Vec::new();
    }

    let step = tile_size.saturating_sub(halo * 2).max(1);
    let mut specs = Vec::new();
    let mut tile_idx = 0;

    let mut cy = 0usize;
    while cy < height {
        let core_y0 = cy;
        let core_y1 = (cy + step).min(height);
        let y0 = core_y0.saturating_sub(halo);
        let y1 = (core_y1 + halo).min(height);

        let mut cx = 0usize;
        while cx < width {
            let core_x0 = cx;
            let core_x1 = (cx + step).min(width);
            let x0 = core_x0.saturating_sub(halo);
            let x1 = (core_x1 + halo).min(width);

            specs.push(TileSpec {
                tile_idx,
                x0,
                y0,
                x1,
                y1,
                core_x0,
                core_y0,
                core_x1,
                core_y1,
            });

            tile_idx += 1;
            cx += step;
        }

        cy += step;
    }

    specs
}

/// Extracts a tile's sub-image from full image into a flat buffer.
pub fn extract_tile_buffer(
    src: &[f32],
    src_w: usize,
    spec: &TileSpec,
) -> (Vec<f32>, usize, usize) {
    let tw = spec.x1 - spec.x0;
    let th = spec.y1 - spec.y0;
    let mut tile_buf = vec![0.0f32; tw * th];

    for y in 0..th {
        let src_row = (spec.y0 + y) * src_w;
        let dst_row = y * tw;
        tile_buf[dst_row..dst_row + tw]
            .copy_from_slice(&src[src_row + spec.x0..src_row + spec.x1]);
    }

    (tile_buf, tw, th)
}

/// Deduplicates candidates located in overlapping tile boundary margins.
pub fn deduplicate_tile_candidates(
    mut candidates: Vec<DetectedDustSpot>,
    distance_threshold: f64,
) -> Vec<DetectedDustSpot> {
    if candidates.len() <= 1 {
        return candidates;
    }

    // Sort by confidence or contrast drop descending
    candidates.sort_by(|a, b| {
        let conf_a = a.confidence.unwrap_or(0.5);
        let conf_b = b.confidence.unwrap_or(0.5);
        conf_b.total_cmp(&conf_a)
    });

    let mut retained = Vec::new();

    for cand in candidates {
        let is_duplicate = retained.iter().any(|r: &DetectedDustSpot| {
            (r.cx - cand.cx).hypot(r.cy - cand.cy) <= distance_threshold
        });
        if !is_duplicate {
            retained.push(cand);
        }
    }

    // Re-index remaining spots
    for (i, sp) in retained.iter_mut().enumerate() {
        sp.index = i + 1;
    }

    retained
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiles_cover_entire_frame() {
        let w = 2000usize;
        let h = 1500usize;
        let specs = generate_tile_specs(w, h, 1024, 64);
        assert!(!specs.is_empty());

        // Verify that every pixel is covered by at least one core
        let mut covered = vec![false; w * h];
        for s in &specs {
            for y in s.core_y0..s.core_y1 {
                for x in s.core_x0..s.core_x1 {
                    covered[y * w + x] = true;
                }
            }
        }
        assert!(covered.iter().all(|&c| c));
    }
}
