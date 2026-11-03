import {
  ColorSpaceId,
  DetectedDustSpot,
  DetectionParams,
  DetectionResult,
  InpaintResult,
  ManualBrushStroke,
  MultiFrameReport,
  SessionMetadata,
  SessionUrls,
} from '../types/sensor';
import SensorWorker from '../workers/sensorWorker?worker';

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  onProgress?: (percent: number, label?: string) => void;
}

class LocalSensorEngineClient {
  private worker: Worker | null = null;
  private reqCounter = 0;
  private pending = new Map<number, PendingRequest>();

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new SensorWorker();
      this.worker.onmessage = (e: MessageEvent) => {
        const { id, type, percent, label, ok, data, error } = e.data || {};
        const entry = this.pending.get(id);
        if (!entry) return;

        if (type === 'progress') {
          entry.onProgress?.(percent, label);
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
    onProgress?: (percent: number, label?: string) => void
  ): Promise<T> {
    const worker = this.getWorker();
    const id = ++this.reqCounter;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ id, action, payload }, transfer);
    });
  }

  async uploadAndDetect(
    file: File,
    params: DetectionParams,
    onProgress?: (percent: number, label?: string) => void
  ): Promise<{
    sessionId: string;
    meta: SessionMetadata;
    detection: DetectionResult;
    urls: SessionUrls;
  }> {
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
    onProgress?: (percent: number, label?: string) => void
  ): Promise<{
    detection: DetectionResult;
    urls: { vizBwEdge: string; maskAuto: string };
  }> {
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
    onProgress?: (percent: number, label?: string) => void
  ): Promise<{
    inpaintResult: InpaintResult;
    urls: { previewInpainted: string; maskFinal: string };
  }> {
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
    onProgress?: (percent: number, label?: string) => void
  ): Promise<{
    fileBlob: Blob;
    downloadName: string;
    inpaintResult: InpaintResult;
    urls: { previewInpainted: string; maskFinal: string };
  }> {
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
    params: DetectionParams
  ): Promise<{
    sessions: Array<{
      sessionId: string;
      meta: SessionMetadata;
      detection: DetectionResult;
      urls: SessionUrls;
    }>;
    multiReport: MultiFrameReport;
  }> {
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

    const res = await this.callWorker('multi_upload', { files: fileItems, params }, transfers);

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
    minFramesMatch = 2
  ): Promise<MultiFrameReport & { perFrame: any[] }> {
    return await this.callWorker('multi_detect', {
      sessionIds,
      params,
      tolerancePx,
      minFramesMatch,
    });
  }

  async multiExportZip(
    items: Array<{
      sessionId: string;
      spots: DetectedDustSpot[];
      manualStrokes: ManualBrushStroke[];
      params: DetectionParams;
    }>,
    format: 'dng' | 'tiff16' | 'png' | 'jpg',
    colorSpace: ColorSpaceId = 'auto'
  ): Promise<{ zipBlob: Blob; downloadName: string }> {
    return await this.callWorker('multi_export_zip', { items, format, colorSpace });
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
