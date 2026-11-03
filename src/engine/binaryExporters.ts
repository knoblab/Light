import { ColorSpaceId, SessionMetadata } from '../types/sensor';
import { resizeRgb8Area } from './dustAlgorithms';
import { buildIccProfileBytes, COLOR_SPACE_DEFS } from './colorSpaces';

/**
 * Encodes an RGB8 buffer (W x H x 3) into a PNG or JPEG Blob via OffscreenCanvas.
 */
export async function encodeRgb8ToBlob(
  rgb8: Uint8Array,
  width: number,
  height: number,
  mimeType: 'image/jpeg' | 'image/png' = 'image/jpeg',
  quality = 0.96
): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D 컨텍스트 생성 실패');

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < rgb8.length; i += 3, j += 4) {
    rgba[j] = rgb8[i];
    rgba[j + 1] = rgb8[i + 1];
    rgba[j + 2] = rgb8[i + 2];
    rgba[j + 3] = 255;
  }

  const imgData = new ImageData(rgba, width, height);
  ctx.putImageData(imgData, 0, 0);

  return await canvas.convertToBlob({
    type: mimeType,
    quality: mimeType === 'image/jpeg' ? quality : undefined,
  });
}

/**
 * Encodes a single-channel U8 mask (W x H) into a PNG or JPEG Blob.
 */
export async function encodeMaskU8ToBlob(
  maskU8: Uint8Array,
  width: number,
  height: number
): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D 컨텍스트 생성 실패');

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < maskU8.length; i++, j += 4) {
    const v = maskU8[i];
    rgba[j] = v;
    rgba[j + 1] = v;
    rgba[j + 2] = v;
    rgba[j + 3] = 255;
  }

  const imgData = new ImageData(rgba, width, height);
  ctx.putImageData(imgData, 0, 0);
  return await canvas.convertToBlob({ type: 'image/png' });
}

interface TiffTagEntry {
  tag: number;
  type: number; // 1=BYTE, 2=ASCII, 3=SHORT, 4=LONG, 5=RATIONAL, 10=SRATIONAL, 11=FLOAT
  count: number;
  writeData: (view: DataView, offset: number) => void;
}

function makeShortTag(tag: number, values: number[]): TiffTagEntry {
  return {
    tag,
    type: 3,
    count: values.length,
    writeData: (view, offset) => {
      for (let i = 0; i < values.length; i++) {
        view.setUint16(offset + i * 2, values[i], true);
      }
    },
  };
}

function makeLongTag(tag: number, values: number[]): TiffTagEntry {
  return {
    tag,
    type: 4,
    count: values.length,
    writeData: (view, offset) => {
      for (let i = 0; i < values.length; i++) {
        view.setUint32(offset + i * 4, values[i] >>> 0, true);
      }
    },
  };
}

function makeByteTag(tag: number, values: number[]): TiffTagEntry {
  return {
    tag,
    type: 1,
    count: values.length,
    writeData: (view, offset) => {
      for (let i = 0; i < values.length; i++) {
        view.setUint8(offset + i, values[i] & 0xff);
      }
    },
  };
}

function makeAsciiTag(tag: number, str: string): TiffTagEntry {
  const clean = str.replace(/[^\x20-\x7E]/g, '').trim() || 'Camera';
  const bytes = new Uint8Array(clean.length + 1);
  for (let i = 0; i < clean.length; i++) bytes[i] = clean.charCodeAt(i);
  bytes[clean.length] = 0;
  return {
    tag,
    type: 2,
    count: bytes.length,
    writeData: (view, offset) => {
      for (let i = 0; i < bytes.length; i++) {
        view.setUint8(offset + i, bytes[i]);
      }
    },
  };
}

function makeRationalTag(tag: number, pairs: Array<[number, number]>): TiffTagEntry {
  return {
    tag,
    type: 5,
    count: pairs.length,
    writeData: (view, offset) => {
      for (let i = 0; i < pairs.length; i++) {
        view.setUint32(offset + i * 8, pairs[i][0] >>> 0, true);
        view.setUint32(offset + i * 8 + 4, pairs[i][1] >>> 0, true);
      }
    },
  };
}

