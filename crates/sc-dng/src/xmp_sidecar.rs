//! Adobe Lightroom / Camera Raw Compatible XMP Sidecar Generator.
//!
//! Exports dust spots and brush strokes into standard `crs:RetouchAreas` XML
//! with optimal clean-source offset search in the surrounding sensor area.

#![forbid(unsafe_code)]

use sc_core::{DetectedDustSpot, ManualBrushStroke, Result, ScError};
use std::path::Path;

/// Finds an optimal clean source patch offset `(src_x, src_y)` in the ring surrounding a dust spot.
/// Evaluates candidate offsets in 8 directions at distance $2.5 \times r$ from `(cx, cy)`.
pub fn search_clean_source_offset(
    cfa: &[u16],
    width: usize,
    height: usize,
    cx: f64,
    cy: f64,
    radius: f64,
) -> (f64, f64) {
    let offset_dist = (radius * 2.8).max(12.0);
    let inv_sqrt2 = std::f64::consts::FRAC_1_SQRT_2;
    let dirs = [
        (1.0, 0.0),
        (-1.0, 0.0),
        (0.0, 1.0),
        (0.0, -1.0),
        (inv_sqrt2, inv_sqrt2),
        (-inv_sqrt2, inv_sqrt2),
        (inv_sqrt2, -inv_sqrt2),
        (-inv_sqrt2, -inv_sqrt2),
    ];

    let mut best_dir = dirs[0];
    let mut min_var = f64::INFINITY;

    let sample_r = (radius * 0.5).round().max(2.0) as usize;

    for (dx, dy) in dirs {
        let cand_x = cx + dx * offset_dist;
        let cand_y = cy + dy * offset_dist;

        let ix = cand_x.round() as isize;
        let iy = cand_y.round() as isize;

        // Ensure candidate circle is within image frame with margin
        let margin = sample_r as isize + 2;
        if ix - margin < 0
            || ix + margin >= width as isize
            || iy - margin < 0
            || iy + margin >= height as isize
        {
            continue;
        }

        // Measure local variance in candidate patch
        let mut sum = 0.0f64;
        let mut sum_sq = 0.0f64;
        let mut count = 0usize;

        for sy in (iy - sample_r as isize)..=(iy + sample_r as isize) {
            for sx in (ix - sample_r as isize)..=(ix + sample_r as isize) {
                let val = cfa[sy as usize * width + sx as usize] as f64;
                sum += val;
                sum_sq += val * val;
                count += 1;
            }
        }

        if count > 0 {
            let mean = sum / count as f64;
            let var = (sum_sq / count as f64) - mean * mean;
            if var < min_var {
                min_var = var;
                best_dir = (dx, dy);
            }
        }
    }

    (cx + best_dir.0 * offset_dist, cy + best_dir.1 * offset_dist)
}

/// Generates Adobe Lightroom / ACR compatible XMP XML content with `crs:RetouchAreas`.
pub fn generate_xmp_sidecar_xml(
    cfa: &[u16],
    width: usize,
    height: usize,
    spots: &[DetectedDustSpot],
    _strokes: &[ManualBrushStroke],
) -> String {
    let inv_w = 1.0 / width.max(1) as f64;
    let inv_h = 1.0 / height.max(1) as f64;

    let mut retouch_entries = String::new();

    for spot in spots {
        if !spot.enabled {
            continue;
        }

        let (src_x, src_y) =
            search_clean_source_offset(cfa, width, height, spot.cx, spot.cy, spot.radius);

        let norm_cx = spot.cx * inv_w;
        let norm_cy = spot.cy * inv_h;
        let norm_src_x = src_x * inv_w;
        let norm_src_y = src_y * inv_h;
        let norm_r = spot.radius * inv_w;
        let feather = 0.50f64;

        retouch_entries.push_str(&format!(
            r#"            <rdf:li rdf:parseType="Resource">
              <crs:SpotType>Heal</crs:SpotType>
              <crs:SourceState>SourceSetExplicitly</crs:SourceState>
              <crs:Method>Alpha</crs:Method>
              <crs:SourceX>{norm_src_x:.6}</crs:SourceX>
              <crs:SourceY>{norm_src_y:.6}</crs:SourceY>
              <crs:OffsetY>0.000000</crs:OffsetY>
              <crs:Opacity>1.000000</crs:Opacity>
              <crs:Feather>{feather:.6}</crs:Feather>
              <crs:Seed>42</crs:Seed>
              <crs:Mask>
                <rdf:Seq>
                  <rdf:li>
                    <crs:MaskValue>1.000000</crs:MaskValue>
                    <crs:X>{norm_cx:.6}</crs:X>
                    <crs:Y>{norm_cy:.6}</crs:Y>
                    <crs:SizeX>{norm_r:.6}</crs:SizeX>
                    <crs:SizeY>{norm_r:.6}</crs:SizeY>
                    <crs:Angle>0.000000</crs:Angle>
                    <crs:Alpha>0.000000</crs:Alpha>
                    <crs:CenterWeight>1.000000</crs:CenterWeight>
                  </rdf:li>
                </rdf:Seq>
              </crs:Mask>
            </rdf:li>
"#
        ));
    }

    format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="SensorClean Pro Engine">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">
      <crs:HasSettings>True</crs:HasSettings>
      <crs:AlreadyApplied>False</crs:AlreadyApplied>
      <crs:RetouchAreas>
        <rdf:Seq>
{retouch_entries}        </rdf:Seq>
      </crs:RetouchAreas>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
"#
    )
}

/// Writes an `.xmp` sidecar file alongside the specified raw path.
pub fn write_xmp_sidecar(
    path: &Path,
    cfa: &[u16],
    width: usize,
    height: usize,
    spots: &[DetectedDustSpot],
    strokes: &[ManualBrushStroke],
) -> Result<()> {
    let xml = generate_xmp_sidecar_xml(cfa, width, height, spots, strokes);
    std::fs::write(path, xml)
        .map_err(|e| ScError::Pipeline(format!("XMP 사이드카 저장 실패: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_well_formed_lightroom_xmp() {
        let w = 100usize;
        let h = 100usize;
        let cfa = vec![1000u16; w * h];

        let spot = DetectedDustSpot {
            id: "spot_1".into(),
            index: 0,
            cx: 50.0,
            cy: 50.0,
            work_cx: 0.0,
            work_cy: 0.0,
            radius: 5.0,
            work_radius: 0.0,
            area: 78.5,
            perimeter: 31.4,
            circularity: 0.95,
            contrast_drop_pct: 15.0,
            spot_type: Some("dust".into()),
            confidence: Some(0.95),
            enabled: true,
            is_manual: false,
            tier: None,
            is_multi_confirmed: None,
            is_projected: None,
            cluster_id: None,
            match_count: None,
            total_frames: None,
        };

        let xml = generate_xmp_sidecar_xml(&cfa, w, h, &[spot], &[]);
        assert!(xml.contains("<x:xmpmeta"));
        assert!(xml.contains("<crs:RetouchAreas>"));
        assert!(xml.contains("<crs:SpotType>Heal</crs:SpotType>"));
        assert!(xml.contains("<crs:SourceX>"));
        assert!(xml.contains("<crs:X>0.500000</crs:X>"));
        assert!(xml.contains("<crs:Y>0.500000</crs:Y>"));
    }
}
