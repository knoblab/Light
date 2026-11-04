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

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  onProgress?: ProgressCallback;
}

class LocalSensorEngineClient {
  private worker: Worker | null = null;
  private reqCounter = 0;
  private pending = new Map<number, PendingRequest>();

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
          entry.reject(new Error(error || '로컬 엔진 처리 오류'));
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

  private isBackendSession(sessionId: string): boolean {
    return sessionId.startsWith('sc_');
  }

  private async downloadChunkedFile(
    sessionId: string,
    fileName: string,
    mimeType: string,
    fileSizeBytes: number,
    chunkSize: number,
    totalChunks: number,
    onProgress?: ProgressCallback,
    startPct = 40,
    endPct = 98
  ): Promise<Blob> {
    const chunks: Uint8Array[] = [];
    for (let idx = 0; idx < totalChunks; idx++) {
      const offset = idx * chunkSize;
      const length = Math.min(chunkSize, fileSizeBytes - offset);
      const pct = Math.round(startPct + ((idx + 1) / totalChunks) * (endPct - startPct));
      onProgress?.(pct, `무손실 16-bit 데이터 스트리밍 (${idx + 1}/${totalChunks})`);
      const res = await fetch(
        `/api/export-chunk/${encodeURIComponent(sessionId)}/${encodeURIComponent(fileName)}?offset=${offset}&length=${length}`
      );
      if (!res.ok) {
        throw new Error(`청크 다운로드 실패 (${res.status})`);
      }
      const buf = await res.arrayBuffer();
      chunks.push(new Uint8Array(buf));
    }
    return new Blob(chunks as unknown as BlobPart[], { type: mimeType });
  }

  async uploadAndDetect(
    file: File,
    params: DetectionParams,
    onProgress?: ProgressCallback
  ): Promise<{
    sessionId: string;
    meta: SessionMetadata;
    detection: DetectionResult;
    urls: SessionUrls;
  }> {
    // 1. Prefer Backend Python 16-bit LibRaw (rawpy) pipeline for 100% DR preservation on RAW files
    try {
      onProgress?.(12, '16-bit LibRaw(rawpy) 선형 현상 및 센서 디코딩 중...');
      const formData = new FormData();
      formData.append('file', file);
      formData.append('method', params.method);
      formData.append('sensitivity', String(params.sensitivity));
      formData.append('cloudProtection', String(params.cloudProtection));
      formData.append('minRadius', String(params.minRadius));
      formData.append('maxRadius', String(params.maxRadius));
      formData.append('minCircularity', String(params.minCircularity));

      const resp = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (resp.ok) {
        const data = await resp.json();
        if (data && data.sessionId && data.meta) {
          onProgress?.(100, '16-bit 무손실 디코딩 완료');
          return {
            sessionId: data.sessionId,
            meta: data.meta,
            detection: data.detection,
            urls: data.urls,
          };
        }
      }
    } catch {
      // Fallback to local Web Worker if backend is unreachable
    }

    // 2. Local 16-bit Worker Fallback
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

    const urls: SessionUrls = {
      previewOriginal: URL.createObjectURL(res.blobs.previewOriginalBlob),
      vizBwEdge: URL.createObjectURL(res.blobs.vizBwEdgeBlob),
      maskAuto: URL.createObjectURL(res.blobs.maskAutoBlob),
    };

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
  ): Promise<{
    detection: DetectionResult;
    urls: { vizBwEdge: string; maskAuto: string };
  }> {
    if (this.isBackendSession(sessionId)) {
      onProgress?.(20, '16-bit 선형 센서 데이터 기반 먼지 분석 중...');
      const resp = await fetch('/api/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, params }),
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || '먼지 탐지 중 오류가 발생했습니다.');
      }
      const data = await resp.json();
      onProgress?.(100, '먼지 분석 완료');
      return {
        detection: data.detection,
        urls: data.urls,
      };
    }

    const res = await this.callWorker('detect', { sessionId, params }, [], onProgress);
    return {
      detection: res.detection,
      urls: {
        vizBwEdge: URL.createObjectURL(res.blobs.vizBwEdgeBlob),
        maskAuto: URL.createObjectURL(res.blobs.maskAutoBlob),
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
  ): Promise<{
    inpaintResult: InpaintResult;
    urls: { previewInpainted: string; maskFinal: string };
  }> {
    if (this.isBackendSession(sessionId)) {
      onProgress?.(25, '16-bit 임시 저장 체크포인트 증분 복원 중...');
      const resp = await fetch('/api/inpaint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          spots,
          manualStrokes,
          inpaintRadius,
          preserveGrain,
        }),
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || '16-bit 복원 중 오류가 발생했습니다.');
      }
      const data = await resp.json();
      onProgress?.(100, '복원 및 임시 저장 완료');
      return {
        inpaintResult: data.inpaintResult,
        urls: data.urls,
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

    return {
      inpaintResult: res.inpaintResult,
      urls: {
        previewInpainted: URL.createObjectURL(res.blobs.previewInpaintedBlob),
        maskFinal: URL.createObjectURL(res.blobs.maskFinalBlob),
      },
    };
  }

