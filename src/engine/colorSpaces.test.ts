import { describe, expect, it } from 'vitest';
import { buildIccProfileBytes, COLOR_SPACE_DEFS } from './colorSpaces';
import type { ColorSpaceId } from '../types/sensor';

const SPACES = Object.keys(COLOR_SPACE_DEFS) as Array<Exclude<ColorSpaceId, 'auto'>>;

describe.each(SPACES)('buildIccProfileBytes(%s)', (space) => {
  const bytes = buildIccProfileBytes(space);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  it('writes a header whose size matches the buffer', () => {
    expect(view.getUint32(0, false)).toBe(bytes.length);
    expect(bytes.length % 4).toBe(0);
  });

  it("carries the 'acsp' signature and RGB/XYZ spaces", () => {
    const ascii = (offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4));
    expect(ascii(36)).toBe('acsp');
    expect(ascii(16)).toBe('RGB ');
    expect(ascii(20)).toBe('XYZ ');
  });

  it('has all tags inside the profile and 4-byte aligned', () => {
    const tagCount = view.getUint32(128, false);
    expect(tagCount).toBe(9);
    const sigs: string[] = [];
    for (let i = 0; i < tagCount; i++) {
      const entry = 132 + i * 12;
      sigs.push(String.fromCharCode(...bytes.slice(entry, entry + 4)));
      const offset = view.getUint32(entry + 4, false);
      const size = view.getUint32(entry + 8, false);
      expect(offset % 4).toBe(0);
      expect(offset + size).toBeLessThanOrEqual(bytes.length);
    }
    expect(sigs).toEqual(['desc', 'cprt', 'wtpt', 'rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC']);
  });
});
