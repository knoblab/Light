import { ColorSpaceId, ExifMetadata } from '../types/sensor';

export interface DecodedImagePayload {
  fullWidth: number;
  fullHeight: number;
  origRgb8: Uint8Array;      // W * H * 3 (exact original camera color & contrast)
  linear16: Uint16Array;     // W * H * 3 (16-bit linearized 0..65535 for dust physics & 16-bit export)
  lut16ToOrig8R: Uint8Array; // 65536-entry LUT mapping linear16 R -> origRgb8 R
  lut16ToOrig8G: Uint8Array; // 65536-entry LUT mapping linear16 G -> origRgb8 G
  lut16ToOrig8B: Uint8Array; // 65536-entry LUT mapping linear16 B -> origRgb8 B
  isRaw: boolean;
  extension: string;
  exposureScale: number;
  detectedColorSpace: ColorSpaceId;
  rawIccProfileBytes?: Uint8Array;
  exif: ExifMetadata;
}

const RAW_EXT_SET = new Set([
  'rw2', 'dng', 'cr2', 'cr3', 'nef', 'arw',
  'orf', 'pef', 'raf', 'srw', 'erf', 'kdc', 'dcr',
]);

// Precomputed 256-entry sRGB (0..255) -> 16-bit Linear (0..65535) LUT
export const SRGB8_TO_LINEAR16_LUT = new Uint16Array(256);
// Precomputed 65536-entry 16-bit Linear (0..65535) -> sRGB (0..255) inverse LUT
export const LINEAR16_TO_SRGB8_LUT = new Uint8Array(65536);
// Precomputed 256-entry sRGB (0..255) -> 16-bit sRGB (0..65535) LUT
export const SRGB8_TO_SRGB16_LUT = new Uint16Array(256);

(function initColorLuts() {
  for (let i = 0; i < 256; i++) {
    const norm = i / 255.0;
    const lin = norm <= 0.04045 ? norm / 12.92 : Math.pow((norm + 0.055) / 1.055, 2.4);
    SRGB8_TO_LINEAR16_LUT[i] = Math.max(0, Math.min(65535, Math.round(lin * 65535.0)));
    SRGB8_TO_SRGB16_LUT[i] = i * 257;
  }
  for (let v = 0; v < 65536; v++) {
    const lin = v / 65535.0;
    const srgb =
      lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(Math.max(lin, 1e-8), 1.0 / 2.4) - 0.055;
    LINEAR16_TO_SRGB8_LUT[v] = Math.max(0, Math.min(255, Math.round(srgb * 255.0)));
  }
  // Ensure exact round-trip identity for all 256 8-bit values
  for (let i = 0; i < 256; i++) {
    LINEAR16_TO_SRGB8_LUT[SRGB8_TO_LINEAR16_LUT[i]] = i;
  }
})();

interface TiffIfdSummary {
  width: number;
  height: number;
  bitsPerSample: number[];
  compression: number;
  photometric: number;
  samplesPerPixel: number;
  stripOffsets: number[];
  stripByteCounts: number[];
  jpegOffset: number;
  jpegLength: number;
  rw2JpgFromRawOffset: number;
  rw2JpgFromRawLength: number;
  subIfdOffsets: number[];
  exifIfdOffset: number;
  orientation: number;
  make?: string;
  model?: string;
  dateTime?: string;
  software?: string;
  iccProfileBytes?: Uint8Array;
  colorSpaceTag?: number;
}

function readAscii(view: DataView, offset: number, count: number): string {
  const maxLen = Math.min(count, view.byteLength - offset);
  let out = '';
  for (let i = 0; i < maxLen; i++) {
    const ch = view.getUint8(offset + i);
    if (ch === 0) break;
    if (ch >= 32 && ch <= 126) out += String.fromCharCode(ch);
  }
  return out.trim();
}

/**
 * Parses an embedded ICC Profile description to identify known wide gamut color spaces.
 */
export function detectColorSpaceFromIcc(iccBytes: Uint8Array): ColorSpaceId {
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(iccBytes);
    const lower = text.toLowerCase();
    if (lower.includes('adobe rgb') || lower.includes('adobergb') || lower.includes('adobe-rgb')) {
      return 'adobe-rgb';
    }
    if (lower.includes('display p3') || lower.includes('display-p3') || lower.includes('dci-p3') || lower.includes('dci p3')) {
      return 'display-p3';
    }
    if (lower.includes('bt.2020') || lower.includes('bt2020') || lower.includes('rec.2020') || lower.includes('rec2020')) {
      return 'bt2020';
    }
    if (lower.includes('prophoto') || lower.includes('romm rgb') || lower.includes('pro photo')) {
      return 'prophoto-rgb';
    }
    if (lower.includes('srgb') || lower.includes('s-rgb')) {
      return 'srgb';
    }
  } catch {
    // Ignore decode errors
  }
  return 'srgb';
}

/**
 * Extracts ICC Profile binary from JPEG APP2 marker segments (\xFF\xE2).
 */
