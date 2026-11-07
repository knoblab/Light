import { ColorSpaceId, ColorSpaceInfo } from '../types/sensor';

export const COLOR_SPACE_OPTIONS: ColorSpaceInfo[] = [
  {
    id: 'auto',
    label: '원본 색공간 유지 (자동 감지)',
    shortLabel: '원본 유지',
    description: '촬영 시 카메라의 내장 광색역 프로파일 및 ICC를 그대로 유지하여 색 손실을 방지합니다.',
    gamutCoverage: '원본 1:1',
  },
  {
    id: 'adobe-rgb',
    label: 'Adobe RGB (1998)',
    shortLabel: 'Adobe RGB',
    description: '인쇄 및 사진 전문 표준 광색역. 시안/녹색 영역이 넓어 풍경 및 자연 사진에 최적입니다.',
    gamutCoverage: 'CIE 1931 ~52.1%',
  },
  {
    id: 'display-p3',
    label: 'DCI-P3 / Display P3',
    shortLabel: 'Display P3',
    description: '애플 및 최신 모바일/OLED 표준 광색역. sRGB 대비 25% 넓으며 레드와 그린이 선명합니다.',
    gamutCoverage: 'CIE 1931 ~45.5%',
  },
  {
    id: 'bt2020',
    label: 'ITU-R BT.2020 (Rec.2020)',
    shortLabel: 'BT.2020',
    description: '차세대 초광색역 표준. 현존하는 거의 모든 가시광선 영역을 포함하는 가장 넓은 색공간입니다.',
    gamutCoverage: 'CIE 1931 ~75.8%',
  },
  {
    id: 'prophoto-rgb',
    label: 'ProPhoto RGB (ROMM RGB)',
    shortLabel: 'ProPhoto RGB',
    description: '라이트룸 16비트 마스터용 광색역. 센서의 전 다이내믹 레인지를 온전히 수용합니다.',
    gamutCoverage: 'CIE 1931 ~90.0%',
  },
  {
    id: 'srgb',
    label: 'sRGB (웹 표준)',
    shortLabel: 'sRGB',
    description: '일반 웹 및 모니터 표준 색역. 범용 호환성이 높으나 녹색과 딥 블루가 좁습니다.',
    gamutCoverage: 'CIE 1931 ~35.9%',
  },
];

interface Chromaticity {
  rx: number;
  ry: number;
  gx: number;
  gy: number;
  bx: number;
  by: number;
  wx: number;
  wy: number;
}

export interface ColorSpaceDef {
  id: ColorSpaceId;
  name: string;
  chromaticity: Chromaticity;
  gamma: number; // 0 for sRGB/P3 piece-wise, >0 for pure power
  dngColorMatrix1: Array<[number, number]>; // XYZ D65 -> RGB
}

