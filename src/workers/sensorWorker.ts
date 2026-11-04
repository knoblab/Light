/// <reference lib="webworker" />

import {
  ColorSpaceId,
  DetectedDustSpot,
  DetectionParams,
  DetectionResult,
  DetailedProgressInfo,
  InpaintResult,
  ManualBrushStroke,
  SessionMetadata,
} from '../types/sensor';
import { decodeImageFileLocal } from '../engine/tiffRawDecoder';
import {
  computeDetGrayFromRgb8,
  detectSensorDustLocal,
  inpaint16BitAndCameraRgbLocal,
  LocalCheckpointState,
  resizeRgb8Area,
  runMultiFrameClustering,
} from '../engine/dustAlgorithms';
import {
  buildZipArchiveBlob,
  encodeMaskU8ToBlob,
  encodeRgb8ToBlob,
  injectMetadataAndIccToJpegBlob,
  injectMetadataToPngBlob,
  writeLinearDngBuffer,
  writeTiff16Buffer,
} from '../engine/binaryExporters';
import {
  buildIccProfileBytes,
  COLOR_SPACE_DEFS,
  transformLinear16ColorSpace,
  transformRgb8ColorSpace,
} from '../engine/colorSpaces';

interface WorkerSessionData {
  sessionId: string;
  meta: SessionMetadata;
  origRgb8: Uint8Array;
  linear16: Uint16Array;
  workRgb8: Uint8Array;
  detGray: Float32Array;
  healedRgb8?: Uint8Array;
  healedLinear16?: Uint16Array;
  checkpoint?: LocalCheckpointState;
  rawIccProfileBytes?: Uint8Array;
  lastDetection?: DetectionResult;
}

const sessions = new Map<string, WorkerSessionData>();

function sendDetailedProgress(
  reqId: number,
  stepIndex: number,
  totalSteps: number,
  stepName: string,
  stepPercent: number,
  overallPercent?: number
) {
  const stepW = 100 / Math.max(1, totalSteps);
  const computedOverall =
    overallPercent !== undefined
      ? overallPercent
      : Math.round(((stepIndex - 1) * 100 + stepPercent) / totalSteps);

  const progressInfo: DetailedProgressInfo = {
    stepIndex,
    totalSteps,
    stepName,
    stepPercent: Math.min(100, Math.max(0, Math.round(stepPercent))),
    overallPercent: Math.min(100, Math.max(0, Math.round(computedOverall))),
  };

  const label = `${stepIndex}/${totalSteps}단계 · ${stepName} (${progressInfo.stepPercent}%)`;

  self.postMessage({
    id: reqId,
    type: 'progress',
    percent: progressInfo.overallPercent,
    label,
    progressInfo,
  });
}

function sendProgress(reqId: number, percent: number, label?: string) {
  self.postMessage({
    id: reqId,
    type: 'progress',
    percent: Math.min(100, Math.max(0, percent)),
    label,
  });
}

