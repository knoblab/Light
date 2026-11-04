import {
  DetectedDustSpot,
  DetectionParams,
  DetectionResult,
  InpaintResult,
  ManualBrushStroke,
  MultiFrameCluster,
} from '../types/sensor';

// Precomputed 301x301 radial distance, coordinate, and 8-sector lookup grids centered at (150, 150)
const GRID_HALF = 150;
const GRID_DIM = GRID_HALF * 2 + 1; // 301
const GX = new Float32Array(GRID_DIM * GRID_DIM);
const GY = new Float32Array(GRID_DIM * GRID_DIM);
const GDIST = new Float32Array(GRID_DIM * GRID_DIM);
const GSECTOR = new Int32Array(GRID_DIM * GRID_DIM);

(function initRadialGrids() {
  for (let dy = -GRID_HALF; dy <= GRID_HALF; dy++) {
    const rowOffset = (dy + GRID_HALF) * GRID_DIM;
    for (let dx = -GRID_HALF; dx <= GRID_HALF; dx++) {
      const idx = rowOffset + (dx + GRID_HALF);
      GX[idx] = dx;
      GY[idx] = dy;
      GDIST[idx] = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const sec = Math.floor(((ang + Math.PI) / (2.0 * Math.PI)) * 8.0);
      GSECTOR[idx] = Math.max(0, Math.min(7, sec));
    }
  }
})();

/**
 * Solves 3x3 normal equations for 1st-order plane (a*x + b*y + c) in O(N) without allocations.
 */
function fastFitPlane(
  ax: Float32Array,
  ay: Float32Array,
  av: Float32Array,
  count: number
): [number, number, number] {
  let sx = 0;
  let sy = 0;
  let sxx = 1e-5;
  let syy = 1e-5;
  let sxy = 0;
  let sv = 0;
  let sxv = 0;
  let syv = 0;

  for (let i = 0; i < count; i++) {
    const x = ax[i];
    const y = ay[i];
    const v = av[i];
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sv += v;
    sxv += x * v;
    syv += y * v;
  }

  const n = count + 1e-5;
  // Cramer's rule / Gaussian elimination on symmetric 3x3 matrix:
  // [sxx, sxy, sx] [a]   [sxv]
  // [sxy, syy, sy] [b] = [syv]
  // [sx,  sy,  n ] [c]   [sv ]
  const m00 = sxx, m01 = sxy, m02 = sx;
  const m10 = sxy, m11 = syy, m12 = sy;
  const m20 = sx,  m21 = sy,  m22 = n;

  const det =
    m00 * (m11 * m22 - m12 * m21) -
    m01 * (m10 * m22 - m12 * m20) +
    m02 * (m10 * m21 - m11 * m20);

  if (Math.abs(det) < 1e-9) {
    return [0, 0, count > 0 ? sv / count : 0];
  }

  const invDet = 1.0 / det;
  const a =
    (sxv * (m11 * m22 - m12 * m21) -
      m01 * (syv * m22 - m12 * sv) +
      m02 * (syv * m21 - m11 * sv)) *
    invDet;
  const b =
    (m00 * (syv * m22 - m12 * sv) -
      sxv * (m10 * m22 - m12 * m20) +
      m02 * (m10 * sv - syv * m20)) *
    invDet;
  const c =
    (m00 * (m11 * sv - syv * m21) -
      m01 * (m10 * sv - syv * m20) +
      sxv * (m10 * m21 - m11 * m20)) *
    invDet;

  return [a, b, c];
}

/**
 * Separable 1D Gaussian blur on a 2D Float32Array (W x H) with reflect-101 border clamping.
 */
export function gaussianBlurFloat32(
  src: Float32Array,
  w: number,
  h: number,
  sigma: number,
  dst?: Float32Array,
  tmp?: Float32Array
): Float32Array {
  const out = dst || new Float32Array(w * h);
  if (sigma <= 0.15) {
    out.set(src);
    return out;
  }

  // For large sigmas (e.g. sigma >= 4.0), 3-pass separable box blur (IIR/box approximation)
  // is O(1) per pixel regardless of radius and matches true Gaussian within 99.8%.
  if (sigma >= 3.6) {
    const tempBuf = tmp || new Float32Array(w * h);
    // Ideal box width for 3 passes: w_ideal = sqrt((12 * sigma^2 / 3) + 1)
    const wIdeal = Math.sqrt((12.0 * sigma * sigma) / 3.0 + 1.0);
    let wl = Math.floor(wIdeal);
    if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const mIdeal =
      (12.0 * sigma * sigma - 3.0 * wl * wl - 12.0 * wl - 9.0) / (-4.0 * wl - 4.0);
    const m = Math.round(mIdeal);

    let curSrc = src;
    let curDst = out;
    for (let pass = 0; pass < 3; pass++) {
      const rad = Math.max(1, Math.floor((pass < m ? wl : wu) - 1) >> 1);
      boxBlurHorizontal(curSrc, tempBuf, w, h, rad);
      boxBlurVertical(tempBuf, curDst, w, h, rad);
      curSrc = curDst;
    }
    return out;
  }

  const radius = Math.max(1, Math.min(24, Math.ceil(sigma * 3.0)));
  const kLen = radius * 2 + 1;
  const kernel = new Float32Array(kLen);
  const inv2Sigma2 = 1.0 / (2.0 * sigma * sigma);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const val = Math.exp(-i * i * inv2Sigma2);
    kernel[i + radius] = val;
    sum += val;
  }
  for (let i = 0; i < kLen; i++) kernel[i] /= sum;

  const tempBuf = tmp || new Float32Array(w * h);

  // Horizontal pass
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let sx = x + k;
        if (sx < 0) sx = -sx;
        else if (sx >= w) sx = 2 * w - 2 - sx;
        sx = Math.max(0, Math.min(w - 1, sx));
        acc += src[rowOff + sx] * kernel[k + radius];
      }
      tempBuf[rowOff + x] = acc;
    }
  }

  // Vertical pass
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let sy = y + k;
        if (sy < 0) sy = -sy;
        else if (sy >= h) sy = 2 * h - 2 - sy;
        sy = Math.max(0, Math.min(h - 1, sy));
        acc += tempBuf[sy * w + x] * kernel[k + radius];
      }
      out[rowOff + x] = acc;
    }
  }

  return out;
}

function boxBlurHorizontal(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  r: number
) {
  const iarr = 1.0 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    let ti = y * w;
    let li = ti;
    let ri = ti + Math.min(w - 1, r);
    const fv = src[ti];
    const lv = src[ti + w - 1];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) {
      val += src[ti + Math.min(w - 1, j)];
    }
    for (let j = 0; j <= r && j < w; j++) {
      val += src[ri] - fv;
      dst[ti++] = val * iarr;
      if (ri < y * w + w - 1) ri++;
    }
    for (let j = r + 1; j < w - r; j++) {
      val += src[ri++] - src[li++];
      dst[ti++] = val * iarr;
    }
    for (let j = Math.max(r + 1, w - r); j < w; j++) {
      val += lv - src[li++];
      dst[ti++] = val * iarr;
    }
  }
}

function boxBlurVertical(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  r: number
) {
  const iarr = 1.0 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    let ti = x;
    let li = ti;
    let ri = ti + Math.min(h - 1, r) * w;
    const fv = src[ti];
    const lv = src[ti + w * (h - 1)];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) {
      val += src[ti + Math.min(h - 1, j) * w];
    }
    for (let j = 0; j <= r && j < h; j++) {
      val += src[ri] - fv;
      dst[ti] = val * iarr;
      ti += w;
      if (ri < x + w * (h - 1)) ri += w;
    }
    for (let j = r + 1; j < h - r; j++) {
      val += src[ri] - src[li];
      dst[ti] = val * iarr;
      li += w;
      ri += w;
      ti += w;
    }
    for (let j = Math.max(r + 1, h - r); j < h; j++) {
      val += lv - src[li];
      dst[ti] = val * iarr;
      li += w;
      ti += w;
    }
  }
}

/**
 * Downsamples a 3-channel RGB8 or RGB16 buffer to target (dstW, dstH) using area-averaging.
 */
export function resizeRgb8Area(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Uint8Array {
  if (srcW === dstW && srcH === dstH) return new Uint8Array(src);
  const dst = new Uint8Array(dstW * dstH * 3);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    const sy0 = Math.floor(y * scaleY);
    const sy1 = Math.min(srcH, Math.max(sy0 + 1, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < dstW; x++) {
      const sx0 = Math.floor(x * scaleX);
      const sx1 = Math.min(srcW, Math.max(sx0 + 1, Math.ceil((x + 1) * scaleX)));
      let r = 0, g = 0, b = 0, cnt = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const rowOff = sy * srcW * 3;
        for (let sx = sx0; sx < sx1; sx++) {
          const idx = rowOff + sx * 3;
          r += src[idx];
          g += src[idx + 1];
          b += src[idx + 2];
          cnt++;
        }
      }
      const dIdx = (y * dstW + x) * 3;
      const inv = 1.0 / Math.max(1, cnt);
      dst[dIdx] = Math.round(r * inv);
      dst[dIdx + 1] = Math.round(g * inv);
      dst[dIdx + 2] = Math.round(b * inv);
    }
  }
  return dst;
}

