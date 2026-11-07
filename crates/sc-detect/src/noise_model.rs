//! Dual-Stream Poisson-Gaussian Sensor Noise Modeling & Dimensionless SNR Estimation.
//!
//! Models sensor noise variance as $\sigma^2(y) = a \cdot y + b$ across the intensity range,
//! providing dimensionless $\sigma$-normalized SNR thresholds that preserve high sensitivity
//! at low ISO without exploding false alarms at high ISO (up to ISO 12,800).

#![forbid(unsafe_code)]

/// Poisson-Gaussian Noise Model parameters $\sigma^2(y) = a \cdot y + b$.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NoiseModel {
    /// Shot noise slope coefficient $a$.
    pub a: f32,
    /// Read noise variance offset $b$.
    pub b: f32,
    /// Camera ISO sensitivity.
    pub iso: u32,
}

impl Default for NoiseModel {
    fn default() -> Self {
        Self {
            a: 0.25,
            b: 16.0,
            iso: 100,
        }
    }
}

impl NoiseModel {
    /// Creates a prior noise model from camera ISO.
    pub fn from_iso(iso_val: Option<u32>) -> Self {
        let iso = iso_val.unwrap_or(100).clamp(50, 102400);
        let ratio = iso as f32 / 100.0;
        let a = (0.20 * ratio).max(0.10);
        let b = (12.0 * ratio * ratio.sqrt()).max(8.0);
        Self { a, b, iso }
    }

    /// Evaluates the expected standard deviation at local background intensity $y \in [0.0..=65535.0]$.
    #[inline]
    pub fn sigma_at(&self, y: f32) -> f32 {
        let var = (self.a * y.max(0.0) + self.b).max(1.0);
        var.sqrt()
    }

    /// Computes dimensionless $\sigma$-normalized SNR for an intensity attenuation $\Delta y$ at background $y_{bg}$.
    #[inline]
    pub fn compute_snr(&self, y_bg: f32, delta_y: f32) -> f32 {
        let sigma = self.sigma_at(y_bg);
        delta_y / sigma
    }

    /// Fits noise model parameters $(a, b)$ from image luminance samples using weighted least squares (WLS).
    pub fn fit_from_samples(y_samples: &[f32], local_mad_samples: &[f32], iso_hint: Option<u32>) -> Self {
        if y_samples.is_empty() || y_samples.len() != local_mad_samples.len() {
            return Self::from_iso(iso_hint);
        }

        let n = y_samples.len();
        if n < 10 {
            return Self::from_iso(iso_hint);
        }

        // Prepare (y, sigma^2) pairs
        let mut sum_w = 0.0f64;
        let mut sum_wx = 0.0f64;
        let mut sum_wy = 0.0f64;
        let mut sum_wxx = 0.0f64;
        let mut sum_wxy = 0.0f64;

        for i in 0..n {
            let y = y_samples[i] as f64;
            let mad = local_mad_samples[i] as f64;
            let var = (mad * 1.4826).powi(2); // Normal distribution MAD -> std -> var

            // Weight inversely proportional to variance estimate stability
            let w = 1.0;
            sum_w += w;
            sum_wx += w * y;
            sum_wy += w * var;
            sum_wxx += w * y * y;
            sum_wxy += w * y * var;
        }

        let denom = sum_w * sum_wxx - sum_wx * sum_wx;
        if denom.abs() < 1e-9 {
            return Self::from_iso(iso_hint);
        }

        let a = ((sum_w * sum_wxy - sum_wx * sum_wy) / denom) as f32;
        let b = ((sum_wy * sum_wxx - sum_wx * sum_wxy) / denom) as f32;

        let prior = Self::from_iso(iso_hint);

        // Regularize against ISO prior
        let fitted_a = if a > 0.01 && a < 50.0 {
            0.7 * a + 0.3 * prior.a
        } else {
            prior.a
        };

        let fitted_b = if b > 1.0 && b < 100000.0 {
            0.7 * b + 0.3 * prior.b
        } else {
            prior.b
        };

        Self {
            a: fitted_a,
            b: fitted_b,
            iso: prior.iso,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_model_iso_prior_scales_sensibly() {
        let m100 = NoiseModel::from_iso(Some(100));
        let m6400 = NoiseModel::from_iso(Some(6400));

        assert!(m6400.a > m100.a * 10.0);
        assert!(m6400.b > m100.b * 10.0);

        let s100 = m100.sigma_at(10000.0);
        let s6400 = m6400.sigma_at(10000.0);
        assert!(s6400 > s100 * 5.0);

        // At 500 ADU drop, SNR at ISO 100 is strong, while at ISO 6400 it's moderate
        let snr100 = m100.compute_snr(10000.0, 500.0);
        let snr6400 = m6400.compute_snr(10000.0, 500.0);
        assert!(snr100 > snr6400);
        assert!(snr100 > 8.0);
    }
}