function makeSRationalTag(tag: number, pairs: Array<[number, number]>): TiffTagEntry {
  return {
    tag,
    type: 10,
    count: pairs.length,
    writeData: (view, offset) => {
      for (let i = 0; i < pairs.length; i++) {
        view.setInt32(offset + i * 8, pairs[i][0] | 0, true);
        view.setInt32(offset + i * 8 + 4, pairs[i][1] | 0, true);
      }
    },
  };
}

function makeFloatTag(tag: number, values: number[]): TiffTagEntry {
  return {
    tag,
    type: 11,
    count: values.length,
    writeData: (view, offset) => {
      for (let i = 0; i < values.length; i++) {
        view.setFloat32(offset + i * 4, values[i], true);
      }
    },
  };
}

function makeUndefinedTag(tag: number, data: Uint8Array): TiffTagEntry {
  return {
    tag,
    type: 7, // UNDEFINED
    count: data.length,
    writeData: (view, offset) => {
      const u8 = new Uint8Array(view.buffer, view.byteOffset + offset, data.length);
      u8.set(data);
    },
  };
}

/**
 * Injects an ICC Profile into a JPEG Blob using the standard APP2 marker (\xFF\xE2 "ICC_PROFILE\0").
 */
export async function injectIccProfileToJpegBlob(jpegBlob: Blob, iccBytes: Uint8Array): Promise<Blob> {
  const origBuf = await jpegBlob.arrayBuffer();
  const origU8 = new Uint8Array(origBuf);

  // JPEG starts with SOI (\xFF\xD8)
  if (origU8.length < 4 || origU8[0] !== 0xff || origU8[1] !== 0xd8) {
    return jpegBlob;
  }

  // Max payload per APP2 chunk is 65535 - 2 (length) - 14 ("ICC_PROFILE\0" + seq + total) = 65519
  const MAX_CHUNK = 65519;
  const totalChunks = Math.ceil(iccBytes.length / MAX_CHUNK);
  const app2Segments: Uint8Array[] = [];

  for (let seq = 1; seq <= totalChunks; seq++) {
    const start = (seq - 1) * MAX_CHUNK;
    const end = Math.min(iccBytes.length, seq * MAX_CHUNK);
    const chunkData = iccBytes.subarray(start, end);
    const segLen = 2 + 14 + chunkData.length;

    const seg = new Uint8Array(2 + segLen);
    seg[0] = 0xff;
    seg[1] = 0xe2; // APP2
    seg[2] = (segLen >> 8) & 0xff;
    seg[3] = segLen & 0xff;

    // "ICC_PROFILE\0"
    const sig = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00];
    for (let k = 0; k < 12; k++) seg[4 + k] = sig[k];
    seg[16] = seq;
    seg[17] = totalChunks;
    seg.set(chunkData, 18);
    app2Segments.push(seg);
  }

  // Combine: SOI (2 bytes) + APP2 segments + rest of JPEG (from offset 2)
  const totalLength = 2 + app2Segments.reduce((sum, s) => sum + s.length, 0) + (origU8.length - 2);
  const result = new Uint8Array(totalLength);
  result.set(origU8.subarray(0, 2), 0);
  let offset = 2;
  for (const seg of app2Segments) {
    result.set(seg, offset);
    offset += seg.length;
  }
  result.set(origU8.subarray(2), offset);

  return new Blob([result.buffer], { type: 'image/jpeg' });
}

function getTiffTypeByteSize(type: number): number {
  switch (type) {
    case 1:
    case 2:
    case 7:
      return 1;
    case 3:
      return 2;
    case 4:
    case 11:
      return 4;
    case 5:
    case 10:
      return 8;
    default:
      return 1;
  }
}

