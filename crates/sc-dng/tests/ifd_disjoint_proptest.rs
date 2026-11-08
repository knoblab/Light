//! Property-based and edge-case verification that DNG 1.6 and TIFF 16-bit writers
//! produce strictly disjoint, non-overlapping IFDs, tag data, metadata, and pixel strips/tiles,
//! even with large (>100KB) XMP packets.

#![forbid(unsafe_code)]

use proptest::prelude::*;
use sc_color::spaces::ColorSpace;
use sc_core::{ExifMetadata, SessionMetadata, Stats16Bit};
use sc_dng::{write_cfa_dng_bytes, write_rendered_tiff16_bytes};
use std::collections::HashMap;

#[derive(Debug, Clone)]
struct Range {
    start: usize,
    end: usize,
    label: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
struct TagEntry {
    tag: u16,
    tag_type: u16,
    count: usize,
    value_offset: usize,
    inline: bool,
}

#[derive(Debug, Clone)]
struct ParsedIfd {
    label: String,
    entries: HashMap<u16, TagEntry>,
}

fn type_unit_size(tag_type: u16) -> usize {
    match tag_type {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 => 4,
        5 | 10 | 12 => 8,
        _ => 1,
    }
}

fn read_ifd(
    buffer: &[u8],
    offset: usize,
    label: &str,
    ranges: &mut Vec<Range>,
) -> Option<ParsedIfd> {
    if offset == 0 || offset + 2 > buffer.len() {
        return None;
    }
    let count = u16::from_le_bytes([buffer[offset], buffer[offset + 1]]) as usize;
    let block_end = offset + 2 + count * 12 + 4;
    assert!(
        block_end <= buffer.len(),
        "{label} block exceeds buffer length: {block_end} > {}",
        buffer.len()
    );
    ranges.push(Range {
        start: offset,
        end: block_end,
        label: format!("{label} directory"),
    });

    let mut entries = HashMap::new();
    for i in 0..count {
        let pos = offset + 2 + i * 12;
        let tag = u16::from_le_bytes([buffer[pos], buffer[pos + 1]]);
        let tag_type = u16::from_le_bytes([buffer[pos + 2], buffer[pos + 3]]);
        let n = u32::from_le_bytes([
            buffer[pos + 4],
            buffer[pos + 5],
            buffer[pos + 6],
            buffer[pos + 7],
        ]) as usize;
        let unit_size = type_unit_size(tag_type);
        let size = unit_size * n;
        let inline = size <= 4;
        let value_offset = if inline {
            pos + 8
        } else {
            u32::from_le_bytes([
                buffer[pos + 8],
                buffer[pos + 9],
                buffer[pos + 10],
                buffer[pos + 11],
            ]) as usize
        };

        if !inline {
            assert!(
                value_offset + size <= buffer.len(),
                "{label} tag {tag} data extends past EOF: {} + {size} > {}",
                value_offset,
                buffer.len()
            );
            ranges.push(Range {
                start: value_offset,
                end: value_offset + size,
                label: format!("{label} tag {tag} payload"),
            });
        }
        entries.insert(
            tag,
            TagEntry {
                tag,
                tag_type,
                count: n,
                value_offset,
                inline,
            },
        );
    }

    Some(ParsedIfd {
        label: label.to_string(),
        entries,
    })
}

fn parse_tiff_ranges(buffer: &[u8]) -> (Vec<Range>, Vec<ParsedIfd>) {
    assert!(buffer.len() >= 8, "Buffer too short for TIFF header");
    let magic = u16::from_le_bytes([buffer[0], buffer[1]]);
    let version = u16::from_le_bytes([buffer[2], buffer[3]]);
    assert_eq!(magic, 0x4949, "TIFF must be little-endian (II)");
    assert_eq!(version, 42, "TIFF version must be 42");

    let mut ranges: Vec<Range> = vec![Range {
        start: 0,
        end: 8,
        label: "TIFF Header".into(),
    }];
    let mut ifds: Vec<ParsedIfd> = Vec::new();

    let first_ifd_offset =
        u32::from_le_bytes([buffer[4], buffer[5], buffer[6], buffer[7]]) as usize;
    if let Some(ifd0) = read_ifd(buffer, first_ifd_offset, "IFD0", &mut ranges) {
        // Strip data
        if let (Some(off_entry), Some(len_entry)) =
            (ifd0.entries.get(&273), ifd0.entries.get(&279))
        {
            let off = u32::from_le_bytes([
                buffer[off_entry.value_offset],
                buffer[off_entry.value_offset + 1],
                buffer[off_entry.value_offset + 2],
                buffer[off_entry.value_offset + 3],
            ]) as usize;
            let len = u32::from_le_bytes([
                buffer[len_entry.value_offset],
                buffer[len_entry.value_offset + 1],
                buffer[len_entry.value_offset + 2],
                buffer[len_entry.value_offset + 3],
            ]) as usize;
            assert!(
                off + len <= buffer.len(),
                "IFD0 strips extend past buffer length: {off} + {len} > {}",
                buffer.len()
            );
            ranges.push(Range {
                start: off,
                end: off + len,
                label: "IFD0 Strip Pixels".into(),
            });
        }

        // SubIFD check (tag 330)
        if let Some(sub_entry) = ifd0.entries.get(&330) {
            let sub_offset = u32::from_le_bytes([
                buffer[sub_entry.value_offset],
                buffer[sub_entry.value_offset + 1],
                buffer[sub_entry.value_offset + 2],
                buffer[sub_entry.value_offset + 3],
            ]) as usize;
            if let Some(sub_ifd) = read_ifd(buffer, sub_offset, "SubIFD", &mut ranges) {
                if let (Some(off_entry), Some(len_entry)) =
                    (sub_ifd.entries.get(&273), sub_ifd.entries.get(&279))
                {
                    let off = u32::from_le_bytes([
                        buffer[off_entry.value_offset],
                        buffer[off_entry.value_offset + 1],
                        buffer[off_entry.value_offset + 2],
                        buffer[off_entry.value_offset + 3],
                    ]) as usize;
                    let len = u32::from_le_bytes([
                        buffer[len_entry.value_offset],
                        buffer[len_entry.value_offset + 1],
                        buffer[len_entry.value_offset + 2],
                        buffer[len_entry.value_offset + 3],
                    ]) as usize;
                    assert!(
                        off + len <= buffer.len(),
                        "SubIFD strips extend past buffer length"
                    );
                    ranges.push(Range {
                        start: off,
                        end: off + len,
                        label: "SubIFD Strip Pixels".into(),
                    });
                }
                ifds.push(sub_ifd);
            }
        }

        ifds.push(ifd0);
    }

    (ranges, ifds)
}

fn assert_strictly_disjoint(mut ranges: Vec<Range>) {
    ranges.sort_by_key(|r| r.start);
    for i in 1..ranges.len() {
        let prev = &ranges[i - 1];
        let curr = &ranges[i];
        assert!(
            curr.start >= prev.end,
            "Overlap detected between '{}' [{}, {}) and '{}' [{}, {})",
            prev.label,
            prev.start,
            prev.end,
            curr.label,
            curr.start,
            curr.end
        );
    }
}

fn make_test_meta(w: usize, h: usize, xmp_bytes: Vec<u8>) -> SessionMetadata {
    SessionMetadata {
        original_file_name: "test.rw2".into(),
        extension: "RW2".into(),
        is_raw: true,
        decode_kind: None,
        is_input_16_bit: true,
        is_linear16: true,
        full_width: w,
        full_height: h,
        work_width: w,
        work_height: h,
        work_scale: 1.0,
        exposure_scale: 1.5,
        bit_depth: "16-bit".into(),
        color_space: "sRGB".into(),
        camera_wb: vec![1.0, 1.0, 1.0, 1.0],
        color_matrix: vec![
            vec![1.0, 0.0, 0.0],
            vec![0.0, 1.0, 0.0],
            vec![0.0, 0.0, 1.0],
        ],
        black_level: vec![0, 0, 0, 0],
        white_level: 65535,
        bayer_pattern: "RGGB".into(),
        stats_16_bit: Stats16Bit {
            min_code_value: 0,
            max_code_value: 65535,
            mean_code_value: 1000.0,
            estimated_dynamic_range_ev: 12.0,
        },
        exif: ExifMetadata {
            make: "TestCamera".into(),
            model: "ProSensor".into(),
            iso: Some(200),
            f_number: Some(2.8),
            exposure_time: Some("1/250s".into()),
            focal_length: Some("35mm".into()),
            date_time: Some("2026:11:05 10:00:00".into()),
            software: "SensorClean Pro".into(),
            raw_xmp_bytes: xmp_bytes,
        },
        raw_crop: None,
    }
}

#[test]
fn test_fixed_sizes_disjoint() {
    let test_sizes = [0, 600, 20_000, 100_000];
    let w = 32;
    let h = 32;
    let cfa = vec![4096u16; w * h];
    let rgb16 = vec![4096u16; w * h * 3];

    for &xmp_len in &test_sizes {
        let xmp = (0..xmp_len).map(|i| (0x41 + (i % 26)) as u8).collect::<Vec<_>>();
        let meta = make_test_meta(w, h, xmp.clone());

        // 1. Verify CFA DNG
        let dng_buf = write_cfa_dng_bytes(&cfa, w, h, &meta).expect("write_cfa_dng_bytes failed");
        let (dng_ranges, dng_ifds) = parse_tiff_ranges(&dng_buf);
        assert_strictly_disjoint(dng_ranges);

        if xmp_len > 0 {
            let ifd0 = &dng_ifds.iter().find(|i| i.label == "IFD0").unwrap();
            let xmp_tag = ifd0.entries.get(&700).expect("XMP tag 700 missing in DNG");
            let xmp_slice = &dng_buf[xmp_tag.value_offset..xmp_tag.value_offset + xmp_tag.count];
            assert_eq!(xmp_slice, &xmp[..], "DNG XMP payload mismatch");
        }

        // 2. Verify TIFF 16-bit
        let tiff_buf = write_rendered_tiff16_bytes(&rgb16, w, h, ColorSpace::Srgb, &meta)
            .expect("write_rendered_tiff16_bytes failed");
        let (tiff_ranges, tiff_ifds) = parse_tiff_ranges(&tiff_buf);
        assert_strictly_disjoint(tiff_ranges);

        if xmp_len > 0 {
            let ifd0 = &tiff_ifds.iter().find(|i| i.label == "IFD0").unwrap();
            let xmp_tag = ifd0.entries.get(&700).expect("XMP tag 700 missing in TIFF");
            let xmp_slice =
                &tiff_buf[xmp_tag.value_offset..xmp_tag.value_offset + xmp_tag.count];
            assert_eq!(xmp_slice, &xmp[..], "TIFF XMP payload mismatch");
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(15))]

    #[test]
    fn proptest_arbitrary_xmp_and_dimensions_disjoint(
        w in 16usize..64,
        h in 16usize..64,
        xmp_len in 0usize..80_000,
    ) {
        let xmp: Vec<u8> = (0..xmp_len).map(|i| ((i * 31 + 7) & 0xff) as u8).collect();
        let meta = make_test_meta(w, h, xmp.clone());
        let cfa = vec![2048u16; w * h];
        let rgb16 = vec![2048u16; w * h * 3];

        let dng_buf = write_cfa_dng_bytes(&cfa, w, h, &meta).unwrap();
        let (dng_ranges, dng_ifds) = parse_tiff_ranges(&dng_buf);
        assert_strictly_disjoint(dng_ranges);

        if xmp_len > 0 {
            let ifd0 = dng_ifds.iter().find(|i| i.label == "IFD0").unwrap();
            let xmp_tag = ifd0.entries.get(&700).unwrap();
            assert_eq!(&dng_buf[xmp_tag.value_offset..xmp_tag.value_offset + xmp_tag.count], &xmp[..]);
        }

        let tiff_buf = write_rendered_tiff16_bytes(&rgb16, w, h, ColorSpace::Srgb, &meta).unwrap();
        let (tiff_ranges, tiff_ifds) = parse_tiff_ranges(&tiff_buf);
        assert_strictly_disjoint(tiff_ranges);

        if xmp_len > 0 {
            let ifd0 = tiff_ifds.iter().find(|i| i.label == "IFD0").unwrap();
            let xmp_tag = ifd0.entries.get(&700).unwrap();
            assert_eq!(&tiff_buf[xmp_tag.value_offset..xmp_tag.value_offset + xmp_tag.count], &xmp[..]);
        }
    }
}
