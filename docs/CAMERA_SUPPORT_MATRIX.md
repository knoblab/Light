# SensorClean Camera & RAW Format Support Matrix

SensorClean runs 100% pure Rust (`sc-decode`) with `#![forbid(unsafe_code)]` and zero C/C++ or Python dependencies across PC Desktop (Tauri v2), Android Mobile, and Static Web (WebAssembly).

## Supported Camera RAW & Image Formats

| Manufacturer / Standard | File Extension | Sensor Layout | CFA Bayer Patterns | 16-Bit Lossless Output | Verified Models |
|---|---|---|---|---|---|
| **Panasonic Lumix** | `.rw2`, `.raw` | Bayer | RGGB, BGGR | DNG 1.6, TIFF-16, PNG-16 | S5, S5II, S5IIX, S1, S1R, GH5, GH6, G9, G9II |
| **Sony Alpha** | `.arw` | Bayer | RGGB | DNG 1.6, TIFF-16, PNG-16 | A7 IV, A7R V, A7C II, A7S III, A1, A9 III, A6700 |
| **Canon EOS** | `.cr2`, `.cr3` | Bayer | RGGB | DNG 1.6, TIFF-16, PNG-16 | EOS R5, R5C, R6 II, R3, R8, 5D Mark IV, 1D X III |
| **Nikon Z / D** | `.nef`, `.nrw` | Bayer | RGGB | DNG 1.6, TIFF-16, PNG-16 | Z9, Z8, Z6 III, Zf, D850, D780 |
| **Fujifilm X / GFX** | `.raf` | Bayer & Linear | RGGB | DNG 1.6, TIFF-16, PNG-16 | X-T5, X-H2, X-T4, GFX 100 II, GFX 50S II |
| **Olympus / OM System** | `.orf` | Bayer | RGGB | DNG 1.6, TIFF-16, PNG-16 | OM-1, OM-1 II, E-M1 Mark III, E-M5 III |
| **Pentax** | `.pef`, `.dng` | Bayer | RGGB | DNG 1.6, TIFF-16, PNG-16 | K-1 II, K-3 III, 645Z |
| **Leica** | `.rwl`, `.dng` | Bayer | RGGB | DNG 1.6, TIFF-16, PNG-16 | M11, SL2, SL3, Q2, Q3 |
| **Hasselblad** | `.3fr` | Bayer | RGGB | DNG 1.6, TIFF-16, PNG-16 | X2D 100C, X1D II 50C |
| **Phase One** | `.iiq` | Bayer | RGGB | DNG 1.6, TIFF-16, PNG-16 | IQ4 150MP, IQ3 |
| **Adobe Digital Negative** | `.dng` | CFA & Linear | RGGB, BGGR, GBRG, GRBG | DNG 1.6, TIFF-16, PNG-16 | Universal DNG 1.1 ~ 1.6 compliant |
| **Lossless TIFF** | `.tif`, `.tiff` | RGB / Grayscale | N/A | TIFF-16, DNG 1.6, PNG-16 | 16-bit uncompressed & LZW TIFF |
| **Standard Images** | `.png`, `.jpg`, `.jpeg` | sRGB / Display P3 | N/A | PNG-16, PNG-8, JPEG | 8-bit & 16-bit standard image files |

## Bit-Exactness Guarantee
SensorClean mathematically enforces the invariant:
$$\text{Pixel}_{\text{healed}}(x, y) \equiv \text{Pixel}_{\text{original}}(x, y) \quad \forall (x, y) \notin \bigcup_{k} \text{ROI}_k$$
- Unaffected pixels are copied byte-for-byte with $0$ bit deviation.
- Healed pixels undergo 4-phase Telea CFA reconstruction preserving camera color balance, black level, white level, and sensor read noise floor.
- Sidecar `.xmp` files are generated following Adobe Camera Raw (ACR) Retouch / Heal specification for non-destructive Lightroom workflows.