function writeIfdBlock(
  view: DataView,
  ifdOffset: number,
  entries: TiffTagEntry[],
  nextIfdOffset: number
): number {
  // Sort entries strictly by ascending tag ID per TIFF/DNG specification
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const numEntries = sorted.length;
  view.setUint16(ifdOffset, numEntries, true);

  let extraOffset = ifdOffset + 2 + numEntries * 12 + 4;
  if (extraOffset % 2 !== 0) extraOffset++;

  for (let i = 0; i < numEntries; i++) {
    const e = sorted[i];
    const entryPos = ifdOffset + 2 + i * 12;
    const totalBytes = getTiffTypeByteSize(e.type) * e.count;

    view.setUint16(entryPos, e.tag, true);
    view.setUint16(entryPos + 2, e.type, true);
    view.setUint32(entryPos + 4, e.count, true);

    if (totalBytes <= 4) {
      view.setUint32(entryPos + 8, 0, true);
      e.writeData(view, entryPos + 8);
    } else {
      view.setUint32(entryPos + 8, extraOffset, true);
      e.writeData(view, extraOffset);
      extraOffset += totalBytes;
      if (extraOffset % 2 !== 0) extraOffset++;
    }
  }

  view.setUint32(ifdOffset + 2 + numEntries * 12, nextIfdOffset, true);
  return extraOffset;
}

/**
 * Builds a standard Dual-IFD 16-bit Linear DNG 1.4 binary ArrayBuffer:
 *   - IFD0: High-resolution 8-bit RGB preview with 100% original camera color & contrast
 *     paired with embedded Tag 34675 (ICCProfile) for wide gamut color spaces (Adobe RGB, P3, BT.2020)
 *   - SubIFD0: Full-resolution 16-bit LinearRaw RGB with D65 ColorMatrix1 + ProfileToneCurve
 *     (for Adobe Lightroom, Camera Raw, Darktable, and professional 16-bit workflows)
 */
