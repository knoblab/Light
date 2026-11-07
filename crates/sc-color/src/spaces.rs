//! Color space definitions, 3x3 chromatic adaptation matrices, and transfer curves.

#![forbid(unsafe_code)]

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum ColorSpace {
    Srgb,
    AdobeRgb1998,
    DisplayP3,
    ProPhotoRgb,
}

impl ColorSpace {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Srgb => "sRGB",
            Self::AdobeRgb1998 => "Adobe RGB (1998)",
            Self::DisplayP3 => "Display P3",
            Self::ProPhotoRgb => "ProPhoto RGB",
        }
    }

    /// Primary chromaticities $(x, y)$ for Red, Green, Blue and White Point.
    #[allow(clippy::type_complexity)]
    pub fn chromaticities(&self) -> ((f64, f64), (f64, f64), (f64, f64), (f64, f64)) {
        match self {
            Self::Srgb => (
                (0.6400, 0.3300), // R
                (0.3000, 0.6000), // G
                (0.1500, 0.0600), // B
                (0.3127, 0.3290), // D65
            ),
            Self::AdobeRgb1998 => (
                (0.6400, 0.3300),
                (0.2100, 0.7100),
                (0.1500, 0.0600),
                (0.3127, 0.3290),
            ),
            Self::DisplayP3 => (
                (0.6800, 0.3200),
                (0.2650, 0.6900),
                (0.1500, 0.0600),
                (0.3127, 0.3290),
            ),
            Self::ProPhotoRgb => (
                (0.7347, 0.2653),
                (0.1596, 0.8404),
                (0.0366, 0.0001),
                (0.3457, 0.3585), // D50
            ),
        }
    }

    /// Gamma exponent or transfer function description.
    pub fn gamma(&self) -> f64 {
        match self {
            Self::Srgb => 2.2, // Piecewise sRGB
            Self::AdobeRgb1998 => 2.19921875, // 2 + 51/256
            Self::DisplayP3 => 2.2,
            Self::ProPhotoRgb => 1.8,
        }
    }
}

/// Linear XYZ D50 matrix for RGB colorant tags in ICC profile.
pub fn colorant_xyz_d50(space: ColorSpace) -> [[f64; 3]; 3] {
    match space {
        ColorSpace::Srgb => [
            [0.4360747, 0.3850649, 0.1430804],
            [0.2225045, 0.7168786, 0.0606169],
            [0.0139322, 0.0971045, 0.7141733],
        ],
        ColorSpace::AdobeRgb1998 => [
            [0.6097559, 0.2052401, 0.1491920],
            [0.2982721, 0.6255975, 0.0761304],
            [0.0000000, 0.0608724, 0.7445776],
        ],
        ColorSpace::DisplayP3 => [
            [0.5151205, 0.3265370, 0.1224305],
            [0.2411985, 0.6922440, 0.0665575],
            [-0.0010529, 0.0450596, 0.6897303],
        ],
        ColorSpace::ProPhotoRgb => [
            [0.7976749, 0.1351917, 0.0313534],
            [0.2880402, 0.7118741, 0.0000857],
            [0.0000000, 0.0000000, 0.8249054],
        ],
    }
}