export function resizeFloat32Area(
  src: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Float32Array {
  if (srcW === dstW && srcH === dstH) return new Float32Array(src);
  const dst = new Float32Array(dstW * dstH);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    const sy0 = Math.floor(y * scaleY);
    const sy1 = Math.min(srcH, Math.max(sy0 + 1, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < dstW; x++) {
      const sx0 = Math.floor(x * scaleX);
      const sx1 = Math.min(srcW, Math.max(sx0 + 1, Math.ceil((x + 1) * scaleX)));
      let sum = 0, cnt = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const rowOff = sy * srcW;
        for (let sx = sx0; sx < sx1; sx++) {
          sum += src[rowOff + sx];
          cnt++;
        }
      }
      dst[y * dstW + x] = sum / Math.max(1, cnt);
    }
  }
  return dst;
}

export function resizeFloat32Bilinear(
  src: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Float32Array {
  if (srcW === dstW && srcH === dstH) return new Float32Array(src);
  const dst = new Float32Array(dstW * dstH);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    const fy = (y + 0.5) * scaleY - 0.5;
    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(fy)));
    const y1 = Math.max(0, Math.min(srcH - 1, y0 + 1));
    const wy = Math.max(0, Math.min(1, fy - y0));
    const row0 = y0 * srcW;
    const row1 = y1 * srcW;

    for (let x = 0; x < dstW; x++) {
      const fx = (x + 0.5) * scaleX - 0.5;
      const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(fx)));
      const x1 = Math.max(0, Math.min(srcW - 1, x0 + 1));
      const wx = Math.max(0, Math.min(1, fx - x0));

      const v00 = src[row0 + x0];
      const v01 = src[row0 + x1];
      const v10 = src[row1 + x0];
      const v11 = src[row1 + x1];

      const top = v00 + (v01 - v00) * wx;
      const bot = v10 + (v11 - v10) * wx;
      dst[y * dstW + x] = top + (bot - top) * wy;
    }
  }
  return dst;
}

/**
 * Pads black letterbox/pillarbox borders (< 8.0) with nearest valid interior pixels
 * so large Gaussian kernels (sigma=22) never bleed dark borders into sky edges.
 */
function padBlackBorders(gray: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(gray);
  // Check top/bottom rows and left/right columns for letterbox/pillarbox bars
  let topValid = 0;
  while (topValid < h - 1) {
    let rowMean = 0;
    for (let x = 0; x < w; x += 4) rowMean += out[topValid * w + x];
    if (rowMean / Math.ceil(w / 4) >= 8.0) break;
    topValid++;
  }
  let botValid = h - 1;
  while (botValid > topValid) {
    let rowMean = 0;
    for (let x = 0; x < w; x += 4) rowMean += out[botValid * w + x];
    if (rowMean / Math.ceil(w / 4) >= 8.0) break;
    botValid--;
  }
  let leftValid = 0;
  while (leftValid < w - 1) {
    let colMean = 0;
    for (let y = topValid; y <= botValid; y += 4) colMean += out[y * w + leftValid];
    if (colMean / Math.max(1, Math.ceil((botValid - topValid + 1) / 4)) >= 8.0) break;
    leftValid++;
  }
  let rightValid = w - 1;
  while (rightValid > leftValid) {
    let colMean = 0;
    for (let y = topValid; y <= botValid; y += 4) colMean += out[y * w + rightValid];
    if (colMean / Math.max(1, Math.ceil((botValid - topValid + 1) / 4)) >= 8.0) break;
    rightValid--;
  }

  for (let y = 0; y < topValid; y++) {
    out.set(out.subarray(topValid * w, (topValid + 1) * w), y * w);
  }
  for (let y = botValid + 1; y < h; y++) {
    out.set(out.subarray(botValid * w, (botValid + 1) * w), y * w);
  }
  if (leftValid > 0 || rightValid < w - 1) {
    for (let y = 0; y < h; y++) {
      const rowOff = y * w;
      const lv = out[rowOff + leftValid];
      for (let x = 0; x < leftValid; x++) out[rowOff + x] = lv;
      const rv = out[rowOff + rightValid];
      for (let x = rightValid + 1; x < w; x++) out[rowOff + x] = rv;
    }
  }
  return out;
}

// Reusable scratch buffers for annulus plane evaluation
const _annX = new Float32Array(92000);
const _annY = new Float32Array(92000);
const _annV = new Float32Array(92000);
const _annSec = new Int32Array(92000);
const _annRes = new Float32Array(92000);
const _annResSorted = new Float32Array(92000);
const _cleanX = new Float32Array(92000);
const _cleanY = new Float32Array(92000);
const _cleanV = new Float32Array(92000);
const _corePixels = new Float32Array(25000);
const _innerGrad = new Float32Array(45000);

function evalSingleRadiusAnnulus(
  imgGray: Float32Array,
  gradMap: Float32Array,
  bgStdMap: Float32Array,
  hfTexMap: Float32Array,
  w: number,
  h: number,
  cxDet: number,
  cyDet: number,
  rDet: number,
  isSharpBranch: boolean,
  cloudProtection: number,
  sensitivity: number
): { passed: boolean; contrastPct: number; isotropy: number; snr: number; depth: number } {
  const ix = Math.round(cxDet);
  const iy = Math.round(cyDet);
  const rOut = Math.min(GRID_HALF, Math.round(Math.max(rDet * 2.28, rDet + 5.0)));

  const minBorder = Math.round(Math.max(rDet * 1.15, 4.0));
  if (ix < minBorder || ix >= w - minBorder || iy < minBorder || iy >= h - minBorder) {
    return { passed: false, contrastPct: 0, isotropy: 0, snr: 0, depth: 0 };
  }

  const prot = 0.55 + (cloudProtection / 100.0) * 0.6;
  const centerIdx = iy * w + ix;
  const localBgStd = bgStdMap[centerIdx];
  const localHfTex = hfTexMap[centerIdx];

  const maxBgStd = (isSharpBranch ? 3.45 : 2.75) / prot;
  if (localBgStd > maxBgStd || localHfTex > 1.55 / prot) {
    return { passed: false, contrastPct: 0, isotropy: 0, snr: 0, depth: 0 };
  }

  const y0 = Math.max(0, iy - rOut);
  const y1 = Math.min(h, iy + rOut + 1);
  const x0 = Math.max(0, ix - rOut);
  const x1 = Math.min(w, ix + rOut + 1);

  const rCore = Math.max(1.2, rDet * (isSharpBranch ? 0.52 : 0.48));
  const rAnnIn = Math.max(rDet * 1.32, rDet + 1.8);

  let nAnn = 0;
  let nCore = 0;
  let sumAnn = 0;
  let sumCore = 0;

  for (let py = y0; py < y1; py++) {
    const gy = GRID_HALF + (py - iy);
    const gRow = gy * GRID_DIM;
    const iRow = py * w;
    for (let px = x0; px < x1; px++) {
      const val = imgGray[iRow + px];
      if (val < 8.0) continue;
      const gx = GRID_HALF + (px - ix);
      const gIdx = gRow + gx;
      const d = GDIST[gIdx];
      if (d <= rCore) {
        _corePixels[nCore++] = val;
        sumCore += val;
      } else if (d >= rAnnIn && d <= rOut) {
        _annX[nAnn] = GX[gIdx];
        _annY[nAnn] = GY[gIdx];
        _annV[nAnn] = val;
        _annSec[nAnn] = GSECTOR[gIdx];
        sumAnn += val;
        nAnn++;
      }
    }
  }

  if (nAnn < 16 || nCore < 1) {
    return { passed: false, contrastPct: 0, isotropy: 0, snr: 0, depth: 0 };
  }

  const sensFactor = 1.32 - (sensitivity / 100.0) * 0.52;
  const minDepth = (isSharpBranch ? 2.1 : 1.08) * sensFactor;

  const approxBg = sumAnn / nAnn;
  if (approxBg < 84.0) {
    return { passed: false, contrastPct: 0, isotropy: 0, snr: 0, depth: 0 };
  }

  let coreVal: number;
  if (isSharpBranch) {
    const coreSub = _corePixels.subarray(0, nCore);
    coreSub.sort();
    coreVal = coreSub[Math.floor(nCore * 0.25)];
  } else {
    coreVal = sumCore / nCore;
  }

  if (approxBg - coreVal < minDepth * 0.72) {
    return { passed: false, contrastPct: 0, isotropy: 0, snr: 0, depth: 0 };
  }

  // Step 1: Initial 1st-order plane fit on ALL outer annulus pixels
  const coeffs1 = fastFitPlane(_annX, _annY, _annV, nAnn);
  let sumResSq = 0;
  let sumRes = 0;
  for (let i = 0; i < nAnn; i++) {
    const r = _annV[i] - (coeffs1[0] * _annX[i] + coeffs1[1] * _annY[i] + coeffs1[2]);
    _annRes[i] = r;
    _annResSorted[i] = r;
    sumRes += r;
    sumResSq += r * r;
  }
  const meanRes1 = sumRes / nAnn;
  const annAllStd = Math.sqrt(Math.max(0, sumResSq / nAnn - meanRes1 * meanRes1));

  const sortedSlice = _annResSorted.subarray(0, nAnn);
  sortedSlice.sort();
  const p05Res = sortedSlice[Math.floor(nAnn * 0.05)];
  const p95Res = sortedSlice[Math.min(nAnn - 1, Math.floor(nAnn * 0.95))];
  const annSpan = p95Res - p05Res;

  const maxAnnAllStd = (isSharpBranch ? 1.85 : 1.48) / prot;
  const maxAnnSpan = (isSharpBranch ? 5.2 : 4.3) / prot;
  if (annAllStd > maxAnnAllStd || annSpan > maxAnnSpan) {
    return { passed: false, contrastPct: 0, isotropy: 0, snr: 0, depth: 0 };
  }

  // Step 2: Symmetric [18, 82] percentile trimming
  const loP = sortedSlice[Math.floor(nAnn * 0.18)];
  const hiP = sortedSlice[Math.min(nAnn - 1, Math.floor(nAnn * 0.82))];
  let nClean = 0;
  for (let i = 0; i < nAnn; i++) {
    const r = _annRes[i];
    if (r >= loP && r <= hiP) {
      _cleanX[nClean] = _annX[i];
      _cleanY[nClean] = _annY[i];
      _cleanV[nClean] = _annV[i];
      nClean++;
    }
  }

  let coeffs = coeffs1;
  let annCleanStd = annAllStd;
  if (nClean >= 10) {
    coeffs = fastFitPlane(_cleanX, _cleanY, _cleanV, nClean);
    let cSum = 0;
    let cSq = 0;
    for (let i = 0; i < nClean; i++) {
      const r = _cleanV[i] - (coeffs[0] * _cleanX[i] + coeffs[1] * _cleanY[i] + coeffs[2]);
      cSum += r;
      cSq += r * r;
    }
    const cMean = cSum / nClean;
    annCleanStd = Math.sqrt(Math.max(0, cSq / nClean - cMean * cMean));
  }

  const planeCenter = coeffs[2];
  if (planeCenter < 86.0) {
    return { passed: false, contrastPct: 0, isotropy: 0, snr: 0, depth: 0 };
  }

  const depth = planeCenter - coreVal;
  if (depth < minDepth) {
    return { passed: false, contrastPct: 0, isotropy: 0, snr: 0, depth: 0 };
  }

  const effNoise = Math.max(annCleanStd * 1.35, annAllStd * 0.72, 0.25);
  const snr = depth / effNoise;
  const minSnr = (isSharpBranch ? 3.15 : 2.4) * sensFactor * (0.82 + 0.18 * prot);
  if (snr < minSnr) {
    return { passed: false, contrastPct: 0, isotropy: 0, snr: 0, depth: 0 };
  }

  if (!isSharpBranch) {
    let nGrad = 0;
    const rGradMax = rDet * 1.35;
    for (let py = y0; py < y1; py++) {
      const gy = GRID_HALF + (py - iy);
      const gRow = gy * GRID_DIM;
      const iRow = py * w;
      for (let px = x0; px < x1; px++) {
        if (GDIST[gRow + GRID_HALF + (px - ix)] <= rGradMax) {
          _innerGrad[nGrad++] = gradMap[iRow + px];
        }
      }
    }
    if (nGrad > 0) {
      const gSub = _innerGrad.subarray(0, nGrad);
      gSub.sort();
      const innerGradP90 = gSub[Math.min(nGrad - 1, Math.floor(nGrad * 0.9))];
      if (innerGradP90 > Math.max(3.4, depth * 1.35)) {
        return { passed: false, contrastPct: 0, isotropy: 0, snr: 0, depth: 0 };
      }
    }
  }

  // Step 4: Fast 8-Sector Angular Enclosure Check
  const secCounts = new Int32Array(8);
  const secSums = new Float64Array(8);
  for (let i = 0; i < nAnn; i++) {
    const s = _annSec[i];
    secCounts[s]++;
    secSums[s] += _annRes[i] + planeCenter;
  }

  let validSectors = 0;
  let brighterSectors = 0;
  const reqMargin = depth * 0.2;
  for (let s = 0; s < 8; s++) {
    if (secCounts[s] >= 2) {
      validSectors++;
      const meanS = secSums[s] / secCounts[s];
      if (meanS - coreVal >= reqMargin) {
        brighterSectors++;
      }
    }
  }

  if (validSectors < 6 || brighterSectors < Math.max(6, validSectors - 1)) {
    return { passed: false, contrastPct: 0, isotropy: 0, snr: 0, depth: 0 };
  }

  const contrastPct = (depth / Math.max(planeCenter, 20.0)) * 100.0;
  const isotropy = Math.max(0.62, Math.min(0.98, 1.0 - effNoise / (depth * 1.5 + 0.35)));
  return { passed: true, contrastPct, isotropy, snr, depth };
}

