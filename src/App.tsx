import React, { useState, useEffect, useRef } from 'react';
import {
  Upload,
  Check,
  Download,
  RefreshCw,
  AlertCircle,
  Film,
  Eraser,
  MousePointer,
  Paintbrush,
  RotateCcw,
  Undo2,
  Redo2,
  Sliders,
  Sparkles,
  ListFilter,
  ChevronDown,
  ChevronRight,
  PanelRightClose,
  PanelRightOpen,
  X,
  Plus,
  Palette,
} from 'lucide-react';
import {
  ColorSpaceId,
  DetectedDustSpot,
  DetectionMethod,
  DetectionParams,
  InpaintResult,
  InteractionTool,
  ManualBrushStroke,
  MultiFrameItem,
  MultiFrameReport,
  OverlayMode,
  SessionMetadata,
  SessionUrls,
  SpotFilterMode,
  StudioMode,
  ViewComparisonMode,
} from './types/sensor';
import { COLOR_SPACE_OPTIONS } from './engine/colorSpaces';
import { DarkroomCanvas } from './components/DarkroomCanvas';
import { localSensorEngine } from './services/localSensorEngine';

type MobileDrawerTab = 'tools' | 'detect' | 'heal' | 'spots' | 'export' | null;

interface HistorySnapshot {
  spots: DetectedDustSpot[];
  manualStrokes: ManualBrushStroke[];
  inpaintResult: InpaintResult | null;
  previewInpainted?: string;
  maskFinal?: string;
  comparisonMode: ViewComparisonMode;
  showDustOverlay: boolean;
}

// Reusable Lightroom CC Compact Slider Component
const LrSlider: React.FC<{
  label: string;
  value: number;
  displayValue?: string | number;
  min: number;
  max: number;
  step?: number;
  onChange: (val: number) => void;
}> = ({ label, value, displayValue, min, max, step = 1, onChange }) => (
  <div className="py-1.5">
    <div className="flex items-center justify-between text-[11px] mb-1">
      <span className="text-[#B8B8B8] font-medium">{label}</span>
      <span className="font-mono text-[#E5E5E5] tabular-nums">
        {displayValue !== undefined ? displayValue : value}
      </span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="lr-slider"
    />
  </div>
);

