use crate::annulus::AnnulusGrids;

/// Reusable scratch buffer pool for detection pipeline to eliminate heap churn.
pub struct DetectionWorkspace {
    pub gray_filt: Vec<f32>,
    pub valid_photo_mask: Vec<bool>,
    pub s1: Vec<f32>,
    pub g8: Vec<f32>,
    pub denoise_det: Vec<f32>,
    pub s1_masked: Vec<f32>,
    pub denoise_masked: Vec<f32>,
    pub bg_mean_22: Vec<f32>,
    pub bg_diff_sq: Vec<f32>,
    pub bg_sq_22: Vec<f32>,
    pub bg_std_map: Vec<f32>,
    pub hf_diff_clamped: Vec<f32>,
    pub hf_texture: Vec<f32>,
    pub grad_mag: Vec<f32>,
    pub bm_sharp: Vec<u8>,
    pub combined_vis_det: Vec<f32>,
    pub dx_buf: Vec<f32>,
    pub dy_buf: Vec<f32>,
    pub tmp_det: Vec<f32>,

    // Bokeh pyramid buffers
    pub denoise_pyr: Vec<f32>,
    pub quiet_sky_mask: Vec<bool>,
    pub quiet_sky_pyr: Vec<bool>,
    pub max_z_pyr: Vec<f32>,
    pub best_c_pyr: Vec<f32>,
    pub bokeh_best_idx_pyr: Vec<usize>,
    pub bokeh_max_z_pyr: Vec<f32>,
    pub bokeh_max_z: Vec<f32>,
    pub local_max_pyr: Vec<f32>,
    pub pyr_scratch_a: Vec<f32>,
    pub pyr_scratch_b: Vec<f32>,
    pub pyr_scratch_c: Vec<f32>,

    // Reusable outputs
    pub mask_auto_u8: Vec<u8>,
    pub viz_bw_edge_rgb: Vec<u8>,

    // Annulus grids cache
    pub grids: AnnulusGrids,
}

impl Default for DetectionWorkspace {
    fn default() -> Self {
        Self::new()
    }
}

impl DetectionWorkspace {
    pub fn new() -> Self {
        Self {
            gray_filt: Vec::new(),
            valid_photo_mask: Vec::new(),
            s1: Vec::new(),
            g8: Vec::new(),
            denoise_det: Vec::new(),
            s1_masked: Vec::new(),
            denoise_masked: Vec::new(),
            bg_mean_22: Vec::new(),
            bg_diff_sq: Vec::new(),
            bg_sq_22: Vec::new(),
            bg_std_map: Vec::new(),
            hf_diff_clamped: Vec::new(),
            hf_texture: Vec::new(),
            grad_mag: Vec::new(),
            bm_sharp: Vec::new(),
            combined_vis_det: Vec::new(),
            dx_buf: Vec::new(),
            dy_buf: Vec::new(),
            tmp_det: Vec::new(),

            denoise_pyr: Vec::new(),
            quiet_sky_mask: Vec::new(),
            quiet_sky_pyr: Vec::new(),
            max_z_pyr: Vec::new(),
            best_c_pyr: Vec::new(),
            bokeh_best_idx_pyr: Vec::new(),
            bokeh_max_z_pyr: Vec::new(),
            bokeh_max_z: Vec::new(),
            local_max_pyr: Vec::new(),
            pyr_scratch_a: Vec::new(),
            pyr_scratch_b: Vec::new(),
            pyr_scratch_c: Vec::new(),

            mask_auto_u8: Vec::new(),
            viz_bw_edge_rgb: Vec::new(),

            grids: AnnulusGrids::new(),
        }
    }

    /// Pre-allocates or resizes scratch buffers to match target dimensions.
    /// If dimensions match, no memory reallocations occur.
    pub fn prepare_for_dims(
        &mut self,
        det_w: usize,
        det_h: usize,
        pyr_w: usize,
        pyr_h: usize,
        work_w: usize,
        work_h: usize,
    ) {
        let n_det = det_w * det_h;
        let n_pyr = pyr_w * pyr_h;
        let n_work = work_w * work_h;

        if self.gray_filt.len() != n_det {
            self.gray_filt.resize(n_det, 0.0);
            self.valid_photo_mask.resize(n_det, false);
            self.s1.resize(n_det, 0.0);
            self.g8.resize(n_det, 0.0);
            self.denoise_det.resize(n_det, 0.0);
            self.s1_masked.resize(n_det, 0.0);
            self.denoise_masked.resize(n_det, 0.0);
            self.bg_mean_22.resize(n_det, 0.0);
            self.bg_diff_sq.resize(n_det, 0.0);
            self.bg_sq_22.resize(n_det, 0.0);
            self.bg_std_map.resize(n_det, 0.0);
            self.hf_diff_clamped.resize(n_det, 0.0);
            self.hf_texture.resize(n_det, 0.0);
            self.grad_mag.resize(n_det, 0.0);
            self.bm_sharp.resize(n_det, 0);
            self.combined_vis_det.resize(n_det, 0.0);
            self.dx_buf.resize(n_det, 0.0);
            self.dy_buf.resize(n_det, 0.0);
            self.tmp_det.resize(n_det, 0.0);
            self.quiet_sky_mask.resize(n_det, false);
            self.bokeh_max_z.resize(n_det, 0.0);
        }

        if self.denoise_pyr.len() != n_pyr {
            self.denoise_pyr.resize(n_pyr, 0.0);
            self.quiet_sky_pyr.resize(n_pyr, false);
            self.max_z_pyr.resize(n_pyr, 0.0);
            self.best_c_pyr.resize(n_pyr, 0.0);
            self.bokeh_best_idx_pyr.resize(n_pyr, 0);
            self.bokeh_max_z_pyr.resize(n_pyr, 0.0);
            self.local_max_pyr.resize(n_pyr, 0.0);
            self.pyr_scratch_a.resize(n_pyr, 0.0);
            self.pyr_scratch_b.resize(n_pyr, 0.0);
            self.pyr_scratch_c.resize(n_pyr, 0.0);
        }

        if self.mask_auto_u8.len() != n_work {
            self.mask_auto_u8.resize(n_work, 0);
        }
        if self.viz_bw_edge_rgb.len() != n_work * 3 {
            self.viz_bw_edge_rgb.resize(n_work * 3, 0);
        }
    }
}