async function processSingleIngestAndDetect(
  reqId: number,
  sessionId: string,
  fileName: string,
  buffer: ArrayBuffer,
  params: DetectionParams
) {
  sendProgress(reqId, 8, '파일 바이너리 파싱 중');
  const decoded = await decodeImageFileLocal(fileName, buffer);
  sendProgress(reqId, 22, '16-bit 메타데이터 추출 중');
  const fullW = decoded.fullWidth;
  const fullH = decoded.fullHeight;

  const maxWorkDim = 2304;
  let workScale = 1.0;
  let workW = fullW;
  let workH = fullH;
  if (Math.max(fullW, fullH) > maxWorkDim) {
    workScale = maxWorkDim / Math.max(fullW, fullH);
    workW = Math.max(1, Math.round(fullW * workScale));
    workH = Math.max(1, Math.round(fullH * workScale));
  }

  sendProgress(reqId, 30, '센서 작업 버퍼 추출 중');
  const workRgb8 =
    workW === fullW && workH === fullH
      ? new Uint8Array(decoded.origRgb8)
      : resizeRgb8Area(decoded.origRgb8, fullW, fullH, workW, workH);

  sendProgress(reqId, 36, '그레이스케일 변환 중');
  const detGray = computeDetGrayFromRgb8(workRgb8, workW, workH);

  // Compute 16-bit stats
  let minVal = 65535;
  let maxVal = 0;
  let sumVal = 0;
  let cnt = 0;
  const step = Math.max(3, Math.floor(decoded.linear16.length / 30000) * 3);
  for (let i = 0; i < decoded.linear16.length; i += step) {
    const v = decoded.linear16[i];
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
    sumVal += v;
    cnt++;
  }
  const meanVal = cnt > 0 ? Math.round((sumVal / cnt) * 10) / 10 : 12000;
  const drEv =
    maxVal > minVal
      ? Math.round(Math.log2(Math.max(maxVal, 1) / Math.max(minVal, 1)) * 100) / 100
      : 14.0;

  const colorSpaceName =
    decoded.detectedColorSpace && decoded.detectedColorSpace !== 'auto'
      ? COLOR_SPACE_DEFS[decoded.detectedColorSpace]?.name || 'Adobe RGB (1998)'
      : decoded.isRaw
      ? 'Original Camera Color & Tone Profile'
      : 'Original sRGB 1:1';

  const meta: SessionMetadata = {
    originalFileName: fileName,
    extension: decoded.extension,
    isRaw: decoded.isRaw,
    isLinear16: decoded.isLinear16 ?? true,
    fullWidth: fullW,
    fullHeight: fullH,
    workWidth: workW,
    workHeight: workH,
    workScale,
    exposureScale: decoded.exposureScale,
    bitDepth: '16-bit Linear + 1:1 Original Camera Profile',
    colorSpace: colorSpaceName,
    detectedColorSpace: decoded.detectedColorSpace,
    hasEmbeddedIcc: Boolean(decoded.rawIccProfileBytes),
    cameraWb: [1.0, 1.0, 1.0, 1.0],
    colorMatrix: [],
    blackLevel: [0, 0, 0, 0],
    whiteLevel: 65535,
    bayerPattern: 'RGBG',
    stats16Bit: {
      minCodeValue: minVal,
      maxCodeValue: maxVal,
      meanCodeValue: meanVal,
      estimatedDynamicRangeEv: drEv,
    },
    exif: decoded.exif,
  };

  const { detectionResult, vizBwEdgeRgb8, maskAutoU8 } = detectSensorDustLocal(
    detGray,
    workW,
    workH,
    fullW,
    fullH,
    workW,
    workH,
    workScale,
    params,
    (detPct, detLabel) => {
      const mapped = Math.round(40 + (detPct / 100) * 48); // 40% ~ 88%
      sendProgress(reqId, mapped, detLabel);
    }
  );

  sessions.set(sessionId, {
    sessionId,
    meta,
    origRgb8: decoded.origRgb8,
    linear16: decoded.linear16,
    workRgb8,
    detGray,
    rawIccProfileBytes: decoded.rawIccProfileBytes,
    lastDetection: detectionResult,
  });

  sendProgress(reqId, 92, '다크룸 캔버스 인코딩 중');

  const [previewOriginalBlob, vizBwEdgeBlob, maskAutoBlob] = await Promise.all([
    encodeRgb8ToBlob(workRgb8, workW, workH, 'image/jpeg', 0.96),
    encodeRgb8ToBlob(vizBwEdgeRgb8, workW, workH, 'image/jpeg', 0.92),
    encodeMaskU8ToBlob(maskAutoU8, workW, workH),
  ]);

  sendProgress(reqId, 100, '로딩 및 분석 완료');

  return {
    sessionId,
    meta,
    detection: detectionResult,
    blobs: {
      previewOriginalBlob,
      vizBwEdgeBlob,
      maskAutoBlob,
    },
  };
}