export function extractJpegIccProfile(bytes: Uint8Array): Uint8Array | null {
  const len = bytes.length;
  const chunks: Array<{ seq: number; total: number; data: Uint8Array }> = [];

  for (let i = 0; i < len - 18; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xe2) {
      const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
      if (segLen < 16 || i + 2 + segLen > len) continue;

      // Check header "ICC_PROFILE\0"
      if (
        bytes[i + 4] === 0x49 && // 'I'
        bytes[i + 5] === 0x43 && // 'C'
        bytes[i + 6] === 0x43 && // 'C'
        bytes[i + 7] === 0x5f && // '_'
        bytes[i + 8] === 0x50 && // 'P'
        bytes[i + 9] === 0x52 && // 'R'
        bytes[i + 10] === 0x4f && // 'O'
        bytes[i + 11] === 0x46 && // 'F'
        bytes[i + 12] === 0x49 && // 'I'
        bytes[i + 13] === 0x4c && // 'L'
        bytes[i + 14] === 0x45 && // 'E'
        bytes[i + 15] === 0x00
      ) {
        const seq = bytes[i + 16];
        const total = bytes[i + 17];
        const data = bytes.subarray(i + 18, i + 2 + segLen);
        chunks.push({ seq, total, data });
      }
      i += 1 + segLen;
    } else if (bytes[i] === 0xff && bytes[i + 1] === 0xda) {
      // Start of Scan: markers end
      break;
    }
  }

  if (chunks.length === 0) return null;
  chunks.sort((a, b) => a.seq - b.seq);
  let totalBytes = 0;
  for (const c of chunks) totalBytes += c.data.length;
  const fullIcc = new Uint8Array(totalBytes);
  let curOffset = 0;
  for (const c of chunks) {
    fullIcc.set(c.data, curOffset);
    curOffset += c.data.length;
  }
  return fullIcc.length >= 128 ? fullIcc : null;
}

function readTagValues(
  view: DataView,
  littleEndian: boolean,
  type: number,
  count: number,
  valueOffsetFieldPos: number
): number[] {
  const typeSizes: Record<number, number> = {
    1: 1, // BYTE
    2: 1, // ASCII
    3: 2, // SHORT
    4: 4, // LONG
    5: 8, // RATIONAL
    6: 1, // SBYTE
    7: 1, // UNDEFINED
    8: 2, // SSHORT
    9: 4, // SLONG
    10: 8, // SRATIONAL
  };
  const elemSize = typeSizes[type] || 1;
  const totalBytes = elemSize * count;
  const dataPos =
    totalBytes <= 4 ? valueOffsetFieldPos : view.getUint32(valueOffsetFieldPos, littleEndian);

  if (dataPos < 0 || dataPos + totalBytes > view.byteLength) return [];

  const result: number[] = [];
  const safeCount = Math.min(count, 65536);
  for (let i = 0; i < safeCount; i++) {
    const pos = dataPos + i * elemSize;
    if (type === 1 || type === 2 || type === 7) {
      result.push(view.getUint8(pos));
    } else if (type === 3) {
      result.push(view.getUint16(pos, littleEndian));
    } else if (type === 4) {
      result.push(view.getUint32(pos, littleEndian));
    } else if (type === 5) {
      const num = view.getUint32(pos, littleEndian);
      const den = view.getUint32(pos + 4, littleEndian);
      result.push(den !== 0 ? num / den : 0);
    } else if (type === 8) {
      result.push(view.getInt16(pos, littleEndian));
    } else if (type === 9) {
      result.push(view.getInt32(pos, littleEndian));
    } else if (type === 10) {
      const num = view.getInt32(pos, littleEndian);
      const den = view.getInt32(pos + 4, littleEndian);
      result.push(den !== 0 ? num / den : 0);
    }
  }
  return result;
}