function verifyAnnulusPlaneSnr(
  imgGray: Float32Array,
  gradMap: Float32Array,
  bgStdMap: Float32Array,
  hfTexMap: Float32Array,
  w: number,
  h: number,
  cxDet: number,
  cyDet: number,
  rDet: number,
  isSharpBranch: boolean,
  cloudProtection: number,
  sensitivity: number
): { passed: boolean; bestR: number; contrastPct: number; isotropy: number; snr: number } {
  const scaleMultipliers = isSharpBranch ? [0.9, 1.0, 1.25, 1.55] : [0.88, 1.0, 1.15, 1.28];
  let bestScore = -1.0;
  let bestRes = { passed: false, bestR: rDet, contrastPct: 0, isotropy: 0, snr: 0 };

  for (const mult of scaleMultipliers) {
    const candR = Math.max(1.4, rDet * mult);
    const res = evalSingleRadiusAnnulus(
      imgGray,
      gradMap,
      bgStdMap,
      hfTexMap,
      w,
      h,
      cxDet,
      cyDet,
      candR,
      isSharpBranch,
      cloudProtection,
      sensitivity
    );
    if (res.passed) {
      const score = res.depth * Math.sqrt(res.snr);
      if (score > bestScore) {
        bestScore = score;
        bestRes = {
          passed: true,
          bestR: candR,
          contrastPct: res.contrastPct,
          isotropy: res.isotropy,
          snr: res.snr,
        };
      }
    }
  }
  return bestRes;
}

/**
 * Computes perceptual detection grayscale (0..255 float32) from working RGB8 buffer.
 */
export function computeDetGrayFromRgb8(
  workRgb8: Uint8Array,
  workW: number,
  workH: number
): Float32Array {
  const numPixels = workW * workH;
  const gray = new Float32Array(numPixels);
  for (let i = 0, j = 0; i < numPixels; i++, j += 3) {
    gray[i] = 0.2126 * workRgb8[j] + 0.7152 * workRgb8[j + 1] + 0.0722 * workRgb8[j + 2];
  }
  return gray;
}

/**
 * Dual-Branch Sensor Dust Detector:
 *   - Branch A: Sharp / Focused Micro-Dust (g_8.5 - g_0.9 + Plane-Detrended Annulus SNR)
 *   - Branch B: Defocused / Bokeh Circular Dust (12-Scale 0.5x DoG Pyramid + Annulus SNR)
 */
