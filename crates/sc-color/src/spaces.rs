//! Color space definitions, 3x3 chromatic adaptation matrices, and transfer curves.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

/// Row-major 3×3 matrix.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Mat3(pub [[f64; 3]; 3]);

impl Mat3 {
    pub const IDENTITY: Mat3 = Mat3([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]);

    pub fn diag(a: f64, b: f64, c: f64) -> Mat3 {
        Mat3([[a, 0.0, 0.0], [0.0, b, 0.0], [0.0, 0.0, c]])
    }

    pub fn mul(&self, o: &Mat3) -> Mat3 {
        let mut r = [[0.0; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                r[i][j] = (0..3).map(|k| self.0[i][k] * o.0[k][j]).sum();
            }
        }
        Mat3(r)
    }

    pub fn apply(&self, v: [f64; 3]) -> [f64; 3] {
        let m = &self.0;
        [
            m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
            m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
            m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
        ]
    }

    pub fn apply_f32(&self, v: [f32; 3]) -> [f32; 3] {
        let r = self.apply([v[0] as f64, v[1] as f64, v[2] as f64]);
        [r[0] as f32, r[1] as f32, r[2] as f32]
    }

    pub fn determinant(&self) -> f64 {
        let m = &self.0;
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    }

    pub fn inverse(&self) -> Option<Mat3> {
        let d = self.determinant();
        if d.abs() < 1e-300 {
            return None;
        }
        let m = &self.0;
        let i = 1.0 / d;
        Some(Mat3([
            [
                (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * i,
                (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * i,
                (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * i,
            ],
            [
                (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * i,
                (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * i,
                (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * i,
            ],
            [
                (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * i,
                (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * i,
                (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * i,
            ],
        ]))
    }

    pub fn transpose(&self) -> Mat3 {
        let m = &self.0;
        Mat3([
            [m[0][0], m[1][0], m[2][0]],
            [m[0][1], m[1][1], m[2][1]],
            [m[0][2], m[1][2], m[2][2]],
        ])
    }

    pub fn to_f32(&self) -> [[f32; 3]; 3] {
        self.0.map(|r| r.map(|v| v as f32))
    }
}

/// CIE xy chromaticity.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Xy {
    pub x: f64,
    pub y: f64,
}

impl Xy {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    /// XYZ with Y = 1.
    pub fn to_xyz(self) -> [f64; 3] {
        [self.x / self.y, 1.0, (1.0 - self.x - self.y) / self.y]
    }

    pub fn from_xyz(v: [f64; 3]) -> Xy {
        let s = v[0] + v[1] + v[2];
        if s <= 0.0 {
            D65
        } else {
            Xy::new(v[0] / s, v[1] / s)
        }
    }
}

pub const D65: Xy = Xy::new(0.3127, 0.3290);
pub const D50: Xy = Xy::new(0.3457, 0.3585);

/// An RGB colour space: primaries and white point.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct RgbSpace {
    pub name: &'static str,
    pub r: Xy,
    pub g: Xy,
    pub b: Xy,
    pub white: Xy,
}

pub const SRGB: RgbSpace = RgbSpace {
    name: "sRGB",
    r: Xy::new(0.64, 0.33),
    g: Xy::new(0.30, 0.60),
    b: Xy::new(0.15, 0.06),
    white: D65,
};
pub const DISPLAY_P3: RgbSpace = RgbSpace {
    name: "Display P3",
    r: Xy::new(0.680, 0.320),
    g: Xy::new(0.265, 0.690),
    b: Xy::new(0.150, 0.060),
    white: D65,
};
pub const REC2020: RgbSpace = RgbSpace {
    name: "Rec.2020",
    r: Xy::new(0.708, 0.292),
    g: Xy::new(0.170, 0.797),
    b: Xy::new(0.131, 0.046),
    white: D65,
};
pub const PROPHOTO: RgbSpace = RgbSpace {
    name: "ProPhoto RGB",
    r: Xy::new(0.734699, 0.265301),
    g: Xy::new(0.159597, 0.840403),
    b: Xy::new(0.036598, 0.000105),
    white: D50,
};
pub const ADOBE_RGB: RgbSpace = RgbSpace {
    name: "Adobe RGB (1998) compatible",
    r: Xy::new(0.64, 0.33),
    g: Xy::new(0.21, 0.71),
    b: Xy::new(0.15, 0.06),
    white: D65,
};
pub const WORKING: RgbSpace = REC2020;

impl RgbSpace {
    pub fn to_xyz(&self) -> Mat3 {
        let p = [self.r.to_xyz(), self.g.to_xyz(), self.b.to_xyz()];
        let m = Mat3([
            [p[0][0], p[1][0], p[2][0]],
            [p[0][1], p[1][1], p[2][1]],
            [p[0][2], p[1][2], p[2][2]],
        ]);
        let s = m
            .inverse()
            .map_or([1.0; 3], |inv| inv.apply(self.white.to_xyz()));
        m.mul(&Mat3::diag(s[0], s[1], s[2]))
    }

    pub fn from_xyz(&self) -> Mat3 {
        self.to_xyz().inverse().unwrap_or(Mat3::IDENTITY)
    }

    pub fn luma(&self) -> [f64; 3] {
        self.to_xyz().0[1]
    }

    pub fn to_space(&self, dst: &RgbSpace) -> Mat3 {
        let adapt = bradford(self.white, dst.white);
        dst.from_xyz().mul(&adapt).mul(&self.to_xyz())
    }
}

/// The Bradford cone-response matrix (XYZ → sharpened cones) that [`bradford`] adapts in.
pub const BRADFORD: Mat3 = Mat3([
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
]);

/// Bradford chromatic adaptation matrix (XYZ → XYZ) from white `src` to white `dst`.
pub fn bradford(src: Xy, dst: Xy) -> Mat3 {
    if src == dst {
        return Mat3::IDENTITY;
    }
    let s = BRADFORD.apply(src.to_xyz());
    let d = BRADFORD.apply(dst.to_xyz());
    let Some(inv) = BRADFORD.inverse() else {
        return Mat3::IDENTITY;
    };
    inv.mul(&Mat3::diag(d[0] / s[0], d[1] / s[1], d[2] / s[2]))
        .mul(&BRADFORD)
}

pub const LUMA_2020: [f32; 3] = [0.2627, 0.6780, 0.0593];
pub const LUMA_709: [f32; 3] = [0.2126, 0.7152, 0.0722];

#[inline]
pub fn luminance_2020(c: [f32; 3]) -> f32 {
    c[0] * LUMA_2020[0] + c[1] * LUMA_2020[1] + c[2] * LUMA_2020[2]
}

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
            Self::Srgb => 2.2,             // Piecewise sRGB
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