function parseSingleIfd(
  view: DataView,
  ifdOffset: number,
  littleEndian: boolean
): { summary: TiffIfdSummary; nextIfdOffset: number } | null {
  if (ifdOffset <= 0 || ifdOffset + 2 > view.byteLength) return null;
  const numEntries = view.getUint16(ifdOffset, littleEndian);
  if (numEntries <= 0 || numEntries > 512 || ifdOffset + 2 + numEntries * 12 > view.byteLength) {
    return null;
  }

  const summary: TiffIfdSummary = {
    width: 0,
    height: 0,
    bitsPerSample: [],
    compression: 1,
    photometric: 2,
    samplesPerPixel: 3,
    stripOffsets: [],
    stripByteCounts: [],
    jpegOffset: 0,
    jpegLength: 0,
    rw2JpgFromRawOffset: 0,
    rw2JpgFromRawLength: 0,
    subIfdOffsets: [],
    exifIfdOffset: 0,
    orientation: 1,
  };

  for (let i = 0; i < numEntries; i++) {
    const entryPos = ifdOffset + 2 + i * 12;
    const tag = view.getUint16(entryPos, littleEndian);
    const type = view.getUint16(entryPos + 2, littleEndian);
    const count = view.getUint32(entryPos + 4, littleEndian);
    const valPos = entryPos + 8;

    if (tag === 0x002e && count > 1024) {
      // Panasonic RW2 JpgFromRaw (embedded full-resolution camera-processed JPEG)
      const dataOffset = view.getUint32(valPos, littleEndian);
      if (dataOffset > 0 && dataOffset + count <= view.byteLength) {
        summary.rw2JpgFromRawOffset = dataOffset;
        summary.rw2JpgFromRawLength = count;
      }
      continue;
    }

    if (type === 2) {
      const strOffset = count <= 4 ? valPos : view.getUint32(valPos, littleEndian);
      if (strOffset > 0 && strOffset < view.byteLength) {
        const strVal = readAscii(view, strOffset, count);
        if (tag === 271 && strVal) summary.make = strVal;
        else if (tag === 272 && strVal) summary.model = strVal;
        else if (tag === 305 && strVal) summary.software = strVal;
        else if (tag === 306 && strVal) summary.dateTime = strVal;
      }
      continue;
    }

    if (tag === 34675 && count >= 128) {
      // ICC Profile tag
      const dataOffset = count <= 4 ? valPos : view.getUint32(valPos, littleEndian);
      if (dataOffset > 0 && dataOffset + count <= view.byteLength) {
        summary.iccProfileBytes = new Uint8Array(view.buffer, view.byteOffset + dataOffset, count).slice();
      }
      continue;
    }

    const vals = readTagValues(view, littleEndian, type, count, valPos);
    if (vals.length === 0) continue;

    switch (tag) {
      case 256: // ImageWidth
        summary.width = vals[0];
        break;
      case 257: // ImageLength
        summary.height = vals[0];
        break;
      case 258: // BitsPerSample
        summary.bitsPerSample = vals;
        break;
      case 259: // Compression
        summary.compression = vals[0];
        break;
      case 262: // PhotometricInterpretation
        summary.photometric = vals[0];
        break;
      case 273: // StripOffsets
        summary.stripOffsets = vals;
        break;
      case 274: // Orientation
        summary.orientation = vals[0];
        break;
      case 277: // SamplesPerPixel
        summary.samplesPerPixel = vals[0];
        break;
      case 279: // StripByteCounts
        summary.stripByteCounts = vals;
        break;
      case 330: // SubIFDs
        summary.subIfdOffsets = vals;
        break;
      case 513: // JPEGInterchangeFormat
        summary.jpegOffset = vals[0];
        break;
      case 514: // JPEGInterchangeFormatLength
        summary.jpegLength = vals[0];
        break;
      case 34665: // ExifIFD
        summary.exifIfdOffset = vals[0];
        break;
      case 40961: // ColorSpace
        summary.colorSpaceTag = vals[0];
        break;
    }
  }

  const nextIfdPos = ifdOffset + 2 + numEntries * 12;
  const nextIfdOffset =
    nextIfdPos + 4 <= view.byteLength ? view.getUint32(nextIfdPos, littleEndian) : 0;

  return { summary, nextIfdOffset };
}

function parseExifSubIfd(
  view: DataView,
  exifOffset: number,
  littleEndian: boolean,
  exifOut: ExifMetadata
): { colorSpaceTag?: number } {
  let colorSpaceTag: number | undefined;
  if (exifOffset <= 0 || exifOffset + 2 > view.byteLength) return { colorSpaceTag };
  const numEntries = view.getUint16(exifOffset, littleEndian);
  if (numEntries <= 0 || numEntries > 512 || exifOffset + 2 + numEntries * 12 > view.byteLength) {
    return { colorSpaceTag };
  }

  for (let i = 0; i < numEntries; i++) {
    const entryPos = exifOffset + 2 + i * 12;
    const tag = view.getUint16(entryPos, littleEndian);
    const type = view.getUint16(entryPos + 2, littleEndian);
    const count = view.getUint32(entryPos + 4, littleEndian);
    const valPos = entryPos + 8;

    if (type === 2) {
      const strOffset = count <= 4 ? valPos : view.getUint32(valPos, littleEndian);
      if (strOffset > 0 && strOffset < view.byteLength) {
        const strVal = readAscii(view, strOffset, count);
        if ((tag === 36867 || tag === 36868) && strVal && !exifOut.dateTime) {
          exifOut.dateTime = strVal;
        }
      }
      continue;
    }

    if (tag === 33434 && type === 5) {
      // ExposureTime
      const dataPos = view.getUint32(valPos, littleEndian);
      if (dataPos + 8 <= view.byteLength) {
        const num = view.getUint32(dataPos, littleEndian);
        const den = view.getUint32(dataPos + 4, littleEndian);
        if (den > 0 && num > 0) {
          exifOut.exposureTime =
            num < den ? `1/${Math.round(den / num)}s` : `${(num / den).toFixed(2)}s`;
        }
      }
      continue;
    }

    const vals = readTagValues(view, littleEndian, type, count, valPos);
    if (vals.length === 0) continue;

    if (tag === 33437 && vals[0] > 0) {
      // FNumber
      exifOut.fNumber = Math.round(vals[0] * 10) / 10;
    } else if ((tag === 34855 || tag === 0x0017) && vals[0] > 0) {
      // ISOSpeedRatings / Panasonic ISO
      exifOut.iso = Math.round(vals[0]);
    } else if (tag === 37386 && vals[0] > 0) {
      // FocalLength
      exifOut.focalLength = `${Math.round(vals[0] * 10) / 10}mm`;
    } else if (tag === 40961) {
      // ColorSpace: 1=sRGB, 2=Adobe RGB, 65535=Uncalibrated/Wide
      colorSpaceTag = vals[0];
    }
  }

  return { colorSpaceTag };
}