export function detectSensorDustLocal(
  grayDet: Float32Array,
  detW: number,
  detH: number,
  fullW: number,
  fullH: number,
  workW: number,
  workH: number,
  workScale: number,
  params: DetectionParams,
  onProgress?: (percent: number, label: string) => void
): {
  detectionResult: DetectionResult;
  vizBwEdgeRgb8: Uint8Array;
  maskAutoU8: Uint8Array;
} {
  const detScale = detW / fullW;
  const method = (params.method || 'dual').toLowerCase();
  const sensitivity = Number(params.sensitivity ?? 68.0);
  const minRadiusFull = Number(params.minRadius ?? 2.0);
  const maxRadiusFull = Number(params.maxRadius ?? 44.0);
  const minCircularity = Number(params.minCircularity ?? 0.6);
  const cloudProtection = Number(params.cloudProtection ?? 75.0);

  const minRDet = Math.max(1.2, minRadiusFull * detScale);
  const maxRDet = Math.max(minRDet + 4.0, maxRadiusFull * detScale);

  const numDetPixels = detW * detH;
  const validPhotoMask = new Uint8Array(numDetPixels);
  for (let i = 0; i < numDetPixels; i++) {
    validPhotoMask[i] = grayDet[i] >= 8.0 ? 1 : 0;
  }

  const grayFilt = padBlackBorders(grayDet, detW, detH);
  const tmpBuf = new Float32Array(numDetPixels);

  const s1 = gaussianBlurFloat32(grayFilt, detW, detH, 0.9, undefined, tmpBuf);
  const g8 = gaussianBlurFloat32(s1, detW, detH, 8.5, undefined, tmpBuf);
  const denoiseDet = gaussianBlurFloat32(grayFilt, detW, detH, 1.8, undefined, tmpBuf);

  const s1Masked = new Float32Array(numDetPixels);
  const denoiseMasked = new Float32Array(numDetPixels);
  for (let i = 0; i < numDetPixels; i++) {
    if (validPhotoMask[i]) {
      s1Masked[i] = s1[i];
      denoiseMasked[i] = denoiseDet[i];
    }
  }

  const bgMean22 = gaussianBlurFloat32(denoiseDet, detW, detH, 22.0, undefined, tmpBuf);
  const bgDiffSq = new Float32Array(numDetPixels);
  const hfDiffClamped = new Float32Array(numDetPixels);

  for (let i = 0; i < numDetPixels; i++) {
    const diff = Math.max(denoiseDet[i] - bgMean22[i], -3.2);
    bgDiffSq[i] = diff * diff;
    const sg = s1[i] - g8[i];
    hfDiffClamped[i] = Math.min(Math.abs(sg), Math.max(sg + 2.8, 2.8));
  }

  const bgSq22 = gaussianBlurFloat32(bgDiffSq, detW, detH, 22.0, undefined, tmpBuf);
  const bgStdMap = new Float32Array(numDetPixels);
  for (let i = 0; i < numDetPixels; i++) {
    bgStdMap[i] = Math.sqrt(Math.max(0, bgSq22[i]));
  }
  const hfTexture = gaussianBlurFloat32(hfDiffClamped, detW, detH, 18.0, undefined, tmpBuf);

  // Sobel gradient magnitude on denoiseDet
  const gradRaw = new Float32Array(numDetPixels);
  for (let y = 1; y < detH - 1; y++) {
    const r0 = (y - 1) * detW;
    const r1 = y * detW;
    const r2 = (y + 1) * detW;
    for (let x = 1; x < detW - 1; x++) {
      const gx =
        -denoiseDet[r0 + x - 1] +
        denoiseDet[r0 + x + 1] -
        2.0 * denoiseDet[r1 + x - 1] +
        2.0 * denoiseDet[r1 + x + 1] -
        denoiseDet[r2 + x - 1] +
        denoiseDet[r2 + x + 1];
      const gy =
        -denoiseDet[r0 + x - 1] -
        2.0 * denoiseDet[r0 + x] -
        denoiseDet[r0 + x + 1] +
        denoiseDet[r2 + x - 1] +
        2.0 * denoiseDet[r2 + x] +
        denoiseDet[r2 + x + 1];
      gradRaw[r1 + x] = Math.hypot(gx, gy) * 0.25;
    }
  }
  const gradMag = gaussianBlurFloat32(gradRaw, detW, detH, 1.5, undefined, tmpBuf);

  const prot = 0.55 + (cloudProtection / 100.0) * 0.6;
  const combinedVisDet = new Float32Array(numDetPixels);

  interface RawCandidate {
    cx: number;
    cy: number;
    workCx: number;
    workCy: number;
    radius: number;
    workRadius: number;
    area: number;
    perimeter: number;
    circularity: number;
    contrastDropPct: number;
    score: number;
    spotType: 'sharp' | 'bokeh';
  }
  const rawCandidates: RawCandidate[] = [];

  const runSharp = ['dual', 'multiscale', 'hybrid', 'sharp', 'blackhat'].includes(method);
  const runBokeh = ['dual', 'multiscale', 'hybrid', 'bokeh', 'dog'].includes(method);

  onProgress?.(20, '초점 미세 먼지 입자 스캔 중');

  // ─── BRANCH A: Sharp / Focused Sensor Dust Detector ───
  if (runSharp) {
    const diffThresh = Math.max(1.75, 4.1 - (sensitivity / 100.0) * 2.55);
    const bmSharp = new Uint8Array(numDetPixels);
    const maxBgStdSharp = 3.45 / prot;
    const maxHfSharp = 1.55 / prot;

    for (let i = 0; i < numDetPixels; i++) {
      if (
        validPhotoMask[i] &&
        g8[i] >= 86.0 &&
        bgStdMap[i] <= maxBgStdSharp &&
        hfTexture[i] <= maxHfSharp
      ) {
        const sd = Math.max(0, g8[i] - s1[i]);
        if (sd * 1.4 > combinedVisDet[i]) combinedVisDet[i] = sd * 1.4;
        if (sd >= diffThresh) bmSharp[i] = 1;
      }
    }

    // Connected components via fast BFS queue on bmSharp
    const visited = new Uint8Array(numDetPixels);
    const q = new Int32Array(numDetPixels);

    for (let y = 2; y < detH - 2; y++) {
      const rowOff = y * detW;
      for (let x = 2; x < detW - 2; x++) {
        const startIdx = rowOff + x;
        if (!bmSharp[startIdx] || visited[startIdx]) continue;

        let qHead = 0;
        let qTail = 0;
        q[qTail++] = startIdx;
        visited[startIdx] = 1;

        let sumX = 0, sumY = 0;
        let minX = x, maxX = x, minY = y, maxY = y;

        while (qHead < qTail) {
          const curr = q[qHead++];
          const cy = Math.floor(curr / detW);
          const cx = curr - cy * detW;
          sumX += cx;
          sumY += cy;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          // 8-neighbors
          for (let dy = -1; dy <= 1; dy++) {
            const ny = cy + dy;
            if (ny <= 0 || ny >= detH - 1) continue;
            const nRow = ny * detW;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx;
              if (nx <= 0 || nx >= detW - 1) continue;
              const nIdx = nRow + nx;
              if (bmSharp[nIdx] && !visited[nIdx]) {
                visited[nIdx] = 1;
                q[qTail++] = nIdx;
              }
            }
          }
        }

        const areaDet = qTail;
        if (areaDet < 3 || areaDet > 500) continue;

        const cxD = sumX / areaDet;
        const cyD = sumY / areaDet;
        const spanW = maxX - minX + 1;
        const spanH = maxY - minY + 1;
        if (Math.min(spanW, spanH) > 1 && Math.max(spanW, spanH) / Math.min(spanW, spanH) > 2.8) {
          continue;
        }

        const encRD = 0.5 * Math.hypot(spanW, spanH);
        const eqRD = Math.sqrt(areaDet / Math.PI);
        const rD = Math.max(1.6, 0.55 * encRD + 0.45 * eqRD);
        const rFull = rD / detScale;
        if (rFull < minRadiusFull || rFull > maxRadiusFull) continue;

        const ver = verifyAnnulusPlaneSnr(
          s1Masked,
          gradMag,
          bgStdMap,
          hfTexture,
          detW,
          detH,
          cxD,
          cyD,
          rD,
          true,
          cloudProtection,
          sensitivity
        );
        if (!ver.passed || ver.isotropy < minCircularity) continue;

        const rFullOpt = ver.bestR / detScale;
        rawCandidates.push({
          cx: Math.round((cxD / detScale) * 10) / 10,
          cy: Math.round((cyD / detScale) * 10) / 10,
          workCx: Math.round((cxD / detScale) * workScale * 10) / 10,
          workCy: Math.round((cyD / detScale) * workScale * 10) / 10,
          radius: Math.round(rFullOpt * 10) / 10,
          workRadius: Math.round((rFullOpt * workScale * 1.55 + 2.5) * 10) / 10,
          area: Math.round((areaDet / (detScale * detScale)) * 10) / 10,
          perimeter: Math.round(2.0 * Math.PI * rFullOpt * 10) / 10,
          circularity: Math.round(ver.isotropy * 1000) / 1000,
          contrastDropPct: Math.round(ver.contrastPct * 100) / 100,
          score: ver.snr * 1.25,
          spotType: 'sharp',
        });
      }
    }
  }

  // ─── BRANCH B: Defocused / Bokeh Circular Dust Detector (12-Scale 0.5x DoG Pyramid) ───
  if (runBokeh) {
    const pyrW = Math.max(1, detW >> 1);
    const pyrH = Math.max(1, detH >> 1);
    const numPyr = pyrW * pyrH;
    const pyrScaleX = pyrW / detW;
    const pyrScaleY = pyrH / detH;
    const pyrScale = 0.5 * (pyrScaleX + pyrScaleY);

    const denoisePyr = resizeFloat32Area(denoiseDet, detW, detH, pyrW, pyrH);
    const quietSkyIndices: number[] = [];
    for (let py = 0; py < pyrH; py++) {
      const dy = Math.min(detH - 1, py << 1);
      const dRow = dy * detW;
      const pRow = py * pyrW;
      for (let px = 0; px < pyrW; px++) {
        const dIdx = dRow + Math.min(detW - 1, px << 1);
        if (
          validPhotoMask[dIdx] &&
          bgMean22[dIdx] >= 86.0 &&
          bgStdMap[dIdx] <= 1.65 &&
          hfTexture[dIdx] <= 1.1
        ) {
          quietSkyIndices.push(pRow + px);
        }
      }
    }

    const hasQuietSky = quietSkyIndices.length > 100;
    const skyStride = hasQuietSky ? Math.max(1, Math.floor(quietSkyIndices.length / 16000)) : 1;

    const bokehMinR = Math.max(7.2, minRDet);
    const bokehMaxR = Math.max(bokehMinR + 6.0, maxRDet * 0.98);
    const bokehRadii = new Float32Array(12);
    const logRatio = Math.log(bokehMaxR / bokehMinR);
    for (let s = 0; s < 12; s++) {
      bokehRadii[s] = bokehMinR * Math.exp((s / 11.0) * logRatio);
    }

    const bokehMaxZPyr = new Float32Array(numPyr);
    const bokehBestC = new Float32Array(numPyr);
    const bokehBestIdxPyr = new Uint8Array(numPyr);

    const gInBuf = new Float32Array(numPyr);
    const gOutBuf = new Float32Array(numPyr);
    const pyrTmp = new Float32Array(numPyr);
    const rawBand = new Float32Array(numPyr);
    const skySamples = new Float32Array(20000);
    const absDev = new Float32Array(20000);

    for (let s = 0; s < 12; s++) {
      onProgress?.(
        Math.round(35 + ((s + 1) / 12) * 50),
        `보케 먼지 다중 스케일 분석 중 (${s + 1}/12)`
      );
      const rB = bokehRadii[s];
      const rP = rB * pyrScale;
      gaussianBlurFloat32(denoisePyr, pyrW, pyrH, rP * 0.45, gInBuf, pyrTmp);
      gaussianBlurFloat32(denoisePyr, pyrW, pyrH, rP * 1.24, gOutBuf, pyrTmp);

      for (let i = 0; i < numPyr; i++) {
        const go = gOutBuf[i];
        rawBand[i] = ((go - gInBuf[i]) / Math.max(go, 25.0)) * 255.0;
      }

      let sampleCnt = 0;
      if (hasQuietSky) {
        for (let i = 0; i < quietSkyIndices.length && sampleCnt < 20000; i += skyStride) {
          skySamples[sampleCnt++] = rawBand[quietSkyIndices[i]];
        }
      } else {
        const step = Math.max(1, Math.floor(numPyr / 12000));
        for (let i = 0; i < numPyr && sampleCnt < 20000; i += step) {
          skySamples[sampleCnt++] = rawBand[i];
        }
      }

      const subSamples = skySamples.subarray(0, sampleCnt);
      subSamples.sort();
      const med = subSamples[sampleCnt >> 1] || 0;
      for (let i = 0; i < sampleCnt; i++) {
        absDev[i] = Math.abs(subSamples[i] - med);
      }
      const subDev = absDev.subarray(0, sampleCnt);
      subDev.sort();
      const madSky = (subDev[sampleCnt >> 1] || 0.12) * 1.4826;
      const effMad = Math.max(madSky, 0.16);
      const invMad = 1.0 / effMad;
      const scaleWeight = Math.pow(rB / bokehMinR, -0.05);

      for (let i = 0; i < numPyr; i++) {
        const diff = rawBand[i] - med;
        if (diff > 0) {
          const z = diff * invMad;
          if (z > bokehMaxZPyr[i]) bokehMaxZPyr[i] = z;
          const c = diff * scaleWeight;
          if (c > bokehBestC[i]) {
            bokehBestC[i] = c;
            bokehBestIdxPyr[i] = s;
          }
        }
      }
    }

    const smoothedMaxZPyr = gaussianBlurFloat32(bokehMaxZPyr, pyrW, pyrH, 0.8, undefined, pyrTmp);
    const bokehMaxZFull = resizeFloat32Bilinear(smoothedMaxZPyr, pyrW, pyrH, detW, detH);
    const maxBgStdBokeh = 3.0 / prot;
    for (let i = 0; i < numDetPixels; i++) {
      if (validPhotoMask[i] && bgMean22[i] >= 86.0 && bgStdMap[i] <= maxBgStdBokeh) {
        if (bokehMaxZFull[i] > combinedVisDet[i]) {
          combinedVisDet[i] = bokehMaxZFull[i];
        }
      }
    }

    const zThresh = Math.max(1.35, 4.42 - (sensitivity / 100.0) * 3.0);
    const nmsRad = Math.max(3, Math.round(bokehMinR * pyrScale * 0.92));

    for (let pyP = nmsRad; pyP < pyrH - nmsRad; pyP++) {
      const pRow = pyP * pyrW;
      for (let pxP = nmsRad; pxP < pyrW - nmsRad; pxP++) {
        const zVal = smoothedMaxZPyr[pRow + pxP];
        if (zVal < zThresh) continue;

        let isPeak = true;
        for (let dy = -nmsRad; dy <= nmsRad && isPeak; dy++) {
          const nRow = (pyP + dy) * pyrW;
          for (let dx = -nmsRad; dx <= nmsRad; dx++) {
            if (smoothedMaxZPyr[nRow + pxP + dx] > zVal + 1e-4) {
              isPeak = false;
              break;
            }
          }
        }
        if (!isPeak) continue;

        const px = Math.min(detW - 1, Math.round(pxP / pyrScaleX));
        const py = Math.min(detH - 1, Math.round(pyP / pyrScaleY));
        const dIdx = py * detW + px;
        if (!validPhotoMask[dIdx] || bgMean22[dIdx] < 86.0 || bgStdMap[dIdx] > 2.75 / prot) {
          continue;
        }

        // Refine dark center inside 3x3 full-res neighborhood
        let pxRef = px;
        let pyRef = py;
        let minVal = denoiseDet[dIdx];
        for (let dy = -1; dy <= 1; dy++) {
          const ny = Math.max(0, Math.min(detH - 1, py + dy));
          for (let dx = -1; dx <= 1; dx++) {
            const nx = Math.max(0, Math.min(detW - 1, px + dx));
            const v = denoiseDet[ny * detW + nx];
            if (v < minVal) {
              minVal = v;
              pxRef = nx;
              pyRef = ny;
            }
          }
        }

        const bestRD = bokehRadii[bokehBestIdxPyr[pRow + pxP]];
        const ver = verifyAnnulusPlaneSnr(
          denoiseMasked,
          gradMag,
          bgStdMap,
          hfTexture,
          detW,
          detH,
          pxRef,
          pyRef,
          bestRD,
          false,
          cloudProtection,
          sensitivity
        );
        if (!ver.passed || ver.isotropy < minCircularity) continue;

        const rFull = ver.bestR / detScale;
        if (rFull < minRadiusFull || rFull > maxRadiusFull) continue;

        rawCandidates.push({
          cx: Math.round((pxRef / detScale) * 10) / 10,
          cy: Math.round((pyRef / detScale) * 10) / 10,
          workCx: Math.round((pxRef / detScale) * workScale * 10) / 10,
          workCy: Math.round((pyRef / detScale) * workScale * 10) / 10,
          radius: Math.round(rFull * 10) / 10,
          workRadius: Math.round((rFull * workScale * 1.72 + 2.0) * 10) / 10,
          area: Math.round(Math.PI * rFull * rFull * 10) / 10,
          perimeter: Math.round(2.0 * Math.PI * rFull * 10) / 10,
          circularity: Math.round(ver.isotropy * 1000) / 1000,
          contrastDropPct: Math.round(ver.contrastPct * 100) / 100,
          score: ver.snr,
          spotType: 'bokeh',
        });
      }
    }
  }

  // Unified Non-Maximum Suppression across both Sharp and Bokeh branches
  rawCandidates.sort((a, b) => b.score - a.score);
  const acceptedSpots: DetectedDustSpot[] = [];

  for (const cand of rawCandidates) {
    let isDup = false;
    for (const kept of acceptedSpots) {
      const dist = Math.hypot(cand.cx - kept.cx, cand.cy - kept.cy);
      const minSep = Math.max(cand.radius, kept.radius) * 0.85;
      if (dist < minSep) {
        isDup = true;
        break;
      }
    }
    if (!isDup) {
      const spotIdx = acceptedSpots.length + 1;
      acceptedSpots.push({
        id: `dust-${spotIdx}`,
        index: spotIdx,
        cx: cand.cx,
        cy: cand.cy,
        workCx: cand.workCx,
        workCy: cand.workCy,
        radius: cand.radius,
        workRadius: cand.workRadius,
        area: cand.area,
        perimeter: cand.perimeter,
        circularity: cand.circularity,
        contrastDropPct: cand.contrastDropPct,
        spotType: cand.spotType,
        enabled: true,
        isManual: false,
      });
    }
  }

  onProgress?.(92, '스팟 신뢰도 검증 및 마스크 합성 중');

  // Build maskAutoU8 and vizBwEdgeRgb8 at working resolution (workW, workH)
  const maskAutoU8 = new Uint8Array(workW * workH);
  for (const sp of acceptedSpots) {
    drawFilledCircleU8(
      maskAutoU8,
      workW,
      workH,
      Math.round(sp.workCx),
      Math.round(sp.workCy),
      Math.max(2, Math.round(sp.workRadius)),
      255
    );
  }

  const visWork =
    detW === workW && detH === workH
      ? combinedVisDet
      : resizeFloat32Bilinear(combinedVisDet, detW, detH, workW, workH);

  // Estimate 99.3th percentile of visWork
  const visSample = new Float32Array(Math.ceil((workW * workH) / 8));
  let vsCnt = 0;
  for (let i = 0; i < visWork.length && vsCnt < visSample.length; i += 8) {
    visSample[vsCnt++] = visWork[i];
  }
  const visSub = visSample.subarray(0, vsCnt).sort();
  const visScale = Math.max(2.5, visSub[Math.min(vsCnt - 1, Math.floor(vsCnt * 0.993))] || 2.5);

  const vizBwEdgeRgb8 = new Uint8Array(workW * workH * 3);
  for (let i = 0, j = 0; i < visWork.length; i++, j += 3) {
    const v = Math.max(0, Math.min(255, Math.round((visWork[i] / visScale) * 215.0)));
    vizBwEdgeRgb8[j] = v;
    vizBwEdgeRgb8[j + 1] = v;
    vizBwEdgeRgb8[j + 2] = v;
  }

  const detectionResult: DetectionResult = {
    method,
    sensitivity,
    thresholdValue: 0,
    minRadius: minRadiusFull,
    maxRadius: maxRadiusFull,
    minCircularity,
    totalDetected: acceptedSpots.length,
    spots: acceptedSpots,
  };

  onProgress?.(100, '먼지 분석 완료');

  return { detectionResult, vizBwEdgeRgb8, maskAutoU8 };
}