// Color primaries & D65/D50 white points
export const COLOR_SPACE_DEFS: Record<Exclude<ColorSpaceId, 'auto'>, ColorSpaceDef> = {
  'adobe-rgb': {
    id: 'adobe-rgb',
    name: 'Adobe RGB (1998)',
    chromaticity: {
      rx: 0.64, ry: 0.33,
      gx: 0.21, gy: 0.71,
      bx: 0.15, by: 0.06,
      wx: 0.3127, wy: 0.3290, // D65
    },
    gamma: 2.19921875, // 563/256
    dngColorMatrix1: [
      [20415, 10000], [-5650, 10000], [-3447, 10000],
      [-9692, 10000], [18759, 10000], [415, 10000],
      [136, 10000],   [-1414, 10000], [10141, 10000],
    ],
  },
  'display-p3': {
    id: 'display-p3',
    name: 'Display P3',
    chromaticity: {
      rx: 0.680, ry: 0.320,
      gx: 0.265, gy: 0.690,
      bx: 0.150, by: 0.060,
      wx: 0.3127, wy: 0.3290, // D65
    },
    gamma: 0, // piece-wise sRGB transfer curve
    dngColorMatrix1: [
      [24934, 10000], [-9313, 10000], [-4027, 10000],
      [-8294, 10000], [17626, 10000], [236, 10000],
      [368, 10000],   [-759, 10000],  [9571, 10000],
    ],
  },
  'bt2020': {
    id: 'bt2020',
    name: 'ITU-R BT.2020',
    chromaticity: {
      rx: 0.708, ry: 0.292,
      gx: 0.170, gy: 0.797,
      bx: 0.131, by: 0.046,
      wx: 0.3127, wy: 0.3290, // D65
    },
    gamma: 0.45, // Rec.2020 transfer
    dngColorMatrix1: [
      [17166, 10000], [-3556, 10000], [-2534, 10000],
      [-6667, 10000], [16165, 10000], [158, 10000],
      [176, 10000],   [-428, 10000],  [9421, 10000],
    ],
  },
  'prophoto-rgb': {
    id: 'prophoto-rgb',
    name: 'ProPhoto RGB',
    chromaticity: {
      rx: 0.7347, ry: 0.2653,
      gx: 0.1596, gy: 0.8404,
      bx: 0.0366, by: 0.0001,
      wx: 0.3457, wy: 0.3585, // D50
    },
    gamma: 1.8,
    dngColorMatrix1: [
      [13460, 10000], [-1313, 10000], [-1212, 10000],
      [-5451, 10000], [14264, 10000], [339, 10000],
      [58, 10000],    [-288, 10000],  [9566, 10000],
    ],
  },
  'srgb': {
    id: 'srgb',
    name: 'sRGB IEC61966-2.1',
    chromaticity: {
      rx: 0.64, ry: 0.33,
      gx: 0.30, gy: 0.60,
      bx: 0.15, by: 0.06,
      wx: 0.3127, wy: 0.3290, // D65
    },
    gamma: 0, // piece-wise sRGB transfer
    dngColorMatrix1: [
      [32405, 10000], [-15371, 10000], [-4985, 10000],
      [-9693, 10000], [18760, 10000],  [416, 10000],
      [556, 10000],   [-2040, 10000],  [10572, 10000],
    ],
  },
};

/**
 * Computes 3x3 RGB-to-XYZ matrix given primaries and white point.
 */