/**
 * Scans an ArrayBuffer for the largest valid embedded JPEG stream (\xFF\xD8\xFF ... \xFF\xD9).
 * Used as a universal fallback for any camera RAW container (.RW2, .RAF, .CR3, .ORF, .NEF, .ARW).
 */
function findLargestEmbeddedJpeg(bytes: Uint8Array): Uint8Array | null {
  let bestStart = -1;
  let bestEnd = -1;
  let bestLen = 0;

  const len = bytes.length;
  for (let i = 0; i < len - 16; i++) {
    // Look for JPEG SOI + APP0/APP1/APP2/DQT/SOF marker: FF D8 FF (E0..EF or DB or C0..C4)
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
      const m = bytes[i + 3];
      if ((m >= 0xe0 && m <= 0xef) || m === 0xdb || m === 0xc0 || m === 0xc2 || m === 0xc4) {
        // Walk JPEG segments or search forward for matching EOI
        let pos = i + 2;
        let foundSos = false;
        while (pos < len - 4) {
          if (bytes[pos] !== 0xff) {
            pos++;
            continue;
          }
          while (pos < len && bytes[pos] === 0xff) pos++;
          if (pos >= len) break;
          const marker = bytes[pos];
          pos++;

          if (marker === 0xd9) {
            if (foundSos) {
              const candidateLen = pos - i;
              if (candidateLen > bestLen) {
                bestLen = candidateLen;
                bestStart = i;
                bestEnd = pos;
              }
            }
            break;
          }
          if (marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
            continue;
          }
          if (pos + 2 > len) break;
          const segLen = (bytes[pos] << 8) | bytes[pos + 1];
          if (segLen < 2 || pos + segLen > len) break;
          if (marker === 0xda) {
            // Start of Scan (SOS) — entropy coded data follows until FF D9
            foundSos = true;
            pos += segLen;
            while (pos < len - 1) {
              if (bytes[pos] === 0xff && bytes[pos + 1] === 0xd9) {
                pos += 2;
                const candidateLen = pos - i;
                if (candidateLen > bestLen) {
                  bestLen = candidateLen;
                  bestStart = i;
                  bestEnd = pos;
                }
                // Advance outer loop past this full JPEG stream
                i = pos - 1;
                break;
              }
              pos++;
            }
            break;
          } else {
            pos += segLen;
          }
        }
      }
    }
  }

  if (bestStart >= 0 && bestEnd > bestStart && bestLen > 8192) {
    return bytes.subarray(bestStart, bestEnd);
  }
  return null;
}

/**
 * Decodes an uncompressed 8-bit or 16-bit TIFF/DNG IFD into planar/interleaved RGB arrays.
 */
function decodeUncompressedIfdPixels(
  buffer: ArrayBuffer,
  ifd: TiffIfdSummary,
  littleEndian: boolean
): { width: number; height: number; rgb16?: Uint16Array; rgb8?: Uint8Array } | null {
  if (ifd.compression !== 1) return null;
  if (ifd.width <= 0 || ifd.height <= 0 || ifd.stripOffsets.length === 0) return null;
  const bps = ifd.bitsPerSample[0] || 8;
  if (bps !== 8 && bps !== 16) return null;
  const spp = ifd.samplesPerPixel || 3;
  if (spp !== 1 && spp !== 3 && spp !== 4) return null;
  // Exclude Bayer CFA raw mosaic (Photometric 32803) from direct RGB strip copy
  if (ifd.photometric === 32803) return null;

  const totalPixels = ifd.width * ifd.height;
  const bytesPerSample = bps === 16 ? 2 : 1;
  const expectedTotalBytes = totalPixels * spp * bytesPerSample;

  let availableBytes = 0;
  for (const bc of ifd.stripByteCounts) availableBytes += bc;
  if (availableBytes < expectedTotalBytes) return null;

  const view = new DataView(buffer);
  if (bps === 16) {
    const out16 = new Uint16Array(totalPixels * 3);
    let dstPixel = 0;
    for (let s = 0; s < ifd.stripOffsets.length; s++) {
      const offset = ifd.stripOffsets[s];
      const byteCount = ifd.stripByteCounts[s] || 0;
      const samplesInStrip = Math.floor(byteCount / 2);
      const pixelsInStrip = Math.floor(samplesInStrip / spp);
      for (let p = 0; p < pixelsInStrip && dstPixel < totalPixels; p++) {
        const baseByte = offset + p * spp * 2;
        if (baseByte + spp * 2 > buffer.byteLength) break;
        if (spp === 1) {
          const v = view.getUint16(baseByte, littleEndian);
          out16[dstPixel * 3] = v;
          out16[dstPixel * 3 + 1] = v;
          out16[dstPixel * 3 + 2] = v;
        } else {
          out16[dstPixel * 3] = view.getUint16(baseByte, littleEndian);
          out16[dstPixel * 3 + 1] = view.getUint16(baseByte + 2, littleEndian);
          out16[dstPixel * 3 + 2] = view.getUint16(baseByte + 4, littleEndian);
        }
        dstPixel++;
      }
    }
    if (dstPixel === totalPixels) {
      return { width: ifd.width, height: ifd.height, rgb16: out16 };
    }
  } else {
    const out8 = new Uint8Array(totalPixels * 3);
    const srcBytes = new Uint8Array(buffer);
    let dstPixel = 0;
    for (let s = 0; s < ifd.stripOffsets.length; s++) {
      const offset = ifd.stripOffsets[s];
      const byteCount = ifd.stripByteCounts[s] || 0;
      const pixelsInStrip = Math.floor(byteCount / spp);
      for (let p = 0; p < pixelsInStrip && dstPixel < totalPixels; p++) {
        const baseByte = offset + p * spp;
        if (baseByte + spp > buffer.byteLength) break;
        if (spp === 1) {
          const v = srcBytes[baseByte];
          out8[dstPixel * 3] = v;
          out8[dstPixel * 3 + 1] = v;
          out8[dstPixel * 3 + 2] = v;
        } else {
          out8[dstPixel * 3] = srcBytes[baseByte];
          out8[dstPixel * 3 + 1] = srcBytes[baseByte + 1];
          out8[dstPixel * 3 + 2] = srcBytes[baseByte + 2];
        }
        dstPixel++;
      }
    }
    if (dstPixel === totalPixels) {
      return { width: ifd.width, height: ifd.height, rgb8: out8 };
    }
  }

  return null;
}

