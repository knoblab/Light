//! Pure-Rust image processing primitives for SensorClean (`sc-imgproc`), replacing OpenCV (`cv2`).
//!
//! Includes:
//! - Separable `f32` Gaussian blur with `BORDER_REFLECT_101` (`gaussian`)
//! - Exact box-integrated `INTER_AREA`, `INTER_LINEAR`, and `INTER_NEAREST` resizers (`resize`)
//! - 3×3 Sobel derivatives and gradient magnitude (`sobel`)
//! - Elliptical structuring elements and grayscale/binary dilation (`morph`)
//! - Exact 2D Euclidean Voronoi nearest-valid-pixel border padding (`dist_transform`)
//! - 8-connected components, contour area, minimum enclosing circle, and ellipse axis ratio (`contours`)
//! - Circle and stroke rasterizers for masks and B&W visualizations (`draw`)

#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unimplemented,
    clippy::todo,
    clippy::unreachable
)]

pub mod contours;
pub mod dist_transform;
pub mod draw;
pub mod gaussian;
pub mod morph;
pub mod resize;
pub mod sobel;
pub mod telea;

pub use contours::{ComponentCandidate, extract_sharp_candidates};
pub use dist_transform::pad_invalid_border_nearest;
pub use draw::{draw_aa_circle_rgb, draw_filled_circle_u8, draw_thick_line_u8};
pub use gaussian::{
    downsample_2x_f32, downsample_4x_f32, gaussian_blur_f32, gaussian_blur_f32_into,
    upsample_bilinear_f32, upsample_bilinear_f32_into,
};
pub use morph::{dilate_f32, dilate_u8, ellipse_kernel};
pub use resize::{
    resize_bilinear_f32, resize_inter_area_f32, resize_inter_area_u16_rgb, resize_nearest_bool,
    resize_nearest_u8,
};
pub use sobel::{
    gradient_magnitude_f32, gradient_magnitude_f32_into, sobel_3x3_f32, sobel_3x3_f32_into,
};
pub use telea::{inpaint_telea_f32, inpaint_telea_harmonic_f32};
