use lightcraft_raw::{BlackLevel, Cfa, ColorData, OpcodeLists, RawData, RawFormat, RawImage, Rect};
use lightcraft_tiff::{ByteOrder, IfdBuilder, ImageData, TiffWriter, Value, tags as t};
use sc_core::DecodeKind;
use sc_decode::{
    decode_raw_isolated, ingest_bytes, raw_pixels_u16, raw_pixels_u16_mut, write_cfa_dng_isolated,
};
use std::path::Path;
use std::time::Instant;

fn make_synthetic_cfa_raw(w: usize, h: usize) -> RawImage {
    let mut samples = vec![0u16; w * h];
    for y in 0..h {
        for x in 0..w {
            let base = 256 + ((x * 7 + y * 13) % 3500) as u16;
            samples[y * w + x] = base;
        }
    }
    let full = Rect::new(0, 0, w, h);
    RawImage {
        format: RawFormat::Dng,
        width: w,
        height: h,
        cpp: 1,
        data: RawData::U16(samples),
        cfa: Cfa::bayer("RGGB"),
        bits: 12,
        black: BlackLevel::uniform(256.0),
        white: vec![4095.0],
        active_area: full,
        crop: full,
        orientation: lightcraft_geom::Orientation::Normal,
        color: ColorData::default(),
        wb_multipliers: Some([2.1, 1.0, 1.6]),
        linearized: true,
        pixel_aspect: 1.0,
        opcodes: OpcodeLists::default(),
        metadata: lightcraft_meta::Metadata {
            make: Some("Panasonic".into()),
            model: Some("DC-S5".into()),
            iso: Some(100),
            ..Default::default()
        },
        lens_metadata: Default::default(),
    }
}

#[test]
fn r0_cfa_dng_roundtrip_bit_exact_outside_modified_roi() {
    let orig = make_synthetic_cfa_raw(512, 384);
    let orig_pixels = raw_pixels_u16(&orig).unwrap().to_vec();

    // 1. Unmodified roundtrip via Lossless JPEG (LJ92) tiles
    let dng_unmod = write_cfa_dng_isolated(&orig, true).unwrap();
    let decoded_unmod = decode_raw_isolated(&dng_unmod).unwrap();
    assert_eq!(raw_pixels_u16(&decoded_unmod).unwrap(), orig_pixels.as_slice());

    // 2. Modify a 24x24 dust ROI at (200..224, 150..174) and write as LJ92 CFA DNG
    let mut healed = orig.clone();
    {
        let buf = raw_pixels_u16_mut(&mut healed).unwrap();
        for y in 150..174 {
            for x in 200..224 {
                buf[y * 512 + x] = 2048;
            }
        }
    }
    let dng_healed = write_cfa_dng_isolated(&healed, true).unwrap();
    let decoded_healed = decode_raw_isolated(&dng_healed).unwrap();
    let healed_pixels = raw_pixels_u16(&decoded_healed).unwrap();

    for y in 0..384 {
        for x in 0..512 {
            let idx = y * 512 + x;
            if (150..174).contains(&y) && (200..224).contains(&x) {
                assert_eq!(healed_pixels[idx], 2048);
            } else {
                assert_eq!(
                    healed_pixels[idx], orig_pixels[idx],
                    "pixel outside ROI changed at ({x}, {y})"
                );
            }
        }
    }
}

#[test]
fn r0_real_rw2_sample_decode_and_cfa_dng_roundtrip() {
    let sample_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/RAW Sample/_1180814.RW2");
    if !sample_path.exists() {
        eprintln!("Skipping real RW2 test: {:?} not found", sample_path);
        return;
    }

    let bytes = std::fs::read(&sample_path).unwrap();
    let t0 = Instant::now();
    let raw = decode_raw_isolated(&bytes).expect("real RW2 sample should decode cleanly");
    let decode_ms = t0.elapsed().as_secs_f64() * 1000.0;

    println!(
        "[R0 Real RW2] {}x{}, cpp={}, cfa={:?}, bits={}, black_mean={}, white={}, active={:?}, crop={:?}, decode_ms={:.1}ms",
        raw.width,
        raw.height,
        raw.cpp,
        raw.cfa.as_ref().map(|c| c.name()),
        raw.bits,
        raw.black.mean(),
        raw.white_at(0),
        raw.active_area,
        raw.crop,
        decode_ms
    );

    let orig_pixels = raw_pixels_u16(&raw).unwrap().to_vec();
    let w = raw.width;
    let h = raw.height;

    // Heal a 32x32 ROI in the center of the sensor and write to LJ92 CFA DNG
    let mut healed = raw.clone();
    let rx0 = w / 2 - 16;
    let rx1 = w / 2 + 16;
    let ry0 = h / 2 - 16;
    let ry1 = h / 2 + 16;
    {
        let mut_px = raw_pixels_u16_mut(&mut healed).unwrap();
        for y in ry0..ry1 {
            for x in rx0..rx1 {
                mut_px[y * w + x] = 1024;
            }
        }
    }

    let t_write = Instant::now();
    let dng_bytes = write_cfa_dng_isolated(&healed, true).expect("CFA DNG write should succeed");
    let write_ms = t_write.elapsed().as_secs_f64() * 1000.0;

    let decoded_dng = decode_raw_isolated(&dng_bytes).expect("written CFA DNG should decode back");
    let roundtrip_px = raw_pixels_u16(&decoded_dng).unwrap();
    assert_eq!(roundtrip_px.len(), orig_pixels.len());

    let mut outside_diff = 0usize;
    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;
            if (ry0..ry1).contains(&y) && (rx0..rx1).contains(&x) {
                assert_eq!(roundtrip_px[idx], 1024);
            } else if roundtrip_px[idx] != orig_pixels[idx] {
                outside_diff += 1;
            }
        }
    }
    println!(
        "[R0 Real RW2 -> CFA DNG] dng_size={} bytes, write_ms={:.1}ms, outside_roi_bit_diff={}",
        dng_bytes.len(),
        write_ms,
        outside_diff
    );
    assert_eq!(outside_diff, 0, "all CFA pixels outside ROI must be bit-identical");
}