/**
 * Decodes a JPEG/PNG/WebP Blob into an exact RGB8 Uint8Array using createImageBitmap + OffscreenCanvas
 * with colorSpaceConversion: 'none' to preserve 100% of the original file's color and contrast.
 */
async function decodeBlobToRgb8(
  blob: Blob
): Promise<{ width: number; height: number; rgb8: Uint8Array }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
  } catch {
    bitmap = await createImageBitmap(blob);
  }

  const width = bitmap.width;
  const height = bitmap.height;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    throw new Error('OffscreenCanvas 2D 컨텍스트를 생성할 수 없습니다.');
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imgData = ctx.getImageData(0, 0, width, height);
  const rgba = imgData.data;
  const numPixels = width * height;
  const rgb8 = new Uint8Array(numPixels * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb8[j] = rgba[i];
    rgb8[j + 1] = rgba[i + 1];
    rgb8[j + 2] = rgba[i + 2];
  }
  return { width, height, rgb8 };
}

/**
 * Calibrates per-channel 65,536-entry monotonic CDF Lookup Tables mapping a 16-bit linear image
 * to the camera's reference 8-bit preview (or builds a rich camera S-curve LUT if no preview is present).
 */
function buildCameraMatchedLutsFrom16Bit(
  rgb16: Uint16Array,
  width: number,
  height: number,
  refPreview8?: { width: number; height: number; rgb8: Uint8Array } | null
): {
  origRgb8: Uint8Array;
  lutR: Uint8Array;
  lutG: Uint8Array;
  lutB: Uint8Array;
  exposureScale: number;
} {
  const numPixels = width * height;
  const lutR = new Uint8Array(65536);
  const lutG = new Uint8Array(65536);
  const lutB = new Uint8Array(65536);

  if (refPreview8 && refPreview8.rgb8.length >= 3) {
    // Build per-channel monotonic CDF matching LUTs between 16-bit data and camera preview
    const hist16R = new Uint32Array(65536);
    const hist16G = new Uint32Array(65536);
    const hist16B = new Uint32Array(65536);
    const step16 = Math.max(1, Math.floor(numPixels / 200000));
    let count16 = 0;
    for (let i = 0; i < numPixels; i += step16) {
      const idx = i * 3;
      hist16R[rgb16[idx]]++;
      hist16G[rgb16[idx + 1]]++;
      hist16B[rgb16[idx + 2]]++;
      count16++;
    }

    const hist8R = new Uint32Array(256);
    const hist8G = new Uint32Array(256);
    const hist8B = new Uint32Array(256);
    const refPixels = refPreview8.width * refPreview8.height;
    const step8 = Math.max(1, Math.floor(refPixels / 200000));
    let count8 = 0;
    const p8 = refPreview8.rgb8;
    for (let i = 0; i < refPixels; i += step8) {
      const idx = i * 3;
      hist8R[p8[idx]]++;
      hist8G[p8[idx + 1]]++;
      hist8B[p8[idx + 2]]++;
      count8++;
    }

    const matchChannelCdf = (h16: Uint32Array, h8: Uint32Array, outLut: Uint8Array) => {
      const cdf8 = new Float64Array(256);
      let acc8 = 0;
      for (let k = 0; k < 256; k++) {
        acc8 += h8[k];
        cdf8[k] = acc8 / Math.max(1, count8);
      }
      let acc16 = 0;
      let target8 = 0;
      for (let v = 0; v < 65536; v++) {
        acc16 += h16[v];
        const p = acc16 / Math.max(1, count16);
        while (target8 < 255 && cdf8[target8] < p) {
          target8++;
        }
        outLut[v] = target8;
      }
    };

    matchChannelCdf(hist16R, hist8R, lutR);
    matchChannelCdf(hist16G, hist8G, lutG);
    matchChannelCdf(hist16B, hist8B, lutB);

    const origRgb8 = new Uint8Array(numPixels * 3);
    if (refPreview8.width === width && refPreview8.height === height) {
      origRgb8.set(refPreview8.rgb8);
    } else {
      for (let i = 0; i < numPixels * 3; i += 3) {
        origRgb8[i] = lutR[rgb16[i]];
        origRgb8[i + 1] = lutG[rgb16[i + 1]];
        origRgb8[i + 2] = lutB[rgb16[i + 2]];
      }
    }
    return { origRgb8, lutR, lutG, lutB, exposureScale: 1.0 };
  }

  // Standard 16-bit TIFF or Linear DNG without separate preview:
  // Detect whether data is already gamma-encoded 16-bit sRGB or linear 16-bit
  let sumMid = 0;
  let sampleCount = 0;
  const stride = Math.max(1, Math.floor(numPixels / 50000));
  const lumSamples = new Float32Array(Math.ceil(numPixels / stride));
  for (let i = 0, s = 0; i < numPixels; i += stride, s++) {
    const idx = i * 3;
    const lum = (0.2126 * rgb16[idx] + 0.7152 * rgb16[idx + 1] + 0.0722 * rgb16[idx + 2]) / 65535.0;
    lumSamples[s] = lum;
    sumMid += lum;
    sampleCount++;
  }
  const sortedLum = lumSamples.subarray(0, sampleCount).sort();
  const p50 = sortedLum[Math.floor(sampleCount * 0.5)] || 0.25;
  const p995 = sortedLum[Math.min(sampleCount - 1, Math.floor(sampleCount * 0.996))] || 0.95;

  // If median brightness is >= 0.22, the 16-bit TIFF is already in perceptual sRGB space
  const isAlreadyPerceptual16 = p50 >= 0.22 && sumMid / Math.max(1, sampleCount) >= 0.22;
  const exposureScale = isAlreadyPerceptual16
    ? 1.0
    : Math.max(0.5, Math.min(16.0, 0.94 / Math.max(p995, 1e-4)));

  for (let v = 0; v < 65536; v++) {
    let val8: number;
    if (isAlreadyPerceptual16) {
      val8 = Math.max(0, Math.min(255, Math.round(v / 257.0)));
    } else {
      const exposed = Math.max(0.0, Math.min(1.0, (v / 65535.0) * exposureScale));
      const srgb =
        exposed <= 0.0031308
          ? exposed * 12.92
          : 1.055 * Math.pow(Math.max(exposed, 1e-8), 1.0 / 2.4) - 0.055;
      val8 = Math.max(0, Math.min(255, Math.round(srgb * 255.0)));
    }
    lutR[v] = val8;
    lutG[v] = val8;
    lutB[v] = val8;
  }

  const origRgb8 = new Uint8Array(numPixels * 3);
  for (let i = 0; i < numPixels * 3; i += 3) {
    origRgb8[i] = lutR[rgb16[i]];
    origRgb8[i + 1] = lutG[rgb16[i + 1]];
    origRgb8[i + 2] = lutB[rgb16[i + 2]];
  }

  return { origRgb8, lutR, lutG, lutB, exposureScale };
}

