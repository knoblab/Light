use serde::{Deserialize, Serialize};

/// 2D floating-point coordinate in pixels (or normalized `[0, 1]` space).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Point2f {
    pub x: f64,
    pub y: f64,
}

impl Point2f {
    #[inline]
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    #[inline]
    pub fn distance_to(self, other: Self) -> f64 {
        (self.x - other.x).hypot(self.y - other.y)
    }
}

/// Integer pixel rectangle (top-left `(x, y)` and `(width, height)`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CropRect {
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
}

impl CropRect {
    #[inline]
    pub const fn new(x: usize, y: usize, width: usize, height: usize) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    #[inline]
    pub fn clipped(self, max_w: usize, max_h: usize) -> Self {
        let x = self.x.min(max_w);
        let y = self.y.min(max_h);
        Self {
            x,
            y,
            width: self.width.min(max_w.saturating_sub(x)),
            height: self.height.min(max_h.saturating_sub(y)),
        }
    }
}

/// EXIF Orientation tag values (1..=8).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Orientation {
    #[default]
    Normal = 1,
    FlipHorizontal = 2,
    Rotate180 = 3,
    FlipVertical = 4,
    Transpose = 5,
    Rotate90Cw = 6,
    Transverse = 7,
    Rotate270Cw = 8,
}

#[allow(non_upper_case_globals)]
impl Orientation {
    pub const FlipH: Self = Self::FlipHorizontal;
    pub const FlipV: Self = Self::FlipVertical;
    pub const Rotate90: Self = Self::Rotate90Cw;
    pub const Rotate270: Self = Self::Rotate270Cw;

    pub fn from_exif(code: u16) -> Self {
        match code {
            2 => Self::FlipHorizontal,
            3 => Self::Rotate180,
            4 => Self::FlipVertical,
            5 => Self::Transpose,
            6 => Self::Rotate90Cw,
            7 => Self::Transverse,
            8 => Self::Rotate270Cw,
            _ => Self::Normal,
        }
    }

    pub fn to_exif(self) -> u16 {
        self as u16
    }

    /// Decompose into `(flip_horizontal, quarter_turns_cw)`.
    pub fn to_parts(self) -> (bool, u8) {
        match self {
            Self::Normal => (false, 0),
            Self::Rotate90Cw => (false, 1),
            Self::Rotate180 => (false, 2),
            Self::Rotate270Cw => (false, 3),
            Self::FlipHorizontal => (true, 0),
            Self::Transverse => (true, 1),
            Self::FlipVertical => (true, 2),
            Self::Transpose => (true, 3),
        }
    }

    pub fn from_parts(flip: bool, quarter_turns_cw: u8) -> Self {
        match (flip, quarter_turns_cw % 4) {
            (false, 0) => Self::Normal,
            (false, 1) => Self::Rotate90Cw,
            (false, 2) => Self::Rotate180,
            (false, _) => Self::Rotate270Cw,
            (true, 0) => Self::FlipHorizontal,
            (true, 1) => Self::Transverse,
            (true, 2) => Self::FlipVertical,
            (true, _) => Self::Transpose,
        }
    }

    /// Whether the orientation swaps width and height.
    pub fn swaps_axes(self) -> bool {
        matches!(
            self,
            Self::Transpose | Self::Rotate90Cw | Self::Transverse | Self::Rotate270Cw
        )
    }

    /// Inverse orientation.
    pub fn inverse(self) -> Self {
        match self {
            Self::Rotate90Cw => Self::Rotate270Cw,
            Self::Rotate270Cw => Self::Rotate90Cw,
            other => other,
        }
    }

    /// Map a point in stored pixel space (w x h) to oriented space.
    pub fn map(self, x: f64, y: f64, w: f64, h: f64) -> (f64, f64) {
        let (flip, t) = self.to_parts();
        let (mut x, y2, mut w2, mut h2) = (x, y, w, h);
        if flip {
            x = w2 - x;
        }
        let mut y = y2;
        for _ in 0..t {
            let nx = h2 - y;
            let ny = x;
            x = nx;
            y = ny;
            std::mem::swap(&mut w2, &mut h2);
        }
        (x, y)
    }

    /// Dimensions `(width, height)` after applying orientation to `(w, h)`.
    pub fn oriented_size(self, w: usize, h: usize) -> (usize, usize) {
        if self.swaps_axes() { (h, w) } else { (w, h) }
    }

    /// Maps continuous pixel coordinates `(x, y)` inside an unoriented `(w, h)` frame
    /// (where pixel centers are at integer coordinates `0 .. w-1`, so the continuous
    /// span is `[0, w - 1]`) into the oriented frame.
    #[inline]
    pub fn apply(self, x: f64, y: f64, w: usize, h: usize) -> Point2f {
        let wf = (w.max(1) - 1) as f64;
        let hf = (h.max(1) - 1) as f64;
        match self {
            Self::Normal => Point2f::new(x, y),
            Self::FlipHorizontal => Point2f::new(wf - x, y),
            Self::Rotate180 => Point2f::new(wf - x, hf - y),
            Self::FlipVertical => Point2f::new(x, hf - y),
            Self::Transpose => Point2f::new(y, x),
            Self::Rotate90Cw => Point2f::new(hf - y, x),
            Self::Transverse => Point2f::new(hf - y, wf - x),
            Self::Rotate270Cw => Point2f::new(y, wf - x),
        }
    }