#[test]
fn r0_corrupt_and_truncated_files_never_panic() {
    let base_raw = make_synthetic_cfa_raw(128, 128);
    let valid_dng = write_cfa_dng_isolated(&base_raw, true).unwrap();

    // 20 corrupt / truncated / garbage payloads
    let mut payloads: Vec<Vec<u8>> = vec![
        vec![],
        b"II*\0".to_vec(),
        b"MM\0*".to_vec(),
        b"IIU\0\x08\0\0\0".to_vec(),
        b"FUJIFILMCCD-RAW 0201".to_vec(),
        b"\0\0\0\x18ftypcrx \0\0\0\x01".to_vec(),
    ];
    for cut in [10, 32, 64, 128, 256, 512, 1024, valid_dng.len() / 2, valid_dng.len() - 5] {
        if cut < valid_dng.len() {
            payloads.push(valid_dng[..cut].to_vec());
        }
    }
    for flip_idx in [4, 8, 16, 24, 48] {
        if flip_idx < valid_dng.len() {
            let mut m = valid_dng.clone();
            m[flip_idx] ^= 0xFF;
            payloads.push(m);
        }
    }

    for (i, payload) in payloads.iter().enumerate() {
        // Must return Err cleanly, never panic
        let _ = decode_raw_isolated(payload);
        let _ = ingest_bytes(payload, &format!("corrupt_{i}.dng"), "dng");
    }
}

#[test]
fn phase0_single_channel_mosaic_is_rejected_and_8bit_tiff_is_embedded_preview() {
    // 1. 1-channel 16-bit TIFF (Bayer mosaic without DNG tags) -> must be rejected!
    let mut ifd_mosaic = IfdBuilder::new();
    ifd_mosaic.set(t::IMAGE_WIDTH, Value::Long(vec![64]));
    ifd_mosaic.set(t::IMAGE_LENGTH, Value::Long(vec![64]));
    ifd_mosaic.set(t::BITS_PER_SAMPLE, Value::Short(vec![16]));
    ifd_mosaic.set(t::COMPRESSION, Value::Short(vec![t::compression::NONE]));
    ifd_mosaic.set(t::PHOTOMETRIC, Value::Short(vec![t::photometric::BLACK_IS_ZERO]));
    ifd_mosaic.set(t::SAMPLES_PER_PIXEL, Value::Short(vec![1]));
    ifd_mosaic.set(t::PLANAR_CONFIGURATION, Value::Short(vec![1]));
    ifd_mosaic.set_image(ImageData::Strips {
        rows_per_strip: 64,
        strips: vec![vec![0u8; 64 * 64 * 2]],
    });
    let mosaic_bytes = TiffWriter::new(ByteOrder::Little, false)
        .write(&[ifd_mosaic])
        .expect("write mosaic tiff");

    let err = ingest_bytes(&mosaic_bytes, "mosaic.dng", "dng");
    assert!(err.is_err(), "single-channel mosaic TIFF must be rejected");

    // 2. 3-channel 8-bit RGB TIFF with .dng extension -> must be flagged as EmbeddedPreview
    let mut ifd_rgb8 = IfdBuilder::new();
    ifd_rgb8.set(t::IMAGE_WIDTH, Value::Long(vec![64]));
    ifd_rgb8.set(t::IMAGE_LENGTH, Value::Long(vec![64]));
    ifd_rgb8.set(t::BITS_PER_SAMPLE, Value::Short(vec![8, 8, 8]));
    ifd_rgb8.set(t::COMPRESSION, Value::Short(vec![t::compression::NONE]));
    ifd_rgb8.set(t::PHOTOMETRIC, Value::Short(vec![t::photometric::RGB]));
    ifd_rgb8.set(t::SAMPLES_PER_PIXEL, Value::Short(vec![3]));
    ifd_rgb8.set(t::PLANAR_CONFIGURATION, Value::Short(vec![1]));
    ifd_rgb8.set_image(ImageData::Strips {
        rows_per_strip: 64,
        strips: vec![vec![128u8; 64 * 64 * 3]],
    });
    let rgb8_bytes = TiffWriter::new(ByteOrder::Little, false)
        .write(&[ifd_rgb8])
        .expect("write rgb8 tiff");

    let ingested = ingest_bytes(&rgb8_bytes, "preview_only.dng", "dng")
        .expect("3-channel 8-bit fallback TIFF should ingest as preview");
    assert!(ingested.meta.is_raw);
    assert_eq!(ingested.meta.decode_kind, Some(DecodeKind::EmbeddedPreview));
}