function drawFilledCircleU8(
  mask: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  r: number,
  val: number
) {
  const y0 = Math.max(0, cy - r);
  const y1 = Math.min(h - 1, cy + r);
  const rSq = r * r;
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const dxMax = Math.floor(Math.sqrt(Math.max(0, rSq - dy * dy)));
    const x0 = Math.max(0, cx - dxMax);
    const x1 = Math.min(w - 1, cx + dxMax);
    const rowOff = y * w;
    for (let x = x0; x <= x1; x++) {
      mask[rowOff + x] = val;
    }
  }
}

function drawThickLineU8(
  mask: Uint8Array,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  val: number
) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(dist / Math.max(1, r * 0.35)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = Math.round(x0 + (x1 - x0) * t);
    const cy = Math.round(y0 + (y1 - y0) * t);
    drawFilledCircleU8(mask, w, h, cx, cy, r, val);
  }
}

/**
 * Builds the full-resolution binary dust mask from enabled spots and manual brush strokes.
 */
export function buildFullResolutionMask(
  fullW: number,
  fullH: number,
  workScale: number,
  spots: DetectedDustSpot[],
  manualStrokes: ManualBrushStroke[],
  skirtPadPx: number
): Uint8Array {
  const mask = new Uint8Array(fullW * fullH);
  const invScale = 1.0 / Math.max(workScale, 1e-5);

  for (const spot of spots) {
    if (!spot.enabled) continue;
    const cx = Math.round(spot.cx);
    const cy = Math.round(spot.cy);
    const minSkirtR = spot.radius * (spot.spotType === 'bokeh' ? 1.72 : 1.55) + 2.0 * invScale;
    const fullWorkR = spot.workRadius ? spot.workRadius * invScale : minSkirtR;
    const r = Math.max(3, Math.round(Math.max(fullWorkR, minSkirtR) + skirtPadPx));
    drawFilledCircleU8(mask, fullW, fullH, cx, cy, r, 255);
  }

  for (const stroke of manualStrokes) {
    const val = stroke.mode === 'add' ? 255 : 0;
    const baseR = Math.max(2, Math.round(stroke.radius + (stroke.mode === 'add' ? skirtPadPx : 0)));
    const pts = stroke.points || [];
    if (pts.length === 1) {
      drawFilledCircleU8(mask, fullW, fullH, Math.round(pts[0].x), Math.round(pts[0].y), baseR, val);
    } else if (pts.length > 1) {
      for (let i = 0; i < pts.length - 1; i++) {
        drawThickLineU8(
          mask,
          fullW,
          fullH,
          pts[i].x,
          pts[i].y,
          pts[i + 1].x,
          pts[i + 1].y,
          baseR,
          val
        );
      }
    }
  }

  return mask;
}

