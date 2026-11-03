import React, { useState, useEffect, useRef } from 'react';
import {
  Upload,
  Check,
  Download,
  RefreshCw,
  AlertCircle,
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
  Search,
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

// Reusable Compact Slider Component
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
      <span className="text-[#C2C1BB] font-medium">{label}</span>
      <span className="text-[#E7E6E1] tabular-nums">
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
    metadata: boolean;
    spots: boolean;
  }>({
    detect: true,
    heal: true,
    colorSpace: false,
    metadata: true,
    spots: true,
  });
  const [selectedColorSpace, setSelectedColorSpace] = useState<ColorSpaceId>('auto');
  const [isExportMenuOpen, setIsExportMenuOpen] = useState<boolean>(false);

  // Mobile Drawer state
  const [mobileTab, setMobileTab] = useState<MobileDrawerTab>(null);

  // Processing state
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [processingLabel, setProcessingLabel] = useState<string>('');
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [exportingFormat, setExportingFormat] = useState<string | null>(null);

  const handleProgress = (percent: number, label?: string) => {
    setProgressPercent(percent);
    if (label) setProcessingLabel(label);
  };

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

  // Step 1: Upload file and display original image without automatically triggering dust detection
  const handleUploadFile = async (file: File) => {
    setErrorMessage(null);
    setIsProcessing(true);
    setProgressPercent(5);
    setProcessingLabel(`${file.name} 불러오는 중...`);

    try {
      const data = await localSensorEngine.uploadAndDetect(file, params, handleProgress);

      setSessionId(data.sessionId);
      setMeta(data.meta);
      setUrls(data.urls);
      // Initialize with no active spots so the user can analyze or manually edit
      setSpots([]);
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
      setProgressPercent(0);
    }
  };

  // Step 2: Dust Analysis action button
  const handleRedetect = async (overrideParams?: Partial<DetectionParams>) => {
    if (!sessionId) return;
    pushHistorySnapshot();
    const nextParams = { ...params, ...overrideParams };
    setParams(nextParams);
    setErrorMessage(null);
    setIsProcessing(true);
    setProgressPercent(5);
    setProcessingLabel('먼지 분석 중...');

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
        const data = await localSensorEngine.detect(sessionId, nextParams, handleProgress);

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
      setProgressPercent(0);
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
    setProcessingLabel(`연속 사진 ${files.length}장 불러오는 중...`);

    try {
      const data = await localSensorEngine.multiUpload(files, params);

      const items: MultiFrameItem[] = (data.sessions || []).map((s: any) => ({
        sessionId: s.sessionId,
        meta: s.meta,
        detection: s.detection,
        urls: s.urls,
        spots: [],
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
        setSpots([]);
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
    setProcessingLabel(`연속 사진 ${sequenceItems.length}장 일괄 먼지 제거 적용 중...`);

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
      setErrorMessage(err.message || '일괄 적용 오류');
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

  // Step 3: Apply inpainting
  const handleApplyInpainting = async () => {
    if (!sessionId) return;
    pushHistorySnapshot();
    setErrorMessage(null);
    setIsProcessing(true);
    setProgressPercent(5);
    setProcessingLabel('스팟 제거 적용 중...');

    try {
      const data = await localSensorEngine.inpaint(
        sessionId,
        spots,
        manualStrokes,
        params.inpaintRadius,
        params.preserveGrain,
        handleProgress
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
      setErrorMessage(err.message || '복원 적용 중 오류 발생');
    } finally {
      setIsProcessing(false);
      setProcessingLabel('');
      setProgressPercent(0);
    }
  };

  // Step 4: Export (if not applied, export original; if applied, export cleaned)
  const handleExportFormat = async (format: 'dng' | 'tiff16' | 'png' | 'jpg') => {
    if (!sessionId) return;
    setExportingFormat(format);
    setIsExportMenuOpen(false);
    setMobileTab(null);
    setErrorMessage(null);
    setIsProcessing(true);
    setProgressPercent(5);

    const formatNames: Record<string, string> = {
      dng: 'DNG (16-bit)',
      tiff16: 'TIFF (16-bit)',
      png: 'PNG',
      jpg: 'JPG',
    };
    const labelPrefix = formatNames[format] || format.toUpperCase();

    try {
      setProcessingLabel(`${labelPrefix} 내보내는 중...`);
      const res = await localSensorEngine.exportSingle(
        sessionId,
        format,
        spots,
        manualStrokes,
        params.inpaintRadius,
        params.preserveGrain,
        selectedColorSpace,
        handleProgress
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
      localSensorEngine.triggerBrowserDownload(res.fileBlob, res.downloadName);
    } catch (err: any) {
      setErrorMessage(err.message || '내보내기 실패');
    } finally {
      setIsProcessing(false);
      setProcessingLabel('');
      setProgressPercent(0);
      setTimeout(() => setExportingFormat(null), 400);
    }
  };

  const enabledSpotsCount = spots.filter((s) => s.enabled).length;

  return (
    <div className="h-[100dvh] w-screen flex flex-col bg-[#2B2B2E] text-[#E7E6E1] overflow-hidden select-none">
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

      {/* Top Header Bar */}
      <header className="h-11 px-3 bg-[#3A3A3D] border-b border-[#535356] flex items-center justify-between gap-4 shrink-0 z-30">
        {/* Left: Brand + Mode Switch + Import */}
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="flex items-center gap-1.5">
            <img src="/favicon.svg" alt="SensorClean" className="w-4 h-4 rounded-xs" />
            <span className="text-xs font-semibold tracking-tight text-white whitespace-nowrap">
              SensorClean
            </span>
          </div>

          <div className="flex items-center p-0.5 bg-[#2B2B2E] border border-[#535356] rounded">
            <button
              type="button"
              onClick={() => setStudioMode('single')}
              className={`px-2 py-0.5 rounded-xs text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                studioMode === 'single'
                  ? 'bg-[#556042] text-white'
                  : 'text-[#888783] hover:text-[#C2C1BB]'
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
                  ? 'bg-[#556042] text-white'
                  : 'text-[#888783] hover:text-[#C2C1BB]'
              }`}
            >
              <span>연속</span>
              {sequenceItems.length > 0 && (
                <span className="text-[10px] opacity-90">
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
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#2B2B2E] hover:bg-[#535356] text-[#E7E6E1] text-[11px] font-medium border border-[#535356] transition-colors cursor-pointer whitespace-nowrap"
          >
            <Upload className="w-3 h-3 text-[#C2C1BB]" />
            <span className="hidden sm:inline">1. 불러오기</span>
          </button>

          {sessionId && (
            <button
              type="button"
              onClick={() => handleRedetect()}
              disabled={isProcessing}
              className="hidden md:flex items-center gap-1 px-2.5 py-1 rounded bg-[#556042] hover:bg-[#687652] text-white text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0"
              title="먼지 분석 실행"
            >
              <Search className="w-3 h-3" />
              <span>2. 먼지 분석</span>
            </button>
          )}

          {sessionId && (
            <div className="flex items-center gap-0.5 ml-0.5 shrink-0">
              <button
                type="button"
                onClick={handleUndo}
                disabled={undoStack.length === 0 || isProcessing}
                title="되돌리기 (Ctrl+Z)"
                className="p-1.5 rounded text-[#C2C1BB] hover:text-white hover:bg-[#535356] disabled:opacity-30 transition-colors cursor-pointer"
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={handleRedo}
                disabled={redoStack.length === 0 || isProcessing}
                title="다시 실행 (Ctrl+Shift+Z)"
                className="p-1.5 rounded text-[#C2C1BB] hover:text-white hover:bg-[#535356] disabled:opacity-30 transition-colors cursor-pointer"
              >
                <Redo2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* Center: Metadata Readout */}
        {meta && (
          <div className="hidden lg:flex items-center gap-2 text-[11px] text-[#C2C1BB] truncate">
            <span className="text-[#E7E6E1] font-medium truncate max-w-[170px]">
              {meta.originalFileName}
            </span>
            {(meta.exif.make || meta.exif.model) && (
              <>
                <span>·</span>
                <span className="truncate max-w-[160px] text-[#E7E6E1]">
                  {[meta.exif.make, meta.exif.model].filter(Boolean).join(' ')}
                </span>
              </>
            )}
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
            {meta.exif.exposureTime && (
              <>
                <span>·</span>
                <span>{meta.exif.exposureTime}</span>
              </>
            )}
            {meta.exif.iso && (
              <>
                <span>·</span>
                <span>ISO {meta.exif.iso}</span>
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
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-[#2B2B2E] text-[#E7E6E1] border border-[#535356]"
              title={`원본 감지 색공간: ${meta.detectedColorSpace || 'sRGB'}`}
            >
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
            </span>
            <span>·</span>
            <span className="text-[#E7E6E1]">
              스팟 {enabledSpotsCount}/{spots.length}
            </span>
          </div>
        )}

        {/* Mobile Center Filename (Visible only from sm breakpoint) */}
        {meta && (
          <div className="hidden sm:flex lg:hidden items-center gap-1.5 text-[11px] text-[#C2C1BB] truncate">
            <span className="truncate max-w-[100px] text-[#E7E6E1]">
              {meta.originalFileName}
            </span>
            {meta.exif.model && (
              <>
                <span>·</span>
                <span className="truncate max-w-[80px] text-[#E7E6E1]">
                  {meta.exif.model}
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
              className="hidden sm:flex items-center gap-1 px-2.5 py-1 rounded bg-[#2B2B2E] hover:bg-[#535356] border border-[#535356] text-[#E7E6E1] text-[11px] font-medium cursor-pointer whitespace-nowrap disabled:opacity-40"
            >
              <Check className="w-3 h-3 text-[#556042]" />
              <span>전체 적용</span>
            </button>
          )}

          {(inpaintResult || urls?.previewInpainted) && (
            <button
              type="button"
              onClick={handleRevertInpainting}
              disabled={isProcessing}
              title="적용된 먼지 복원을 취소하고 작업 화면으로 되돌리기"
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#2B2B2E] hover:bg-[#535356] border border-[#535356] text-[#C2C1BB] text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-40"
            >
              <RotateCcw className="w-3 h-3 text-[#C2C1BB]" />
              <span className="hidden sm:inline">복원 되돌리기</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleApplyInpainting}
            disabled={!sessionId || isProcessing}
            className="flex items-center gap-1 px-3 py-1 rounded bg-[#556042] hover:bg-[#687652] text-white text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-40"
          >
            <Check className="w-3 h-3" />
            <span>3. 적용</span>
          </button>

          {/* Desktop Export Dropdown */}
          <div ref={exportMenuRef} className="relative hidden md:block">
            <button
              type="button"
              onClick={() => setIsExportMenuOpen((v) => !v)}
              disabled={!sessionId || isProcessing}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#2B2B2E] hover:bg-[#535356] border border-[#535356] text-[#E7E6E1] text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-40"
            >
              <Download className="w-3 h-3" />
              <span>4. 내보내기</span>
              <ChevronDown className="w-3 h-3 text-[#888783]" />
            </button>

            {isExportMenuOpen && (
              <div className="absolute right-0 mt-1.5 w-56 rounded-md bg-[#3A3A3D] border border-[#535356] shadow-2xl py-1 z-50 text-xs text-[#E7E6E1]">
                <div className="px-3 py-1.5 border-b border-[#535356] space-y-1 text-[11px] text-[#C2C1BB]">
                  <div className="flex items-center justify-between">
                    <span>출력 상태</span>
                    <span className="text-[10px] text-[#E7E6E1] font-semibold">
                      {inpaintResult ? '적용된 버전' : '원본 버전 (미적용)'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>출력 해상도</span>
                    <span className="text-[10px] text-[#E7E6E1]">
                      {meta ? `${meta.fullWidth}×${meta.fullHeight} (1:1 원본)` : '1:1 원본'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>색공간</span>
                    <span className="text-[10px] text-[#E7E6E1] font-medium">
                      {COLOR_SPACE_OPTIONS.find((c) => c.id === selectedColorSpace)?.shortLabel || '원본'}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleExportFormat('dng')}
                  className="w-full px-3 py-1.5 text-left hover:bg-[#556042] hover:text-white flex items-center justify-between cursor-pointer"
                >
                  <span>DNG</span>
                  <span className="text-[10px] opacity-75">16-bit · 1:1 원본</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleExportFormat('tiff16')}
                  className="w-full px-3 py-1.5 text-left hover:bg-[#556042] hover:text-white flex items-center justify-between cursor-pointer"
                >
                  <span>TIFF</span>
                  <span className="text-[10px] opacity-75">16-bit · 1:1 원본</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleExportFormat('png')}
                  className="w-full px-3 py-1.5 text-left hover:bg-[#556042] hover:text-white flex items-center justify-between cursor-pointer"
                >
                  <span>PNG</span>
                  <span className="text-[10px] opacity-75">무손실 · 1:1 원본</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleExportFormat('jpg')}
                  className="w-full px-3 py-1.5 text-left hover:bg-[#556042] hover:text-white flex items-center justify-between cursor-pointer"
                >
                  <span>JPG</span>
                  <span className="text-[10px] opacity-75">98% · 1:1 원본</span>
                </button>

                {studioMode === 'sequence' && sequenceItems.length > 0 && (
                  <>
                    <div className="my-1 border-t border-[#535356]" />
                    <div className="px-3 py-1 text-[10px] text-[#888783]">
                      연속 {sequenceItems.length}장 ZIP
                    </div>
                    <div className="grid grid-cols-2 gap-1 px-2 pb-1">
                      {(['dng', 'tiff16', 'png', 'jpg'] as const).map((fmt) => (
                        <button
                          key={fmt}
                          type="button"
                          onClick={() => handleBatchExportZip(fmt)}
                          className="px-2 py-1 rounded bg-[#2B2B2E] hover:bg-[#556042] hover:text-white text-[10px] uppercase text-center cursor-pointer border border-[#535356]"
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
            progressPercent={progressPercent}
            onUploadFile={handleUploadFile}
            onBeginHistoryBatch={pushHistorySnapshot}
            onBatchDeselectSpots={handleBatchDeselectSpots}
            onUndo={handleUndo}
            onRedo={handleRedo}
            filterMode={studioMode === 'sequence' ? filterMode : undefined}
            onChangeFilterMode={studioMode === 'sequence' ? setFilterMode : undefined}
            isSequenceMode={studioMode === 'sequence'}
          />

          {/* Bottom Filmstrip (Sequence Mode) */}
          {studioMode === 'sequence' && (
            <div className="h-16 md:h-20 bg-[#2B2B2E] border-t border-[#535356] px-3 flex items-center gap-2 overflow-x-auto shrink-0">
              <button
                type="button"
                onClick={() => multiFileInputRef.current?.click()}
                className="h-12 md:h-14 px-3 rounded border border-dashed border-[#535356] hover:border-[#556042] text-[#888783] hover:text-white flex flex-col items-center justify-center gap-0.5 text-[10px] shrink-0 cursor-pointer"
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
                        ? 'border-[#556042] ring-1 ring-[#556042]'
                        : 'border-[#535356] opacity-70 hover:opacity-100'
                    }`}
                  >
                    <img
                      src={item.urls.previewInpainted || item.urls.previewOriginal}
                      alt={item.meta.originalFileName}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-x-0 bottom-0 bg-[#2B2B2E]/80 px-1 py-0.5 flex items-center justify-between text-[9px]">
                      <span className="text-[#C2C1BB]">#{idx + 1}</span>
                      <span className="text-[#E7E6E1]">{activeCount}</span>
                    </div>
                  </button>
                );
              })}

              {multiReport && (
                <div className="ml-auto pl-2 text-[11px] text-[#888783] whitespace-nowrap hidden sm:block">
                  공통 먼지 {multiReport.multiConfirmedClusters}개
                </div>
              )}
            </div>
          )}
        </div>

        {/* Desktop Right Collapsible Inspector Panel */}
        {isRightDockOpen && (
          <aside className="hidden md:flex w-[272px] bg-[#3A3A3D] border-l border-[#535356] flex-col overflow-y-auto shrink-0">
            {/* Contextual Brush Bar */}
            {(interactionTool === 'deselect-brush' ||
              interactionTool === 'brush-add' ||
              interactionTool === 'brush-erase') && (
              <div className="px-3.5 py-2.5 bg-[#2B2B2E] border-b border-[#535356]">
                <div className="flex items-center justify-between text-[11px] mb-1">
                  <span className="font-medium text-white">
                    {interactionTool === 'deselect-brush'
                      ? '지우개 브러시 반경'
                      : interactionTool === 'brush-add'
                      ? '복원 브러시 반경'
                      : '마스크 지우개 반경'}
                  </span>
                  <span className="text-[#556042] font-semibold">{brushRadius}px</span>
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
                    className="flex-1 py-1 rounded bg-[#3A3A3D] hover:bg-[#535356] disabled:opacity-35 text-[11px] text-[#E7E6E1] flex items-center justify-center gap-1 cursor-pointer"
                  >
                    <Undo2 className="w-3 h-3" />
                    <span>되돌리기</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleRedo}
                    disabled={redoStack.length === 0 || isProcessing}
                    className="flex-1 py-1 rounded bg-[#3A3A3D] hover:bg-[#535356] disabled:opacity-35 text-[11px] text-[#E7E6E1] flex items-center justify-center gap-1 cursor-pointer"
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
                    className="mt-1.5 w-full py-1 rounded bg-[#3A3A3D] hover:bg-[#535356] text-[11px] text-[#C2C1BB] cursor-pointer"
                  >
                    수동 브러시 초기화 ({manualStrokes.length})
                  </button>
                )}
              </div>
            )}

            {/* Accordion 1: 먼지 탐지 (Detection) */}
            <div className="border-b border-[#535356]">
              <div className="flex items-center justify-between px-3.5 py-2.5 hover:bg-[#2B2B2E]">
                <button
                  type="button"
                  onClick={() =>
                    setOpenAccordions((p) => ({ ...p, detect: !p.detect }))
                  }
                  className="flex items-center gap-1.5 text-xs font-semibold text-[#E7E6E1] cursor-pointer flex-1 text-left"
                >
                  {openAccordions.detect ? (
                    <ChevronDown className="w-3.5 h-3.5 text-[#888783]" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-[#888783]" />
                  )}
                  <span>먼지 탐지</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleRedetect()}
                  disabled={!sessionId || isProcessing}
                  title="분석 및 탐지"
                  className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#556042] hover:bg-[#687652] text-[11px] text-white cursor-pointer disabled:opacity-40"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>분석</span>
                </button>
              </div>

              {openAccordions.detect && (
                <div className="px-3.5 pb-3 space-y-1">
                  {/* Method Segment */}
                  <div className="grid grid-cols-3 gap-1 p-0.5 bg-[#2B2B2E] border border-[#535356] rounded mb-2">
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
                            ? 'bg-[#556042] text-white'
                            : 'text-[#888783] hover:text-[#C2C1BB]'
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
            <div className="border-b border-[#535356]">
              <button
                type="button"
                onClick={() => setOpenAccordions((p) => ({ ...p, heal: !p.heal }))}
                className="w-full flex items-center gap-1.5 px-3.5 py-2.5 hover:bg-[#2B2B2E] text-xs font-semibold text-[#E7E6E1] cursor-pointer text-left"
              >
                {openAccordions.heal ? (
                  <ChevronDown className="w-3.5 h-3.5 text-[#888783]" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-[#888783]" />
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
                    <span className="text-[11px] text-[#C2C1BB] font-medium">
                      센서 입자 유지
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setParams((p) => ({ ...p, preserveGrain: !p.preserveGrain }))
                      }
                      className={`w-8 h-4 rounded-full transition-colors relative cursor-pointer ${
                        params.preserveGrain ? 'bg-[#556042]' : 'bg-[#535356]'
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
                      className="w-full mt-1 py-1.5 rounded bg-[#2B2B2E] hover:bg-[#535356] border border-[#535356] text-[11px] text-[#E7E6E1] flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3 text-[#C2C1BB]" />
                      <span>복원 되돌리기 (원본 작업 상태로)</span>
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Accordion 3: 색공간 및 ICC 프로파일 */}
            <div className="border-b border-[#535356]">
              <button
                type="button"
                onClick={() =>
                  setOpenAccordions((p) => ({ ...p, colorSpace: !p.colorSpace }))
                }
                className="w-full flex items-center gap-1.5 px-3.5 py-2.5 hover:bg-[#2B2B2E] text-xs font-semibold text-[#E7E6E1] cursor-pointer text-left"
              >
                {openAccordions.colorSpace ? (
                  <ChevronDown className="w-3.5 h-3.5 text-[#888783]" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-[#888783]" />
                )}
                <span>색공간 및 ICC 프로파일</span>
              </button>

              {openAccordions.colorSpace && (
                <div className="px-3.5 pb-3 space-y-2.5">
                  {/* Detected color space readout */}
                  {meta && (
                    <div className="p-2 rounded bg-[#2B2B2E] border border-[#535356] text-[11px]">
                      <div className="flex items-center justify-between text-[#888783] mb-0.5">
                        <span>원본 감지 색역</span>
                        <span className="text-[#E7E6E1] font-medium">
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
                      <div className="text-[10px] text-[#C2C1BB] flex items-center justify-between">
                        <span>프로파일 출처</span>
                        <span className="text-[#E7E6E1]">
                          {meta.hasEmbeddedIcc
                            ? '내장 ICC Profile (Tag 34675 / APP2)'
                            : 'EXIF ColorSpace 메타데이터'}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Target Color Space Selector */}
                  <div className="space-y-1.5">
                    <div className="text-[11px] text-[#C2C1BB] font-medium flex items-center justify-between">
                      <span>내보내기 대상 색공간</span>
                      <span className="text-[10px] text-[#888783]">16비트 리니어 매핑</span>
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
                                ? 'bg-[#556042]/30 border-[#556042] text-white'
                                : 'bg-[#2B2B2E] border-[#535356] text-[#C2C1BB] hover:bg-[#3A3A3D]'
                            }`}
                          >
                            <div className="flex items-center justify-between mb-0.5">
                              <span className="text-[11px] font-semibold flex items-center gap-1.5">
                                <span
                                  className={`w-2 h-2 rounded-full ${
                                    isSelected ? 'bg-[#556042]' : 'bg-[#535356]'
                                  }`}
                                />
                                {opt.label}
                              </span>
                              <span className="text-[9px] text-[#888783]">
                                {opt.gamutCoverage}
                              </span>
                            </div>
                            <p className="text-[10px] text-[#888783] leading-tight pl-3.5">
                              {opt.description}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Accordion 4: 카메라 메타데이터 (EXIF) */}
            <div className="border-b border-[#535356]">
              <button
                type="button"
                onClick={() =>
                  setOpenAccordions((p) => ({ ...p, metadata: !p.metadata }))
                }
                className="w-full flex items-center gap-1.5 px-3.5 py-2.5 hover:bg-[#2B2B2E] text-xs font-semibold text-[#E7E6E1] cursor-pointer text-left"
              >
                {openAccordions.metadata ? (
                  <ChevronDown className="w-3.5 h-3.5 text-[#888783]" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-[#888783]" />
                )}
                <span>카메라 메타데이터 (EXIF)</span>
              </button>

              {openAccordions.metadata && (
                <div className="p-3.5 space-y-3 bg-[#2B2B2E]">
                  {meta ? (
                    <div className="space-y-1.5 text-[11px]">
                      <div className="flex items-center justify-between py-1 border-b border-[#535356]">
                        <span className="text-[#888783]">카메라 기종</span>
                        <span className="text-[#E7E6E1] font-medium text-right max-w-[190px] truncate">
                          {[meta.exif.make, meta.exif.model].filter(Boolean).join(' ') || '카메라 태그 없음'}
                        </span>
                      </div>
                      {meta.exif.lensModel && (
                        <div className="flex items-center justify-between py-1 border-b border-[#535356]">
                          <span className="text-[#888783]">렌즈 모델</span>
                          <span className="text-[#E7E6E1] font-medium text-right max-w-[190px] truncate" title={meta.exif.lensModel}>
                            {meta.exif.lensModel}
                          </span>
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-2 pt-0.5">
                        <div className="bg-[#3A3A3D] p-2 rounded border border-[#535356]">
                          <div className="text-[10px] text-[#888783]">조리개</div>
                          <div className="text-xs text-[#E7E6E1] font-medium">
                            {meta.exif.fNumber ? `f/${meta.exif.fNumber}` : '—'}
                          </div>
                        </div>
                        <div className="bg-[#3A3A3D] p-2 rounded border border-[#535356]">
                          <div className="text-[10px] text-[#888783]">셔터 스피드</div>
                          <div className="text-xs text-[#E7E6E1] font-medium">
                            {meta.exif.exposureTime || '—'}
                          </div>
                        </div>
                        <div className="bg-[#3A3A3D] p-2 rounded border border-[#535356]">
                          <div className="text-[10px] text-[#888783]">감도 (ISO)</div>
                          <div className="text-xs text-[#E7E6E1] font-medium">
                            {meta.exif.iso ? `ISO ${meta.exif.iso}` : '—'}
                          </div>
                        </div>
                        <div className="bg-[#3A3A3D] p-2 rounded border border-[#535356]">
                          <div className="text-[10px] text-[#888783]">초점거리</div>
                          <div className="text-xs text-[#E7E6E1] font-medium">
                            {meta.exif.focalLength || '—'}
                          </div>
                        </div>
                      </div>

                      {meta.exif.dateTime && (
                        <div className="flex items-center justify-between py-1 border-b border-[#535356]">
                          <span className="text-[#888783]">촬영 일시</span>
                          <span className="text-[#C2C1BB] text-[10px]">
                            {meta.exif.dateTime}
                          </span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-[11px] text-[#888783] text-center py-4">
                      이미지를 불러오면 카메라 및 EXIF 메타데이터가 표시됩니다.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Accordion 5: 스팟 목록 (Spots) */}
            <div className="flex-1 flex flex-col min-h-[180px]">
              <div className="flex items-center justify-between px-3.5 py-2.5 hover:bg-[#2B2B2E] border-b border-[#535356]">
                <button
                  type="button"
                  onClick={() =>
                    setOpenAccordions((p) => ({ ...p, spots: !p.spots }))
                  }
                  className="flex items-center gap-1.5 text-xs font-semibold text-[#E7E6E1] cursor-pointer text-left"
                >
                  {openAccordions.spots ? (
                    <ChevronDown className="w-3.5 h-3.5 text-[#888783]" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-[#888783]" />
                  )}
                  <span>스팟</span>
                  <span className="text-[11px] text-[#888783] font-normal ml-1">
                    {enabledSpotsCount}/{spots.length}
                  </span>
                </button>

                {spots.length > 0 && (
                  <div className="flex items-center gap-2 text-[11px] text-[#C2C1BB]">
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
                <div className="flex-1 overflow-y-auto divide-y divide-[#535356]">
                  {spots.length === 0 ? (
                    <div className="py-8 text-center text-[11px] text-[#888783]">
                      검출된 스팟 없음
                    </div>
                  ) : (
                    spots.map((spot) => {
                      const isSelected = spot.id === selectedSpotId;
                      return (
                        <div
                          key={spot.id}
                          onClick={() => setSelectedSpotId(spot.id)}
                          className={`flex items-center justify-between px-3.5 py-1.5 text-[11px] cursor-pointer transition-colors ${
                            isSelected ? 'bg-[#556042]/30' : 'hover:bg-[#2B2B2E]'
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
                              className="accent-[#556042] rounded-xs cursor-pointer"
                            />
                            <span
                              className={
                                spot.enabled
                                  ? 'text-[#E7E6E1]'
                                  : 'text-[#888783] line-through'
                              }
                            >
                              #{spot.index}
                            </span>
                            {spot.isMultiConfirmed && (
                              <span className="text-[10px] text-[#C2C1BB]">
                                {spot.matchCount}f
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2.5 text-[#888783]">
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

        {/* Desktop Rightmost Tool Rail */}
        <div className="hidden md:flex w-11 bg-[#2B2B2E] border-l border-[#535356] flex-col items-center py-2.5 gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setInteractionTool('inspect')}
            title="선택 및 개별 토글"
            className={`w-8 h-8 rounded flex items-center justify-center transition-colors cursor-pointer ${
              interactionTool === 'inspect'
                ? 'bg-[#556042] text-white'
                : 'text-[#888783] hover:text-white hover:bg-[#3A3A3D]'
            }`}
          >
            <MousePointer className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => setInteractionTool('deselect-brush')}
            title="드래그 지우개 브러시"
            className={`w-8 h-8 rounded flex items-center justify-center transition-colors cursor-pointer ${
              interactionTool === 'deselect-brush'
                ? 'bg-[#556042] text-white'
                : 'text-[#888783] hover:text-white hover:bg-[#3A3A3D]'
            }`}
          >
            <Eraser className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => setInteractionTool('brush-add')}
            title="수동 복원 브러시"
            className={`w-8 h-8 rounded flex items-center justify-center transition-colors cursor-pointer ${
              interactionTool === 'brush-add'
                ? 'bg-[#556042] text-white'
                : 'text-[#888783] hover:text-white hover:bg-[#3A3A3D]'
            }`}
          >
            <Paintbrush className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => setInteractionTool('brush-erase')}
            title="수동 마스크 지우개"
            className={`w-8 h-8 rounded flex items-center justify-center transition-colors cursor-pointer ${
              interactionTool === 'brush-erase'
                ? 'bg-[#556042] text-white'
                : 'text-[#888783] hover:text-white hover:bg-[#3A3A3D]'
            }`}
          >
            <RotateCcw className="w-4 h-4" />
          </button>

          <div className="w-5 h-[1px] bg-[#535356] my-1" />

          <button
            type="button"
            onClick={() => setIsRightDockOpen((v) => !v)}
            title="패널 접기/펴기"
            className="w-8 h-8 rounded flex items-center justify-center text-[#888783] hover:text-white hover:bg-[#3A3A3D] transition-colors cursor-pointer"
          >
            {isRightDockOpen ? (
              <PanelRightClose className="w-4 h-4" />
            ) : (
              <PanelRightOpen className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {/* Mobile Slide-Up Contextual Tray */}
      {mobileTab && (
        <div className="md:hidden bg-[#3A3A3D]/95 backdrop-blur-md border-t border-[#535356] px-4 pt-2.5 pb-3 z-30 shrink-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-[#E7E6E1]">
              {mobileTab === 'tools' && '브러시 및 선택 도구'}
              {mobileTab === 'detect' && '먼지 탐지 설정'}
              {mobileTab === 'heal' && '복원 설정'}
              {mobileTab === 'spots' && `스팟 목록 (${enabledSpotsCount}/${spots.length})`}
              {mobileTab === 'export' && '내보내기'}
            </span>
            <button
              type="button"
              onClick={() => setMobileTab(null)}
              className="p-1 text-[#888783] hover:text-white cursor-pointer"
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
                      ? 'bg-[#556042] text-white'
                      : 'bg-[#2B2B2E] text-[#C2C1BB]'
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
                      ? 'bg-[#556042] text-white'
                      : 'bg-[#2B2B2E] text-[#C2C1BB]'
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
                      ? 'bg-[#556042] text-white'
                      : 'bg-[#2B2B2E] text-[#C2C1BB]'
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
                      ? 'bg-[#556042] text-white'
                      : 'bg-[#2B2B2E] text-[#C2C1BB]'
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
                  className="min-h-[38px] rounded bg-[#2B2B2E] border border-[#535356] disabled:opacity-35 text-xs text-[#E7E6E1] flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Undo2 className="w-3.5 h-3.5" />
                  <span>되돌리기</span>
                </button>
                <button
                  type="button"
                  onClick={handleRedo}
                  disabled={redoStack.length === 0 || isProcessing}
                  className="min-h-[38px] rounded bg-[#2B2B2E] border border-[#535356] disabled:opacity-35 text-xs text-[#E7E6E1] flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Redo2 className="w-3.5 h-3.5" />
                  <span>다시 실행</span>
                </button>
              </div>
            </div>
          )}

          {/* Mobile Tab 2: Detect */}
          {mobileTab === 'detect' && (
            <div className="space-y-2.5 max-h-[240px] overflow-y-auto pr-1">
              <button
                type="button"
                onClick={() => handleRedetect()}
                disabled={!sessionId || isProcessing}
                className="w-full py-2 rounded-lg bg-[#556042] hover:bg-[#687652] text-white text-xs font-semibold flex items-center justify-center gap-1.5 shrink-0 cursor-pointer shadow-md disabled:opacity-40"
              >
                <Search className="w-4 h-4" />
                <span>2. 먼지 분석 실행</span>
              </button>

              <div className="grid grid-cols-3 gap-1 p-0.5 bg-[#2B2B2E] border border-[#535356] rounded">
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
                    className={`py-1.5 rounded-xs text-[11px] font-medium cursor-pointer ${
                      params.method === m.id
                        ? 'bg-[#556042] text-white'
                        : 'text-[#888783]'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
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
                <span className="text-xs text-[#C2C1BB]">센서 입자 유지</span>
                <button
                  type="button"
                  onClick={() =>
                    setParams((p) => ({ ...p, preserveGrain: !p.preserveGrain }))
                  }
                  className={`w-9 h-5 rounded-full transition-colors relative cursor-pointer ${
                    params.preserveGrain ? 'bg-[#556042]' : 'bg-[#535356]'
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
                  className="w-full min-h-[40px] rounded bg-[#2B2B2E] border border-[#535356] text-xs text-[#E7E6E1] flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-[#C2C1BB]" />
                  <span>복원 되돌리기</span>
                </button>
              )}
            </div>
          )}

          {/* Mobile Tab 4: Spots */}
          {mobileTab === 'spots' && (
            <div>
              <div className="flex items-center justify-between mb-2 text-xs text-[#C2C1BB]">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => handleToggleAllSpots(true)}
                    className="text-[#E7E6E1] font-medium cursor-pointer"
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
              <div className="max-h-[150px] overflow-y-auto divide-y divide-[#535356]">
                {spots.map((spot) => (
                  <div
                    key={spot.id}
                    onClick={() => handleToggleSpot(spot.id)}
                    className="flex items-center justify-between py-2 text-xs cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={spot.enabled}
                        onChange={() => {}}
                        className="accent-[#556042]"
                      />
                      <span className={spot.enabled ? 'text-white' : 'text-[#888783]'}>
                        #{spot.index}
                      </span>
                    </div>
                    <span className="text-[#888783]">
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
                    className="min-h-[44px] px-3 py-2 rounded bg-[#2B2B2E] border border-[#535356] flex items-center justify-between text-xs font-medium cursor-pointer"
                  >
                    <span>{fmt.label}</span>
                    <span className="text-[10px] text-[#888783]">
                      {exportingFormat === fmt.id ? '...' : fmt.sub}
                    </span>
                  </button>
                ))}
              </div>

              {studioMode === 'sequence' && sequenceItems.length > 0 && (
                <div className="pt-1 border-t border-[#535356] grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => handleBatchExportZip('dng')}
                    className="min-h-[40px] rounded bg-[#556042]/30 border border-[#556042] text-[#E7E6E1] text-xs font-medium cursor-pointer"
                  >
                    전체 DNG ZIP
                  </button>
                  <button
                    type="button"
                    onClick={() => handleBatchExportZip('jpg')}
                    className="min-h-[40px] rounded bg-[#556042]/30 border border-[#556042] text-[#E7E6E1] text-xs font-medium cursor-pointer"
                  >
                    전체 JPG ZIP
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Mobile Fixed Bottom Icon Dock */}
      <nav className="md:hidden h-14 bg-[#2B2B2E] border-t border-[#535356] grid grid-cols-5 items-center shrink-0 z-30">
        {(
          [
            { id: 'tools', label: '도구', icon: Eraser },
            { id: 'detect', label: '탐지', icon: Sliders },
            { id: 'heal', label: '복원', icon: Sparkles },
            { id: 'spots', label: '스팟', icon: ListFilter },
            { id: 'export', label: '내보내기', icon: Download },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const isActive = mobileTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setMobileTab((curr) => (curr === tab.id ? null : tab.id))}
              className={`h-full flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                isActive ? 'text-[#556042] bg-[#3A3A3D]' : 'text-[#888783] hover:text-[#E7E6E1]'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

export default App;