function getRgbToXyzMatrix(c: Chromaticity): number[][] {
  const Xr = c.rx / c.ry;
  const Yr = 1.0;
  const Zr = (1.0 - c.rx - c.ry) / c.ry;

  const Xg = c.gx / c.gy;
  const Yg = 1.0;
  const Zg = (1.0 - c.gx - c.gy) / c.gy;

  const Xb = c.bx / c.by;
  const Yb = 1.0;
  const Zb = (1.0 - c.bx - c.by) / c.by;

  const Xw = c.wx / c.wy;
  const Yw = 1.0;
  const Zw = (1.0 - c.wx - c.wy) / c.wy;

  // Invert 3x3 matrix [Xr Xg Xb; Yr Yg Yb; Zr Zg Zb]
  const m = [
    [Xr, Xg, Xb],
    [Yr, Yg, Yb],
    [Zr, Zg, Zb],
  ];

  const det =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

  const invDet = 1.0 / det;
  const inv = [
    [
      (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * invDet,
      (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * invDet,
      (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * invDet,
    ],
    [
      (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * invDet,
      (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * invDet,
      (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * invDet,
    ],
    [
      (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * invDet,
      (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * invDet,
      (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * invDet,
    ],
  ];

  const Sr = inv[0][0] * Xw + inv[0][1] * Yw + inv[0][2] * Zw;
  const Sg = inv[1][0] * Xw + inv[1][1] * Yw + inv[1][2] * Zw;
  const Sb = inv[2][0] * Xw + inv[2][1] * Yw + inv[2][2] * Zw;

  return [
    [Sr * Xr, Sg * Xg, Sb * Xb],
    [Sr * Yr, Sg * Yg, Sb * Yb],
    [Sr * Zr, Sg * Zg, Sb * Zb],
  ];
}

/**
 * Inverts a 3x3 matrix.
 */
function invert3x3(m: number[][]): number[][] {
  const det =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

  const invDet = 1.0 / det;
  return [
    [
      (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * invDet,
      (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * invDet,
      (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * invDet,
    ],
    [
      (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * invDet,
      (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * invDet,
      (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * invDet,
    ],
    [
      (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * invDet,
      (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * invDet,
      (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * invDet,
    ],
  ];
}

/**
 * Multiplies two 3x3 matrices.
 */
function multiply3x3(a: number[][], b: number[][]): number[][] {
  const res = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      res[r][c] = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c];
    }
  }
  return res;
}

// Bradford matrix for chromatic adaptation to D50 (ICC PCS standard)
const BRADFORD_D65_TO_D50 = [
  [1.0478112, 0.0228866, -0.050127],
  [0.0295424, 0.9904844, -0.0170491],
  [-0.0092345, 0.0150436, 0.7521316],
];

/**
 * Returns D50-adapted RGB->XYZ matrix for ICC profile generation.
 */
function getD50AdaptedMatrix(colorSpaceId: Exclude<ColorSpaceId, 'auto'>): number[][] {
  const def = COLOR_SPACE_DEFS[colorSpaceId];
  const mat = getRgbToXyzMatrix(def.chromaticity);
  if (colorSpaceId === 'prophoto-rgb') {
    // ProPhoto RGB is already natively D50
    return mat;
  }
  // Adapt D65 -> D50 via Bradford transform
  return multiply3x3(BRADFORD_D65_TO_D50, mat);
}

/**
 * Generates conversion matrix from src color space to target color space (both in linear domain).
 */
export function getLinearColorConversionMatrix(
  srcId: Exclude<ColorSpaceId, 'auto'>,
  dstId: Exclude<ColorSpaceId, 'auto'>
): number[][] {
  if (srcId === dstId) {
    return [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  }
  const srcRgbToXyz = getRgbToXyzMatrix(COLOR_SPACE_DEFS[srcId].chromaticity);
  const dstXyzToRgb = invert3x3(getRgbToXyzMatrix(COLOR_SPACE_DEFS[dstId].chromaticity));
  return multiply3x3(dstXyzToRgb, srcRgbToXyz);
}

/**
 * Linearizes 8-bit encoded value based on color space TRC.
 */
export function linearizeFromColorSpace(val8: number, colorSpaceId: Exclude<ColorSpaceId, 'auto'>): number {
  const norm = val8 / 255.0;
  const def = COLOR_SPACE_DEFS[colorSpaceId];
  if (def.gamma === 0) {
    // sRGB / Display P3 transfer curve
    return norm <= 0.04045 ? norm / 12.92 : Math.pow((norm + 0.055) / 1.055, 2.4);
  }
  if (colorSpaceId === 'bt2020') {
    const alpha = 1.09929682680944;
    const beta = 0.018053968510807;
    return norm < beta * 4.5 ? norm / 4.5 : Math.pow((norm + (alpha - 1.0)) / alpha, 1.0 / 0.45);
  }
  return Math.pow(norm, def.gamma);
}

/**
 * Encodes linear (0..1) value to 8-bit non-linear value based on target color space TRC.
 */
export function encodeToColorSpace(lin: number, colorSpaceId: Exclude<ColorSpaceId, 'auto'>): number {
  const clamped = Math.max(0.0, Math.min(1.0, lin));
  const def = COLOR_SPACE_DEFS[colorSpaceId];
  let res: number;
  if (def.gamma === 0) {
    res = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(Math.max(clamped, 1e-8), 1.0 / 2.4) - 0.055;
  } else if (colorSpaceId === 'bt2020') {
    const alpha = 1.09929682680944;
    const beta = 0.018053968510807;
    res = clamped < beta ? clamped * 4.5 : alpha * Math.pow(clamped, 0.45) - (alpha - 1.0);
  } else {
    res = Math.pow(clamped, 1.0 / def.gamma);
  }
  return Math.max(0, Math.min(255, Math.round(res * 255.0)));
}

/**
 * Encodes linear (0..1) value to 16-bit non-linear value (0..65535 uint16).
 */
export function encodeToColorSpace16(lin: number, colorSpaceId: Exclude<ColorSpaceId, 'auto'>): number {
  const clamped = Math.max(0.0, Math.min(1.0, lin));
  const def = COLOR_SPACE_DEFS[colorSpaceId];
  let res: number;
  if (def.gamma === 0) {
    res = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(Math.max(clamped, 1e-8), 1.0 / 2.4) - 0.055;
  } else if (colorSpaceId === 'bt2020') {
    const alpha = 1.09929682680944;
    const beta = 0.018053968510807;
    res = clamped < beta ? clamped * 4.5 : alpha * Math.pow(clamped, 0.45) - (alpha - 1.0);
  } else {
    res = Math.pow(clamped, 1.0 / def.gamma);
  }
  return Math.max(0, Math.min(65535, Math.round(res * 65535.0)));
}

/**
 * Transforms an 8-bit RGB buffer from src color space to target color space.
 */
export function transformRgb8ColorSpace(
  srcRgb: Uint8Array,
  dstRgb: Uint8Array,
  srcSpace: Exclude<ColorSpaceId, 'auto'>,
  dstSpace: Exclude<ColorSpaceId, 'auto'>
) {
  if (srcSpace === dstSpace) {
    dstRgb.set(srcRgb);
    return;
  }
  const mat = getLinearColorConversionMatrix(srcSpace, dstSpace);
  const numPixels = Math.floor(srcRgb.length / 3);

  // Precompute 256-entry linearize LUT
  const linLut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    linLut[i] = linearizeFromColorSpace(i, srcSpace);
  }

  const m00 = mat[0][0], m01 = mat[0][1], m02 = mat[0][2];
  const m10 = mat[1][0], m11 = mat[1][1], m12 = mat[1][2];
  const m20 = mat[2][0], m21 = mat[2][1], m22 = mat[2][2];

  for (let i = 0, j = 0; i < numPixels; i++, j += 3) {
    const rL = linLut[srcRgb[j]];
    const gL = linLut[srcRgb[j + 1]];
    const bL = linLut[srcRgb[j + 2]];

    const rT = m00 * rL + m01 * gL + m02 * bL;
    const gT = m10 * rL + m11 * gL + m12 * bL;
    const bT = m20 * rL + m21 * gL + m22 * bL;

    dstRgb[j] = encodeToColorSpace(rT, dstSpace);
    dstRgb[j + 1] = encodeToColorSpace(gT, dstSpace);
    dstRgb[j + 2] = encodeToColorSpace(bT, dstSpace);
  }
}

/**
 * Transforms a 16-bit linear RGB buffer from src color space to target color space.
 */
export function transformLinear16ColorSpace(
  src16: Uint16Array,
  dst16: Uint16Array,
  srcSpace: Exclude<ColorSpaceId, 'auto'>,
  dstSpace: Exclude<ColorSpaceId, 'auto'>
) {
  if (srcSpace === dstSpace) {
    dst16.set(src16);
    return;
  }
  const mat = getLinearColorConversionMatrix(srcSpace, dstSpace);
  const numPixels = Math.floor(src16.length / 3);
  const inv65535 = 1.0 / 65535.0;

  const m00 = mat[0][0], m01 = mat[0][1], m02 = mat[0][2];
  const m10 = mat[1][0], m11 = mat[1][1], m12 = mat[1][2];
  const m20 = mat[2][0], m21 = mat[2][1], m22 = mat[2][2];

  for (let i = 0, j = 0; i < numPixels; i++, j += 3) {
    const rL = src16[j] * inv65535;
    const gL = src16[j + 1] * inv65535;
    const bL = src16[j + 2] * inv65535;

    const rT = m00 * rL + m01 * gL + m02 * bL;
    const gT = m10 * rL + m11 * gL + m12 * bL;
    const bT = m20 * rL + m21 * gL + m22 * bL;

    dst16[j] = Math.max(0, Math.min(65535, Math.round(Math.max(0, rT) * 65535.0)));
    dst16[j + 1] = Math.max(0, Math.min(65535, Math.round(Math.max(0, gT) * 65535.0)));
    dst16[j + 2] = Math.max(0, Math.min(65535, Math.round(Math.max(0, bT) * 65535.0)));
  }
}

/**
 * Converts a floating point number to s15Fixed16Number (32-bit signed fixed point 16.16) for ICC.
 */
function toS15Fixed16(val: number): number {
  return Math.round(val * 65536.0) | 0;
}

/**
 * Builds a standard, fully compliant ICC v2.4 profile binary for any supported color space:
 *   - Adobe RGB (1998)
 *   - Display P3 (DCI-P3)
 *   - ITU-R BT.2020 (Rec.2020)
 *   - ProPhoto RGB
 *   - sRGB IEC61966-2.1
 * Recognized natively by Adobe Lightroom, Photoshop, macOS ColorSync, Windows ICM, and Android Gallery.
 */
export function buildIccProfileBytes(colorSpaceId: Exclude<ColorSpaceId, 'auto'>): Uint8Array {
  const def = COLOR_SPACE_DEFS[colorSpaceId];
  const d50Mat = getD50AdaptedMatrix(colorSpaceId);

  const descText = def.name;
  const copyrightText = 'SensorClean Wide-Gamut Color Engine';

  // We write:
  // 1. Header (128 bytes)
  // 2. Tag Table: 9 tags ('desc', 'cprt', 'wtpt', 'rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC')
  //    Count: 9 * 12 bytes + 4 bytes tag count = 112 bytes
  // 3. Tag Data Elements:
  //    - desc (type 'desc', 4 + 4 + text.length + 1 + 4 + 4 + 2 + 1 + 67 bytes)
  //    - cprt (type 'text', 4 + 4 + text.length + 1)
  //    - wtpt (type 'XYZ ', 4 + 4 + 12 bytes = 20 bytes; D50 = 0.9642, 1.0, 0.8249)
  //    - rXYZ, gXYZ, bXYZ (type 'XYZ ', 20 bytes each)
  //    - rTRC, gTRC, bTRC (type 'curv', 4 + 4 + 4 + (samples or gamma) bytes)

  // Buffer calculation: fixed tags fit in 2 KB; sampled curves (sRGB / Display P3) add 3 x (12 + 1024 * 2) bytes + padding
  const SAMPLED_CURVE_BYTES = 12 + 1024 * 2;
  const totalSize = 2048 + (def.gamma > 0 ? 0 : 3 * (SAMPLED_CURVE_BYTES + 4));
  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      u8[offset + i] = text.charCodeAt(i);
    }
  };

  // 1. Profile Header (128 bytes) - Big-Endian per ICC spec!
  // view.setUint32(0, totalSize, false); will be set at end
  writeAscii(4, 'none'); // Preferred CMM type
  view.setUint32(8, 0x02400000, false); // Version 2.4.0
  writeAscii(12, 'mntr'); // Profile class = display device
  writeAscii(16, 'RGB '); // Color space
  writeAscii(20, 'XYZ '); // Connection space = PCS XYZ
  // Creation date/time (2025-01-01)
  view.setUint16(24, 2025, false);
  view.setUint16(26, 1, false);
  view.setUint16(28, 1, false);
  view.setUint16(30, 0, false);
  view.setUint16(32, 0, false);
  view.setUint16(34, 0, false);
  writeAscii(36, 'acsp'); // Profile file signature
  writeAscii(40, 'APPL'); // Primary platform
  view.setUint32(44, 0, false); // Profile flags
  writeAscii(48, 'ADBE'); // Device manufacturer
  writeAscii(52, 'none'); // Device model
  view.setUint32(64, 0, false); // Rendering intent = Perceptual
  // Illuminant = D50 (0.9642, 1.0, 0.8249) in s15Fixed16Number
  view.setInt32(68, toS15Fixed16(0.9642), false);
  view.setInt32(72, toS15Fixed16(1.0000), false);
  view.setInt32(76, toS15Fixed16(0.8249), false);
  writeAscii(80, 'SCLE'); // Profile creator signature

  // 2. Tag Table
  let tagCount = 9;
  view.setUint32(128, tagCount, false);
  let curTagEntry = 132;
  let curDataOffset = 132 + tagCount * 12;

  const addTag = (sig: string, dataBytesLength: number, writeFn: (offset: number) => void) => {
    // ICC tags must be 4-byte aligned
    if (curDataOffset % 4 !== 0) {
      curDataOffset += 4 - (curDataOffset % 4);
    }
    writeAscii(curTagEntry, sig);
    view.setUint32(curTagEntry + 4, curDataOffset, false);
    view.setUint32(curTagEntry + 8, dataBytesLength, false);
    curTagEntry += 12;

    writeFn(curDataOffset);
    curDataOffset += dataBytesLength;
  };

  // Tag 1: 'desc'
  const descLen = descText.length + 1;
  const descTagTotal = 4 + 4 + 4 + descLen + 4 + 4 + 2 + 1 + 67;
  addTag('desc', descTagTotal, (off) => {
    writeAscii(off, 'desc');
    view.setUint32(off + 4, 0, false);
    view.setUint32(off + 8, descLen, false);
    writeAscii(off + 12, descText);
    u8[off + 12 + descText.length] = 0;
  });

  // Tag 2: 'cprt'
  const cprtLen = copyrightText.length + 1;
  addTag('cprt', 8 + cprtLen, (off) => {
    writeAscii(off, 'text');
    view.setUint32(off + 4, 0, false);
    writeAscii(off + 8, copyrightText);
    u8[off + 8 + copyrightText.length] = 0;
  });

  // Tag 3: 'wtpt' (D50)
  addTag('wtpt', 20, (off) => {
    writeAscii(off, 'XYZ ');
    view.setUint32(off + 4, 0, false);
    view.setInt32(off + 8, toS15Fixed16(0.9642), false);
    view.setInt32(off + 12, toS15Fixed16(1.0000), false);
    view.setInt32(off + 16, toS15Fixed16(0.8249), false);
  });

  // Tag 4: 'rXYZ'
  addTag('rXYZ', 20, (off) => {
    writeAscii(off, 'XYZ ');
    view.setUint32(off + 4, 0, false);
    view.setInt32(off + 8, toS15Fixed16(d50Mat[0][0]), false);
    view.setInt32(off + 12, toS15Fixed16(d50Mat[1][0]), false);
    view.setInt32(off + 16, toS15Fixed16(d50Mat[2][0]), false);
  });

  // Tag 5: 'gXYZ'
  addTag('gXYZ', 20, (off) => {
    writeAscii(off, 'XYZ ');
    view.setUint32(off + 4, 0, false);
    view.setInt32(off + 8, toS15Fixed16(d50Mat[0][1]), false);
    view.setInt32(off + 12, toS15Fixed16(d50Mat[1][1]), false);
    view.setInt32(off + 16, toS15Fixed16(d50Mat[2][1]), false);
  });

  // Tag 6: 'bXYZ'
  addTag('bXYZ', 20, (off) => {
    writeAscii(off, 'XYZ ');
    view.setUint32(off + 4, 0, false);
    view.setInt32(off + 8, toS15Fixed16(d50Mat[0][2]), false);
    view.setInt32(off + 12, toS15Fixed16(d50Mat[1][2]), false);
    view.setInt32(off + 16, toS15Fixed16(d50Mat[2][2]), false);
  });

  // Tone Reproduction Curves ('rTRC', 'gTRC', 'bTRC')
  if (def.gamma > 0) {
    // Pure gamma: curve count = 1, value = gamma * 256 (u8Fixed8)
    const gammaU8Fixed8 = Math.round(def.gamma * 256.0);
    const writeGammaCurv = (off: number) => {
      writeAscii(off, 'curv');
      view.setUint32(off + 4, 0, false);
      view.setUint32(off + 8, 1, false); // count = 1
      view.setUint16(off + 12, gammaU8Fixed8, false);
    };
    addTag('rTRC', 14, writeGammaCurv);
    addTag('gTRC', 14, writeGammaCurv);
    addTag('bTRC', 14, writeGammaCurv);
  } else {
    // sRGB / Display P3: 1024-entry sampled curve
    const numSamples = 1024;
    const curvSize = 12 + numSamples * 2;
    const writeSampledCurv = (off: number) => {
      writeAscii(off, 'curv');
      view.setUint32(off + 4, 0, false);
      view.setUint32(off + 8, numSamples, false);
      for (let i = 0; i < numSamples; i++) {
        const norm = i / (numSamples - 1.0);
        const lin = norm <= 0.04045 ? norm / 12.92 : Math.pow((norm + 0.055) / 1.055, 2.4);
        view.setUint16(off + 12 + i * 2, Math.round(lin * 65535.0), false);
      }
    };
    addTag('rTRC', curvSize, writeSampledCurv);
    addTag('gTRC', curvSize, writeSampledCurv);
    addTag('bTRC', curvSize, writeSampledCurv);
  }

  // Set total profile size in header
  if (curDataOffset % 4 !== 0) curDataOffset += 4 - (curDataOffset % 4);
  view.setUint32(0, curDataOffset, false);

  return u8.slice(0, curDataOffset);
}
