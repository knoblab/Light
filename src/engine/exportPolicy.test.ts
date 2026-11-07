import { describe, expect, it } from 'vitest';
import { getDecodeNotice, isDngExportAllowed } from './exportPolicy';
import type { DecodeKind, SessionMetadata } from '../types/sensor';

const meta = (decodeKind: DecodeKind | undefined, isRaw: boolean) =>
  ({ decodeKind, isRaw } as unknown as SessionMetadata);

describe('isDngExportAllowed', () => {
  it('allows only sessions backed by RAW-derived 16-bit data', () => {
    expect(isDngExportAllowed(meta('raw-linear16', true))).toBe(true);
    expect(isDngExportAllowed(meta('raw-developed', true))).toBe(true);
  });

  it('rejects embedded previews and ordinary images', () => {
    expect(isDngExportAllowed(meta('embedded-preview', true))).toBe(false);
    expect(isDngExportAllowed(meta('image-8bit', false))).toBe(false);
    expect(isDngExportAllowed(meta('image-16bit', false))).toBe(false);
  });

  it('falls back to isRaw for sessions without decodeKind and rejects missing meta', () => {
    expect(isDngExportAllowed(meta(undefined, true))).toBe(true);
    expect(isDngExportAllowed(meta(undefined, false))).toBe(false);
    expect(isDngExportAllowed(null)).toBe(false);
  });
});

describe('getDecodeNotice', () => {
  it('warns for previews and developed RAW, stays silent otherwise', () => {
    expect(getDecodeNotice(meta('embedded-preview', true))).toContain('미리보기');
    expect(getDecodeNotice(meta('raw-developed', true))).toContain('현상');
    expect(getDecodeNotice(meta('raw-linear16', true))).toBeNull();
    expect(getDecodeNotice(meta('image-8bit', false))).toBeNull();
    expect(getDecodeNotice(null)).toBeNull();
  });
});
