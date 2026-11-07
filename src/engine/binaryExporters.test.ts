import { describe, expect, it } from 'vitest';
import { writeLinearDngBuffer, writeTiff16Buffer } from './binaryExporters';
import type { SessionMetadata } from '../types/sensor';

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

interface Range {
  start: number;
  end: number;
  label: string;
}

interface Entry {
  tag: number;
  type: number;
  count: number;
  valueOffset: number;
  inline: boolean;
}

interface ParsedIfd {
  label: string;
  entries: Map<number, Entry>;
}

function parseTiff(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  expect(view.getUint16(0, true)).toBe(0x4949);
  expect(view.getUint16(2, true)).toBe(42);

  const ranges: Range[] = [{ start: 0, end: 8, label: 'header' }];
  const ifds: ParsedIfd[] = [];

  const readIfd = (offset: number, label: string) => {
    expect(offset, `${label} offset in range`).toBeGreaterThan(0);
    expect(offset + 2, `${label} header in range`).toBeLessThanOrEqual(buffer.byteLength);
    const count = view.getUint16(offset, true);
    const blockEnd = offset + 2 + count * 12 + 4;
    expect(blockEnd, `${label} block in range`).toBeLessThanOrEqual(buffer.byteLength);
    ranges.push({ start: offset, end: blockEnd, label: `${label} ifd` });

    const entries = new Map<number, Entry>();
    for (let i = 0; i < count; i++) {
      const pos = offset + 2 + i * 12;
      const tag = view.getUint16(pos, true);
      const type = view.getUint16(pos + 2, true);
      const n = view.getUint32(pos + 4, true);
      const size = (TYPE_SIZE[type] ?? 1) * n;
      const inline = size <= 4;
      const valueOffset = inline ? pos + 8 : view.getUint32(pos + 8, true);
      if (!inline) {
        expect(valueOffset + size, `${label} tag ${tag} data in range`).toBeLessThanOrEqual(buffer.byteLength);
        ranges.push({ start: valueOffset, end: valueOffset + size, label: `${label} tag ${tag}` });
      }
      entries.set(tag, { tag, type, count: n, valueOffset, inline });
    }
    const parsed = { label, entries };
    ifds.push(parsed);
    return parsed;
  };

  const ifd0 = readIfd(view.getUint32(4, true), 'IFD0');
  const subIfdEntry = ifd0.entries.get(330);
  const exifEntry = ifd0.entries.get(34665);
  const subIfd = subIfdEntry ? readIfd(view.getUint32(subIfdEntry.valueOffset, true), 'SubIFD') : null;
  const exifIfd = exifEntry ? readIfd(view.getUint32(exifEntry.valueOffset, true), 'ExifIFD') : null;

  const addStrip = (ifd: ParsedIfd | null) => {
    if (!ifd) return null;
    const off = ifd.entries.get(273);
    const len = ifd.entries.get(279);
    expect(off, `${ifd.label} StripOffsets`).toBeTruthy();
    expect(len, `${ifd.label} StripByteCounts`).toBeTruthy();
    const start = view.getUint32(off!.valueOffset, true);
    const size = view.getUint32(len!.valueOffset, true);
    expect(start + size, `${ifd.label} strip in range`).toBeLessThanOrEqual(buffer.byteLength);
    ranges.push({ start, end: start + size, label: `${ifd.label} pixels` });
    return { start, size };
  };
  const strip0 = addStrip(ifd0);
  const stripSub = addStrip(subIfd);

  return { view, ranges, ifd0, subIfd, exifIfd, strip0, stripSub };
}

function expectNoOverlap(ranges: Range[]) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    expect(cur.start, `${prev.label} [${prev.start},${prev.end}) overlaps ${cur.label} [${cur.start},${cur.end})`)
      .toBeGreaterThanOrEqual(prev.end);
  }
}

function readBytes(view: DataView, entry: Entry): Uint8Array {
  const size = (TYPE_SIZE[entry.type] ?? 1) * entry.count;
  return new Uint8Array(view.buffer, entry.valueOffset, size).slice();
}

function makeMeta(xmpSize: number): SessionMetadata {
  const xmp = new Uint8Array(xmpSize);
  for (let i = 0; i < xmp.length; i++) xmp[i] = 0x41 + (i % 26);
  return {
    originalFileName: 'test.rw2',
    extension: 'RW2',
    isRaw: true,
    isLinear16: true,
    fullWidth: 64,
    fullHeight: 48,
    workWidth: 64,
    workHeight: 48,
    workScale: 1,
    exposureScale: 1.5,
    bitDepth: '16-bit',
    colorSpace: 'sRGB',
    detectedColorSpace: 'srgb',
    cameraWb: [1, 1, 1, 1],
    colorMatrix: [],
    blackLevel: [0, 0, 0, 0],
    whiteLevel: 65535,
    bayerPattern: 'RGBG',
    stats16Bit: { minCodeValue: 0, maxCodeValue: 65535, meanCodeValue: 1000, estimatedDynamicRangeEv: 12 },
    exif: {
      make: 'TestMake',
      model: 'TestModel',
      iso: 200,
      fNumber: 2.8,
      exposureTime: '1/250s',
      focalLength: '35mm',
      dateTime: '2026:11:05 10:00:00',
      software: 'test',
      artist: 'Some Artist',
      copyright: 'Copyright 2026 Some Artist',
      lensModel: 'Test Lens 35mm F2.8',
      rawXmpBytes: xmp,
    },
  };
}

function makePixels(w: number, h: number) {
  const rgb8 = new Uint8Array(w * h * 3);
  const linear16 = new Uint16Array(w * h * 3);
  for (let i = 0; i < linear16.length; i++) {
    rgb8[i] = (i * 7) & 0xff;
    linear16[i] = (i * 257 + 13) & 0xffff;
  }
  return { rgb8, linear16 };
}

describe.each([0, 600, 20000, 100000])('TIFF writers with %i byte XMP', (xmpSize) => {
  const meta = makeMeta(xmpSize);
  const { rgb8, linear16 } = makePixels(meta.fullWidth, meta.fullHeight);

  it('writeLinearDngBuffer keeps IFDs, tag data and pixels disjoint', () => {
    const buf = writeLinearDngBuffer(rgb8, linear16, meta.fullWidth, meta.fullHeight, meta, 'srgb');
    const parsed = parseTiff(buf);
    expectNoOverlap(parsed.ranges);

    if (xmpSize > 0) {
      const xmp = readBytes(parsed.view, parsed.ifd0.entries.get(700)!);
      expect(xmp).toEqual(meta.exif.rawXmpBytes);
    }

    const raw = new Uint16Array(buf, parsed.stripSub!.start, linear16.length);
    expect(raw[0]).toBe(linear16[0]);
    expect(raw[raw.length - 1]).toBe(linear16[linear16.length - 1]);
    expect(parsed.stripSub!.size).toBe(linear16.length * 2);
  });

  it('writeTiff16Buffer keeps IFDs, tag data and pixels disjoint', () => {
    const buf = writeTiff16Buffer(rgb8, linear16, meta.fullWidth, meta.fullHeight, meta, 'srgb');
    const parsed = parseTiff(buf);
    expectNoOverlap(parsed.ranges);

    if (xmpSize > 0) {
      const xmp = readBytes(parsed.view, parsed.ifd0.entries.get(700)!);
      expect(xmp).toEqual(meta.exif.rawXmpBytes);
    }
    expect(parsed.strip0!.size).toBe(linear16.length * 2);
  });
});
