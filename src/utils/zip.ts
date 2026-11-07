/**
 * Standalone browser-memory ZIP file creator.
 * Pure TypeScript, zero external dependencies.
 */

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

export function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

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