export function writeLinearDngBuffer(
  healedRgb8: Uint8Array,
  healedLinear16: Uint16Array,
  fullW: number,
  fullH: number,
  meta: SessionMetadata,
  targetColorSpace: ColorSpaceId = 'auto',
  customIccProfile?: Uint8Array
): ArrayBuffer {
  const maxPrevDim = 2560;
  let prevW = fullW;
  let prevH = fullH;
  let prevRgb8 = healedRgb8;
  if (Math.max(fullW, fullH) > maxPrevDim) {
    const scale = maxPrevDim / Math.max(fullW, fullH);
    prevW = Math.max(1, Math.round(fullW * scale));
    prevH = Math.max(1, Math.round(fullH * scale));
    prevRgb8 = resizeRgb8Area(healedRgb8, fullW, fullH, prevW, prevH);
  }

  const makeStr = meta.exif?.make || 'Panasonic';
  const modelStr = meta.exif?.model || 'Lumix Camera Sensor';
  const uniqueModel = `${makeStr} ${modelStr}`.trim();

  const effectiveSpace: Exclude<ColorSpaceId, 'auto'> =
    targetColorSpace === 'auto'
      ? (meta.detectedColorSpace && meta.detectedColorSpace !== 'auto' ? meta.detectedColorSpace : 'adobe-rgb')
      : targetColorSpace;

  const colorMatrix1 = COLOR_SPACE_DEFS[effectiveSpace]?.dngColorMatrix1 || [
    [32405, 10000], [-15371, 10000], [-4985, 10000],
    [-9693, 10000], [18760, 10000],  [416, 10000],
    [556, 10000],   [-2040, 10000],  [10572, 10000],
  ];

  const iccBytes = customIccProfile || buildIccProfileBytes(effectiveSpace);
  const profileName = COLOR_SPACE_DEFS[effectiveSpace]?.name || 'Adobe RGB (1998)';

  // Camera S-Curve ProfileToneCurve (Tag 50940 / 0xC6FC) so Lightroom/ACR renders deep blacks and rich contrast
  const profileToneCurveFloats = [
    0.0, 0.0,
    0.06, 0.038,
    0.15, 0.125,
    0.35, 0.365,
    0.65, 0.705,
    0.85, 0.895,
    1.0, 1.0,
  ];

  const prevByteCount = prevW * prevH * 3;
  const raw16ByteCount = fullW * fullH * 3 * 2;

  // Reserve 16384 bytes for headers + IFD0 + SubIFD0 + ICC profile metadata before pixel strips
  const headerReserve = 16384;
  const prevStripOffset = headerReserve;
  const raw16StripOffset = prevStripOffset + prevByteCount + (prevByteCount % 2);
  const totalBufferSize = raw16StripOffset + raw16ByteCount;

  const buffer = new ArrayBuffer(totalBufferSize);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  // Little-Endian TIFF magic header: 'II', 42, offset to IFD0 = 8
  u8[0] = 0x49;
  u8[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);

  // Placeholder SubIFD0 offset (will be computed after sizing IFD0)
  const subIfdOffset = 4096;

  const ifd0Entries: TiffTagEntry[] = [
    makeLongTag(254, [1]), // NewSubfileType = 1 (Preview / Reduced-res)
    makeLongTag(256, [prevW]),
    makeLongTag(257, [prevH]),
    makeShortTag(258, [8, 8, 8]),
    makeShortTag(259, [1]), // Uncompressed
    makeShortTag(262, [2]), // Photometric = RGB
    makeAsciiTag(271, makeStr),
    makeAsciiTag(272, modelStr),
    makeLongTag(273, [prevStripOffset]),
    makeShortTag(274, [1]), // Orientation = TopLeft
    makeShortTag(277, [3]), // SamplesPerPixel = 3
    makeLongTag(278, [prevH]),
    makeLongTag(279, [prevByteCount]),
    makeRationalTag(282, [[72, 1]]),
    makeRationalTag(283, [[72, 1]]),
    makeShortTag(284, [1]), // PlanarConfig = Contig
    makeShortTag(296, [2]), // ResolutionUnit = Inch
    makeAsciiTag(305, 'SensorClean Pro Wide-Gamut DNG Engine'),
    makeLongTag(330, [subIfdOffset]), // SubIFDs pointer -> SubIFD0
    makeUndefinedTag(34675, iccBytes), // Tag 34675 ICCProfile
    makeByteTag(50706, [1, 4, 0, 0]), // DNGVersion 1.4.0.0
    makeByteTag(50707, [1, 1, 0, 0]), // DNGBackwardVersion 1.1.0.0
    makeAsciiTag(50708, uniqueModel), // UniqueCameraModel
    makeSRationalTag(50721, colorMatrix1), // ColorMatrix1
    makeRationalTag(50728, [[10000, 10000], [10000, 10000], [10000, 10000]]), // AsShotNeutral
    makeShortTag(50740, [21]), // CalibrationIlluminant1 = D65
    makeAsciiTag(50936, profileName), // ProfileName
    makeFloatTag(50940, profileToneCurveFloats), // ProfileToneCurve
  ];

  const subIfdEntries: TiffTagEntry[] = [
    makeLongTag(254, [0]), // NewSubfileType = 0 (Full-res Main Image)
    makeLongTag(256, [fullW]),
    makeLongTag(257, [fullH]),
    makeShortTag(258, [16, 16, 16]),
    makeShortTag(259, [1]), // Uncompressed
    makeShortTag(262, [34892]), // Photometric = LinearRaw
    makeLongTag(273, [raw16StripOffset]),
    makeShortTag(277, [3]),
    makeLongTag(278, [fullH]),
    makeLongTag(279, [raw16ByteCount]),
    makeRationalTag(282, [[72, 1]]),
    makeRationalTag(283, [[72, 1]]),
    makeShortTag(284, [1]),
    makeShortTag(296, [2]),
    makeLongTag(50714, [0, 0, 0]), // BlackLevel
    makeLongTag(50717, [65535, 65535, 65535]), // WhiteLevel
  ];

  writeIfdBlock(view, 8, ifd0Entries, 0);
  writeIfdBlock(view, subIfdOffset, subIfdEntries, 0);

  // Write IFD0 8-bit preview pixels (100% original camera colors & contrast)
  u8.set(prevRgb8, prevStripOffset);

  // Write SubIFD0 16-bit Linear RGB pixels (Little-Endian uint16)
  const dst16 = new Uint16Array(buffer, raw16StripOffset, healedLinear16.length);
  dst16.set(healedLinear16);

  return buffer;
}

/**
 * Builds a standard 16-bit uncompressed RGB TIFF binary ArrayBuffer (.tiff)
 * with Tag 34675 (ICCProfile) embedded for wide-gamut reproduction.
 */