/**
 * Dilates a binary mask (0 or 255) by circular radius `rad` using separable distance threshold.
 */
function dilateMaskCircular(
  src: Uint8Array,
  w: number,
  h: number,
  rad: number
): Uint8Array {
  if (rad <= 0) return new Uint8Array(src);
  const INF = 1e9;
  const distSq = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);

  // Horizontal 1D squared distance transform
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    let lastZero = -100000;
    for (let x = 0; x < w; x++) {
      if (src[rowOff + x] > 0) lastZero = x;
      const d = x - lastZero;
      tmp[rowOff + x] = d * d;
    }
    lastZero = 100000;
    for (let x = w - 1; x >= 0; x--) {
      if (src[rowOff + x] > 0) lastZero = x;
      const d = lastZero - x;
      const d2 = d * d;
      if (d2 < tmp[rowOff + x]) tmp[rowOff + x] = d2;
    }
  }

  const rSq = rad * rad;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - rad);
    const y1 = Math.min(h - 1, y + rad);
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      let minD2 = INF;
      for (let ny = y0; ny <= y1; ny++) {
        const dy = ny - y;
        const d2 = tmp[ny * w + x] + dy * dy;
        if (d2 <= rSq) {
          minD2 = d2;
          break;
        }
      }
      distSq[rowOff + x] = minD2;
      if (minD2 <= rSq) out[rowOff + x] = 255;
    }
  }
  return out;
}

/**
 * Fast inward boundary propagation + harmonic diffusion solver on a plane-detrended 2D ROI patch.
 * Propagates clean unshadowed outer boundary values smoothly across the mask and applies harmonic relaxation.
 */
function inpaintDetrendedPatch(
  detrended: Float32Array,
  mask: Uint8Array,
  rw: number,
  rh: number,
  harmSigma: number
): Float32Array {
  const num = rw * rh;
  const filled = new Float32Array(detrended);
  const known = new Uint8Array(num);
  let unknownCount = 0;

  for (let i = 0; i < num; i++) {
    if (mask[i] === 0) {
      known[i] = 1;
    } else {
      unknownCount++;
    }
  }

  if (unknownCount === 0) return filled;

  // Multi-shell inward frontier propagation (Fast Marching / onion-peel weighted average)
  const frontier: number[] = [];
  for (let pass = 0; pass < Math.max(rw, rh) && unknownCount > 0; pass++) {
    frontier.length = 0;
    for (let y = 0; y < rh; y++) {
      const rOff = y * rw;
      for (let x = 0; x < rw; x++) {
        const idx = rOff + x;
        if (known[idx]) continue;
        // Check if any 8-neighbor is known
        let hasKnownNeighbor = false;
        for (let dy = -1; dy <= 1 && !hasKnownNeighbor; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= rh) continue;
          const nRow = ny * rw;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= rw) continue;
            if (known[nRow + nx]) {
              hasKnownNeighbor = true;
              break;
            }
          }
        }
        if (hasKnownNeighbor) frontier.push(idx);
      }
    }

    if (frontier.length === 0) break;

    for (const idx of frontier) {
      const y = Math.floor(idx / rw);
      const x = idx - y * rw;
      let wSum = 0;
      let vSum = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= rh) continue;
        const nRow = ny * rw;
        for (let dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= rw) continue;
          const nIdx = nRow + nx;
          if (known[nIdx]) {
            const w = 1.0 / (dx * dx + dy * dy);
            wSum += w;
            vSum += filled[nIdx] * w;
          }
        }
      }
      if (wSum > 0) {
        filled[idx] = vSum / wSum;
      }
    }

    for (const idx of frontier) {
      known[idx] = 1;
      unknownCount--;
    }
  }

  // Harmonic Gaussian smoothing blended inside the mask
  const smooth = gaussianBlurFloat32(filled, rw, rh, harmSigma);
  for (let i = 0; i < num; i++) {
    if (mask[i] > 0) {
      filled[i] = 0.42 * filled[i] + 0.58 * smooth[i];
    }
  }
  return filled;
}

/**
 * Deterministic fast Gaussian PRNG for sensor grain synthesis.
 */
function createSeededGaussianRng(seed = 42) {
  let state = seed >>> 0;
  const nextUniform = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296.0;
  };
  return () => {
    const u1 = Math.max(1e-7, nextUniform());
    const u2 = nextUniform();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  };
}

/**
 * Zero-Halo Plane-Detrended 16-bit & Camera-Color Inpainting with Zero-Touch Outside-Mask Preservation:
 *   - Pixels outside the dust healing mask (`roi_alpha == 0`) are NEVER modified or re-tonemapped:
 *     `healedRgb8` and `healedLinear16` retain 100% identical color, contrast, and deep blacks as the original photo.
 *   - Inside each connected dust ROI, fits a 1st-order background plane (ax + by + c) with symmetric
 *     [15, 85] percentile trimming on the clean outer reference ring, inpaints the detrended residual,
 *     restores the gradient plane + matched local sensor grain, and blends with outward-only feathering.
 */