export function App() {
  const [studioMode, setStudioMode] = useState<StudioMode>('single');
  const [filterMode, setFilterMode] = useState<SpotFilterMode>('all');

  // Active photo session state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [meta, setMeta] = useState<SessionMetadata | null>(null);
  const [urls, setUrls] = useState<SessionUrls | null>(null);
  const [spots, setSpots] = useState<DetectedDustSpot[]>([]);
  const [selectedSpotId, setSelectedSpotId] = useState<string | null>(null);
  const [manualStrokes, setManualStrokes] = useState<ManualBrushStroke[]>([]);
  const [inpaintResult, setInpaintResult] = useState<InpaintResult | null>(null);
  const [undoStack, setUndoStack] = useState<HistorySnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<HistorySnapshot[]>([]);

  // Continuous Multi-Frame Sequence state
  const [sequenceItems, setSequenceItems] = useState<MultiFrameItem[]>([]);
  const [activeSequenceIndex, setActiveSequenceIndex] = useState<number>(0);
  const [multiReport, setMultiReport] = useState<MultiFrameReport | null>(null);

  // Detection & Inpainting parameters
  const [params, setParams] = useState<DetectionParams>({
    method: 'dual',
    sensitivity: 68,
    cloudProtection: 75,
    minRadius: 2,
    maxRadius: 40,
    minCircularity: 0.6,
    inpaintRadius: 6,
    preserveGrain: true,
  });

  // Canvas & Tool UI state
  const [showDustOverlay, setShowDustOverlay] = useState<boolean>(true);
  const [overlayMode, setOverlayMode] = useState<OverlayMode>('red-circle');
  const [interactionTool, setInteractionTool] = useState<InteractionTool>('inspect');
  const [brushRadius, setBrushRadius] = useState<number>(28);
  const [comparisonMode, setComparisonMode] = useState<ViewComparisonMode>('working');

  // Desktop Inspector & Export Menu state
  const [isRightDockOpen, setIsRightDockOpen] = useState<boolean>(true);
  const [openAccordions, setOpenAccordions] = useState<{
    detect: boolean;
    heal: boolean;
    colorSpace: boolean;
    spots: boolean;
  }>({
    detect: true,
    heal: true,
    colorSpace: true,
    spots: true,
  });
  const [selectedColorSpace, setSelectedColorSpace] = useState<ColorSpaceId>('auto');
  const [isExportMenuOpen, setIsExportMenuOpen] = useState<boolean>(false);

  // Mobile Drawer state
  const [mobileTab, setMobileTab] = useState<MobileDrawerTab>(null);

  // Processing state
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [processingLabel, setProcessingLabel] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [exportingFormat, setExportingFormat] = useState<string | null>(null);

  const topFileInputRef = useRef<HTMLInputElement>(null);
  const multiFileInputRef = useRef<HTMLInputElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  const captureCurrentSnapshot = (): HistorySnapshot => ({
    spots: spots.map((s) => ({ ...s })),
    manualStrokes: manualStrokes.map((st) => ({
      ...st,
      points: st.points.map((pt) => ({ ...pt })),
    })),
    inpaintResult: inpaintResult ? { ...inpaintResult } : null,
    previewInpainted: urls?.previewInpainted,
    maskFinal: urls?.maskFinal,
    comparisonMode,
    showDustOverlay,
  });

  const pushHistorySnapshot = () => {
    const snap = captureCurrentSnapshot();
    setUndoStack((prev) => [...prev.slice(-39), snap]);
    setRedoStack([]);
  };

  const applySnapshot = (snap: HistorySnapshot) => {
    setSpots(snap.spots);
    setManualStrokes(snap.manualStrokes);
    setInpaintResult(snap.inpaintResult);
    setUrls((prev) =>
      prev
        ? {
            ...prev,
            previewInpainted: snap.previewInpainted,
            maskFinal: snap.maskFinal,
          }
        : null
    );
    setComparisonMode(snap.comparisonMode);
    setShowDustOverlay(snap.showDustOverlay);
    if (studioMode === 'sequence') {
      setSequenceItems((prev) =>
        prev.map((item, idx) =>
          idx === activeSequenceIndex
            ? {
                ...item,
                spots: snap.spots,
                manualStrokes: snap.manualStrokes,
                inpaintResult: snap.inpaintResult,
                urls: {
                  ...item.urls,
                  previewInpainted: snap.previewInpainted,
                  maskFinal: snap.maskFinal,
                },
              }
            : item
        )
      );
    }
  };

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const prevSnap = undoStack[undoStack.length - 1];
    const currentSnap = captureCurrentSnapshot();
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev, currentSnap]);
    applySnapshot(prevSnap);
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const nextSnap = redoStack[redoStack.length - 1];
    const currentSnap = captureCurrentSnapshot();
    setRedoStack((prev) => prev.slice(0, -1));
    setUndoStack((prev) => [...prev, currentSnap]);
    applySnapshot(nextSnap);
  };

  const handleRevertInpainting = () => {
    if (!inpaintResult && !urls?.previewInpainted) return;
    pushHistorySnapshot();
    setInpaintResult(null);
    setUrls((prev) =>
      prev
        ? {
            ...prev,
            previewInpainted: undefined,
            maskFinal: undefined,
          }
        : null
    );
    setShowDustOverlay(true);
    setComparisonMode('working');
    if (studioMode === 'sequence') {
      setSequenceItems((prev) =>
        prev.map((item, idx) =>
          idx === activeSequenceIndex
            ? {
                ...item,
                inpaintResult: null,
                urls: {
                  ...item.urls,
                  previewInpainted: undefined,
                  maskFinal: undefined,
                },
              }
            : item
        )
      );
    }
  };

  // Close desktop export dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setIsExportMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleUploadFile = async (file: File) => {
    setErrorMessage(null);
    setIsProcessing(true);
    setProcessingLabel(`${file.name} 로컬 현상 및 먼지 분석 중...`);

    try {
      const data = await localSensorEngine.uploadAndDetect(file, params);

      setSessionId(data.sessionId);
      setMeta(data.meta);
      setUrls(data.urls);
      setSpots(data.detection.spots || []);
      setSelectedSpotId(null);
      setManualStrokes([]);
      setInpaintResult(null);
      setUndoStack([]);
      setRedoStack([]);
      setShowDustOverlay(true);
      setComparisonMode('working');
      setStudioMode('single');
    } catch (err: any) {
      setErrorMessage(err.message || '파일 처리 중 오류가 발생했습니다.');
    } finally {
      setIsProcessing(false);
      setProcessingLabel('');
    }
  };

  const handleRedetect = async (overrideParams?: Partial<DetectionParams>) => {
    if (!sessionId) return;
    pushHistorySnapshot();
    const nextParams = { ...params, ...overrideParams };
    setParams(nextParams);
    setErrorMessage(null);
    setIsProcessing(true);
    setProcessingLabel('먼지 재탐지 중...');

    try {
      if (studioMode === 'sequence' && sequenceItems.length > 0) {
        const data = await localSensorEngine.multiDetect(
          sequenceItems.map((item) => item.sessionId),
          nextParams,
          14.0,
          2
        );

        const updatedItems = sequenceItems.map((item) => {
          const pf = data.perFrame?.find((f: any) => f.sessionId === item.sessionId);
          if (pf && pf.spots) {
            return {
              ...item,
              spots: pf.spots,
              detection: {
                ...item.detection,
                spots: pf.spots,
                totalDetected: pf.totalDetected,
              },
            };
          }
          return item;
        });
        setSequenceItems(updatedItems);
        setMultiReport({
          totalFrames: data.totalFrames,
          totalClusters: data.totalClusters,
          multiConfirmedClusters: data.multiConfirmedClusters,
          clusters: data.clusters || [],
        });
        const curItem = updatedItems[activeSequenceIndex];
        if (curItem) setSpots(curItem.spots);
      } else {
        const data = await localSensorEngine.detect(sessionId, nextParams);

        setSpots(data.detection.spots || []);
        setUrls((prev) =>
          prev
            ? {
                ...prev,
                vizBwEdge: data.urls.vizBwEdge,
                maskAuto: data.urls.maskAuto,
              }
            : null
        );
      }
      setSelectedSpotId(null);
      setShowDustOverlay(true);
    } catch (err: any) {
      setErrorMessage(err.message || '탐지 중 오류 발생');
    } finally {
      setIsProcessing(false);
      setProcessingLabel('');
    }
  };

  const handleBatchDeselectSpots = (spotIdsToDeselect: string[]) => {
    if (spotIdsToDeselect.length === 0) return;
    const idSet = new Set(spotIdsToDeselect);
    setSpots((prev) =>
      prev.map((s) => (idSet.has(s.id) ? { ...s, enabled: false } : s))
    );
    if (studioMode === 'sequence') {
      setSequenceItems((prev) =>
        prev.map((item, idx) =>
          idx === activeSequenceIndex
            ? {
                ...item,
                spots: item.spots.map((s) =>
                  idSet.has(s.id) ? { ...s, enabled: false } : s
                ),
              }
            : item
        )
      );
    }
  };

  const handleMultiUploadFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).slice(0, 10);
    if (files.length === 0) return;
    setErrorMessage(null);
    setIsProcessing(true);
    setProcessingLabel(`연속 사진 ${files.length}장 로컬 분석 중...`);

    try {
      const data = await localSensorEngine.multiUpload(files, params);

      const items: MultiFrameItem[] = (data.sessions || []).map((s: any) => ({
        sessionId: s.sessionId,
        meta: s.meta,
        detection: s.detection,
        urls: s.urls,
        spots: s.detection?.spots || [],
        manualStrokes: [],
        inpaintResult: null,
      }));

      setSequenceItems(items);
      setMultiReport(data.multiReport || null);
      setActiveSequenceIndex(0);

      if (items.length > 0) {
        const first = items[0];
        setSessionId(first.sessionId);
        setMeta(first.meta);
        setUrls(first.urls);
        setSpots(first.spots);
        setSelectedSpotId(null);
        setManualStrokes([]);
        setInpaintResult(null);
        setUndoStack([]);
        setRedoStack([]);
        setShowDustOverlay(true);
        setComparisonMode('working');
      }
      setStudioMode('sequence');
    } catch (err: any) {
      setErrorMessage(err.message || '다중 사진 처리 오류');
    } finally {
      setIsProcessing(false);
      setProcessingLabel('');
    }
  };

  const handleSelectSequenceItem = (targetIdx: number) => {
    if (targetIdx < 0 || targetIdx >= sequenceItems.length) return;
    setSequenceItems((prev) =>
      prev.map((item, idx) =>
        idx === activeSequenceIndex
          ? { ...item, spots, manualStrokes, inpaintResult }
          : item
      )
    );
    setActiveSequenceIndex(targetIdx);
    const target = sequenceItems[targetIdx];
    setSessionId(target.sessionId);
    setMeta(target.meta);
    setUrls(target.urls);
    setSpots(target.spots);
    setSelectedSpotId(null);
    setManualStrokes(target.manualStrokes || []);
    setInpaintResult(target.inpaintResult);
    setUndoStack([]);
    setRedoStack([]);
    setShowDustOverlay(true);
    setComparisonMode(target.inpaintResult ? 'healed-only' : 'working');
  };

  const handleApplyBatchInpainting = async () => {
    if (sequenceItems.length === 0) return;
    setErrorMessage(null);
    setIsProcessing(true);
    setProcessingLabel(`연속 사진 ${sequenceItems.length}장 일괄 복원 중...`);

    try {
      const currentItems = sequenceItems.map((item, idx) =>
        idx === activeSequenceIndex
          ? { ...item, spots, manualStrokes }
          : item
      );

      const updatedItems = [...currentItems];
      for (let i = 0; i < updatedItems.length; i++) {
        const it = updatedItems[i];
        const data = await localSensorEngine.inpaint(
          it.sessionId,
          it.spots,
          it.manualStrokes,
          params.inpaintRadius,
          params.preserveGrain
        );
        updatedItems[i] = {
          ...it,
          inpaintResult: data.inpaintResult,
          urls: {
            ...it.urls,
            previewInpainted: data.urls.previewInpainted,
            maskFinal: data.urls.maskFinal,
          },
        };
      }

      setSequenceItems(updatedItems);
      const cur = updatedItems[activeSequenceIndex];
      if (cur) {
        setInpaintResult(cur.inpaintResult);
        setUrls(cur.urls);
        setShowDustOverlay(false);
        setComparisonMode('healed-only');
      }
    } catch (err: any) {
      setErrorMessage(err.message || '일괄 복원 오류');
    } finally {
      setIsProcessing(false);
      setProcessingLabel('');
    }
  };

  const handleBatchExportZip = async (format: 'dng' | 'tiff16' | 'png' | 'jpg') => {
    if (sequenceItems.length === 0) return;
    setExportingFormat(`zip-${format}`);
    setIsExportMenuOpen(false);
    setMobileTab(null);
    setErrorMessage(null);
    setIsProcessing(true);
    setProcessingLabel(`ZIP 패키징 중 (${format.toUpperCase()})...`);

    try {
      const exportItems = sequenceItems.map((item, idx) => ({
        sessionId: item.sessionId,
        spots: idx === activeSequenceIndex ? spots : item.spots,
        manualStrokes: idx === activeSequenceIndex ? manualStrokes : item.manualStrokes,
        params,
      }));

      const { zipBlob, downloadName } = await localSensorEngine.multiExportZip(
        exportItems,
        format,
        selectedColorSpace
      );
      localSensorEngine.triggerBrowserDownload(zipBlob, downloadName);
    } catch (err: any) {
      setErrorMessage(err.message || 'ZIP 내보내기 실패');
    } finally {
      setIsProcessing(false);
      setProcessingLabel('');
      setTimeout(() => setExportingFormat(null), 400);
    }
  };

  const handleToggleSpot = (spotId: string) => {
    pushHistorySnapshot();
    setSpots((prev) =>
      prev.map((s) => (s.id === spotId ? { ...s, enabled: !s.enabled } : s))
    );
    if (studioMode === 'sequence') {
      setSequenceItems((prev) =>
        prev.map((item, idx) =>
          idx === activeSequenceIndex
            ? {
                ...item,
                spots: item.spots.map((s) =>
                  s.id === spotId ? { ...s, enabled: !s.enabled } : s
                ),
              }
            : item
        )
      );
    }
  };

  const handleToggleAllSpots = (enableAll: boolean) => {
    pushHistorySnapshot();
    setSpots((prev) => prev.map((s) => ({ ...s, enabled: enableAll })));
    if (studioMode === 'sequence') {
      setSequenceItems((prev) =>
        prev.map((item, idx) =>
          idx === activeSequenceIndex
            ? {
                ...item,
                spots: item.spots.map((s) => ({ ...s, enabled: enableAll })),
              }
            : item
        )
      );
    }
  };

  const handleApplyInpainting = async () => {
    if (!sessionId) return;
    pushHistorySnapshot();
    setErrorMessage(null);
    setIsProcessing(true);
    setProcessingLabel('먼지 복원 적용 중...');

    try {
      const data = await localSensorEngine.inpaint(
        sessionId,
        spots,
        manualStrokes,
        params.inpaintRadius,
        params.preserveGrain
      );

      setInpaintResult(data.inpaintResult);
      setUrls((prev) =>
        prev
          ? {
              ...prev,
              previewInpainted: data.urls.previewInpainted,
              maskFinal: data.urls.maskFinal,
            }
          : null
      );
      setShowDustOverlay(false);
      setComparisonMode('healed-only');
    } catch (err: any) {
      setErrorMessage(err.message || '복원 중 오류 발생');
    } finally {
      setIsProcessing(false);
      setProcessingLabel('');
    }
  };

  const handleExportFormat = async (format: 'dng' | 'tiff16' | 'png' | 'jpg') => {
    if (!sessionId) return;
    setExportingFormat(format);
    setIsExportMenuOpen(false);
    setMobileTab(null);
    setErrorMessage(null);
    setIsProcessing(true);

    const formatNames: Record<string, string> = {
      dng: 'DNG (16-bit)',
      tiff16: 'TIFF (16-bit)',
      png: 'PNG',
      jpg: 'JPG',
    };
    const labelPrefix = formatNames[format] || format.toUpperCase();

    try {
      setProcessingLabel(`${labelPrefix} 렌더링 중...`);
      const res = await localSensorEngine.exportSingle(
        sessionId,
        format,
        spots,
        manualStrokes,
        params.inpaintRadius,
        params.preserveGrain,
        selectedColorSpace
      );

      if (res.inpaintResult) {
        setInpaintResult(res.inpaintResult);
      }
      if (res.urls?.previewInpainted) {
        setUrls((prev) =>
          prev
            ? {
                ...prev,
                previewInpainted: res.urls.previewInpainted,
                maskFinal: res.urls.maskFinal,
              }
            : null
        );
      }
      setShowDustOverlay(false);
      setComparisonMode('healed-only');

      localSensorEngine.triggerBrowserDownload(res.fileBlob, res.downloadName);
    } catch (err: any) {
      setErrorMessage(err.message || '내보내기 실패');
    } finally {
      setIsProcessing(false);
      setProcessingLabel('');
      setTimeout(() => setExportingFormat(null), 400);
    }
  };

  const enabledSpotsCount = spots.filter((s) => s.enabled).length;

  return (
    <div className="h-[100dvh] w-screen flex flex-col bg-[#121212] text-[#E5E5E5] overflow-hidden select-none">
      {/* Hidden File Inputs */}
      <input
        ref={topFileInputRef}
        type="file"
        accept=".rw2,.dng,.cr2,.cr3,.nef,.arw,.orf,.pef,.raf,.tif,.tiff,.png,.jpg,.jpeg"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleUploadFile(f);
          e.target.value = '';
        }}
        className="hidden"
      />
      <input
        ref={multiFileInputRef}
        type="file"
        multiple
        accept=".rw2,.dng,.cr2,.cr3,.nef,.arw,.orf,.pef,.raf,.tif,.tiff,.png,.jpg,.jpeg"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            handleMultiUploadFiles(e.target.files);
          }
          e.target.value = '';
        }}
        className="hidden"
      />

      {/* Top Header Bar — Lightroom CC Slim Header */}
      <header className="h-11 px-3 bg-[#1E1E1E] border-b border-[#323232] flex items-center justify-between gap-4 shrink-0 z-30">
        {/* Left: Brand + Mode Switch + Import */}
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="flex items-center gap-1.5">
            <img src="/favicon.svg" alt="SensorClean" className="w-4 h-4 rounded-xs" />
            <span className="text-xs font-semibold tracking-tight text-white whitespace-nowrap">
              SensorClean
            </span>
          </div>

          <div className="flex items-center p-0.5 bg-[#141414] border border-[#323232] rounded">
            <button
              type="button"
              onClick={() => setStudioMode('single')}
              className={`px-2 py-0.5 rounded-xs text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                studioMode === 'single'
                  ? 'bg-[#2E2E2E] text-white'
                  : 'text-[#8E8E8E] hover:text-[#D4D4D4]'
              }`}
            >
              단일
            </button>
            <button
              type="button"
              onClick={() => {
                setStudioMode('sequence');
                if (sequenceItems.length === 0) {
                  multiFileInputRef.current?.click();
                }
              }}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-xs text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                studioMode === 'sequence'
                  ? 'bg-[#0A84FF] text-white'
                  : 'text-[#8E8E8E] hover:text-[#D4D4D4]'
              }`}
            >
              <span>연속</span>
              {sequenceItems.length > 0 && (
                <span className="font-mono text-[10px] opacity-90">
                  {sequenceItems.length}
                </span>
              )}
            </button>
          </div>

          <button
            type="button"
            onClick={() =>
              studioMode === 'sequence'
                ? multiFileInputRef.current?.click()
                : topFileInputRef.current?.click()
            }
            disabled={isProcessing}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#282828] hover:bg-[#333333] text-[#E5E5E5] text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap"
          >
            <Upload className="w-3 h-3" />
            <span className="hidden sm:inline">불러오기</span>
          </button>

          {sessionId && (
            <div className="flex items-center gap-0.5 ml-0.5">
              <button
                type="button"
                onClick={handleUndo}
                disabled={undoStack.length === 0 || isProcessing}
                title="되돌리기 (Ctrl+Z)"
                className="p-1.5 rounded text-[#B8B8B8] hover:text-white hover:bg-[#282828] disabled:opacity-30 transition-colors cursor-pointer"
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={handleRedo}
                disabled={redoStack.length === 0 || isProcessing}
                title="다시 실행 (Ctrl+Shift+Z)"
                className="p-1.5 rounded text-[#B8B8B8] hover:text-white hover:bg-[#282828] disabled:opacity-30 transition-colors cursor-pointer"
              >
                <Redo2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* Center: Unboxed Metadata Readout */}
        {meta && (
          <div className="hidden lg:flex items-center gap-2 text-[11px] text-[#9E9E9E] font-mono truncate">
            <span className="text-[#E5E5E5] font-medium truncate max-w-[180px]">
              {meta.originalFileName}
            </span>
            <span>·</span>
            <span>
              {meta.fullWidth}×{meta.fullHeight}
            </span>
            {meta.exif.fNumber && (
              <>
                <span>·</span>
                <span>f/{meta.exif.fNumber}</span>
              </>
            )}
            {meta.exif.focalLength && (
              <>
                <span>·</span>
                <span>{meta.exif.focalLength}</span>
              </>
            )}
            <span>·</span>
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-[#242424] text-[#5AC8FA] border border-[#383838]"
              title={`원본 감지 색공간: ${meta.detectedColorSpace || 'sRGB'} ${meta.hasEmbeddedIcc ? '(ICC 프로파일 내장)' : ''}`}
            >
              <Palette className="w-2.5 h-2.5" />
              <span>
                {meta.detectedColorSpace === 'adobe-rgb'
                  ? 'Adobe RGB'
                  : meta.detectedColorSpace === 'display-p3'
                  ? 'Display P3'
                  : meta.detectedColorSpace === 'bt2020'
                  ? 'BT.2020'
                  : meta.detectedColorSpace === 'prophoto-rgb'
                  ? 'ProPhoto RGB'
                  : meta.detectedColorSpace === 'srgb'
                  ? 'sRGB'
                  : '광색역 감지'}
              </span>
              {meta.hasEmbeddedIcc && (
                <span className="text-[9px] text-[#A1A1AA] uppercase">ICC</span>
              )}
            </span>
            <span>·</span>
            <span className="text-[#D4D4D4]">
              스팟 {enabledSpotsCount}/{spots.length}
            </span>
          </div>
        )}

        {/* Mobile Center Filename */}
        {meta && (
          <div className="flex lg:hidden items-center gap-1.5 text-[11px] font-mono text-[#B8B8B8] truncate">
            <span className="truncate max-w-[110px] text-[#E5E5E5]">
              {meta.originalFileName}
            </span>
            {meta.detectedColorSpace && meta.detectedColorSpace !== 'srgb' && (
              <>
                <span>·</span>
                <span className="text-[10px] text-[#5AC8FA]">
                  {meta.detectedColorSpace === 'adobe-rgb' ? 'AdobeRGB' : 'P3'}
                </span>
              </>
            )}
            <span>·</span>
            <span>{enabledSpotsCount}</span>
          </div>
        )}

        {/* Right: Heal & Export Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          {studioMode === 'sequence' && sequenceItems.length > 1 && (
            <button
              type="button"
              onClick={handleApplyBatchInpainting}
              disabled={!sessionId || isProcessing}
              className="hidden sm:flex items-center gap-1 px-2.5 py-1 rounded bg-[#282828] hover:bg-[#333333] text-[#E5E5E5] text-[11px] font-medium cursor-pointer whitespace-nowrap disabled:opacity-40"
            >
              <Check className="w-3 h-3 text-[#0A84FF]" />
              <span>전체 적용</span>
            </button>
          )}

          {(inpaintResult || urls?.previewInpainted) && (
            <button
              type="button"
              onClick={handleRevertInpainting}
              disabled={isProcessing}
              title="적용된 먼지 복원을 취소하고 작업 화면으로 되돌리기"
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#282828] hover:bg-[#333333] border border-[#383838] text-[#D4D4D4] text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-40"
            >
              <RotateCcw className="w-3 h-3 text-[#F59E0B]" />
              <span className="hidden sm:inline">복원 되돌리기</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleApplyInpainting}
            disabled={!sessionId || isProcessing}
            className="flex items-center gap-1 px-3 py-1 rounded bg-[#0A84FF] hover:bg-[#0070E0] text-white text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-40"
          >
            <Check className="w-3 h-3" />
            <span>적용</span>
          </button>

          {/* Desktop Export Dropdown */}
          <div ref={exportMenuRef} className="relative hidden md:block">
            <button
              type="button"
              onClick={() => setIsExportMenuOpen((v) => !v)}
              disabled={!sessionId || isProcessing}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#282828] hover:bg-[#333333] border border-[#383838] text-[#E5E5E5] text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-40"
            >
              <Download className="w-3 h-3" />
              <span>내보내기</span>
              <ChevronDown className="w-3 h-3 text-[#8E8E8E]" />
            </button>

            {isExportMenuOpen && (
              <div className="absolute right-0 mt-1.5 w-48 rounded-md bg-[#222222] border border-[#383838] shadow-2xl py-1 z-50 text-xs">
                <div className="px-3 py-1.5 border-b border-[#333333] flex items-center justify-between text-[11px] text-[#A0A0A0]">
                  <span className="flex items-center gap-1">
                    <Palette className="w-3 h-3 text-[#5AC8FA]" />
                    <span>색공간</span>
                  </span>
                  <span className="font-mono text-[10px] text-[#5AC8FA] font-medium">
                    {COLOR_SPACE_OPTIONS.find((c) => c.id === selectedColorSpace)?.shortLabel || '원본'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleExportFormat('dng')}
                  className="w-full px-3 py-1.5 text-left hover:bg-[#0A84FF] hover:text-white flex items-center justify-between cursor-pointer"
                >
                  <span>DNG</span>
                  <span className="font-mono text-[10px] opacity-75">16-bit</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleExportFormat('tiff16')}
                  className="w-full px-3 py-1.5 text-left hover:bg-[#0A84FF] hover:text-white flex items-center justify-between cursor-pointer"
                >
                  <span>TIFF</span>
                  <span className="font-mono text-[10px] opacity-75">16-bit</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleExportFormat('png')}
                  className="w-full px-3 py-1.5 text-left hover:bg-[#0A84FF] hover:text-white flex items-center justify-between cursor-pointer"
                >
                  <span>PNG</span>
                  <span className="font-mono text-[10px] opacity-75">Lossless</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleExportFormat('jpg')}
                  className="w-full px-3 py-1.5 text-left hover:bg-[#0A84FF] hover:text-white flex items-center justify-between cursor-pointer"
                >
                  <span>JPG</span>
                  <span className="font-mono text-[10px] opacity-75">98%</span>
                </button>

                {studioMode === 'sequence' && sequenceItems.length > 0 && (
                  <>
                    <div className="my-1 border-t border-[#333333]" />
                    <div className="px-3 py-1 text-[10px] text-[#8E8E8E]">
                      연속 {sequenceItems.length}장 ZIP
                    </div>
                    <div className="grid grid-cols-2 gap-1 px-2 pb-1">
                      {(['dng', 'tiff16', 'png', 'jpg'] as const).map((fmt) => (
                        <button
                          key={fmt}
                          type="button"
                          onClick={() => handleBatchExportZip(fmt)}
                          className="px-2 py-1 rounded bg-[#2C2C2C] hover:bg-[#0A84FF] hover:text-white text-[10px] font-mono uppercase text-center cursor-pointer"
                        >
                          {fmt === 'tiff16' ? 'TIFF' : fmt}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Compact Error Banner */}
      {errorMessage && (
        <div className="px-3 py-1.5 bg-[#3A1818] border-b border-[#6E2626] text-[#FCA5A5] text-xs flex items-center justify-between shrink-0 z-30">
          <div className="flex items-center gap-2 truncate">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{errorMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="p-0.5 text-[#FCA5A5] hover:text-white cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Workspace Container */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Center Column: Canvas + Optional Filmstrip */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <DarkroomCanvas
            meta={meta}
            urls={urls}
            spots={spots}
            selectedSpotId={selectedSpotId}
            onSelectSpot={setSelectedSpotId}
            onToggleSpot={handleToggleSpot}
            manualStrokes={manualStrokes}
            onAddManualStroke={(st) => {
              pushHistorySnapshot();
              setManualStrokes((prev) => [...prev, st]);
            }}
            onClearManualStrokes={() => {
              if (manualStrokes.length > 0) {
                pushHistorySnapshot();
                setManualStrokes([]);
              }
            }}
            showDustOverlay={showDustOverlay}
            onToggleDustOverlay={setShowDustOverlay}
            overlayMode={overlayMode}
            onChangeOverlayMode={setOverlayMode}
            interactionTool={interactionTool}
            onChangeInteractionTool={setInteractionTool}
            brushRadius={brushRadius}
            onChangeBrushRadius={setBrushRadius}
            comparisonMode={comparisonMode}
            onChangeComparisonMode={setComparisonMode}
            hasInpaintedResult={Boolean(inpaintResult && urls?.previewInpainted)}
            isProcessing={isProcessing}
            processingLabel={processingLabel}
            onUploadFile={handleUploadFile}
            onBeginHistoryBatch={pushHistorySnapshot}
            onBatchDeselectSpots={handleBatchDeselectSpots}
            onUndo={handleUndo}
            onRedo={handleRedo}
            filterMode={studioMode === 'sequence' ? filterMode : undefined}
            onChangeFilterMode={studioMode === 'sequence' ? setFilterMode : undefined}
            isSequenceMode={studioMode === 'sequence'}
          />

          {/* Lightroom Bottom Filmstrip (Sequence Mode) */}
          {studioMode === 'sequence' && (
            <div className="h-16 md:h-20 bg-[#181818] border-t border-[#323232] px-3 flex items-center gap-2 overflow-x-auto shrink-0">
              <button
                type="button"
                onClick={() => multiFileInputRef.current?.click()}
                className="h-12 md:h-14 px-3 rounded border border-dashed border-[#3A3A3A] hover:border-[#0A84FF] text-[#9E9E9E] hover:text-white flex flex-col items-center justify-center gap-0.5 text-[10px] shrink-0 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>추가</span>
              </button>

              {sequenceItems.map((item, idx) => {
                const isActive = idx === activeSequenceIndex;
                const activeCount = item.spots.filter((s) => s.enabled).length;
                return (
                  <button
                    key={item.sessionId}
                    type="button"
                    onClick={() => handleSelectSequenceItem(idx)}
                    className={`relative h-12 md:h-14 w-20 md:w-24 rounded overflow-hidden border transition-all shrink-0 cursor-pointer ${
                      isActive
                        ? 'border-[#0A84FF] ring-1 ring-[#0A84FF]'
                        : 'border-[#2E2E2E] opacity-70 hover:opacity-100'
                    }`}
                  >
                    <img
                      src={item.urls.previewInpainted || item.urls.previewOriginal}
                      alt={item.meta.originalFileName}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-x-0 bottom-0 bg-black/75 px-1 py-0.5 flex items-center justify-between text-[9px] font-mono">
                      <span className="text-[#D4D4D4]">#{idx + 1}</span>
                      <span className="text-[#5AC8FA]">{activeCount}</span>
                    </div>
                  </button>
                );
              })}

              {multiReport && (
                <div className="ml-auto pl-2 text-[11px] font-mono text-[#8E8E8E] whitespace-nowrap hidden sm:block">
                  공통 먼지 {multiReport.multiConfirmedClusters}개
                </div>
              )}
            </div>
          )}
        </div>

        {/* Desktop Right Collapsible Inspector Panel (Lightroom CC Develop Panel) */}
        {isRightDockOpen && (
          <aside className="hidden md:flex w-[272px] bg-[#1E1E1E] border-l border-[#323232] flex-col overflow-y-auto shrink-0">
            {/* Contextual Brush Bar */}
            {(interactionTool === 'deselect-brush' ||
              interactionTool === 'brush-add' ||
              interactionTool === 'brush-erase') && (
              <div className="px-3.5 py-2.5 bg-[#252525] border-b border-[#323232]">
                <div className="flex items-center justify-between text-[11px] mb-1">
                  <span className="font-medium text-white">
                    {interactionTool === 'deselect-brush'
                      ? '지우개 브러시 반경'
                      : interactionTool === 'brush-add'
                      ? '복원 브러시 반경'
                      : '마스크 지우개 반경'}
                  </span>
                  <span className="font-mono text-[#0A84FF]">{brushRadius}px</span>
                </div>
                <input
                  type="range"
                  min={4}
                  max={120}
                  value={brushRadius}
                  onChange={(e) => setBrushRadius(Number(e.target.value))}
                  className="lr-slider"
                />
                <div className="mt-2 flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleUndo}
                    disabled={undoStack.length === 0 || isProcessing}
                    className="flex-1 py-1 rounded bg-[#303030] hover:bg-[#3A3A3A] disabled:opacity-35 text-[11px] text-[#E5E5E5] flex items-center justify-center gap-1 cursor-pointer"
                  >
                    <Undo2 className="w-3 h-3" />
                    <span>되돌리기</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleRedo}
                    disabled={redoStack.length === 0 || isProcessing}
                    className="flex-1 py-1 rounded bg-[#303030] hover:bg-[#3A3A3A] disabled:opacity-35 text-[11px] text-[#E5E5E5] flex items-center justify-center gap-1 cursor-pointer"
                  >
                    <Redo2 className="w-3 h-3" />
                    <span>다시 실행</span>
                  </button>
                </div>
                {manualStrokes.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      pushHistorySnapshot();
                      setManualStrokes([]);
                    }}
                    className="mt-1.5 w-full py-1 rounded bg-[#303030] hover:bg-[#3A3A3A] text-[11px] text-[#D4D4D4] cursor-pointer"
                  >
                    수동 브러시 초기화 ({manualStrokes.length})
                  </button>
                )}
              </div>
            )}

            {/* Accordion 1: 먼지 탐지 (Detection) */}
            <div className="border-b border-[#323232]">
              <div className="flex items-center justify-between px-3.5 py-2.5 hover:bg-[#252525]">
                <button
                  type="button"
                  onClick={() =>
                    setOpenAccordions((p) => ({ ...p, detect: !p.detect }))
                  }
                  className="flex items-center gap-1.5 text-xs font-semibold text-[#E5E5E5] cursor-pointer flex-1 text-left"
                >
                  {openAccordions.detect ? (
                    <ChevronDown className="w-3.5 h-3.5 text-[#8E8E8E]" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-[#8E8E8E]" />
                  )}
                  <span>먼지 탐지</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleRedetect()}
                  disabled={!sessionId || isProcessing}
                  title="재탐지"
                  className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#2A2A2A] hover:bg-[#363636] text-[11px] text-[#D4D4D4] cursor-pointer disabled:opacity-40"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>재탐지</span>
                </button>
              </div>

              {openAccordions.detect && (
                <div className="px-3.5 pb-3 space-y-1">
                  {/* Method Segment */}
                  <div className="grid grid-cols-3 gap-1 p-0.5 bg-[#141414] border border-[#2E2E2E] rounded mb-2">
                    {(
                      [
                        { id: 'dual', label: '듀얼' },
                        { id: 'sharp', label: '미세' },
                        { id: 'bokeh', label: '보케' },
                      ] as { id: DetectionMethod; label: string }[]
                    ).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => handleRedetect({ method: m.id })}
                        className={`py-1 rounded-xs text-[11px] font-medium transition-colors cursor-pointer ${
                          params.method === m.id
                            ? 'bg-[#2E2E2E] text-white'
                            : 'text-[#8E8E8E] hover:text-[#D4D4D4]'
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>

                  <LrSlider
                    label="감도"
                    value={params.sensitivity}
                    min={1}
                    max={100}
                    onChange={(v) => setParams((p) => ({ ...p, sensitivity: v }))}
                  />
                  <LrSlider
                    label="구름 보호"
                    value={params.cloudProtection}
                    min={0}
                    max={100}
                    onChange={(v) => setParams((p) => ({ ...p, cloudProtection: v }))}
                  />
                  <LrSlider
                    label="최소 반경"
                    value={params.minRadius}
                    displayValue={`${params.minRadius}px`}
                    min={1}
                    max={15}
                    onChange={(v) => setParams((p) => ({ ...p, minRadius: v }))}
                  />
                  <LrSlider
                    label="최대 반경"
                    value={params.maxRadius}
                    displayValue={`${params.maxRadius}px`}
                    min={15}
                    max={80}
                    onChange={(v) => setParams((p) => ({ ...p, maxRadius: v }))}
                  />
                  <LrSlider
                    label="원형도"
                    value={params.minCircularity}
                    displayValue={params.minCircularity.toFixed(2)}
                    min={0.3}
                    max={0.92}
                    step={0.02}
                    onChange={(v) => setParams((p) => ({ ...p, minCircularity: v }))}
                  />
                </div>
              )}
            </div>

            {/* Accordion 2: 복원 (Heal) */}
            <div className="border-b border-[#323232]">
              <button
                type="button"
                onClick={() => setOpenAccordions((p) => ({ ...p, heal: !p.heal }))}
                className="w-full flex items-center gap-1.5 px-3.5 py-2.5 hover:bg-[#252525] text-xs font-semibold text-[#E5E5E5] cursor-pointer text-left"
              >
                {openAccordions.heal ? (
                  <ChevronDown className="w-3.5 h-3.5 text-[#8E8E8E]" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-[#8E8E8E]" />
                )}
                <span>복원 설정</span>
              </button>

              {openAccordions.heal && (
                <div className="px-3.5 pb-3 space-y-2">
                  <LrSlider
                    label="복원 반경"
                    value={params.inpaintRadius}
                    displayValue={`${params.inpaintRadius}px`}
                    min={2}
                    max={20}
                    onChange={(v) => setParams((p) => ({ ...p, inpaintRadius: v }))}
                  />

                  <div className="flex items-center justify-between py-1">
                    <span className="text-[11px] text-[#B8B8B8] font-medium">
                      센서 입자 유지
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setParams((p) => ({ ...p, preserveGrain: !p.preserveGrain }))
                      }
                      className={`w-8 h-4 rounded-full transition-colors relative cursor-pointer ${
                        params.preserveGrain ? 'bg-[#0A84FF]' : 'bg-[#383838]'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                          params.preserveGrain ? 'left-4.5' : 'left-0.5'
                        }`}
                      />
                    </button>
                  </div>
                  {(inpaintResult || urls?.previewInpainted) && (
                    <button
                      type="button"
                      onClick={handleRevertInpainting}
                      disabled={isProcessing}
                      className="w-full mt-1 py-1.5 rounded bg-[#2C2C2C] hover:bg-[#383838] border border-[#3E3E3E] text-[11px] text-[#E5E5E5] flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3 text-[#F59E0B]" />
                      <span>복원 되돌리기 (원본 작업 상태로)</span>
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Accordion: 색공간 및 ICC 프로파일 (Color Space & Gamut) */}
            <div className="border-b border-[#323232]">
              <button
                type="button"
                onClick={() =>
                  setOpenAccordions((p) => ({ ...p, colorSpace: !p.colorSpace }))
                }
                className="w-full flex items-center justify-between px-3.5 py-2.5 hover:bg-[#252525] text-xs font-semibold text-[#E5E5E5] cursor-pointer text-left"
              >
                <div className="flex items-center gap-1.5">
                  {openAccordions.colorSpace ? (
                    <ChevronDown className="w-3.5 h-3.5 text-[#8E8E8E]" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-[#8E8E8E]" />
                  )}
                  <Palette className="w-3.5 h-3.5 text-[#5AC8FA]" />
                  <span>색공간 및 ICC 프로파일</span>
                </div>
                <span className="font-mono text-[10px] text-[#5AC8FA] bg-[#222222] px-1.5 py-0.5 rounded border border-[#333333]">
                  {COLOR_SPACE_OPTIONS.find((c) => c.id === selectedColorSpace)?.shortLabel || '원본'}
                </span>
              </button>

              {openAccordions.colorSpace && (
                <div className="px-3.5 pb-3 space-y-2.5">
                  {/* Detected color space readout */}
                  {meta && (
                    <div className="p-2 rounded bg-[#161616] border border-[#2B2B2B] text-[11px]">
                      <div className="flex items-center justify-between text-[#8E8E8E] mb-0.5">
                        <span>원본 감지 색역</span>
                        <span className="font-mono text-[#5AC8FA] font-medium">
                          {meta.detectedColorSpace === 'adobe-rgb'
                            ? 'Adobe RGB (1998)'
                            : meta.detectedColorSpace === 'display-p3'
                            ? 'Display P3'
                            : meta.detectedColorSpace === 'bt2020'
                            ? 'ITU-R BT.2020'
                            : meta.detectedColorSpace === 'prophoto-rgb'
                            ? 'ProPhoto RGB'
                            : meta.detectedColorSpace === 'srgb'
                            ? 'sRGB'
                            : '자동 감지'}
                        </span>
                      </div>
                      <div className="text-[10px] text-[#A0A0A0] flex items-center justify-between">
                        <span>프로파일 출처</span>
                        <span className="font-mono text-[#D4D4D4]">
                          {meta.hasEmbeddedIcc
                            ? '내장 ICC Profile (Tag 34675 / APP2)'
                            : 'EXIF ColorSpace 메타데이터'}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Target Color Space Selector */}
                  <div className="space-y-1.5">
                    <div className="text-[11px] text-[#B8B8B8] font-medium flex items-center justify-between">
                      <span>내보내기 대상 색공간</span>
                      <span className="text-[10px] text-[#8E8E8E]">16비트 리니어 매핑</span>
                    </div>

                    <div className="space-y-1">
                      {COLOR_SPACE_OPTIONS.map((opt) => {
                        const isSelected = selectedColorSpace === opt.id;
                        return (
                          <div
                            key={opt.id}
                            onClick={() => setSelectedColorSpace(opt.id)}
                            className={`p-2 rounded border cursor-pointer transition-colors ${
                              isSelected
                                ? 'bg-[#1C2638] border-[#0A84FF] text-white'
                                : 'bg-[#181818] border-[#2C2C2C] text-[#C4C4C4] hover:bg-[#202020] hover:border-[#383838]'
                            }`}
                          >
                            <div className="flex items-center justify-between mb-0.5">
                              <span className="text-[11px] font-semibold flex items-center gap-1.5">
                                <span
                                  className={`w-2 h-2 rounded-full ${
                                    isSelected ? 'bg-[#0A84FF]' : 'bg-[#404040]'
                                  }`}
                                />
                                {opt.label}
                              </span>
                              <span className="font-mono text-[9px] text-[#8E8E8E]">
                                {opt.gamutCoverage}
                              </span>
                            </div>
                            <p className="text-[10px] text-[#8E8E8E] leading-tight pl-3.5">
                              {opt.description}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <p className="text-[10px] text-[#737373] leading-relaxed bg-[#141414] p-2 rounded border border-[#262626]">
                    DNG, 16-bit TIFF, JPG 내보내기 시 위 규격의 공식 ICC v2.4 프로파일 및 DNG ColorMatrix 태그가 원본 파일에 함께 임베딩되어 모바일 갤러리 및 모니터에서 광색역을 왜곡 없이 정확하게 표시합니다.
                  </p>
                </div>
              )}
            </div>

            {/* Accordion 3: 스팟 목록 (Spots) */}
            <div className="flex-1 flex flex-col min-h-[180px]">
              <div className="flex items-center justify-between px-3.5 py-2.5 hover:bg-[#252525] border-b border-[#282828]">
                <button
                  type="button"
                  onClick={() =>
                    setOpenAccordions((p) => ({ ...p, spots: !p.spots }))
                  }
                  className="flex items-center gap-1.5 text-xs font-semibold text-[#E5E5E5] cursor-pointer text-left"
                >
                  {openAccordions.spots ? (
                    <ChevronDown className="w-3.5 h-3.5 text-[#8E8E8E]" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-[#8E8E8E]" />
                  )}
                  <span>스팟</span>
                  <span className="font-mono text-[11px] text-[#8E8E8E] font-normal ml-1">
                    {enabledSpotsCount}/{spots.length}
                  </span>
                </button>

                {spots.length > 0 && (
                  <div className="flex items-center gap-2 text-[11px] text-[#9E9E9E]">
                    <button
                      type="button"
                      onClick={() => handleToggleAllSpots(true)}
                      className="hover:text-white cursor-pointer"
                    >
                      전체선택
                    </button>
                    <span>·</span>
                    <button
                      type="button"
                      onClick={() => handleToggleAllSpots(false)}
                      className="hover:text-white cursor-pointer"
                    >
                      해제
                    </button>
                  </div>
                )}
              </div>

              {openAccordions.spots && (
                <div className="flex-1 overflow-y-auto divide-y divide-[#262626]">
                  {spots.length === 0 ? (
                    <div className="py-8 text-center text-[11px] text-[#737373]">
                      검출된 스팟 없음
                    </div>
                  ) : (
                    spots.map((spot) => {
                      const isSelected = spot.id === selectedSpotId;
                      return (
                        <div
                          key={spot.id}
                          onClick={() => setSelectedSpotId(spot.id)}
                          className={`flex items-center justify-between px-3.5 py-1.5 text-[11px] font-mono cursor-pointer transition-colors ${
                            isSelected ? 'bg-[#2C2C2C]' : 'hover:bg-[#242424]'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={spot.enabled}
                              onChange={(e) => {
                                e.stopPropagation();
                                handleToggleSpot(spot.id);
                              }}
                              className="accent-[#0A84FF] rounded-xs cursor-pointer"
                            />
                            <span
                              className={
                                spot.enabled
                                  ? 'text-[#E5E5E5]'
                                  : 'text-[#666666] line-through'
                              }
                            >
                              #{spot.index}
                            </span>
                            {spot.isMultiConfirmed && (
                              <span className="text-[10px] text-[#5AC8FA]">
                                {spot.matchCount}f
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2.5 text-[#8E8E8E]">
                            <span>{spot.radius}px</span>
                            <span className="w-11 text-right">
                              -{spot.contrastDropPct}%
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </aside>
        )}

        {/* Desktop Rightmost Tool Rail (Lightroom CC Vertical Icon Strip) */}
        <div className="hidden md:flex w-11 bg-[#181818] border-l border-[#323232] flex-col items-center py-2.5 gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setInteractionTool('inspect')}
            title="선택 및 개별 토글 (I)"
            className={`w-8 h-8 rounded flex items-center justify-center transition-colors cursor-pointer ${
              interactionTool === 'inspect'
                ? 'bg-[#0A84FF] text-white'
                : 'text-[#9E9E9E] hover:text-white hover:bg-[#262626]'
            }`}
          >
            <MousePointer className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => setInteractionTool('deselect-brush')}
            title="드래그 지우개 브러시 (D)"
            className={`w-8 h-8 rounded flex items-center justify-center transition-colors cursor-pointer ${
              interactionTool === 'deselect-brush'
                ? 'bg-[#0A84FF] text-white'
                : 'text-[#9E9E9E] hover:text-white hover:bg-[#262626]'
            }`}
          >
            <Eraser className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => setInteractionTool('brush-add')}
            title="수동 복원 브러시 (B)"
            className={`w-8 h-8 rounded flex items-center justify-center transition-colors cursor-pointer ${
              interactionTool === 'brush-add'
                ? 'bg-[#0A84FF] text-white'
                : 'text-[#9E9E9E] hover:text-white hover:bg-[#262626]'
            }`}
          >
            <Paintbrush className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => setInteractionTool('brush-erase')}
            title="수동 마스크 지우개 (E)"
            className={`w-8 h-8 rounded flex items-center justify-center transition-colors cursor-pointer ${
              interactionTool === 'brush-erase'
                ? 'bg-[#0A84FF] text-white'
                : 'text-[#9E9E9E] hover:text-white hover:bg-[#262626]'
            }`}
          >
            <RotateCcw className="w-4 h-4" />
          </button>

          <div className="w-5 h-[1px] bg-[#323232] my-1" />

          <button
            type="button"
            onClick={() => setIsRightDockOpen((v) => !v)}
            title="패널 접기/펴기"
            className="w-8 h-8 rounded flex items-center justify-center text-[#9E9E9E] hover:text-white hover:bg-[#262626] transition-colors cursor-pointer"
          >
            {isRightDockOpen ? (
              <PanelRightClose className="w-4 h-4" />
            ) : (
              <PanelRightOpen className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {/* Mobile Slide-Up Contextual Tray (Lightroom Mobile Style, < 768px) */}
      {mobileTab && (
        <div className="md:hidden bg-[#1E1E1E]/95 backdrop-blur-md border-t border-[#323232] px-4 pt-2.5 pb-3 z-30 shrink-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-[#E5E5E5]">
              {mobileTab === 'tools' && '브러시 및 선택 도구'}
              {mobileTab === 'detect' && '먼지 탐지 설정'}
              {mobileTab === 'heal' && '복원 설정'}
              {mobileTab === 'spots' && `스팟 목록 (${enabledSpotsCount}/${spots.length})`}
              {mobileTab === 'export' && '내보내기'}
            </span>
            <button
              type="button"
              onClick={() => setMobileTab(null)}
              className="p-1 text-[#8E8E8E] hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Mobile Tab 1: Tools */}
          {mobileTab === 'tools' && (
            <div className="space-y-2.5">
              <div className="grid grid-cols-4 gap-1.5">
                <button
                  type="button"
                  onClick={() => setInteractionTool('inspect')}
                  className={`min-h-[44px] rounded flex flex-col items-center justify-center gap-1 text-[11px] font-medium cursor-pointer ${
                    interactionTool === 'inspect'
                      ? 'bg-[#0A84FF] text-white'
                      : 'bg-[#282828] text-[#B8B8B8]'
                  }`}
                >
                  <MousePointer className="w-4 h-4" />
                  <span>선택</span>
                </button>
                <button
                  type="button"
                  onClick={() => setInteractionTool('deselect-brush')}
                  className={`min-h-[44px] rounded flex flex-col items-center justify-center gap-1 text-[11px] font-medium cursor-pointer ${
                    interactionTool === 'deselect-brush'
                      ? 'bg-[#0A84FF] text-white'
                      : 'bg-[#282828] text-[#B8B8B8]'
                  }`}
                >
                  <Eraser className="w-4 h-4" />
                  <span>지우개브러시</span>
                </button>
                <button
                  type="button"
                  onClick={() => setInteractionTool('brush-add')}
                  className={`min-h-[44px] rounded flex flex-col items-center justify-center gap-1 text-[11px] font-medium cursor-pointer ${
                    interactionTool === 'brush-add'
                      ? 'bg-[#0A84FF] text-white'
                      : 'bg-[#282828] text-[#B8B8B8]'
                  }`}
                >
                  <Paintbrush className="w-4 h-4" />
                  <span>복원브러시</span>
                </button>
                <button
                  type="button"
                  onClick={() => setInteractionTool('brush-erase')}
                  className={`min-h-[44px] rounded flex flex-col items-center justify-center gap-1 text-[11px] font-medium cursor-pointer ${
                    interactionTool === 'brush-erase'
                      ? 'bg-[#0A84FF] text-white'
                      : 'bg-[#282828] text-[#B8B8B8]'
                  }`}
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>마스크지우개</span>
                </button>
              </div>

              {interactionTool !== 'inspect' && (
                <LrSlider
                  label="브러시 반경"
                  value={brushRadius}
                  displayValue={`${brushRadius}px`}
                  min={4}
                  max={120}
                  onChange={setBrushRadius}
                />
              )}

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleUndo}
                  disabled={undoStack.length === 0 || isProcessing}
                  className="min-h-[38px] rounded bg-[#282828] active:bg-[#383838] disabled:opacity-35 text-xs text-[#E5E5E5] flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Undo2 className="w-3.5 h-3.5" />
                  <span>되돌리기</span>
                </button>
                <button
                  type="button"
                  onClick={handleRedo}
                  disabled={redoStack.length === 0 || isProcessing}
                  className="min-h-[38px] rounded bg-[#282828] active:bg-[#383838] disabled:opacity-35 text-xs text-[#E5E5E5] flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Redo2 className="w-3.5 h-3.5" />
                  <span>다시 실행</span>
                </button>
              </div>
            </div>
          )}

          {/* Mobile Tab 2: Detect */}
          {mobileTab === 'detect' && (
            <div className="space-y-2 max-h-[210px] overflow-y-auto pr-1">
              <div className="flex items-center gap-1.5">
                <div className="grid grid-cols-3 gap-1 p-0.5 bg-[#141414] border border-[#2E2E2E] rounded flex-1">
                  {(
                    [
                      { id: 'dual', label: '듀얼' },
                      { id: 'sharp', label: '미세' },
                      { id: 'bokeh', label: '보케' },
                    ] as { id: DetectionMethod; label: string }[]
                  ).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => handleRedetect({ method: m.id })}
                      className={`py-1 rounded-xs text-[11px] font-medium cursor-pointer ${
                        params.method === m.id
                          ? 'bg-[#2E2E2E] text-white'
                          : 'text-[#8E8E8E]'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => handleRedetect()}
                  disabled={!sessionId || isProcessing}
                  className="px-3 py-1.5 rounded bg-[#0A84FF] text-white text-xs font-medium flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>재탐지</span>
                </button>
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                <LrSlider
                  label="감도"
                  value={params.sensitivity}
                  min={1}
                  max={100}
                  onChange={(v) => setParams((p) => ({ ...p, sensitivity: v }))}
                />
                <LrSlider
                  label="구름 보호"
                  value={params.cloudProtection}
                  min={0}
                  max={100}
                  onChange={(v) => setParams((p) => ({ ...p, cloudProtection: v }))}
                />
                <LrSlider
                  label="최소 반경"
                  value={params.minRadius}
                  displayValue={`${params.minRadius}px`}
                  min={1}
                  max={15}
                  onChange={(v) => setParams((p) => ({ ...p, minRadius: v }))}
                />
                <LrSlider
                  label="최대 반경"
                  value={params.maxRadius}
                  displayValue={`${params.maxRadius}px`}
                  min={15}
                  max={80}
                  onChange={(v) => setParams((p) => ({ ...p, maxRadius: v }))}
                />
              </div>
            </div>
          )}

          {/* Mobile Tab 3: Heal */}
          {mobileTab === 'heal' && (
            <div className="space-y-2.5">
              <LrSlider
                label="복원 반경"
                value={params.inpaintRadius}
                displayValue={`${params.inpaintRadius}px`}
                min={2}
                max={20}
                onChange={(v) => setParams((p) => ({ ...p, inpaintRadius: v }))}
              />
              <div className="flex items-center justify-between py-1">
                <span className="text-xs text-[#B8B8B8]">센서 입자 유지</span>
                <button
                  type="button"
                  onClick={() =>
                    setParams((p) => ({ ...p, preserveGrain: !p.preserveGrain }))
                  }
                  className={`w-9 h-5 rounded-full transition-colors relative cursor-pointer ${
                    params.preserveGrain ? 'bg-[#0A84FF]' : 'bg-[#383838]'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      params.preserveGrain ? 'left-4.5' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>
              {(inpaintResult || urls?.previewInpainted) && (
                <button
                  type="button"
                  onClick={handleRevertInpainting}
                  disabled={isProcessing}
                  className="w-full min-h-[40px] rounded bg-[#282828] active:bg-[#383838] border border-[#3E3E3E] text-xs text-[#E5E5E5] flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-[#F59E0B]" />
                  <span>복원 되돌리기</span>
                </button>
              )}
            </div>
          )}

          {/* Mobile Tab 4: Spots */}
          {mobileTab === 'spots' && (
            <div>
              <div className="flex items-center justify-between mb-2 text-xs text-[#9E9E9E]">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => handleToggleAllSpots(true)}
                    className="text-[#0A84FF] font-medium cursor-pointer"
                  >
                    전체 선택
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleAllSpots(false)}
                    className="hover:text-white cursor-pointer"
                  >
                    전체 해제
                  </button>
                </div>
              </div>
              <div className="max-h-[150px] overflow-y-auto divide-y divide-[#2A2A2A]">
                {spots.map((spot) => (
                  <div
                    key={spot.id}
                    onClick={() => handleToggleSpot(spot.id)}
                    className="flex items-center justify-between py-2 text-xs font-mono cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={spot.enabled}
                        onChange={() => {}}
                        className="accent-[#0A84FF]"
                      />
                      <span className={spot.enabled ? 'text-white' : 'text-[#666666]'}>
                        #{spot.index}
                      </span>
                    </div>
                    <span className="text-[#8E8E8E]">
                      {spot.radius}px · -{spot.contrastDropPct}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Mobile Tab 5: Export */}
          {mobileTab === 'export' && (
            <div className="space-y-2.5">
              {/* Mobile Color Space Selector */}
              <div className="pb-2 border-b border-[#323232]">
                <div className="flex items-center justify-between text-[11px] mb-1.5">
                  <span className="flex items-center gap-1 text-[#B8B8B8] font-medium">
                    <Palette className="w-3 h-3 text-[#5AC8FA]" />
                    <span>내보내기 색공간 (광색역)</span>
                  </span>
                  <span className="font-mono text-[10px] text-[#5AC8FA]">
                    {COLOR_SPACE_OPTIONS.find((c) => c.id === selectedColorSpace)?.shortLabel}
                  </span>
                </div>
                <div className="flex gap-1 overflow-x-auto pb-1 no-scrollbar">
                  {COLOR_SPACE_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setSelectedColorSpace(opt.id)}
                      className={`px-2.5 py-1 rounded text-[11px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
                        selectedColorSpace === opt.id
                          ? 'bg-[#0A84FF] text-white'
                          : 'bg-[#262626] text-[#A0A0A0] hover:text-white'
                      }`}
                    >
                      {opt.shortLabel}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { id: 'dng', label: 'DNG', sub: '16-bit' },
                    { id: 'tiff16', label: 'TIFF', sub: '16-bit' },
                    { id: 'png', label: 'PNG', sub: '무손실' },
                    { id: 'jpg', label: 'JPG', sub: '98%' },
                  ] as const
                ).map((fmt) => (
                  <button
                    key={fmt.id}
                    type="button"
                    disabled={!sessionId || isProcessing}
                    onClick={() => handleExportFormat(fmt.id)}
                    className="min-h-[44px] px-3 py-2 rounded bg-[#282828] active:bg-[#0A84FF] border border-[#383838] flex items-center justify-between text-xs font-medium cursor-pointer"
                  >
                    <span>{fmt.label}</span>
                    <span className="font-mono text-[10px] text-[#8E8E8E]">
                      {exportingFormat === fmt.id ? '...' : fmt.sub}
                    </span>
                  </button>
                ))}
              </div>

              {studioMode === 'sequence' && sequenceItems.length > 0 && (
                <div className="pt-1 border-t border-[#323232] grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => handleBatchExportZip('dng')}
                    className="min-h-[40px] rounded bg-[#0A84FF]/20 border border-[#0A84FF]/50 text-[#5AC8FA] text-xs font-medium cursor-pointer"
                  >
                    전체 DNG ZIP
                  </button>
                  <button
                    type="button"
                    onClick={() => handleBatchExportZip('jpg')}
                    className="min-h-[40px] rounded bg-[#0A84FF]/20 border border-[#0A84FF]/50 text-[#5AC8FA] text-xs font-medium cursor-pointer"
                  >
                    전체 JPG ZIP
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Mobile Fixed Bottom Icon Dock (Lightroom Mobile Style, < 768px) */}
      <nav className="md:hidden h-14 bg-[#181818] border-t border-[#323232] grid grid-cols-5 items-center shrink-0 z-30">
        {(
          [
            { id: 'tools', label: '도구', icon: Eraser },
            { id: 'detect', label: '탐지', icon: Sliders },
            { id: 'heal', label: '복원', icon: Sparkles },
            { id: 'spots', label: '스팟', icon: ListFilter },
            { id: 'export', label: '내보내기', icon: Download },
          ] as const
        ).map((item) => {
          const Icon = item.icon;
          const isActive = mobileTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setMobileTab(isActive ? null : item.id)}
              className={`min-h-[48px] flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
                isActive ? 'text-[#0A84FF]' : 'text-[#9E9E9E] active:text-white'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span className="text-[10px] font-medium tracking-tight">
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
export default App;
