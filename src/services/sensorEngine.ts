/**
 * Unified Multi-Platform Engine Transport for SensorClean.
 *
 * Automatically detects the runtime platform:
 * 1. Tauri v2 (Desktop & Mobile): Direct native IPC + custom URI scheme (`sensorclean://`).
 * 2. Static Web (Serverless): In-Worker WebAssembly crate (`sc-wasm`) with zero server dependency.
 * 3. HTTP (Development): Standalone `sc-server` HTTP API.
 */

import {
  ColorSpaceId,
  DetectedDustSpot,
  DetectionParams,
  DetectionResult,
  DetailedProgressInfo,
  InpaintResult,
  ManualBrushStroke,
  MultiFrameReport,
  SessionMetadata,
  SessionUrls,
} from '../types/sensor';
import SensorWorker from '../workers/sensorWorker?worker';

export type ProgressCallback = (
  percent: number,
  label?: string,
  progressInfo?: DetailedProgressInfo
) => void;

export type TransportKind = 'tauri' | 'wasm-worker' | 'http';

export function detectRuntimeTransport(): TransportKind {
  if (
    typeof window !== 'undefined' &&
    ((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)
  ) {
    return 'tauri';
  }
  return 'wasm-worker';
}

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  onProgress?: ProgressCallback;
}

export interface IngestResponse {
  sessionId: string;
  meta: SessionMetadata;
  detection: DetectionResult;
  urls: SessionUrls;
}

export interface DetectResponse {
  detection: DetectionResult;
  urls: { vizBwEdge: string; maskAuto: string };
}

export interface InpaintResponse {
  inpaintResult: InpaintResult;
  urls: { previewInpainted: string; maskFinal: string };
}

export interface ExportResponse {
  fileBlob: Blob;
  downloadName: string;
  inpaintResult: InpaintResult;
  urls: { previewInpainted: string; maskFinal: string };
}

export interface MultiUploadResponse {
  sessions: IngestResponse[];
  multiReport: MultiFrameReport;
}

export interface MultiDetectResponse extends MultiFrameReport {
  perFrame?: any[];
}

export interface MultiExportZipResponse {
  zipBlob: Blob;
  downloadName: string;
}

export class UnifiedSensorEngine {
  private transport: TransportKind;
  private worker: Worker | null = null;
  private reqCounter = 0;
  private pending = new Map<number, PendingRequest>();
  private lastInpaintUrls: { previewInpainted?: string; maskFinal?: string } = {};
  private lastDetectUrls: { vizBwEdge?: string; maskAuto?: string } = {};
  private lastUploadUrls: { previewOriginal?: string; vizBwEdge?: string; maskAuto?: string } = {};

  constructor() {
    this.transport = detectRuntimeTransport();
  }

  public getTransportKind(): TransportKind {
    return this.transport;
  }