    /// Inverse of [`Self::apply`]: maps oriented coordinates `(ox, oy)` back to the
    /// unoriented `(w, h)` frame.
    #[inline]
    pub fn unapply(self, ox: f64, oy: f64, w: usize, h: usize) -> Point2f {
        let wf = (w.max(1) - 1) as f64;
        let hf = (h.max(1) - 1) as f64;
        match self {
            Self::Normal => Point2f::new(ox, oy),
            Self::FlipHorizontal => Point2f::new(wf - ox, oy),
            Self::Rotate180 => Point2f::new(wf - ox, hf - oy),
            Self::FlipVertical => Point2f::new(ox, hf - oy),
            Self::Transpose => Point2f::new(oy, ox),
            Self::Rotate90Cw => Point2f::new(oy, hf - ox),
            Self::Transverse => Point2f::new(wf - oy, hf - ox),
            Self::Rotate270Cw => Point2f::new(wf - oy, ox),
        }
    }
}

/// Unified coordinate transform between:
/// 1. **Sensor (CFA) coordinates**: `(0..sensor_width, 0..sensor_height)` before crop or orientation.
/// 2. **Output (Full developed) coordinates**: after `active_area` + `default_crop` + `orientation`.
/// 3. **Work / Detection coordinates**: scaled by `work_scale` (max 2304px long edge).
/// 4. **Normalized `[0, 1]` coordinates**: oriented full-frame coordinates for XMP `crs:RetouchAreas`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Geometry {
    pub sensor_width: usize,
    pub sensor_height: usize,
    /// Valid sensor area within `(sensor_width, sensor_height)`.
    pub active_area: CropRect,
    /// Default crop relative to `active_area`.
    pub default_crop: CropRect,
    pub orientation: Orientation,
    pub max_work_dim: usize,
}

impl Geometry {
    pub fn new(
        sensor_width: usize,
        sensor_height: usize,
        active_area: CropRect,
        default_crop: CropRect,
        orientation: Orientation,
    ) -> Self {
        let sw = sensor_width.max(1);
        let sh = sensor_height.max(1);
        let active = {
            let c = active_area.clipped(sw, sh);
            if c.width == 0 || c.height == 0 {
                CropRect::new(0, 0, sw, sh)
            } else {
                c
            }
        };
        let crop = {
            let c = default_crop.clipped(active.width, active.height);
            if c.width == 0 || c.height == 0 {
                CropRect::new(0, 0, active.width, active.height)
            } else {
                c
            }
        };
        Self {
            sensor_width: sw,
            sensor_height: sh,
            active_area: active,
            default_crop: crop,
            orientation,
            max_work_dim: 2304,
        }
    }

    /// Simple identity geometry for an already-oriented image of `(width, height)`.
    pub fn identity(width: usize, height: usize) -> Self {
        let w = width.max(1);
        let h = height.max(1);
        let full = CropRect::new(0, 0, w, h);
        Self::new(w, h, full, full, Orientation::Normal)
    }

    /// Origin of the developed crop in sensor coordinates.
    #[inline]
    pub fn sensor_crop_origin(&self) -> (usize, usize) {
        (
            self.active_area.x + self.default_crop.x,
            self.active_area.y + self.default_crop.y,
        )
    }

    /// Unoriented developed dimensions `(width, height)`.
    #[inline]
    pub fn unoriented_output_size(&self) -> (usize, usize) {
        (self.default_crop.width.max(1), self.default_crop.height.max(1))
    }

    /// Oriented full output dimensions `(fullWidth, fullHeight)`.
    #[inline]
    pub fn output_size(&self) -> (usize, usize) {
        let (uw, uh) = self.unoriented_output_size();
        self.orientation.oriented_size(uw, uh)
    }

    /// Working resolution scale (`<= 1.0`) and `(workWidth, workHeight)`.
    #[inline]
    pub fn work_dimensions(&self) -> (usize, usize, f64) {
        let (fw, fh) = self.output_size();
        let long_edge = fw.max(fh);
        let max_dim = self.max_work_dim.max(1);
        if long_edge > max_dim {
            let scale = max_dim as f64 / long_edge as f64;
            let ww = ((fw as f64 * scale).round() as usize).max(1);
            let wh = ((fh as f64 * scale).round() as usize).max(1);
            (ww, wh, scale)
        } else {
            (fw, fh, 1.0)
        }
    }