export function inpaint16BitAndCameraRgbLocal(
  origRgb8: Uint8Array,
  linear16: Uint16Array,
  fullW: number,
  fullH: number,
  workW: number,
  workH: number,
  workScale: number,
  spots: DetectedDustSpot[],
  manualStrokes: ManualBrushStroke[],
  inpaintRadiusFull: number,
  preserveGrain: boolean,
  onProgress?: (percent: number, label: string) => void
): {
  healedRgb8: Uint8Array;
  healedLinear16: Uint16Array;
  workHealedRgb8: Uint8Array;
  workMaskU8: Uint8Array;
  inpaintResult: InpaintResult;
} {
  const inpaintR = Math.max(3.0, Math.min(25.0, Number(inpaintRadiusFull || 6.0)));
  const skirtPadPx = Math.max(2, Math.round(inpaintR * 0.45));

  onProgress?.(5, '마스크 영역 분석 및 복원 대상 확인 중');

  const fullMaskCore = buildFullResolutionMask(
    fullW,
    fullH,
    workScale,
    spots,
    manualStrokes,
    skirtPadPx
  );

  let inpaintedPixels = 0;
  for (let i = 0; i < fullMaskCore.length; i++) {
    if (fullMaskCore[i] > 0) inpaintedPixels++;
  }

  const enabledSpotCount =
    spots.filter((s) => s.enabled).length +
    manualStrokes.filter((st) => st.mode === 'add').length;

  // Start with 1:1 exact copies of origRgb8 and linear16 (Zero-Touch Outside Mask!)
  const healedRgb8 = new Uint8Array(origRgb8);
  const healedLinear16 = new Uint16Array(linear16);

  if (inpaintedPixels > 0) {
    const featherPx = Math.max(3, Math.round(inpaintR * 0.7));
    const featherSigma = Math.max(2.0, featherPx * 0.55);
    const ringWidthPx = Math.max(7, Math.round(inpaintR * 1.4 + 5));
    const ringPad = ringWidthPx + featherPx + 4;

    // Group touching spots on fullMaskCore using fast BFS connected components
    const visited = new Uint8Array(fullW * fullH);
    const q = new Int32Array(fullW * fullH);
    const randNorm = createSeededGaussianRng(42);

    interface InpaintComponent {
      bx1: number;
      by1: number;
      rw: number;
      rh: number;
      roiSize: number;
      qIndices: Int32Array;
    }
    const components: InpaintComponent[] = [];

    for (let y = 0; y < fullH; y++) {
      const rowOff = y * fullW;
      for (let x = 0; x < fullW; x++) {
        const startIdx = rowOff + x;
        if (!fullMaskCore[startIdx] || visited[startIdx]) continue;

        let qHead = 0;
        let qTail = 0;
        q[qTail++] = startIdx;
        visited[startIdx] = 1;

        let minX = x, maxX = x, minY = y, maxY = y;

        while (qHead < qTail) {
          const curr = q[qHead++];
          const cy = Math.floor(curr / fullW);
          const cx = curr - cy * fullW;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          // Group spots within featherPx + 2 of each other
          const searchR = 2;
          for (let dy = -searchR; dy <= searchR; dy++) {
            const ny = cy + dy;
            if (ny < 0 || ny >= fullH) continue;
            const nRow = ny * fullW;
            for (let dx = -searchR; dx <= searchR; dx++) {
              const nx = cx + dx;
              if (nx < 0 || nx >= fullW) continue;
              const nIdx = nRow + nx;
              if (fullMaskCore[nIdx] && !visited[nIdx]) {
                visited[nIdx] = 1;
                q[qTail++] = nIdx;
              }
            }
          }
        }

        const bx1 = Math.max(0, minX - ringPad);
        const by1 = Math.max(0, minY - ringPad);
        const bx2 = Math.min(fullW, maxX + 1 + ringPad);
        const by2 = Math.min(fullH, maxY + 1 + ringPad);
        const rw = bx2 - bx1;
        const rh = by2 - by1;
        const roiSize = rw * rh;

        components.push({
          bx1,
          by1,
          rw,
          rh,
          roiSize,
          qIndices: q.slice(0, qTail),
        });
      }
    }

    const totalComponents = components.length;
    for (let compIdx = 0; compIdx < totalComponents; compIdx++) {
      const comp = components[compIdx];
      onProgress?.(
        Math.round(((compIdx + 1) / totalComponents) * 100),
        `먼지 스팟 복원 중 (${compIdx + 1}/${totalComponents})`
      );

      const { bx1, by1, rw, rh, roiSize, qIndices } = comp;

      const roiCore = new Uint8Array(roiSize);
      for (let i = 0; i < qIndices.length; i++) {
        const idx = qIndices[i];
        const cy = Math.floor(idx / fullW);
        const cx = idx - cy * fullW;
        roiCore[(cy - by1) * rw + (cx - bx1)] = 255;
      }

        const roiExpanded = dilateMaskCircular(roiCore, rw, rh, featherPx);
        const roiOuterDilated = dilateMaskCircular(roiExpanded, rw, rh, ringWidthPx);

        // Outward-only feather mask: 1.0 across 100% of roiCore, smooth Gaussian taper outside
        const roiExpFloat = new Float32Array(roiSize);
        for (let i = 0; i < roiSize; i++) {
          roiExpFloat[i] = roiExpanded[i] > 0 ? 1.0 : 0.0;
        }
        const roiAlpha = gaussianBlurFloat32(roiExpFloat, rw, rh, featherSigma);
        for (let i = 0; i < roiSize; i++) {
          if (roiCore[i] > 0) {
            roiAlpha[i] = 1.0;
          } else {
            roiAlpha[i] = Math.max(0.0, Math.min(1.0, roiAlpha[i] * 1.12));
          }
        }

        // Clean reference ring strictly outside ANY spot's expanded mask
        const ringXs: number[] = [];
        const ringYs: number[] = [];
        for (let ry = 0; ry < rh; ry++) {
          const fy = by1 + ry;
          const rOff = ry * rw;
          const fOff = fy * fullW;
          for (let rx = 0; rx < rw; rx++) {
            const fx = bx1 + rx;
            const rIdx = rOff + rx;
            if (roiOuterDilated[rIdx] > 0 && roiExpanded[rIdx] === 0 && fullMaskCore[fOff + fx] === 0) {
              ringXs.push(rx);
              ringYs.push(ry);
            }
          }
        }

        const normX = new Float32Array(roiSize);
        const normY = new Float32Array(roiSize);
        const halfW = Math.max(rw * 0.5, 1.0);
        const halfH = Math.max(rh * 0.5, 1.0);
        for (let ry = 0; ry < rh; ry++) {
          const ny = (ry - rh * 0.5) / halfH;
          const rOff = ry * rw;
          for (let rx = 0; rx < rw; rx++) {
            normX[rOff + rx] = (rx - rw * 0.5) / halfW;
            normY[rOff + rx] = ny;
          }
        }

        // Determine clean [15, 85] percentile ring subset using Green channel
        let cleanIndices: number[] | null = null;
        if (ringXs.length >= 16) {
          const nR = ringXs.length;
          const rxArr = new Float32Array(nR);
          const ryArr = new Float32Array(nR);
          const gArr = new Float32Array(nR);
          for (let i = 0; i < nR; i++) {
            const rIdx = ringYs[i] * rw + ringXs[i];
            rxArr[i] = normX[rIdx];
            ryArr[i] = normY[rIdx];
            const fIdx = ((by1 + ringYs[i]) * fullW + (bx1 + ringXs[i])) * 3;
            gArr[i] = origRgb8[fIdx + 1];
          }
          const cG = fastFitPlane(rxArr, ryArr, gArr, nR);
          const resG = new Float32Array(nR);
          const resGSorted = new Float32Array(nR);
          for (let i = 0; i < nR; i++) {
            const r = gArr[i] - (cG[0] * rxArr[i] + cG[1] * ryArr[i] + cG[2]);
            resG[i] = r;
            resGSorted[i] = r;
          }
          resGSorted.sort();
          const loR = resGSorted[Math.floor(nR * 0.15)];
          const hiR = resGSorted[Math.min(nR - 1, Math.floor(nR * 0.85))];
          const cList: number[] = [];
          for (let i = 0; i < nR; i++) {
            if (resG[i] >= loR && resG[i] <= hiR) cList.push(i);
          }
          if (cList.length >= 12) cleanIndices = cList;
        }

        const harmSigma = Math.max(2.0, Math.min(8.0, Math.min(rw, rh) * 0.12));

        // Process each of the 3 channels for both origRgb8 (camera display space) and linear16 (16-bit space)
        for (let ch = 0; ch < 3; ch++) {
          const patch8 = new Float32Array(roiSize);
          const patch16 = new Float32Array(roiSize);
          for (let ry = 0; ry < rh; ry++) {
            const fy = by1 + ry;
            const rOff = ry * rw;
            const fOff = fy * fullW;
            for (let rx = 0; rx < rw; rx++) {
              const pIdx = (fOff + bx1 + rx) * 3 + ch;
              patch8[rOff + rx] = origRgb8[pIdx];
              patch16[rOff + rx] = linear16[pIdx];
            }
          }

          // Estimate local high-frequency sensor grain on clean ring
          let grainStd8 = 0;
          let grainStd16 = 0;
          if (preserveGrain && ringXs.length >= 12) {
            const blur8 = gaussianBlurFloat32(patch8, rw, rh, 1.2);
            const blur16 = gaussianBlurFloat32(patch16, rw, rh, 1.2);
            const hf8 = new Float32Array(ringXs.length);
            const hf16 = new Float32Array(ringXs.length);
            for (let i = 0; i < ringXs.length; i++) {
              const rIdx = ringYs[i] * rw + ringXs[i];
              hf8[i] = Math.abs(patch8[rIdx] - blur8[rIdx]);
              hf16[i] = Math.abs(patch16[rIdx] - blur16[rIdx]);
            }
            hf8.sort();
            hf16.sort();
            grainStd8 = Math.min(3.5, hf8[ringXs.length >> 1] * 1.4826);
            grainStd16 = Math.min(450.0, hf16[ringXs.length >> 1] * 1.4826);
          }

          let healedPatch8: Float32Array;
          let healedPatch16: Float32Array;

          if (cleanIndices) {
            const nC = cleanIndices.length;
            const cxArr = new Float32Array(nC);
            const cyArr = new Float32Array(nC);
            const cv8 = new Float32Array(nC);
            const cv16 = new Float32Array(nC);
            for (let i = 0; i < nC; i++) {
              const idx = cleanIndices[i];
              const rIdx = ringYs[idx] * rw + ringXs[idx];
              cxArr[i] = normX[rIdx];
              cyArr[i] = normY[rIdx];
              cv8[i] = patch8[rIdx];
              cv16[i] = patch16[rIdx];
            }
            const coeffs8 = fastFitPlane(cxArr, cyArr, cv8, nC);
            const coeffs16 = fastFitPlane(cxArr, cyArr, cv16, nC);

            const det8 = new Float32Array(roiSize);
            const det16 = new Float32Array(roiSize);
            const plane8 = new Float32Array(roiSize);
            const plane16 = new Float32Array(roiSize);

            for (let i = 0; i < roiSize; i++) {
              const p8 = coeffs8[0] * normX[i] + coeffs8[1] * normY[i] + coeffs8[2];
              const p16 = coeffs16[0] * normX[i] + coeffs16[1] * normY[i] + coeffs16[2];
              plane8[i] = p8;
              plane16[i] = p16;
              det8[i] = patch8[i] - p8;
              det16[i] = patch16[i] - p16;
            }

            const filledDet8 = inpaintDetrendedPatch(det8, roiExpanded, rw, rh, harmSigma);
            const filledDet16 = inpaintDetrendedPatch(det16, roiExpanded, rw, rh, harmSigma);

            healedPatch8 = new Float32Array(roiSize);
            healedPatch16 = new Float32Array(roiSize);
            for (let i = 0; i < roiSize; i++) {
              healedPatch8[i] = plane8[i] + filledDet8[i];
              healedPatch16[i] = plane16[i] + filledDet16[i];
            }
          } else {
            healedPatch8 = inpaintDetrendedPatch(patch8, roiExpanded, rw, rh, harmSigma);
            healedPatch16 = inpaintDetrendedPatch(patch16, roiExpanded, rw, rh, harmSigma);
          }

          for (let ry = 0; ry < rh; ry++) {
            const fy = by1 + ry;
            const rOff = ry * rw;
            const fOff = fy * fullW;
            for (let rx = 0; rx < rw; rx++) {
              const rIdx = rOff + rx;
              const alpha = roiAlpha[rIdx];
              if (alpha <= 1e-4) continue; // Zero-Touch Outside Mask!

              const gNoise = preserveGrain ? randNorm() : 0;
              const h8 = healedPatch8[rIdx] + gNoise * grainStd8 * 0.85;
              const h16 = healedPatch16[rIdx] + gNoise * grainStd16 * 0.85;

              const b8 = patch8[rIdx] * (1.0 - alpha) + h8 * alpha;
              const b16 = patch16[rIdx] * (1.0 - alpha) + h16 * alpha;

              const pIdx = (fOff + bx1 + rx) * 3 + ch;
              healedRgb8[pIdx] = Math.max(0, Math.min(255, Math.round(b8)));
              healedLinear16[pIdx] = Math.max(0, Math.min(65535, Math.round(b16)));
            }
          }
        }
      }
    }

  const workHealedRgb8 = resizeRgb8Area(healedRgb8, fullW, fullH, workW, workH);
  const workMaskU8 = new Uint8Array(workW * workH);
  for (let wy = 0; wy < workH; wy++) {
    const fy = Math.min(fullH - 1, Math.round(wy / workScale));
    for (let wx = 0; wx < workW; wx++) {
      const fx = Math.min(fullW - 1, Math.round(wx / workScale));
      workMaskU8[wy * workW + wx] = fullMaskCore[fy * fullW + fx];
    }
  }

  const inpaintResult: InpaintResult = {
    healedSpotsCount: enabledSpotCount,
    inpaintedPixels,
    inpaintedAreaPct: Math.round((inpaintedPixels / (fullW * fullH)) * 1000000) / 10000,
    bitDepth: '16-bit Linear + 1:1 Original Camera Color Profile',
    inpaintMethod: 'Zero-Touch Outside Mask + Plane-Detrended 16-bit Harmonic Inpainting',
    inpaintRadius: inpaintR,
    fullWidth: fullW,
    fullHeight: fullH,
  };

  onProgress?.(100, '복원 완료');

  return {
    healedRgb8,
    healedLinear16,
    workHealedRgb8,
    workMaskU8,
    inpaintResult,
  };
}