  async exportSingle(
    sessionId: string,
    format: 'dng' | 'tiff16' | 'png' | 'jpg',
    spots: DetectedDustSpot[],
    manualStrokes: ManualBrushStroke[],
    inpaintRadius: number,
    preserveGrain: boolean,
    colorSpace: ColorSpaceId = 'auto',
    onProgress?: ProgressCallback
  ): Promise<{
    fileBlob: Blob;
    downloadName: string;
    inpaintResult: InpaintResult;
    urls: { previewInpainted: string; maskFinal: string };
  }> {
    if (this.isBackendSession(sessionId)) {
      onProgress?.(15, '임시 저장본 기반 16-bit 무손실 패키징 중...');
      const resp = await fetch('/api/export-prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          format,
          spots,
          manualStrokes,
          inpaintRadius,
          preserveGrain,
          colorSpace,
        }),
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || '파일 내보내기 준비 중 오류가 발생했습니다.');
      }
      const data = await resp.json();
      const meta = data.exportMeta;
      const fileBlob = await this.downloadChunkedFile(
        meta.sessionId,
        meta.fileName,
        meta.mimeType,
        meta.fileSizeBytes,
        meta.chunkSize,
        meta.totalChunks,
        onProgress,
        35,
        98
      );
      onProgress?.(100, '내보내기 완료');
      return {
        fileBlob,
        downloadName: meta.fileName,
        inpaintResult: data.inpaintResult,
        urls: data.urls,
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
  ): Promise<{
    sessions: Array<{
      sessionId: string;
      meta: SessionMetadata;
      detection: DetectionResult;
      urls: SessionUrls;
    }>;
    multiReport: MultiFrameReport;
  }> {
    try {
      onProgress?.(15, `연속 사진 ${files.length}장 16-bit LibRaw 현상 중...`);
      const formData = new FormData();
      for (const f of files) {
        formData.append('files', f);
      }
      const resp = await fetch('/api/multi-upload', {
        method: 'POST',
        body: formData,
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data && Array.isArray(data.sessions)) {
          onProgress?.(100, '연속 사진 로딩 완료');
          return {
            sessions: data.sessions,
            multiReport: data.multiReport,
          };
        }
      }
    } catch {
      // Fallback to local worker
    }

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

    const sessions = (res.sessions || []).map((s: any) => ({
      sessionId: s.sessionId,
      meta: s.meta,
      detection: s.detection,
      urls: {
        previewOriginal: URL.createObjectURL(s.blobs.previewOriginalBlob),
        vizBwEdge: URL.createObjectURL(s.blobs.vizBwEdgeBlob),
        maskAuto: URL.createObjectURL(s.blobs.maskAutoBlob),
      } as SessionUrls,
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
  ): Promise<MultiFrameReport & { perFrame: any[] }> {
    if (sessionIds.length > 0 && this.isBackendSession(sessionIds[0])) {
      onProgress?.(20, '연속 사진 다중 프레임 센서 먼지 분석 중...');
      const resp = await fetch('/api/multi-detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionIds,
          params,
          tolerancePx,
          minFramesMatch,
        }),
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || '다중 프레임 분석 오류');
      }
      const data = await resp.json();
      onProgress?.(100, '다중 프레임 분석 완료');
      return data;
    }

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
    format: 'dng' | 'tiff16' | 'png' | 'jpg',
    colorSpace: ColorSpaceId = 'auto',
    onProgress?: ProgressCallback
  ): Promise<{ zipBlob: Blob; downloadName: string }> {
    if (items.length > 0 && this.isBackendSession(items[0].sessionId)) {
      onProgress?.(15, `연속 ${items.length}장 임시 저장본 기반 ZIP 생성 중...`);
      const resp = await fetch('/api/multi-export-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          format,
          colorSpace,
          prepareOnly: true,
        }),
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || '배치 ZIP 생성 오류');
      }
      const data = await resp.json();
      const meta = data.exportMeta;
      const zipBlob = await this.downloadChunkedFile(
        meta.sessionId,
        meta.fileName,
        meta.mimeType || 'application/zip',
        meta.fileSizeBytes,
        meta.chunkSize,
        meta.totalChunks,
        onProgress,
        40,
        98
      );
      onProgress?.(100, 'ZIP 내보내기 완료');
      return {
        zipBlob,
        downloadName: meta.downloadName || meta.fileName,
      };
    }

    return await this.callWorker(
      'multi_export_zip',
      { items, format, colorSpace },
      [],
      onProgress
    );
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

export const localSensorEngine = new LocalSensorEngineClient();
