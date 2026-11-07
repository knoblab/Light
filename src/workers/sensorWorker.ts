/// <reference lib="webworker" />

/**
 * Pure-Rust WebAssembly Sensor Worker for SensorClean.
 * Zero JavaScript/TypeScript image processing algorithms: all operations
 * (RAW decoding, multiscale DoG detection, CFA inpainting, DNG 1.6 generation)
 * are executed via sc-wasm compiled to wasm32-unknown-unknown.
 */

import initWasm, {
  wasm_init,
  wasm_ingest_and_detect,
  wasm_detect,
  wasm_inpaint,
  wasm_render_tile,
  wasm_export_file,
  wasm_multi_detect,
  wasm_cancel_session,
  wasm_drop_session,
} from '../../crates/sc-wasm/pkg/sc_wasm.js';
import wasmUrl from '../../crates/sc-wasm/pkg/sc_wasm_bg.wasm?url';
import {
  ColorSpaceId,
  DetectedDustSpot,
  DetectionParams,
  DetailedProgressInfo,
  ManualBrushStroke,
} from '../types/sensor';
import { buildZipArchiveBlob } from '../utils/zip';

let wasmInitPromise: Promise<void> | null = null;

async function ensureWasm(): Promise<void> {
  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      await initWasm({ module_or_path: wasmUrl });
      wasm_init();
    })();
  }
  return wasmInitPromise;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

function sendProgress(reqId: number, percent: number, label?: string) {
  self.postMessage({
    id: reqId,
    type: 'progress',
    percent: Math.min(100, Math.max(0, percent)),
    label,
  });
}

function sendDetailedProgress(
  reqId: number,
  stepIndex: number,
  totalSteps: number,
  stepName: string,
  stepPercent: number,
  overallPercent?: number
) {
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

  self.postMessage({
    id: reqId,
    type: 'progress',
    percent: progressInfo.overallPercent,
    label: `${stepIndex}/${totalSteps}단계 · ${stepName} (${progressInfo.stepPercent}%)`,
    progressInfo,
  });
}

const fileNames = new Map<string, string>();