async function renderExportBuffer(
  session: WorkerSessionData,
  format: 'dng' | 'tiff16' | 'png' | 'jpg',
  healedRgb8: Uint8Array,
  healedLinear16: Uint16Array,
  targetColorSpace: ColorSpaceId = 'auto'
): Promise<{ blob: Blob; ext: string; mimeType: string }> {
  const { fullWidth: w, fullHeight: h } = session.meta;
  const fmt = format.toLowerCase();

  const sourceSpace: Exclude<ColorSpaceId, 'auto'> =
    session.meta.detectedColorSpace && session.meta.detectedColorSpace !== 'auto'
      ? session.meta.detectedColorSpace
      : 'adobe-rgb';

  const effectiveTargetSpace: Exclude<ColorSpaceId, 'auto'> =
    targetColorSpace === 'auto' ? sourceSpace : targetColorSpace;

  let exportRgb8 = healedRgb8;
  let exportLinear16 = healedLinear16;

  // Convert color space only if user explicitly selected a different target space
  if (targetColorSpace !== 'auto' && targetColorSpace !== sourceSpace) {
    exportRgb8 = new Uint8Array(healedRgb8.length);
    transformRgb8ColorSpace(healedRgb8, exportRgb8, sourceSpace, effectiveTargetSpace);
    exportLinear16 = new Uint16Array(healedLinear16.length);
    transformLinear16ColorSpace(healedLinear16, exportLinear16, sourceSpace, effectiveTargetSpace);
  }

  const customIcc =
    session.rawIccProfileBytes && (targetColorSpace === 'auto' || targetColorSpace === sourceSpace)
      ? session.rawIccProfileBytes
      : buildIccProfileBytes(effectiveTargetSpace);

  if (fmt === 'dng') {
    const dngBuf = writeLinearDngBuffer(
      exportRgb8,
      exportLinear16,
      w,
      h,
      session.meta,
      effectiveTargetSpace,
      customIcc
    );
    return {
      blob: new Blob([dngBuf], { type: 'image/x-adobe-dng' }),
      ext: 'dng',
      mimeType: 'image/x-adobe-dng',
    };
  } else if (fmt === 'tiff16') {
    const tiffBuf = writeTiff16Buffer(
      exportRgb8,
      exportLinear16,
      w,
      h,
      session.meta,
      effectiveTargetSpace,
      customIcc
    );
    return {
      blob: new Blob([tiffBuf], { type: 'image/tiff' }),
      ext: 'tiff',
      mimeType: 'image/tiff',
    };
  } else if (fmt === 'png') {
    const pngBlob = await encodeRgb8ToBlob(exportRgb8, w, h, 'image/png');
    const metaPngBlob = await injectMetadataToPngBlob(pngBlob, session.meta);
    return {
      blob: metaPngBlob,
      ext: 'png',
      mimeType: 'image/png',
    };
  } else {
    const baseJpgBlob = await encodeRgb8ToBlob(exportRgb8, w, h, 'image/jpeg', 0.98);
    const metaJpgBlob = await injectMetadataAndIccToJpegBlob(baseJpgBlob, session.meta, customIcc);
    return {
      blob: metaJpgBlob,
      ext: 'jpg',
      mimeType: 'image/jpeg',
    };
  }
}