  public setTransportKind(kind: TransportKind) {
    this.transport = kind;
  }

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new SensorWorker();
      this.worker.onmessage = (e: MessageEvent) => {
        const { id, type, percent, label, progressInfo, ok, data, error } = e.data || {};
        const entry = this.pending.get(id);
        if (!entry) return;

        if (type === 'progress') {
          entry.onProgress?.(percent, label, progressInfo);
          return;
        }

        this.pending.delete(id);
        if (ok) {
          entry.resolve(data);
        } else {
          entry.reject(new Error(error || '엔진 처리 오류가 발생했습니다.'));
        }
      };
      this.worker.onerror = (err) => {
        for (const [, entry] of this.pending) {
          entry.reject(new Error(err.message || 'Web Worker 실행 오류'));
        }
        this.pending.clear();
      };
    }
    return this.worker;
  }

  private callWorker<T = any>(
    action: string,
    payload: any,
    transfer: Transferable[] = [],
    onProgress?: ProgressCallback
  ): Promise<T> {
    const worker = this.getWorker();
    const id = ++this.reqCounter;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ id, action, payload }, transfer);
    });
  }

  private async invokeTauri<T = any>(cmd: string, args: Record<string, any>): Promise<T> {
    const tauri = (window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__;
    if (tauri && typeof tauri.invoke === 'function') {
      return await tauri.invoke(cmd, args);
    }
    throw new Error('Tauri API를 찾을 수 없습니다.');
  }

  // ---------------------------------------------------------------------------
  // Core Engine Operations
  // ---------------------------------------------------------------------------

  async uploadAndDetect(
    file: File,
    params: DetectionParams,
    onProgress?: ProgressCallback
  ): Promise<IngestResponse> {
    // 1. Tauri Native Transport
    if (this.transport === 'tauri') {
      onProgress?.(10, 'Tauri 네이티브 센서 파이프라인 시작');
      const buffer = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buffer));
      const res = await this.invokeTauri<any>('cmd_ingest_and_detect', {
        fileName: file.name,
        bytes,
        params,
      });

      const sid = res.sessionId || res.session_id;
      const urls: SessionUrls = {
        previewOriginal: `sensorclean://preview/${sid}`,
        vizBwEdge: `sensorclean://edge/${sid}`,
        maskAuto: `sensorclean://mask/${sid}`,
      };

      onProgress?.(100, 'RAW 분석 완료');
      return {
        sessionId: sid,
        meta: res.meta,
        detection: res.detection,
        urls,
      };
    }

    // 2. Wasm Worker (Serverless Static Web) & HTTP Fallback
    const buffer = await file.arrayBuffer();
    const sessionId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const res = await this.callWorker(
      'ingest_and_detect',
      {
        sessionId,
        fileName: file.name,
        buffer,
        params,
      },
      [buffer],
      onProgress
    );

    if (this.lastUploadUrls.previewOriginal) URL.revokeObjectURL(this.lastUploadUrls.previewOriginal);
    if (this.lastUploadUrls.vizBwEdge) URL.revokeObjectURL(this.lastUploadUrls.vizBwEdge);
    if (this.lastUploadUrls.maskAuto) URL.revokeObjectURL(this.lastUploadUrls.maskAuto);

    const urls: SessionUrls = {
      previewOriginal: URL.createObjectURL(res.blobs.previewOriginalBlob),
      vizBwEdge: URL.createObjectURL(res.blobs.vizBwEdgeBlob),
      maskAuto: URL.createObjectURL(res.blobs.maskAutoBlob),
    };
    this.lastUploadUrls = { ...urls };

    return {
      sessionId: res.sessionId,
      meta: res.meta,
      detection: res.detection,
      urls,
    };
  }

  async detect(
    sessionId: string,
    params: DetectionParams,
    onProgress?: ProgressCallback
  ): Promise<DetectResponse> {
    if (this.transport === 'tauri') {
      onProgress?.(20, 'Tauri 다중 스케일 DoG 먼지 탐지 중');
      const res = await this.invokeTauri<any>('cmd_detect', {
        sessionId,
        params,
      });
      return {
        detection: res,
        urls: {
          vizBwEdge: `sensorclean://edge/${sessionId}?t=${Date.now()}`,
          maskAuto: `sensorclean://mask/${sessionId}?t=${Date.now()}`,
        },
      };
    }

    const res = await this.callWorker('detect', { sessionId, params }, [], onProgress);

    if (this.lastDetectUrls.vizBwEdge) URL.revokeObjectURL(this.lastDetectUrls.vizBwEdge);
    if (this.lastDetectUrls.maskAuto) URL.revokeObjectURL(this.lastDetectUrls.maskAuto);

    const vizBwEdge = URL.createObjectURL(res.blobs.vizBwEdgeBlob);
    const maskAuto = URL.createObjectURL(res.blobs.maskAutoBlob);
    this.lastDetectUrls = { vizBwEdge, maskAuto };

    return {
      detection: res.detection,
      urls: {
        vizBwEdge,
        maskAuto,
      },
    };
  }

  async inpaint(
    sessionId: string,
    spots: DetectedDustSpot[],
    manualStrokes: ManualBrushStroke[],
    inpaintRadius: number,
    preserveGrain: boolean,
    onProgress?: ProgressCallback
  ): Promise<InpaintResponse> {
    if (this.transport === 'tauri') {
      onProgress?.(25, 'Tauri 16-bit CFA 인페인팅 연산 중');
      const res = await this.invokeTauri<any>('cmd_inpaint', {
        sessionId,
        spots,
        manualStrokes,
        inpaintRadius,
        preserveGrain,
      });
      return {
        inpaintResult: res,
        urls: {
          previewInpainted: `sensorclean://healed/${sessionId}?t=${Date.now()}`,
          maskFinal: `sensorclean://mask/${sessionId}?t=${Date.now()}`,
        },
      };
    }

    const res = await this.callWorker(
      'inpaint',
      {
        sessionId,
        spots,
        manualStrokes,
        inpaintRadius,
        preserveGrain,
      },
      [],
      onProgress
    );

    if (this.lastInpaintUrls.previewInpainted) URL.revokeObjectURL(this.lastInpaintUrls.previewInpainted);
    if (this.lastInpaintUrls.maskFinal) URL.revokeObjectURL(this.lastInpaintUrls.maskFinal);

    const previewInpainted = URL.createObjectURL(res.blobs.previewInpaintedBlob);
    const maskFinal = URL.createObjectURL(res.blobs.maskFinalBlob);
    this.lastInpaintUrls = { previewInpainted, maskFinal };

    return {
      inpaintResult: res.inpaintResult,
      urls: {
        previewInpainted,
        maskFinal,
      },
    };
  }

  async exportSingle(
    sessionId: string,
    format: 'dng' | 'tiff16' | 'png' | 'jpg' | 'xmp',
    spots: DetectedDustSpot[],
    manualStrokes: ManualBrushStroke[],
    inpaintRadius: number,
    preserveGrain: boolean,
    colorSpace: ColorSpaceId = 'auto',
    onProgress?: ProgressCallback
  ): Promise<ExportResponse> {
    if (this.transport === 'tauri') {
      onProgress?.(20, 'Tauri 네이티브 파일 내보내기 중');
      const res: any = await this.invokeTauri('cmd_export_file', {
        sessionId,
        format,
        colorSpace,
      });

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

      const rawBytes = Array.isArray(res)
        ? res
        : res && Array.isArray(res.bytes)
        ? res.bytes
        : [];
      const u8 = new Uint8Array(rawBytes);
      const fileBlob = new Blob([u8 as unknown as BlobPart], { type: mimeType });
      const ext = format === 'tiff16' ? 'tiff' : format;
      const downloadName = `image_cleaned.${ext}`;

      return {
        fileBlob,
        downloadName,
        inpaintResult: {
          healedSpotsCount: spots.length,
          inpaintedPixels: 0,
          inpaintedAreaPct: 0,
          bitDepth: '16-bit',
          inpaintMethod: 'cfa_4phase_telea',
          inpaintRadius,
          fullWidth: 0,
          fullHeight: 0,
          fromCache: false,
          incrementalRois: 0,
        },
        urls: {
          previewInpainted: `sensorclean://healed/${sessionId}`,
          maskFinal: `sensorclean://mask/${sessionId}`,
        },
      };
    }

    const res = await this.callWorker(
      'export_single',
      {
        sessionId,
        format,
        spots,
        manualStrokes,
        inpaintRadius,
        preserveGrain,
        colorSpace,
      },
      [],
      onProgress
    );

    return {
      fileBlob: res.fileBlob,
      downloadName: res.downloadName,
      inpaintResult: res.inpaintResult,
      urls: {
        previewInpainted: URL.createObjectURL(res.blobs.previewInpaintedBlob),
        maskFinal: URL.createObjectURL(res.blobs.maskFinalBlob),
      },
    };
  }

  async multiUpload(
    files: File[],
    params: DetectionParams,
    onProgress?: ProgressCallback
  ): Promise<MultiUploadResponse> {
    const fileItems: Array<{ sessionId: string; fileName: string; buffer: ArrayBuffer }> = [];
    const transfers: Transferable[] = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const buf = await f.arrayBuffer();
      fileItems.push({
        sessionId: `seq_${Date.now()}_${i + 1}_${Math.random().toString(36).slice(2, 6)}`,
        fileName: f.name,
        buffer: buf,
      });
      transfers.push(buf);
    }

    const res = await this.callWorker(
      'multi_upload',
      { files: fileItems, params },
      transfers,
      onProgress
    );

    const sessions: IngestResponse[] = (res.sessions || []).map((s: any) => ({
      sessionId: s.sessionId,
      meta: s.meta,
      detection: s.detection,
      urls: {
        previewOriginal: URL.createObjectURL(s.blobs.previewOriginalBlob),
        vizBwEdge: URL.createObjectURL(s.blobs.vizBwEdgeBlob),
        maskAuto: URL.createObjectURL(s.blobs.maskAutoBlob),
      },
    }));

    return {
      sessions,
      multiReport: res.multiReport,
    };
  }

  async multiDetect(
    sessionIds: string[],
    params: DetectionParams,
    tolerancePx = 14.0,
    minFramesMatch = 2,
    onProgress?: ProgressCallback
  ): Promise<MultiDetectResponse> {
    return await this.callWorker(
      'multi_detect',
      {
        sessionIds,
        params,
        tolerancePx,
        minFramesMatch,
      },
      [],
      onProgress
    );
  }

  async multiExportZip(
    items: Array<{
      sessionId: string;
      spots: DetectedDustSpot[];
      manualStrokes: ManualBrushStroke[];
      params: DetectionParams;
    }>,
    format: 'dng' | 'tiff16' | 'png' | 'jpg' | 'xmp',
    colorSpace: ColorSpaceId = 'auto',
    onProgress?: ProgressCallback
  ): Promise<MultiExportZipResponse> {
    return await this.callWorker(
      'multi_export_zip',
      { items, format, colorSpace },
      [],
      onProgress
    );
  }

  async cancel(sessionId: string): Promise<boolean> {
    if (this.transport === 'tauri') {
      return await this.invokeTauri('cmd_cancel_job', { sessionId });
    }
    const res = await this.callWorker('cancel', { sessionId });
    return res.canceled;
  }

  triggerBrowserDownload(blob: Blob, downloadName: string) {
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
  }
}

export const sensorEngine = new UnifiedSensorEngine();
export const localSensorEngine = sensorEngine;