export function writeTiff16Buffer(
  healedRgb8: Uint8Array,
  healedLinear16: Uint16Array,
  fullW: number,
  fullH: number,
  meta: SessionMetadata,
  targetColorSpace: ColorSpaceId = 'auto',
  customIccProfile?: Uint8Array
): ArrayBuffer {
  const numSamples = fullW * fullH * 3;
  const raw16ByteCount = numSamples * 2;

  const effectiveSpace: Exclude<ColorSpaceId, 'auto'> =
    targetColorSpace === 'auto'
      ? (meta.detectedColorSpace && meta.detectedColorSpace !== 'auto' ? meta.detectedColorSpace : 'adobe-rgb')
      : targetColorSpace;

  const iccBytes = customIccProfile || buildIccProfileBytes(effectiveSpace);

  const headerReserve = 8192;
  const stripOffset = headerReserve;
  const totalBufferSize = stripOffset + raw16ByteCount;

  const buffer = new ArrayBuffer(totalBufferSize);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  u8[0] = 0x49;
  u8[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);

  const makeStr = meta.exif?.make || 'Camera';
  const modelStr = meta.exif?.model || 'Sensor';

  const entries: TiffTagEntry[] = [
    makeLongTag(254, [0]),
    makeLongTag(256, [fullW]),
    makeLongTag(257, [fullH]),
    makeShortTag(258, [16, 16, 16]),
    makeShortTag(259, [1]), // Uncompressed
    makeShortTag(262, [2]), // Photometric = 2 (RGB)
    makeAsciiTag(271, makeStr),
    makeAsciiTag(272, modelStr),
    makeLongTag(273, [stripOffset]),
    makeShortTag(274, [1]),
    makeShortTag(277, [3]),
    makeLongTag(278, [fullH]),
    makeLongTag(279, [raw16ByteCount]),
    makeRationalTag(282, [[72, 1]]),
    makeRationalTag(283, [[72, 1]]),
    makeShortTag(284, [1]),
    makeShortTag(296, [2]),
    makeAsciiTag(305, 'SensorClean Pro Wide-Gamut 16-bit TIFF Engine'),
    makeUndefinedTag(34675, iccBytes), // Tag 34675 ICCProfile
  ];

  writeIfdBlock(view, 8, entries, 0);

  // Expand camera-accurate healedRgb8 to 16-bit (0..65535) with low-order bit precision from healedLinear16
  const dst16 = new Uint16Array(buffer, stripOffset, numSamples);
  for (let i = 0; i < numSamples; i++) {
    const v8 = healedRgb8[i];
    const subLsb = healedLinear16[i] & 0xff;
    dst16[i] = v8 === 255 ? 65535 : v8 === 0 ? 0 : (v8 << 8) | subLsb;
  }

  return buffer;
}

// Precomputed CRC32 table for standard ZIP archive generation
const CRC32_TABLE = new Uint32Array(256);
(function initCrc32() {
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    CRC32_TABLE[i] = c >>> 0;
  }
})();

function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Packs multiple named binary files into a standard uncompressed .ZIP Blob in browser memory.
 */
export function buildZipArchiveBlob(
  files: Array<{ name: string; data: Uint8Array }>
): Blob {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let currentOffset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = computeCrc32(file.data);
    const size = file.data.byteLength;

    // Local file header (30 bytes + file name)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // Local file header signature
    lv.setUint16(4, 20, true);         // Version needed to extract (2.0)
    lv.setUint16(6, 0x0800, true);     // UTF-8 filename flag
    lv.setUint16(8, 0, true);          // Compression method = 0 (STORE)
    lv.setUint16(10, 0, true);         // Last mod file time
    lv.setUint16(12, 0, true);         // Last mod file date
    lv.setUint32(14, crc, true);       // CRC-32
    lv.setUint32(18, size, true);      // Compressed size
    lv.setUint32(22, size, true);      // Uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);         // Extra field length
    localHeader.set(nameBytes, 30);

    // Central directory header (46 bytes + file name)
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true); // Central file header signature
    cv.setUint16(4, 20, true);         // Version made by
    cv.setUint16(6, 20, true);         // Version needed
    cv.setUint16(8, 0x0800, true);     // UTF-8 flag
    cv.setUint16(10, 0, true);         // Compression method = STORE
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, currentOffset, true);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, file.data);
    centralParts.push(centralHeader);
    currentOffset += localHeader.byteLength + size;
  }

  let centralSize = 0;
  for (const cp of centralParts) centralSize += cp.byteLength;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // End of central dir signature
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, currentOffset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, eocd] as unknown as BlobPart[], {
    type: 'application/zip',
  });
}