self.onmessage = async (event: MessageEvent) => {
  const { id, action, payload } = event.data || {};
  try {
    await ensureWasm();

    if (action === 'ingest_and_detect') {
      const { sessionId, fileName, buffer, params } = payload;
      sendDetailedProgress(id, 1, 4, 'Rust WebAssembly 엔진 초기화', 20, 10);

      const uint8 = new Uint8Array(buffer);
      sendDetailedProgress(id, 2, 4, '16-bit RAW / TIFF 디코딩', 60, 35);

      const res = wasm_ingest_and_detect(fileName, uint8, params);
      sendDetailedProgress(id, 3, 4, '다중 스케일 가우시안 차분(DoG) 탐지', 90, 70);

      const previewOriginalBlob = base64ToBlob(res.previewJpgBase64, 'image/jpeg');
      const vizBwEdgeBlob = base64ToBlob(res.vizEdgeJpgBase64, 'image/jpeg');
      const maskAutoBlob = base64ToBlob(res.maskAutoPngBase64, 'image/jpeg');

      fileNames.set(res.sessionId, fileName);
      sendDetailedProgress(id, 4, 4, '다크룸 캔버스 인코딩 완료', 100, 100);

      self.postMessage({
        id,
        ok: true,
        data: {
          sessionId: res.sessionId,
          meta: res.meta,
          detection: res.detection,
          blobs: {
            previewOriginalBlob,
            vizBwEdgeBlob,
            maskAutoBlob,
          },
        },
      });
      return;
    }

    if (action === 'detect') {
      const { sessionId, params } = payload;
      sendProgress(id, 20, '다중 스케일 DoG 먼지 탐지 중');

      const res = wasm_detect(sessionId, params);
      sendProgress(id, 85, '미리보기 캔버스 인코딩 중');

      const vizBwEdgeBlob = base64ToBlob(res.vizEdgeJpgBase64, 'image/jpeg');
      const maskAutoBlob = base64ToBlob(res.maskAutoPngBase64, 'image/jpeg');

      sendProgress(id, 100, '먼지 분석 완료');
      self.postMessage({
        id,
        ok: true,
        data: {
          detection: res.detection,
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

      sendProgress(id, 20, '16-bit 센서 CFA 4단계 인페인팅 연산 중');
      const res = wasm_inpaint(sessionId, {
        spots: spots || [],
        manual_strokes: manualStrokes || [],
        inpaint_radius: inpaintRadius,
        preserve_grain: preserveGrain,
      });

      sendProgress(id, 90, '복원 미리보기 인코딩 중');
      const previewInpaintedBlob = base64ToBlob(res.previewHealedBase64, 'image/jpeg');
      const maskFinalBlob = base64ToBlob(res.maskFinalPngBase64, 'image/jpeg');

      sendProgress(id, 100, '복원 완료');
      self.postMessage({
        id,
        ok: true,
        data: {
          inpaintResult: res.result,
          blobs: { previewInpaintedBlob, maskFinalBlob },
        },
      });
      return;
    }

    if (action === 'render_tile') {
      const { sessionId, layer, level, tx, ty } = payload;
      const tileBytes = wasm_render_tile(sessionId, layer, level, tx, ty);
      self.postMessage(
        {
          id,
          ok: true,
          data: { tileBytes },
        },
        [tileBytes.buffer]
      );
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
        format: 'dng' | 'tiff16' | 'png' | 'jpg' | 'xmp';
        colorSpace?: ColorSpaceId;
        spots: DetectedDustSpot[];
        manualStrokes: ManualBrushStroke[];
        inpaintRadius: number;
        preserveGrain: boolean;
      } = payload;

      sendProgress(id, 20, '16-bit CFA 복원 및 검증 중');
      const inpaintRes = wasm_inpaint(sessionId, {
        spots: spots || [],
        manual_strokes: manualStrokes || [],
        inpaint_radius: inpaintRadius,
        preserve_grain: preserveGrain,
      });

      sendProgress(id, 70, `${format.toUpperCase()} 파일 인코딩 중`);
      const fileBytes = wasm_export_file(sessionId, format, colorSpace);

      const mimeType =
        format === 'dng'
          ? 'image/x-adobe-dng'
          : format === 'tiff16'
          ? 'image/tiff'
          : format === 'png'
          ? 'image/png'
          : format === 'xmp'
          ? 'application/xml'
          : 'image/jpeg';

      const ext = format === 'tiff16' ? 'tiff' : format === 'xmp' ? 'xmp' : format;
      const origFileName = fileNames.get(sessionId) || 'image';
      const origBase = origFileName.replace(/\.[^/.]+$/, '');
      const downloadName = `${origBase}_cleaned.${ext}`;

      const fileBlob = new Blob([fileBytes as unknown as BlobPart], { type: mimeType });
      const previewInpaintedBlob = base64ToBlob(inpaintRes.previewHealedBase64, 'image/jpeg');
      const maskFinalBlob = base64ToBlob(inpaintRes.maskFinalPngBase64, 'image/jpeg');

      sendProgress(id, 100, '내보내기 완료');
      self.postMessage({
        id,
        ok: true,
        data: {
          fileBlob,
          downloadName,
          inpaintResult: inpaintRes.result,
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
        sendProgress(id, Math.round((i / total) * 90), `연속 사진 [${i + 1}/${total}] ${f.fileName} 불러오는 중`);
        const uint8 = new Uint8Array(f.buffer);
        const res = wasm_ingest_and_detect(f.fileName, uint8, params);
        fileNames.set(res.sessionId, f.fileName);

        const previewOriginalBlob = base64ToBlob(res.previewJpgBase64, 'image/jpeg');
        const vizBwEdgeBlob = base64ToBlob(res.vizEdgeJpgBase64, 'image/jpeg');
        const maskAutoBlob = base64ToBlob(res.maskAutoPngBase64, 'image/jpeg');

        processedList.push({
          sessionId: res.sessionId,
          meta: res.meta,
          detection: res.detection,
          blobs: { previewOriginalBlob, vizBwEdgeBlob, maskAutoBlob },
        });
      }

      sendProgress(id, 92, '다중 프레임 불변 센서 먼지 교차 매칭 중');
      const sessionIds = processedList.map((p) => p.sessionId);
      const multiReport = wasm_multi_detect({
        session_dirs: sessionIds,
        tolerance_px: 14.0,
        min_frames_match: 2,
        default_method: params.method || 'dual',
      });

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

      sendProgress(id, 20, '연속 사진 다중 프레임 재분석 중');
      for (const sid of sessionIds) {
        wasm_detect(sid, params);
      }

      sendProgress(id, 75, '센서 불변 먼지 클러스터링 계산 중');
      const multiReport = wasm_multi_detect({
        session_dirs: sessionIds,
        tolerance_px: tolerancePx,
        min_frames_match: minFramesMatch,
        default_method: params.method || 'dual',
      });

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
        format: 'dng' | 'tiff16' | 'png' | 'jpg' | 'xmp';
        colorSpace?: ColorSpaceId;
      } = payload;

      const zipEntries: Array<{ name: string; data: Uint8Array }> = [];
      const total = items.length;

      for (let i = 0; i < total; i++) {
        const it = items[i];
        const stepPct = Math.round((i / total) * 90);
        sendProgress(id, stepPct, `배치 [${i + 1}/${total}] 복원 및 ${format.toUpperCase()} 인코딩 중`);

        wasm_inpaint(it.sessionId, {
          spots: it.spots || [],
          manual_strokes: it.manualStrokes || [],
          inpaint_radius: it.params?.inpaintRadius ?? 6,
          preserve_grain: it.params?.preserveGrain ?? true,
        });

        const fileBytes = wasm_export_file(it.sessionId, format, colorSpace);
        const origFileName = fileNames.get(it.sessionId) || `image_${i + 1}`;
        const origBase = origFileName.replace(/\.[^/.]+$/, '');
        const ext = format === 'tiff16' ? 'tiff' : format === 'xmp' ? 'xmp' : format;
        const entryName = `${String(i + 1).padStart(2, '0')}_${origBase}_cleaned.${ext}`;
        zipEntries.push({ name: entryName, data: fileBytes });
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

    if (action === 'cancel') {
      const { sessionId } = payload;
      const canceled = wasm_cancel_session(sessionId);
      self.postMessage({ id, ok: true, data: { canceled } });
      return;
    }

    if (action === 'drop') {
      const { sessionId } = payload;
      fileNames.delete(sessionId);
      const dropped = wasm_drop_session(sessionId);
      self.postMessage({ id, ok: true, data: { dropped } });
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
