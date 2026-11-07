//! Half-size CFA 4-Channel Extraction and Direct Luminance / Delta-G Noise Channel.
//!
//! Extracts non-demosaiced Bayer raw at half-resolution without interpolation artifacts,
//! computing the base luminance stream and green-split discriminator stream.

#![forbid(unsafe_code)]

/// Extracted half-size dual-stream representation of a CFA RAW image.
#[derive(Clone, Debug)]
pub struct CfaHalfStreams {
    /// Half-width ($W / 2$).
    pub width: usize,
    /// Half-height ($H / 2$).
    pub height: usize,
    /// Perceptual luminance $Y_{cfa} \in [0.0..=65535.0]$ ($W_{half} \times H_{half}$).
    pub luma: Vec<f32>,
    /// High-frequency green split magnitude $\Delta G = |G_1 - G_2|$ ($W_{half} \times H_{half}$).
    /// Used as a texture/edge discriminator to suppress false positives on sharp scene features.
    pub delta_g: Vec<f32>,
}

/// Bayer CFA pattern layout for half-size 2x2 extraction.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum BayerLayout {
    Rggb,
    Bggr,
    Grbg,
    Gbrg,
}

impl BayerLayout {
    pub fn from_bayer_str(s: &str) -> Self {
        match s.to_ascii_uppercase().as_str() {
            "BGGR" => Self::Bggr,
            "GRBG" => Self::Grbg,
            "GBRG" => Self::Gbrg,
            _ => Self::Rggb,
        }
    }
}

/// Extracts half-resolution luminance and $\Delta G$ streams from a 16-bit CFA mosaic buffer.
pub fn extract_cfa_half_streams(
    cfa: &[u16],
    full_w: usize,
    full_h: usize,
    layout: BayerLayout,
) -> CfaHalfStreams {
    let half_w = full_w / 2;
    let half_h = full_h / 2;
    let n_pixels = half_w * half_h;

    let mut luma = vec![0.0f32; n_pixels];
    let mut delta_g = vec![0.0f32; n_pixels];

    if full_w < 2 || full_h < 2 || cfa.len() < full_w * full_h {
        return CfaHalfStreams {
            width: half_w,
            height: half_h,
            luma,
            delta_g,
        };
    }

    for hy in 0..half_h {
        let y0 = hy * 2;
        let y1 = y0 + 1;
        let row0 = y0 * full_w;
        let row1 = y1 * full_w;
        let out_row = hy * half_w;

        for hx in 0..half_w {
            let x0 = hx * 2;
            let x1 = x0 + 1;

            let p00 = cfa[row0 + x0] as f32;
            let p10 = cfa[row0 + x1] as f32;
            let p01 = cfa[row1 + x0] as f32;
            let p11 = cfa[row1 + x1] as f32;

            let (r, g1, g2, b) = match layout {
                BayerLayout::Rggb => (p00, p10, p01, p11),
                BayerLayout::Bggr => (p11, p01, p10, p00),
                BayerLayout::Grbg => (p10, p00, p11, p01),
                BayerLayout::Gbrg => (p01, p11, p00, p10),
            };

            let g_avg = 0.5 * (g1 + g2);
            let y = 0.2126 * r + 0.7152 * g_avg + 0.0722 * b;
            let dg = (g1 - g2).abs();

            let out_idx = out_row + hx;
            luma[out_idx] = y;
            delta_g[out_idx] = dg;
        }
    }

    CfaHalfStreams {
        width: half_w,
        height: half_h,
        luma,
        delta_g,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_half_streams_rggb() {
        let w = 4usize;
        let h = 4usize;
        // RGGB 2x2
        // R=1000, G1=2000
        // G2=2020, B=3000
        let mut cfa = vec![0u16; w * h];
        for y in 0..h {
            for x in 0..w {
                let is_y_odd = y % 2 == 1;
                let is_x_odd = x % 2 == 1;
                let val = match (is_y_odd, is_x_odd) {
                    (false, false) => 1000,
                    (false, true) => 2000,
                    (true, false) => 2020,
                    (true, true) => 3000,
                };
                cfa[y * w + x] = val;
            }
        }

        let streams = extract_cfa_half_streams(&cfa, w, h, BayerLayout::Rggb);
        assert_eq!(streams.width, 2);
        assert_eq!(streams.height, 2);

        // Delta G should be |2000 - 2020| = 20
        assert!((streams.delta_g[0] - 20.0).abs() < 1e-3);
        // Luma ~ 0.2126*1000 + 0.7152*2010 + 0.0722*3000 = 212.6 + 1437.552 + 216.6 = 1866.752
        assert!((streams.luma[0] - 1866.752).abs() < 1.0);
    }
}
