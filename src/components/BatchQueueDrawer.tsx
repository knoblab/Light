import React, { useState } from 'react';
import {
  X,
  Play,
  CheckCircle2,
  Clock,
  AlertCircle,
  FileArchive,
  Trash2,
  FolderOpen,
  Camera,
  Layers,
} from 'lucide-react';
import { DetectedDustSpot, DetectionParams, SessionMetadata } from '../types/sensor';
import { sensorEngine } from '../services/sensorEngine';

export interface BatchItem {
  id: string;
  file: File;
  meta?: SessionMetadata;
  spots: DetectedDustSpot[];
  status: 'queued' | 'analyzing' | 'healed' | 'exported' | 'error';
  progress: number;
  errorMessage?: string;
  matchedProfile?: string;
}

interface BatchQueueDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  items: BatchItem[];
  onAddFiles: (files: File[]) => void;
  onRemoveItem: (id: string) => void;
  onClearCompleted: () => void;
  onSelectCurrentItem: (id: string) => void;
  params: DetectionParams;
}

export const BatchQueueDrawer: React.FC<BatchQueueDrawerProps> = ({
  isOpen,
  onClose,
  items,
  onAddFiles,
  onRemoveItem,
  onClearCompleted,
  onSelectCurrentItem,
  params,
}) => {
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [exportFormat, setExportFormat] = useState<'dng' | 'tiff16' | 'jpg'>('dng');
  const [overallProgress, setOverallProgress] = useState(0);

  if (!isOpen) return null;

  const handleFolderUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      onAddFiles(Array.from(fileList));
    }
    e.target.value = '';
  };

  const runBatchProcessing = async () => {
    if (items.length === 0 || isBatchRunning) return;
    setIsBatchRunning(true);
    setOverallProgress(0);

    const pendingItems = items.filter((it) => it.status === 'queued' || it.status === 'error');
    const total = pendingItems.length;

    for (let i = 0; i < total; i++) {
      const it = pendingItems[i];
      it.status = 'analyzing';
      it.progress = 10;
      setOverallProgress(Math.round((i / total) * 100));

      try {
        const ingestRes = await sensorEngine.uploadAndDetect(it.file, params, (pct) => {
          it.progress = Math.round(10 + (pct / 100) * 40);
        });
        it.meta = ingestRes.meta;
        it.spots = ingestRes.detection.spots;
        it.matchedProfile = `${ingestRes.meta.exif.make || ''} ${ingestRes.meta.exif.model || ''}`.trim();

        it.status = 'healed';
        it.progress = 60;

        // Auto export
        await sensorEngine.exportSingle(
          ingestRes.sessionId,
          exportFormat,
          it.spots,
          [],
          params.inpaintRadius || 6,
          params.preserveGrain ?? true,
          'auto',
          (pct) => {
            it.progress = Math.round(60 + (pct / 100) * 40);
          }
        );

        it.status = 'exported';
        it.progress = 100;
      } catch (err: any) {
        it.status = 'error';
        it.errorMessage = err?.message || '처리 오류';
      }
    }

    setOverallProgress(100);
    setIsBatchRunning(false);
  };

  return (
    <div className="fixed inset-y-0 right-0 w-full sm:w-[460px] bg-[#1E1E20] border-l border-[#3A3A3D] shadow-2xl z-50 flex flex-col text-[#F7F6F2] animate-in slide-in-from-right duration-200">
      {/* Drawer Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[#3A3A3D] bg-[#242426]">
        <div className="flex items-center gap-2">
          <Layers className="w-5 h-5 text-[#889B6E]" />
          <h2 className="text-sm font-semibold tracking-wide">일괄 배치 대기열 (Batch Queue)</h2>
          <span className="px-2 py-0.5 rounded-full text-[11px] bg-[#3A3A3D] text-[#C2C1BB] font-mono">
            {items.length}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded text-[#888783] hover:text-[#F7F6F2] hover:bg-[#3A3A3D] transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Action Bar */}
      <div className="p-4 border-b border-[#3A3A3D] flex items-center justify-between gap-3 bg-[#1E1E20]">
        <label className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#2D2D30] hover:bg-[#3A3A3D] text-xs text-[#C2C1BB] hover:text-[#F7F6F2] font-medium transition-colors cursor-pointer border border-[#3A3A3D]">
          <FolderOpen className="w-3.5 h-3.5" />
          <span>폴더 / 사진 추가</span>
          <input
            type="file"
            multiple
            // @ts-ignore
            webkitdirectory=""
            onChange={handleFolderUpload}
            className="hidden"
          />
        </label>

        <div className="flex items-center gap-2">
          <select
            value={exportFormat}
            onChange={(e) => setExportFormat(e.target.value as any)}
            className="bg-[#2D2D30] text-xs text-[#C2C1BB] border border-[#3A3A3D] rounded px-2 py-1.5 outline-none"
          >
            <option value="dng">16-bit DNG (무손실)</option>
            <option value="tiff16">16-bit TIFF</option>
            <option value="jpg">최고품질 JPEG</option>
          </select>

          <button
            onClick={runBatchProcessing}
            disabled={isBatchRunning || items.length === 0}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold shadow-xs transition-colors cursor-pointer ${
              isBatchRunning || items.length === 0
                ? 'bg-[#3A3A3D] text-[#888783] cursor-not-allowed'
                : 'bg-[#556042] hover:bg-[#687652] text-[#F7F6F2]'
            }`}
          >
            <Play className="w-3.5 h-3.5" />
            <span>{isBatchRunning ? '처리 중...' : '일괄 실행'}</span>
          </button>
        </div>
      </div>

      {/* Progress Bar (Visible while running) */}
      {isBatchRunning && (
        <div className="w-full bg-[#2D2D30] h-1.5 relative overflow-hidden">
          <div
            className="bg-[#889B6E] h-full transition-all duration-300"
            style={{ width: `${overallProgress}%` }}
          />
        </div>
      )}

      {/* Item List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
        {items.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-[#888783] px-6">
            <Camera className="w-10 h-10 mb-3 text-[#535356]" />
            <p className="text-sm font-medium mb-1">대기열에 사진이 없습니다</p>
            <p className="text-xs max-w-xs text-[#888783]">
              출사 후 연속 촬영된 RAW 폴더를 추가하면 자동으로 센서 프로파일을 매칭하여 일괄 먼지 제거를 수행합니다.
            </p>
          </div>
        ) : (
          items.map((it) => (
            <div
              key={it.id}
              onClick={() => onSelectCurrentItem(it.id)}
              className="p-3 rounded-lg bg-[#242426] border border-[#3A3A3D] hover:border-[#556042] transition-colors cursor-pointer flex flex-col gap-2"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 overflow-hidden">
                  <span className="text-xs font-medium text-[#F7F6F2] truncate max-w-[220px]">
                    {it.file.name}
                  </span>
                  {it.matchedProfile && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#3A3A3D] text-[#889B6E] font-mono shrink-0">
                      {it.matchedProfile}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {it.status === 'queued' && (
                    <span className="flex items-center gap-1 text-[11px] text-[#888783]">
                      <Clock className="w-3 h-3" /> 대기
                    </span>
                  )}
                  {it.status === 'analyzing' && (
                    <span className="flex items-center gap-1 text-[11px] text-[#889B6E]">
                      분석 중 {it.progress}%
                    </span>
                  )}
                  {it.status === 'healed' && (
                    <span className="flex items-center gap-1 text-[11px] text-[#C2C1BB]">
                      복원 중 {it.progress}%
                    </span>
                  )}
                  {it.status === 'exported' && (
                    <span className="flex items-center gap-1 text-[11px] text-[#889B6E] font-medium">
                      <CheckCircle2 className="w-3.5 h-3.5" /> 완료 ({it.spots.length}점)
                    </span>
                  )}
                  {it.status === 'error' && (
                    <span className="flex items-center gap-1 text-[11px] text-[#E5484D]">
                      <AlertCircle className="w-3.5 h-3.5" /> 오류
                    </span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveItem(it.id);
                    }}
                    className="p-1 rounded text-[#888783] hover:text-[#E5484D] hover:bg-[#3A3A3D] transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Progress per item */}
              {it.status !== 'queued' && it.status !== 'exported' && it.status !== 'error' && (
                <div className="w-full bg-[#1A1A1C] rounded-full h-1 overflow-hidden">
                  <div
                    className="bg-[#889B6E] h-full transition-all duration-200"
                    style={{ width: `${it.progress}%` }}
                  />
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      {items.length > 0 && (
        <div className="p-4 border-t border-[#3A3A3D] bg-[#242426] flex items-center justify-between text-xs text-[#888783]">
          <span>총 {items.length}개 파일</span>
          <button
            onClick={onClearCompleted}
            className="hover:text-[#F7F6F2] transition-colors cursor-pointer"
          >
            완료 항목 비우기
          </button>
        </div>
      )}
    </div>
  );
};