/**
 * Multi-frame spatial dust clustering and cross-frame projection.
 */
export function runMultiFrameClustering(
  frameSessions: Array<{
    sessionId: string;
    originalFileName: string;
    workScale: number;
    spots: DetectedDustSpot[];
  }>,
  tolerancePx = 14.0,
  minFramesMatch = 2
) {
  const totalFrames = frameSessions.length;
  const allSpots: Array<{ frameIdx: number; spot: DetectedDustSpot }> = [];

  frameSessions.forEach((fs, fIdx) => {
    fs.spots.forEach((s) => {
      allSpots.push({ frameIdx: fIdx, spot: { ...s } });
    });
  });

  const clusters: Array<Array<{ frameIdx: number; spot: DetectedDustSpot }>> = [];
  const visited = new Uint8Array(allSpots.length);

  for (let i = 0; i < allSpots.length; i++) {
    if (visited[i]) continue;
    visited[i] = 1;
    const cl = [allSpots[i]];
    const c1x = allSpots[i].spot.cx;
    const c1y = allSpots[i].spot.cy;

    for (let j = i + 1; j < allSpots.length; j++) {
      if (visited[j]) continue;
      const c2x = allSpots[j].spot.cx;
      const c2y = allSpots[j].spot.cy;
      if (Math.hypot(c1x - c2x, c1y - c2y) <= tolerancePx) {
        visited[j] = 1;
        cl.push(allSpots[j]);
      }
    }
    clusters.push(cl);
  }

  const clusterSummaries: MultiFrameCluster[] = [];
  clusters.forEach((cl, idx) => {
    const framesPresent = Array.from(new Set(cl.map((it) => it.frameIdx))).sort((a, b) => a - b);
    const matchCount = framesPresent.length;
    const meanCx = cl.reduce((acc, it) => acc + it.spot.cx, 0) / cl.length;
    const meanCy = cl.reduce((acc, it) => acc + it.spot.cy, 0) / cl.length;
    const meanR = cl.reduce((acc, it) => acc + it.spot.radius, 0) / cl.length;
    const isMultiConfirmed = matchCount >= minFramesMatch;

    const cId = idx + 1;
    clusterSummaries.push({
      clusterId: cId,
      matchCount,
      totalFrames,
      matchRatio: Math.round((matchCount / Math.max(1, totalFrames)) * 1000) / 1000,
      isMultiConfirmed,
      meanCx: Math.round(meanCx * 10) / 10,
      meanCy: Math.round(meanCy * 10) / 10,
      meanRadius: Math.round(meanR * 10) / 10,
      meanConfidence: 0.9,
      framesPresent,
    });

    for (const item of cl) {
      item.spot.clusterId = cId;
      item.spot.matchCount = matchCount;
      item.spot.totalFrames = totalFrames;
      item.spot.tier = isMultiConfirmed ? 'multi-confirmed' : 'single-frame';
      item.spot.isMultiConfirmed = isMultiConfirmed;
    }
  });

  const perFrame = frameSessions.map((fs, fIdx) => {
    const spotsInFrame = allSpots.filter((it) => it.frameIdx === fIdx).map((it) => it.spot);
    const presentClusterIds = new Set(spotsInFrame.map((s) => s.clusterId));
    let nextIdx = spotsInFrame.length + 1;

    for (const cInfo of clusterSummaries) {
      if (cInfo.isMultiConfirmed && !presentClusterIds.has(cInfo.clusterId)) {
        const isBokehProj = cInfo.meanRadius > 8.0;
        spotsInFrame.push({
          id: `proj_${cInfo.clusterId}_${fIdx}`,
          index: nextIdx++,
          cx: cInfo.meanCx,
          cy: cInfo.meanCy,
          workCx: Math.round(cInfo.meanCx * fs.workScale * 10) / 10,
          workCy: Math.round(cInfo.meanCy * fs.workScale * 10) / 10,
          radius: cInfo.meanRadius,
          workRadius:
            Math.round(
              (cInfo.meanRadius * fs.workScale * (isBokehProj ? 1.82 : 1.6) + 2.5) * 10
            ) / 10,
          area: Math.round(Math.PI * cInfo.meanRadius * cInfo.meanRadius * 10) / 10,
          perimeter: Math.round(2 * Math.PI * cInfo.meanRadius * 10) / 10,
          circularity: 0.95,
          contrastDropPct: 1.5,
          spotType: isBokehProj ? 'bokeh' : 'sharp',
          confidence: cInfo.meanConfidence,
          enabled: true,
          tier: 'projected',
          isProjected: true,
          isMultiConfirmed: true,
          clusterId: cInfo.clusterId,
          matchCount: cInfo.matchCount,
          totalFrames,
        });
      }
    }

    return {
      sessionId: fs.sessionId,
      originalFileName: fs.originalFileName,
      spots: spotsInFrame,
      totalDetected: spotsInFrame.length,
      multiConfirmedCount: spotsInFrame.filter((s) => s.tier === 'multi-confirmed').length,
      singleFrameCount: spotsInFrame.filter((s) => s.tier === 'single-frame').length,
      projectedCount: spotsInFrame.filter((s) => s.tier === 'projected').length,
    };
  });

  return {
    totalFrames,
    totalClusters: clusters.length,
    multiConfirmedClusters: clusterSummaries.filter((c) => c.isMultiConfirmed).length,
    clusters: clusterSummaries,
    perFrame,
  };
}