    /// Converts a sensor (CFA) coordinate `(sx, sy)` into oriented output coordinates `(ox, oy)`.
    #[inline]
    pub fn sensor_to_output(&self, p: Point2f) -> Point2f {
        let (ox0, oy0) = self.sensor_crop_origin();
        let cx = p.x - ox0 as f64;
        let cy = p.y - oy0 as f64;
        let (uw, uh) = self.unoriented_output_size();
        self.orientation.apply(cx, cy, uw, uh)
    }

    /// Converts an oriented output coordinate `(ox, oy)` back to sensor (CFA) coordinates `(sx, sy)`.
    #[inline]
    pub fn output_to_sensor(&self, p: Point2f) -> Point2f {
        let (uw, uh) = self.unoriented_output_size();
        let unoriented = self.orientation.unapply(p.x, p.y, uw, uh);
        let (ox0, oy0) = self.sensor_crop_origin();
        Point2f::new(unoriented.x + ox0 as f64, unoriented.y + oy0 as f64)
    }

    /// Converts an oriented output coordinate to working-resolution coordinates.
    #[inline]
    pub fn output_to_work(&self, p: Point2f) -> Point2f {
        let (_, _, scale) = self.work_dimensions();
        Point2f::new(p.x * scale, p.y * scale)
    }

    /// Converts a working-resolution coordinate back to oriented output coordinates.
    #[inline]
    pub fn work_to_output(&self, p: Point2f) -> Point2f {
        let (_, _, scale) = self.work_dimensions();
        let inv = if scale > 1e-12 { 1.0 / scale } else { 1.0 };
        Point2f::new(p.x * inv, p.y * inv)
    }

    /// Direct sensor (CFA) → working-resolution coordinate transform.
    #[inline]
    pub fn sensor_to_work(&self, p: Point2f) -> Point2f {
        self.output_to_work(self.sensor_to_output(p))
    }

    /// Direct working-resolution → sensor (CFA) coordinate transform.
    #[inline]
    pub fn work_to_sensor(&self, p: Point2f) -> Point2f {
        self.output_to_sensor(self.work_to_output(p))
    }

    /// Converts a sensor (CFA) coordinate to normalized `[0, 1]` output coordinates (for XMP `crs:RetouchAreas`).
    #[inline]
    pub fn sensor_to_normalized(&self, p: Point2f) -> Point2f {
        let out = self.sensor_to_output(p);
        let (fw, fh) = self.output_size();
        Point2f::new(
            out.x / (fw.max(1) as f64),
            out.y / (fh.max(1) as f64),
        )
    }

    /// Converts a normalized `[0, 1]` output coordinate back to sensor (CFA) coordinates.
    #[inline]
    pub fn normalized_to_sensor(&self, p: Point2f) -> Point2f {
        let (fw, fh) = self.output_size();
        let out = Point2f::new(p.x * (fw.max(1) as f64), p.y * (fh.max(1) as f64));
        self.output_to_sensor(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn sensor_output_work_roundtrip_error_below_0_01px(
            sw in 64usize..12000,
            sh in 64usize..9000,
            ax in 0usize..32,
            ay in 0usize..32,
            cx in 0usize..16,
            cy in 0usize..16,
            orient_code in 1u16..=8,
            px_norm in 0.0f64..1.0,
            py_norm in 0.0f64..1.0,
        ) {
            let active = CropRect::new(ax, ay, sw.saturating_sub(ax * 2).max(16), sh.saturating_sub(ay * 2).max(16));
            let crop = CropRect::new(cx, cy, active.width.saturating_sub(cx * 2).max(8), active.height.saturating_sub(cy * 2).max(8));
            let geom = Geometry::new(sw, sh, active, crop, Orientation::from_exif(orient_code));

            let p_sensor = Point2f::new(px_norm * sw as f64, py_norm * sh as f64);

            // 1. Sensor <-> Output roundtrip
            let p_out = geom.sensor_to_output(p_sensor);
            let p_back = geom.output_to_sensor(p_out);
            prop_assert!(
                p_sensor.distance_to(p_back) < 0.01,
                "sensor<->output error {} >= 0.01 for {:?}",
                p_sensor.distance_to(p_back),
                geom
            );

            // 2. Sensor <-> Work roundtrip
            let p_work = geom.sensor_to_work(p_sensor);
            let p_work_back = geom.work_to_sensor(p_work);
            prop_assert!(
                p_sensor.distance_to(p_work_back) < 0.01,
                "sensor<->work error {} >= 0.01 for {:?}",
                p_sensor.distance_to(p_work_back),
                geom
            );

            // 3. Sensor <-> Normalized roundtrip
            let p_norm = geom.sensor_to_normalized(p_sensor);
            let p_norm_back = geom.normalized_to_sensor(p_norm);
            prop_assert!(
                p_sensor.distance_to(p_norm_back) < 0.01,
                "sensor<->normalized error {} >= 0.01 for {:?}",
                p_sensor.distance_to(p_norm_back),
                geom
            );
        }
    }
}
