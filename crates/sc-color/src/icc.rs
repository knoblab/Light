//! Pure-Rust ICC Profile v2.4 binary generator for sRGB, Adobe RGB, Display P3, and ProPhoto RGB.

#![forbid(unsafe_code)]

use crate::spaces::{colorant_xyz_d50, ColorSpace};

/// Converts a floating point number to signed 15.16 fixed-point format (`s15Fixed16Number`).
#[inline]
fn to_s15_fixed16(val: f64) -> u32 {
    let fixed = (val * 65536.0).round() as i32;
    fixed as u32
}

/// Converts a gamma float to unsigned 8.8 fixed-point format (`u8Fixed8Number`).
#[inline]
fn to_u8_fixed8(val: f64) -> u16 {
    (val * 256.0).round().clamp(0.0, 65535.0) as u16
}

/// Generates a valid ICC Profile v2.4 binary byte buffer for the specified color space.
pub fn generate_icc_profile(space: ColorSpace) -> Vec<u8> {
    let name = space.name();
    let copyright = "SensorClean Pro Engine";

    // Build Tag Data Blocks
    let mut tag_desc = Vec::new();
    tag_desc.extend_from_slice(b"desc"); // type signature
    tag_desc.extend_from_slice(&[0, 0, 0, 0]); // reserved
    tag_desc.extend_from_slice(&(name.len() as u32 + 1).to_be_bytes()); // ASCII count
    tag_desc.extend_from_slice(name.as_bytes());
    tag_desc.push(0); // null terminator
    tag_desc.extend_from_slice(&[0; 11]); // unicode / scriptcode placeholder

    // D50 White point tag (wtpt)
    let mut tag_wtpt = Vec::new();
    tag_wtpt.extend_from_slice(b"XYZ ");
    tag_wtpt.extend_from_slice(&[0, 0, 0, 0]);
    tag_wtpt.extend_from_slice(&to_s15_fixed16(0.9642).to_be_bytes());
    tag_wtpt.extend_from_slice(&to_s15_fixed16(1.0000).to_be_bytes());
    tag_wtpt.extend_from_slice(&to_s15_fixed16(0.8249).to_be_bytes());

    // Colorant tags (rXYZ, gXYZ, bXYZ)
    let mat = colorant_xyz_d50(space);
    let make_xyz_tag = |vec: [f64; 3]| -> Vec<u8> {
        let mut t = Vec::new();
        t.extend_from_slice(b"XYZ ");
        t.extend_from_slice(&[0, 0, 0, 0]);
        t.extend_from_slice(&to_s15_fixed16(vec[0]).to_be_bytes());
        t.extend_from_slice(&to_s15_fixed16(vec[1]).to_be_bytes());
        t.extend_from_slice(&to_s15_fixed16(vec[2]).to_be_bytes());
        t
    };
    let tag_rxyz = make_xyz_tag(mat[0]);
    let tag_gxyz = make_xyz_tag(mat[1]);
    let tag_bxyz = make_xyz_tag(mat[2]);

    // Curve tags (rTRC, gTRC, bTRC)
    let mut tag_trc = Vec::new();
    tag_trc.extend_from_slice(b"curv");
    tag_trc.extend_from_slice(&[0, 0, 0, 0]);
    tag_trc.extend_from_slice(&1u32.to_be_bytes()); // 1 entry: gamma value in u8Fixed8
    tag_trc.extend_from_slice(&to_u8_fixed8(space.gamma()).to_be_bytes());
    tag_trc.extend_from_slice(&[0, 0]); // pad to 4-byte boundary

    // Copyright tag (cprt)
    let mut tag_cprt = Vec::new();
    tag_cprt.extend_from_slice(b"text");
    tag_cprt.extend_from_slice(&[0, 0, 0, 0]);
    tag_cprt.extend_from_slice(copyright.as_bytes());
    tag_cprt.push(0);
    while tag_cprt.len() % 4 != 0 {
        tag_cprt.push(0);
    }

    // List of tags: (tag_sig, data)
    let tags: [(&[u8; 4], &Vec<u8>); 9] = [
        (b"desc", &tag_desc),
        (b"cprt", &tag_cprt),
        (b"wtpt", &tag_wtpt),
        (b"rXYZ", &tag_rxyz),
        (b"gXYZ", &tag_gxyz),
        (b"bXYZ", &tag_bxyz),
        (b"rTRC", &tag_trc),
        (b"gTRC", &tag_trc),
        (b"bTRC", &tag_trc),
    ];

    let header_size = 128usize;
    let tag_table_size = 4 + tags.len() * 12;
    let mut current_offset = header_size + tag_table_size;

    // Build Tag Table
    let mut tag_table = Vec::with_capacity(tag_table_size);
    tag_table.extend_from_slice(&(tags.len() as u32).to_be_bytes());

    let mut tag_data_blob = Vec::new();
    for (sig, data) in &tags {
        let aligned_len = (data.len() + 3) & !3;
        tag_table.extend_from_slice(*sig);
        tag_table.extend_from_slice(&(current_offset as u32).to_be_bytes());
        tag_table.extend_from_slice(&(data.len() as u32).to_be_bytes());

        tag_data_blob.extend_from_slice(data);
        while tag_data_blob.len() < current_offset - (header_size + tag_table_size) + aligned_len {
            tag_data_blob.push(0);
        }
        current_offset += aligned_len;
    }

    let total_profile_size = header_size + tag_table_size + tag_data_blob.len();

    // 128-byte Header
    let mut header = vec![0u8; 128];
    header[0..4].copy_from_slice(&(total_profile_size as u32).to_be_bytes());
    header[8..12].copy_from_slice(&0x02400000u32.to_be_bytes()); // Profile version 2.4.0
    header[12..16].copy_from_slice(b"mntr"); // Monitor / Display
    header[16..20].copy_from_slice(b"RGB "); // Color space
    header[20..24].copy_from_slice(b"XYZ "); // Connection space
    header[24..26].copy_from_slice(&2026u16.to_be_bytes()); // Year
    header[26..28].copy_from_slice(&1u16.to_be_bytes()); // Month
    header[28..30].copy_from_slice(&1u16.to_be_bytes()); // Day
    header[36..40].copy_from_slice(b"acsp"); // Magic signature
    // D50 Illuminant
    header[68..72].copy_from_slice(&to_s15_fixed16(0.9642).to_be_bytes());
    header[72..76].copy_from_slice(&to_s15_fixed16(1.0000).to_be_bytes());
    header[76..80].copy_from_slice(&to_s15_fixed16(0.8249).to_be_bytes());

    let mut profile = Vec::with_capacity(total_profile_size);
    profile.extend_from_slice(&header);
    profile.extend_from_slice(&tag_table);
    profile.extend_from_slice(&tag_data_blob);

    profile
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_valid_icc_v24_headers() {
        for space in [
            ColorSpace::Srgb,
            ColorSpace::AdobeRgb1998,
            ColorSpace::DisplayP3,
            ColorSpace::ProPhotoRgb,
        ] {
            let icc = generate_icc_profile(space);
            assert!(icc.len() >= 128, "ICC profile must be >= 128 bytes");
            assert_eq!(&icc[36..40], b"acsp", "Magic signature must be 'acsp'");
            assert_eq!(&icc[12..16], b"mntr", "Device class must be 'mntr'");
            assert_eq!(&icc[16..20], b"RGB ", "Color space must be 'RGB '");
            assert_eq!(&icc[20..24], b"XYZ ", "PCS must be 'XYZ '");

            // Profile length field matches actual byte size
            let declared_len = u32::from_be_bytes([icc[0], icc[1], icc[2], icc[3]]) as usize;
            assert_eq!(declared_len, icc.len(), "Header size must match actual size");
        }
    }
}