self.onmessage = async (event: MessageEvent) => {
  const { id, action, payload } = event.data || {};
  try {
    if (action === 'ingest_and_detect') {
      const { sessionId, fileName, buffer, params } = payload;
      const res = await processSingleIngestAndDetect(id, sessionId, fileName, buffer, params);
      self.postMessage({ id, ok: true, data: res });
      return;
    }

    if (action === 'detect') {
      const { sessionId, params } = payload;
      sendProgress(id, 5, '먼지 분석 준비 중');
      const session = sessions.get(sessionId);
      if (!session) throw new Error('세션 데이터를 찾을 수 없습니다. 사진을 다시 불러와 주세요.');

      const { fullWidth, fullHeight, workWidth, workHeight, workScale } = session.meta;
      sendProgress(id, 10, '다중 스케일 가우시안 차분(DoG) 탐지 시작');
      const { detectionResult, vizBwEdgeRgb8, maskAutoU8 } = detectSensorDustLocal(
        session.detGray,
        workWidth,
        workHeight,
        fullWidth,
        fullHeight,
        workWidth,
        workHeight,
        workScale,
        params,
        (detPct, detLabel) => {
          const mapped = Math.round(10 + (detPct / 100) * 80); // 10% ~ 90%
          sendProgress(id, mapped, detLabel);
        }
      );
      session.lastDetection = detectionResult;

      sendProgress(id, 92, '미리보기 캔버스 인코딩 중');
      const [vizBwEdgeBlob, maskAutoBlob] = await Promise.all([
        encodeRgb8ToBlob(vizBwEdgeRgb8, workWidth, workHeight, 'image/jpeg', 0.92),
        encodeMaskU8ToBlob(maskAutoU8, workWidth, workHeight),
      ]);

      sendProgress(id, 100, '먼지 분석 완료');
      self.postMessage({
        id,
        ok: true,
        data: {
          detection: detectionResult,
          blobs: { vizBwEdgeBlob, maskAutoBlob },
        },
      });
      return;
    }

    if (action === 'inpaint') {
      const {
        sessionId,
        spots,
        manualStrokes,
        inpaintRadius,
        preserveGrain,
      }: {
        sessionId: string;
        spots: DetectedDustSpot[];
        manualStrokes: ManualBrushStroke[];
        inpaintRadius: number;
        preserveGrain: boolean;
      } = payload;

      sendProgress(id, 5, '마스크 오버레이 및 ROI 클러스터 분석 중');
      const session = sessions.get(sessionId);
      if (!session) throw new Error('세션 데이터를 찾을 수 없습니다. 사진을 다시 불러와 주세요.');

      const { fullWidth, fullHeight, workWidth, workHeight, workScale } = session.meta;
      sendProgress(id, 10, '16-bit 증분 체크포인트 복원 중');
      const { healedRgb8, healedLinear16, workHealedRgb8, workMaskU8, inpaintResult, checkpoint } =
        inpaint16BitAndCameraRgbLocal(
          session.origRgb8,
          session.linear16,
          fullWidth,
          fullHeight,
          workWidth,
          workHeight,
          workScale,
          spots || [],
          manualStrokes || [],
          inpaintRadius,
          preserveGrain,
          (inpaintPct, inpaintLabel) => {
            const mapped = Math.round(10 + (inpaintPct / 100) * 80); // 10% ~ 90%
            sendProgress(id, mapped, inpaintLabel);
          },
          session.checkpoint
        );

      session.healedRgb8 = healedRgb8;
      session.healedLinear16 = healedLinear16;
      session.checkpoint = checkpoint;

      sendProgress(id, 92, '복원 미리보기 캔버스 인코딩 중');
      const [previewInpaintedBlob, maskFinalBlob] = await Promise.all([
        encodeRgb8ToBlob(workHealedRgb8, workWidth, workHeight, 'image/jpeg', 0.96),
        encodeMaskU8ToBlob(workMaskU8, workWidth, workHeight),
      ]);

      sendProgress(id, 100, '복원 완료');
      self.postMessage({
        id,
        ok: true,
        data: {
          inpaintResult,
          blobs: { previewInpaintedBlob, maskFinalBlob },
        },
      });
      return;
    }

    if (action === 'export_single') {
      const {
        sessionId,
        format,
        colorSpace = 'auto',
        spots,
        manualStrokes,
        inpaintRadius,
        preserveGrain,
      }: {
        sessionId: string;
        format: 'dng' | 'tiff16' | 'png' | 'jpg';
        colorSpace?: ColorSpaceId;
        spots: DetectedDustSpot[];
        manualStrokes: ManualBrushStroke[];
        inpaintRadius: number;
        preserveGrain: boolean;
      } = payload;

      sendProgress(id, 5, '1:1 원본 해상도 무손실 내보내기 준비');
      const session = sessions.get(sessionId);
      if (!session) throw new Error('세션 데이터를 찾을 수 없습니다. 사진을 다시 불러와 주세요.');

      const { fullWidth, fullHeight, workWidth, workHeight, workScale } = session.meta;
      sendProgress(id, 15, '임시 저장본 확인 및 1:1 버퍼 검증 중');
      const { healedRgb8, healedLinear16, workHealedRgb8, workMaskU8, inpaintResult, checkpoint } =
        inpaint16BitAndCameraRgbLocal(
          session.origRgb8,
          session.linear16,
          fullWidth,
          fullHeight,
          workWidth,
          workHeight,
          workScale,
          spots || [],
          manualStrokes || [],
          inpaintRadius,
          preserveGrain,
          (inpaintPct, inpaintLabel) => {
            const mapped = Math.round(15 + (inpaintPct / 100) * 50); // 15% ~ 65%
            sendProgress(id, mapped, inpaintLabel);
          },
          session.checkpoint
        );

      session.healedRgb8 = healedRgb8;
      session.healedLinear16 = healedLinear16;
      session.checkpoint = checkpoint;

      sendProgress(id, 70, `${format.toUpperCase()} 파일 포맷 무손실 인코딩 중`);
      const [{ blob: fileBlob, ext }, previewInpaintedBlob, maskFinalBlob] = await Promise.all([
        renderExportBuffer(session, format, healedRgb8, healedLinear16, colorSpace),
        encodeRgb8ToBlob(workHealedRgb8, workWidth, workHeight, 'image/jpeg', 0.96),
        encodeMaskU8ToBlob(workMaskU8, workWidth, workHeight),
      ]);

      const origBase = session.meta.originalFileName.replace(/\.[^/.]+$/, '');
      const downloadName = `${origBase}_cleaned.${ext}`;

      sendProgress(id, 100, '내보내기 완료');

      self.postMessage({
        id,
        ok: true,
        data: {
          fileBlob,
          downloadName,
          inpaintResult,
          blobs: { previewInpaintedBlob, maskFinalBlob },
        },
      });
      return;
    }

    if (action === 'multi_upload') {
      const {
        files,
        params,
      }: {
        files: Array<{ sessionId: string; fileName: string; buffer: ArrayBuffer }>;
        params: DetectionParams;
      } = payload;

      const processedList = [];
      const total = files.length;
      for (let i = 0; i < total; i++) {
        const f = files[i];
        const basePct = Math.round((i / total) * 90);
        sendProgress(id, basePct, `연속 사진 [${i + 1}/${total}] ${f.fileName} 불러오는 중`);
        const res = await processSingleIngestAndDetect(id, f.sessionId, f.fileName, f.buffer, params);
        processedList.push(res);
      }

      sendProgress(id, 92, '다중 프레임 센서 먼지 상호 교차 클러스터링 중');
      const multiReport = runMultiFrameClustering(
        processedList.map((p) => ({
          sessionId: p.sessionId,
          originalFileName: p.meta.originalFileName,
          workScale: p.meta.workScale,
          spots: p.detection.spots,
        })),
        14.0,
        2
      );

      for (const p of processedList) {
        const pf = multiReport.perFrame.find((f) => f.sessionId === p.sessionId);
        if (pf) {
          p.detection = {
            ...p.detection,
            spots: pf.spots,
            totalDetected: pf.totalDetected,
          };
          const sess = sessions.get(p.sessionId);
          if (sess) sess.lastDetection = p.detection;
        }
      }

      sendProgress(id, 100, '연속 사진 로딩 및 교차 분석 완료');
      self.postMessage({
        id,
        ok: true,
        data: {
          sessions: processedList,
          multiReport,
        },
      });
      return;
    }

    if (action === 'multi_detect') {
      const {
        sessionIds,
        params,
        tolerancePx = 14.0,
        minFramesMatch = 2,
      }: {
        sessionIds: string[];
        params: DetectionParams;
        tolerancePx?: number;
        minFramesMatch?: number;
      } = payload;

      const frameInputs = [];
      const total = sessionIds.length;
      for (let i = 0; i < total; i++) {
        const sid = sessionIds[i];
        const sess = sessions.get(sid);
        if (!sess) continue;

        const frameStartPct = Math.round((i / total) * 90);
        const frameEndPct = Math.round(((i + 1) / total) * 90);
        sendProgress(id, frameStartPct, `연속 사진 [${i + 1}/${total}] ${sess.meta.originalFileName} 분석 중`);

        const { fullWidth, fullHeight, workWidth, workHeight, workScale } = sess.meta;
        const { detectionResult } = detectSensorDustLocal(
          sess.detGray,
          workWidth,
          workHeight,
          fullWidth,
          fullHeight,
          workWidth,
          workHeight,
          workScale,
          params,
          (detPct, detLabel) => {
            const currentPct = Math.round(frameStartPct + (detPct / 100) * (frameEndPct - frameStartPct));
            sendProgress(id, currentPct, `[${i + 1}/${total}] ${detLabel}`);
          }
        );
        sess.lastDetection = detectionResult;
        frameInputs.push({
          sessionId: sid,
          originalFileName: sess.meta.originalFileName,
          workScale,
          spots: detectionResult.spots,
        });
      }

      sendProgress(id, 92, '다중 프레임 불변 센서 먼지 교차 매칭 중');
      const multiReport = runMultiFrameClustering(frameInputs, tolerancePx, minFramesMatch);
      sendProgress(id, 100, '연속 사진 재분석 완료');

      self.postMessage({
        id,
        ok: true,
        data: multiReport,
      });
      return;
    }

    if (action === 'multi_export_zip') {
      const {
        items,
        format,
        colorSpace = 'auto',
      }: {
        items: Array<{
          sessionId: string;
          spots: DetectedDustSpot[];
          manualStrokes: ManualBrushStroke[];
          params: DetectionParams;
        }>;
        format: 'dng' | 'tiff16' | 'png' | 'jpg';
        colorSpace?: ColorSpaceId;
      } = payload;

      const zipEntries: Array<{ name: string; data: Uint8Array }> = [];
      const total = items.length;
      for (let i = 0; i < total; i++) {
        const it = items[i];
        const sess = sessions.get(it.sessionId);
        if (!sess) continue;

        const frameStartPct = Math.round((i / total) * 90);
        const frameEndPct = Math.round(((i + 1) / total) * 90);
        sendProgress(id, frameStartPct, `배치 [${i + 1}/${total}] ${sess.meta.originalFileName} 복원 중`);

        const { fullWidth, fullHeight, workWidth, workHeight, workScale } = sess.meta;

        const { healedRgb8, healedLinear16, checkpoint } = inpaint16BitAndCameraRgbLocal(
          sess.origRgb8,
          sess.linear16,
          fullWidth,
          fullHeight,
          workWidth,
          workHeight,
          workScale,
          it.spots || [],
          it.manualStrokes || [],
          it.params?.inpaintRadius ?? 6,
          it.params?.preserveGrain ?? true,
          (inpaintPct, inpaintLabel) => {
            const currentPct = Math.round(frameStartPct + (inpaintPct / 100) * (frameEndPct - frameStartPct) * 0.7);
            sendProgress(id, currentPct, `배치 [${i + 1}/${total}] ${inpaintLabel}`);
          },
          sess.checkpoint
        );
        sess.checkpoint = checkpoint;

        sendProgress(id, Math.round(frameStartPct + (frameEndPct - frameStartPct) * 0.75), `배치 [${i + 1}/${total}] ${format.toUpperCase()} 인코딩 중`);
        const { blob, ext } = await renderExportBuffer(
          sess,
          format,
          healedRgb8,
          healedLinear16,
          colorSpace
        );
        const arrBuf = await blob.arrayBuffer();
        const origBase = sess.meta.originalFileName.replace(/\.[^/.]+$/, '');
        const entryName = `${String(i + 1).padStart(2, '0')}_${origBase}_cleaned.${ext}`;
        zipEntries.push({ name: entryName, data: new Uint8Array(arrBuf) });
      }

      sendProgress(id, 94, 'ZIP 압축 아카이브 생성 중');
      const zipBlob = buildZipArchiveBlob(zipEntries);
      const downloadName = `SensorClean_Batch_${format.toUpperCase()}.zip`;
      sendProgress(id, 100, '배치 내보내기 완료');
      self.postMessage({
        id,
        ok: true,
        data: {
          zipBlob,
          downloadName,
        },
      });
      return;
    }

    throw new Error(`알 수 없는 Worker 작업: ${action}`);
  } catch (err: any) {
    self.postMessage({
      id,
      ok: false,
      error: err?.message || String(err),
    });
  }
};
