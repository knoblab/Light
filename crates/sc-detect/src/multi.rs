use sc_core::{
    DetectedDustSpot, MultiFrameCluster, MultiFrameReport, PerFrameResult, SessionMetadata,
};
use std::collections::BTreeSet;
use std::f64::consts::PI;

#[inline]
fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

#[inline]
fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// Spatial clustering of detected dust spots across continuous sequence frames,
/// matching `multi_detect_pipeline` in `raw_pipeline.py:1638-1770`.
pub fn cluster_multi_frame_spots(
    frames: Vec<(String, String, SessionMetadata, Vec<DetectedDustSpot>)>,
    tolerance_px: f64,
    min_frames_match: usize,
) -> MultiFrameReport {
    let total_frames = frames.len();
    let mut all_spots: Vec<(usize, DetectedDustSpot)> = Vec::new();
    for (f_idx, (_, _, _, spots)) in frames.iter().enumerate() {
        for s in spots {
            all_spots.push((f_idx, s.clone()));
        }
    }

    let mut visited = vec![false; all_spots.len()];
    let mut clusters: Vec<Vec<(usize, usize)>> = Vec::new(); // (all_spots_idx, frame_idx)

    for i in 0..all_spots.len() {
        if visited[i] {
            continue;
        }
        visited[i] = true;
        let mut cluster = vec![(i, all_spots[i].0)];
        let c1x = all_spots[i].1.cx;
        let c1y = all_spots[i].1.cy;

        for j in (i + 1)..all_spots.len() {
            if visited[j] {
                continue;
            }
            let c2x = all_spots[j].1.cx;
            let c2y = all_spots[j].1.cy;
            if (c1x - c2x).hypot(c1y - c2y) <= tolerance_px {
                visited[j] = true;
                cluster.push((j, all_spots[j].0));
            }
        }
        clusters.push(cluster);
    }

    let mut cluster_summaries: Vec<MultiFrameCluster> = Vec::with_capacity(clusters.len());
    for (c_id_zero, cl) in clusters.iter().enumerate() {
        let cluster_id = c_id_zero + 1;
        let frames_set: BTreeSet<usize> = cl.iter().map(|&(_, f_idx)| f_idx).collect();
        let frames_present: Vec<usize> = frames_set.into_iter().collect();
        let match_count = frames_present.len();
        let n = cl.len().max(1) as f64;
        let mean_cx = cl.iter().map(|&(idx, _)| all_spots[idx].1.cx).sum::<f64>() / n;
        let mean_cy = cl.iter().map(|&(idx, _)| all_spots[idx].1.cy).sum::<f64>() / n;
        let mean_r = cl.iter().map(|&(idx, _)| all_spots[idx].1.radius).sum::<f64>() / n;
        let mean_conf = cl
            .iter()
            .map(|&(idx, _)| all_spots[idx].1.confidence.unwrap_or(0.8))
            .sum::<f64>()
            / n;
        let is_multi_confirmed = match_count >= min_frames_match;

        cluster_summaries.push(MultiFrameCluster {
            cluster_id,
            match_count,
            total_frames,
            match_ratio: round3(match_count as f64 / total_frames.max(1) as f64),
            is_multi_confirmed,
            mean_cx: round1(mean_cx),
            mean_cy: round1(mean_cy),
            mean_radius: round1(mean_r),
            mean_confidence: round3(mean_conf),
            frames_present,
        });

        for &(idx, _) in cl {
            let sp = &mut all_spots[idx].1;
            sp.cluster_id = Some(cluster_id);
            sp.match_count = Some(match_count);
            sp.total_frames = Some(total_frames);
            sp.tier = Some(
                if is_multi_confirmed {
                    "multi-confirmed"
                } else {
                    "single-frame"
                }
                .to_string(),
            );
            sp.is_multi_confirmed = Some(is_multi_confirmed);
        }
    }

    let mut per_frame_spots: Vec<Vec<DetectedDustSpot>> = vec![Vec::new(); total_frames];
    for (f_idx, sp) in all_spots {
        per_frame_spots[f_idx].push(sp);
    }

    let mut per_frame_results = Vec::with_capacity(total_frames);
    for (f_idx, (session_dir, session_id, meta, _)) in frames.into_iter().enumerate() {
        let work_scale = meta.work_scale;
        let spots_in_frame = &mut per_frame_spots[f_idx];
        let present_ids: BTreeSet<usize> = spots_in_frame
            .iter()
            .filter_map(|s| s.cluster_id)
            .collect();
        let mut next_idx = spots_in_frame.len() + 1;

        for c_info in &cluster_summaries {
            if c_info.is_multi_confirmed && !present_ids.contains(&c_info.cluster_id) {
                let proj_cx = c_info.mean_cx;
                let proj_cy = c_info.mean_cy;
                let proj_r = c_info.mean_radius;
                let is_bokeh_proj = proj_r > 8.0;
                let skirt = if is_bokeh_proj { 1.82 } else { 1.60 };
                spots_in_frame.push(DetectedDustSpot {
                    id: format!("proj_{}_{}", c_info.cluster_id, f_idx),
                    index: next_idx,
                    cx: round1(proj_cx),
                    cy: round1(proj_cy),
                    work_cx: round1(proj_cx * work_scale),
                    work_cy: round1(proj_cy * work_scale),
                    radius: round1(proj_r),
                    work_radius: round1(proj_r * work_scale * skirt + 2.5),
                    area: round1(PI * proj_r * proj_r),
                    perimeter: round1(2.0 * PI * proj_r),
                    circularity: 0.95,
                    contrast_drop_pct: 1.5,
                    spot_type: Some(if is_bokeh_proj { "bokeh" } else { "sharp" }.to_string()),
                    confidence: Some(c_info.mean_confidence),
                    enabled: false,
                    is_manual: false,
                    tier: Some("projected".to_string()),
                    is_projected: Some(true),
                    is_multi_confirmed: Some(true),
                    cluster_id: Some(c_info.cluster_id),
                    match_count: Some(c_info.match_count),
                    total_frames: Some(total_frames),
                });
                next_idx += 1;
            }
        }

        let multi_confirmed_count = spots_in_frame
            .iter()
            .filter(|s| s.tier.as_deref() == Some("multi-confirmed"))
            .count();
        let single_frame_count = spots_in_frame
            .iter()
            .filter(|s| s.tier.as_deref() == Some("single-frame"))
            .count();
        let projected_count = spots_in_frame
            .iter()
            .filter(|s| s.tier.as_deref() == Some("projected"))
            .count();

        per_frame_results.push(PerFrameResult {
            session_dir,
            session_id,
            original_file_name: meta.original_file_name,
            total_detected: spots_in_frame.len(),
            spots: spots_in_frame.clone(),
            multi_confirmed_count,
            single_frame_count,
            projected_count,
        });
    }

    let multi_confirmed_clusters = cluster_summaries
        .iter()
        .filter(|c| c.is_multi_confirmed)
        .count();

    MultiFrameReport {
        total_frames,
        total_clusters: cluster_summaries.len(),
        multi_confirmed_clusters,
        clusters: cluster_summaries,
        per_frame: per_frame_results,
    }
}