/**
 * Decodes any supported camera RAW (.RW2, .DNG, .CR2, .CR3, .NEF, .ARW, .ORF, .PEF, .RAF),
 * 16-bit/8-bit .TIFF, .PNG, or .JPG file completely locally in the browser Worker.
 * Preserves 100% of the original photo's color, tone curve, and deep shadow blacks.
 */
export async function decodeImageFileLocal(
  fileName: string,
  buffer: ArrayBuffer
): Promise<DecodedImagePayload> {
  const dotIdx = fileName.lastIndexOf('.');
  const ext = dotIdx >= 0 ? fileName.slice(dotIdx + 1).toLowerCase() : 'jpg';
  const isRaw = RAW_EXT_SET.has(ext);

  const exif: ExifMetadata = {
    make: isRaw ? 'Camera' : 'Unknown',
    model: isRaw ? `${ext.toUpperCase()} Sensor` : 'Camera Sensor',
    iso: null,
    fNumber: null,
    exposureTime: null,
    focalLength: null,
    dateTime: null,
    software: 'SensorClean Local 16-bit Engine',
  };

  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // Check for TIFF / RW2 / DNG / NEF / CR2 / ARW / ORF header (II or MM)
  let littleEndian: boolean | null = null;
  let magic = 0;
  if (buffer.byteLength > 16) {
    const b0 = bytes[0];
    const b1 = bytes[1];
    if (b0 === 0x49 && b1 === 0x49) {
      littleEndian = true;
      magic = view.getUint16(2, true);
    } else if (b0 === 0x4d && b1 === 0x4d) {
      littleEndian = false;
      magic = view.getUint16(2, false);
    } else if (
      b0 === 0xff &&
      b1 === 0xd8 &&
      bytes[2] === 0xff &&
      bytes[3] === 0xe1 &&
      buffer.byteLength > 32
    ) {
      // JPEG APP1 EXIF header check
      if (
        bytes[6] === 0x45 &&
        bytes[7] === 0x78 &&
        bytes[8] === 0x69 &&
        bytes[9] === 0x66
      ) {
        const tiffStart = 12;
        const subView = new DataView(buffer, tiffStart);
        const sb0 = subView.getUint8(0);
        const sb1 = subView.getUint8(1);
        if (sb0 === 0x49 && sb1 === 0x49) {
          const firstIfd = subView.getUint32(4, true);
          const parsed = parseSingleIfd(subView, firstIfd, true);
          if (parsed) {
            if (parsed.summary.make) exif.make = parsed.summary.make;
            if (parsed.summary.model) exif.model = parsed.summary.model;
            if (parsed.summary.dateTime) exif.dateTime = parsed.summary.dateTime;
            if (parsed.summary.exifIfdOffset) {
              parseExifSubIfd(subView, parsed.summary.exifIfdOffset, true, exif);
            }
          }
        } else if (sb0 === 0x4d && sb1 === 0x4d) {
          const firstIfd = subView.getUint32(4, false);
          const parsed = parseSingleIfd(subView, firstIfd, false);
          if (parsed) {
            if (parsed.summary.make) exif.make = parsed.summary.make;
            if (parsed.summary.model) exif.model = parsed.summary.model;
            if (parsed.summary.dateTime) exif.dateTime = parsed.summary.dateTime;
            if (parsed.summary.exifIfdOffset) {
              parseExifSubIfd(subView, parsed.summary.exifIfdOffset, false, exif);
            }
          }
        }
      }
    }
  }

  let uncompressed16: { width: number; height: number; rgb16: Uint16Array } | null = null;
  let uncompressed8: { width: number; height: number; rgb8: Uint8Array } | null = null;
  let bestEmbeddedJpegBytes: Uint8Array | null = null;
  let detectedIccBytes: Uint8Array | undefined = undefined;
  let detectedColorSpace: ColorSpaceId = isRaw ? 'adobe-rgb' : 'srgb';

  // Parse TIFF / RW2 / DNG / RAW IFD tree if header is II/MM (magic 42 standard TIFF, 85 Panasonic RW2, 0x4F52 Olympus ORF)
  if (littleEndian !== null && (magic === 42 || magic === 85 || magic === 0x4f52 || magic === 0x5352)) {
    const firstIfdOffset = view.getUint32(4, littleEndian);
    const visitedOffsets = new Set<number>();
    const queue: number[] = [firstIfdOffset];

    while (queue.length > 0) {
      const curOffset = queue.shift()!;
      if (!curOffset || visitedOffsets.has(curOffset) || visitedOffsets.size > 32) continue;
      visitedOffsets.add(curOffset);

      const parsed = parseSingleIfd(view, curOffset, littleEndian);
      if (!parsed) continue;
      const { summary, nextIfdOffset } = parsed;

      if (summary.iccProfileBytes && !detectedIccBytes) {
        detectedIccBytes = summary.iccProfileBytes;
        detectedColorSpace = detectColorSpaceFromIcc(detectedIccBytes);
      }
      if (summary.colorSpaceTag === 2) {
        detectedColorSpace = 'adobe-rgb';
      }

      if (summary.make && (exif.make === 'Unknown' || exif.make === 'Camera')) {
        exif.make = summary.make;
      }
      if (summary.model && (exif.model === 'Camera Sensor' || exif.model.endsWith('Sensor'))) {
        exif.model = summary.model;
      }
      if (summary.dateTime && !exif.dateTime) {
        exif.dateTime = summary.dateTime;
      }
      if (summary.exifIfdOffset > 0) {
        const subRes = parseExifSubIfd(view, summary.exifIfdOffset, littleEndian, exif);
        if (subRes.colorSpaceTag === 2) {
          detectedColorSpace = 'adobe-rgb';
        }
      }

      // Check for Panasonic RW2 JpgFromRaw (Tag 0x002E)
      if (
        summary.rw2JpgFromRawOffset > 0 &&
        summary.rw2JpgFromRawLength > (bestEmbeddedJpegBytes?.length || 0)
      ) {
        bestEmbeddedJpegBytes = bytes.subarray(
          summary.rw2JpgFromRawOffset,
          summary.rw2JpgFromRawOffset + summary.rw2JpgFromRawLength
        );
      }

      // Check for JPEGInterchangeFormat (Tag 513 / 514)
      if (
        summary.jpegOffset > 0 &&
        summary.jpegLength > (bestEmbeddedJpegBytes?.length || 0) &&
        summary.jpegOffset + summary.jpegLength <= buffer.byteLength
      ) {
        bestEmbeddedJpegBytes = bytes.subarray(
          summary.jpegOffset,
          summary.jpegOffset + summary.jpegLength
        );
      }

      // Check for JPEG-compressed Strip (Compression 6 or 7)
      if (
        (summary.compression === 6 || summary.compression === 7) &&
        summary.stripOffsets.length === 1 &&
        summary.stripByteCounts.length === 1
      ) {
        const sOff = summary.stripOffsets[0];
        const sLen = summary.stripByteCounts[0];
        if (
          sOff > 0 &&
          sLen > (bestEmbeddedJpegBytes?.length || 0) &&
          sOff + sLen <= buffer.byteLength &&
          bytes[sOff] === 0xff &&
          bytes[sOff + 1] === 0xd8
        ) {
          bestEmbeddedJpegBytes = bytes.subarray(sOff, sOff + sLen);
        }
      }

      // Check for uncompressed 16-bit or 8-bit RGB strips (e.g. 16-bit TIFF or Dual-IFD Linear DNG)
      const decodedIfd = decodeUncompressedIfdPixels(buffer, summary, littleEndian);
      if (decodedIfd) {
        if (decodedIfd.rgb16) {
          if (
            !uncompressed16 ||
            decodedIfd.width * decodedIfd.height > uncompressed16.width * uncompressed16.height
          ) {
            uncompressed16 = {
              width: decodedIfd.width,
              height: decodedIfd.height,
              rgb16: decodedIfd.rgb16,
            };
          }
        } else if (decodedIfd.rgb8) {
          if (
            !uncompressed8 ||
            decodedIfd.width * decodedIfd.height > uncompressed8.width * uncompressed8.height
          ) {
            uncompressed8 = {
              width: decodedIfd.width,
              height: decodedIfd.height,
              rgb8: decodedIfd.rgb8,
            };
          }
        }
      }

      for (const subOff of summary.subIfdOffsets) {
        if (subOff > 0) queue.push(subOff);
      }
      if (nextIfdOffset > 0) {
        queue.push(nextIfdOffset);
      }
    }
  }

  // Case 1: Uncompressed 16-bit RGB data available (e.g. 16-bit TIFF or Linear DNG SubIFD0)
  if (uncompressed16) {
    let refPreview = uncompressed8;
    if (!refPreview && bestEmbeddedJpegBytes) {
      try {
        refPreview = await decodeBlobToRgb8(
          new Blob([bestEmbeddedJpegBytes as unknown as BlobPart], { type: 'image/jpeg' })
        );
      } catch {
        // ignore preview decode error
      }
    }
    const { origRgb8, lutR, lutG, lutB, exposureScale } = buildCameraMatchedLutsFrom16Bit(
      uncompressed16.rgb16,
      uncompressed16.width,
      uncompressed16.height,
      refPreview
    );
    return {
      fullWidth: uncompressed16.width,
      fullHeight: uncompressed16.height,
      origRgb8,
      linear16: uncompressed16.rgb16,
      lut16ToOrig8R: lutR,
      lut16ToOrig8G: lutG,
      lut16ToOrig8B: lutB,
      isRaw,
      extension: ext.toUpperCase(),
      exposureScale,
      detectedColorSpace,
      rawIccProfileBytes: detectedIccBytes,
      exif,
    };
  }

  // Case 2: Uncompressed 8-bit TIFF
  if (uncompressed8 && !isRaw) {
    const numPixels = uncompressed8.width * uncompressed8.height;
    const linear16 = new Uint16Array(numPixels * 3);
    const src8 = uncompressed8.rgb8;
    for (let i = 0; i < src8.length; i++) {
      linear16[i] = SRGB8_TO_LINEAR16_LUT[src8[i]];
    }
    return {
      fullWidth: uncompressed8.width,
      fullHeight: uncompressed8.height,
      origRgb8: src8,
      linear16,
      lut16ToOrig8R: LINEAR16_TO_SRGB8_LUT,
      lut16ToOrig8G: LINEAR16_TO_SRGB8_LUT,
      lut16ToOrig8B: LINEAR16_TO_SRGB8_LUT,
      isRaw: false,
      extension: ext.toUpperCase(),
      exposureScale: 1.0,
      detectedColorSpace,
      rawIccProfileBytes: detectedIccBytes,
      exif,
    };
  }

  // Case 3: Camera RAW (.RW2, .CR2, .CR3, .NEF, .ARW, .ORF, .PEF, .RAF, compressed .DNG)
  // Extract the camera's full-resolution embedded preview (which contains the exact camera ISP color profile & S-curve)
  if (!bestEmbeddedJpegBytes && isRaw) {
    bestEmbeddedJpegBytes = findLargestEmbeddedJpeg(bytes);
  }

  // Check for JPEG APP2 ICC profile in either embedded JPEG or standalone image
  if (!detectedIccBytes) {
    const targetJpg = bestEmbeddedJpegBytes || bytes;
    const jpgIcc = extractJpegIccProfile(targetJpg);
    if (jpgIcc) {
      detectedIccBytes = jpgIcc;
      detectedColorSpace = detectColorSpaceFromIcc(jpgIcc);
    }
  }

  let decoded8: { width: number; height: number; rgb8: Uint8Array };
  if (bestEmbeddedJpegBytes) {
    decoded8 = await decodeBlobToRgb8(
      new Blob([bestEmbeddedJpegBytes as unknown as BlobPart], { type: 'image/jpeg' })
    );
  } else if (uncompressed8) {
    decoded8 = uncompressed8;
  } else {
    // Standard PNG / JPG / WebP or browser-supported image
    decoded8 = await decodeBlobToRgb8(new Blob([buffer]));
  }

  const numPixels = decoded8.width * decoded8.height;
  const origRgb8 = decoded8.rgb8;
  const linear16 = new Uint16Array(numPixels * 3);
  for (let i = 0; i < origRgb8.length; i++) {
    linear16[i] = SRGB8_TO_LINEAR16_LUT[origRgb8[i]];
  }

  return {
    fullWidth: decoded8.width,
    fullHeight: decoded8.height,
    origRgb8,
    linear16,
    lut16ToOrig8R: LINEAR16_TO_SRGB8_LUT,
    lut16ToOrig8G: LINEAR16_TO_SRGB8_LUT,
    lut16ToOrig8B: LINEAR16_TO_SRGB8_LUT,
    isRaw,
    extension: ext.toUpperCase(),
    exposureScale: 1.0,
    detectedColorSpace,
    rawIccProfileBytes: detectedIccBytes,
    exif,
  };
}
