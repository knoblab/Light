import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Eye,
  EyeOff,
  Upload,
  MousePointer,
  Eraser,
  Paintbrush,
  RotateCcw,
  Undo2,
  Redo2,
  Minus,
  Plus,
} from 'lucide-react';
import {
  DetectedDustSpot,
  InteractionTool,
  ManualBrushStroke,
  OverlayMode,
  SessionMetadata,
  SessionUrls,
  ViewComparisonMode,
} from '../types/sensor';

interface DarkroomCanvasProps {
  meta: SessionMetadata | null;
  urls: SessionUrls | null;
  spots: DetectedDustSpot[];
  selectedSpotId: string | null;
  onSelectSpot: (id: string | null) => void;
  onToggleSpot: (id: string) => void;
  manualStrokes: ManualBrushStroke[];
  onAddManualStroke: (stroke: ManualBrushStroke) => void;
  onClearManualStrokes: () => void;
  showDustOverlay: boolean;
  onToggleDustOverlay: (val: boolean) => void;
  overlayMode: OverlayMode;
  onChangeOverlayMode: (mode: OverlayMode) => void;
  interactionTool: InteractionTool;
  onChangeInteractionTool: (tool: InteractionTool) => void;
  brushRadius: number;
  onChangeBrushRadius: (r: number) => void;
  comparisonMode: ViewComparisonMode;
  onChangeComparisonMode: (mode: ViewComparisonMode) => void;
  hasInpaintedResult: boolean;
  isProcessing: boolean;
  processingLabel: string;
  progressPercent?: number;
  onUploadFile: (file: File) => void;
  onBatchDeselectSpots?: (ids: string[]) => void;
  onBeginHistoryBatch?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  filterMode?: 'all' | 'multi-confirmed' | 'single-frame';
  onChangeFilterMode?: (mode: 'all' | 'multi-confirmed' | 'single-frame') => void;
  isSequenceMode?: boolean;
}

export const DarkroomCanvas: React.FC<DarkroomCanvasProps> = ({
  meta,
  urls,
  spots,
  selectedSpotId,
  onSelectSpot,
  onToggleSpot,
  manualStrokes,
  onAddManualStroke,
  showDustOverlay,
  onToggleDustOverlay,
  overlayMode,
  onChangeOverlayMode,
  interactionTool,
  onChangeInteractionTool,
  brushRadius,
  onChangeBrushRadius,
  comparisonMode,
  onChangeComparisonMode,
  hasInpaintedResult,
  isProcessing,
  processingLabel,
  progressPercent = 0,
  onUploadFile,
  onBatchDeselectSpots,
  onBeginHistoryBatch,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  filterMode = 'all',
  onChangeFilterMode,
  isSequenceMode = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const [panStart, setPanStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDrawingStroke, setIsDrawingStroke] = useState<boolean>(false);
  const [currentPoints, setCurrentPoints] = useState<Array<{ x: number; y: number }>>([]);
  const [cursorImgPos, setCursorImgPos] = useState<{ x: number; y: number } | null>(null);
  const [splitPosition, setSplitPosition] = useState<number>(50);
  const [isDraggingSplit, setIsDraggingSplit] = useState<boolean>(false);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const [showSpotLabels, setShowSpotLabels] = useState<boolean>(false);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [meta?.originalFileName]);

  // Lightroom keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          onRedo?.();
        } else {
          onUndo?.();
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && k === 'y') {
        e.preventDefault();
        onRedo?.();
        return;
      }

      if (e.key === '[') {
        onChangeBrushRadius(Math.max(4, brushRadius - 4));
      } else if (e.key === ']') {
        onChangeBrushRadius(Math.min(120, brushRadius + 4));
      } else if (k === 'o') {
        onToggleDustOverlay(!showDustOverlay);
      } else if (k === 'd') {
        onChangeInteractionTool('deselect-brush');
      } else if (k === 'i' || k === 'v') {
        onChangeInteractionTool('inspect');
      } else if (k === 'b') {
        onChangeInteractionTool('brush-add');
      } else if (k === 'e') {
        onChangeInteractionTool('brush-erase');
      } else if (k === '\\') {
        onChangeComparisonMode(
          comparisonMode === 'original-only' ? 'healed-only' : 'original-only'
        );
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    brushRadius,
    showDustOverlay,
    comparisonMode,
    onChangeBrushRadius,
    onToggleDustOverlay,
    onChangeInteractionTool,
    onChangeComparisonMode,
    onUndo,
    onRedo,
  ]);

  const clientToFullCoords = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      if (!overlayCanvasRef.current || !meta) return null;
      const rect = overlayCanvasRef.current.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const normX = (clientX - rect.left) / rect.width;
      const normY = (clientY - rect.top) / rect.height;
      return {
        x: Math.max(0, Math.min(meta.fullWidth, normX * meta.fullWidth)),
        y: Math.max(0, Math.min(meta.fullHeight, normY * meta.fullHeight)),
      };
    },
    [meta]
  );

  const sweepDeselectAtPoint = useCallback(
    (fullPt: { x: number; y: number }) => {
      if (!meta || !onBatchDeselectSpots) return;
      const radiusInSensorPx = brushRadius / meta.workScale;
      const toDeselect: string[] = [];
      for (const spot of spots) {
        if (!spot.enabled) continue;
        const dist = Math.hypot(spot.cx - fullPt.x, spot.cy - fullPt.y);
        if (dist <= spot.radius + radiusInSensorPx) {
          toDeselect.push(spot.id);
        }
      }
      if (toDeselect.length > 0) {
        onBatchDeselectSpots(toDeselect);
      }
    },
    [meta, brushRadius, spots, onBatchDeselectSpots]
  );

  // Render overlay markers
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || !meta) return;
    canvas.width = meta.workWidth;
    canvas.height = meta.workHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const scale = meta.workScale;

    if (showDustOverlay) {
      const allStrokes = [
        ...manualStrokes,
        ...(isDrawingStroke && currentPoints.length > 0 && interactionTool !== 'deselect-brush'
          ? [
               {
                 id: 'temp',
                 mode: interactionTool === 'brush-erase' ? ('erase' as const) : ('add' as const),
                 radius: brushRadius,
                 points: currentPoints,
               },
            ]
          : []),
      ];

      for (const st of allStrokes) {
        if (st.points.length === 0) continue;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(4, st.radius * scale * 2);
        ctx.strokeStyle =
          st.mode === 'add' ? 'rgba(255, 69, 58, 0.45)' : 'rgba(160, 160, 160, 0.40)';
        ctx.fillStyle =
          st.mode === 'add' ? 'rgba(255, 69, 58, 0.45)' : 'rgba(160, 160, 160, 0.40)';

        if (st.points.length === 1) {
          ctx.beginPath();
          ctx.arc(
            st.points[0].x * scale,
            st.points[0].y * scale,
            Math.max(2, st.radius * scale),
            0,
            Math.PI * 2
          );
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(st.points[0].x * scale, st.points[0].y * scale);
          for (let i = 1; i < st.points.length; i++) {
            ctx.lineTo(st.points[i].x * scale, st.points[i].y * scale);
          }
          ctx.stroke();
        }
        ctx.restore();
      }

      const visibleSpots = spots.filter((spot) => {
        if (filterMode === 'multi-confirmed') return spot.isMultiConfirmed;
        if (filterMode === 'single-frame') return !spot.isMultiConfirmed;
        return true;
      });

      for (const spot of visibleSpots) {
        const cx = spot.cx * scale;
        const cy = spot.cy * scale;
        const r = Math.max(5, spot.radius * scale + 2.5);
        const isSelected = spot.id === selectedSpotId;
        const isMulti = spot.tier === 'multi-confirmed' || Boolean(spot.isMultiConfirmed);
        const isProj = spot.tier === 'projected' || Boolean(spot.isProjected);

        let strokeColor = '#FF453A';
        let fillColor = 'rgba(255, 69, 58, 0.12)';
        if (isMulti) {
          strokeColor = '#0A84FF';
          fillColor = 'rgba(10, 132, 255, 0.16)';
        } else if (isProj) {
          strokeColor = '#BF5AF2';
          fillColor = 'rgba(191, 90, 242, 0.16)';
        }
        if (isSelected) {
          strokeColor = '#FFFFFF';
          fillColor = 'rgba(255, 255, 255, 0.22)';
        }

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);

        if (spot.enabled) {
          ctx.fillStyle = fillColor;
          ctx.fill();
          ctx.lineWidth = isSelected ? 2.2 : 1.5;
          ctx.strokeStyle = strokeColor;
          if (isProj) ctx.setLineDash([3, 3]);
          ctx.stroke();
        } else {
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 3]);
          ctx.strokeStyle = 'rgba(160, 160, 160, 0.38)';
          ctx.stroke();
        }

        if (showSpotLabels || isSelected) {
          ctx.setLineDash([]);
          ctx.font = '500 10px "IBM Plex Sans", "Pretendard", sans-serif';
          const label = `#${spot.index}`;
          const textX = cx + r + 3;
          const textY = cy + 3;
          const textW = ctx.measureText(label).width;
          ctx.fillStyle = 'rgba(43, 43, 46, 0.88)';
          ctx.fillRect(textX - 2, textY - 9, textW + 4, 12);
          ctx.fillStyle = spot.enabled ? '#E7E6E1' : '#888783';
          ctx.fillText(label, textX, textY);
        }

        ctx.restore();
      }
    }

    // Active brush cursor ring (Lightroom feather circle style)
    if (cursorImgPos) {
      const cursorX = cursorImgPos.x * scale;
      const cursorY = cursorImgPos.y * scale;
      const r = Math.max(4, brushRadius * scale);

      if (interactionTool === 'brush-add' || interactionTool === 'brush-erase') {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cursorX, cursorY, r, 0, Math.PI * 2);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#FFFFFF';
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cursorX, cursorY, r * 0.72, 0, Math.PI * 2);
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.stroke();
        ctx.restore();
      } else if (interactionTool === 'deselect-brush') {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cursorX, cursorY, r, 0, Math.PI * 2);
        ctx.lineWidth = 1.75;
        ctx.strokeStyle = '#FF453A';
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.fillStyle = isDrawingStroke
          ? 'rgba(255, 69, 58, 0.24)'
          : 'rgba(255, 69, 58, 0.10)';
        ctx.fill();
        ctx.restore();
      }
    }
  }, [
    meta,
    spots,
    selectedSpotId,
    showDustOverlay,
    manualStrokes,
    isDrawingStroke,
    currentPoints,
    interactionTool,
    brushRadius,
    cursorImgPos,
    filterMode,
    showSpotLabels,
  ]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!meta) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (e.button === 1 || e.shiftKey) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      return;
    }

    const pt = clientToFullCoords(e.clientX, e.clientY);
    if (!pt) return;
    setCursorImgPos(pt);

    if (interactionTool === 'deselect-brush') {
      onBeginHistoryBatch?.();
      setIsDrawingStroke(true);
      sweepDeselectAtPoint(pt);
    } else if (interactionTool === 'inspect') {
      let nearestSpot: DetectedDustSpot | null = null;
      let minDist = Infinity;

      for (const spot of spots) {
        const dist = Math.hypot(spot.cx - pt.x, spot.cy - pt.y);
        const hitRadius = Math.max(spot.radius + 16 / meta.workScale, 20 / meta.workScale);
        if (dist <= hitRadius && dist < minDist) {
          minDist = dist;
          nearestSpot = spot;
        }
      }

      if (nearestSpot) {
        onSelectSpot(nearestSpot.id);
        onToggleSpot(nearestSpot.id);
      } else {
        onSelectSpot(null);
      }
    } else if (interactionTool === 'brush-add' || interactionTool === 'brush-erase') {
      setIsDrawingStroke(true);
      setCurrentPoints([pt]);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!meta) return;

    if (isPanning) {
      setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
      return;
    }

    const pt = clientToFullCoords(e.clientX, e.clientY);
    setCursorImgPos(pt);

    if (interactionTool === 'deselect-brush' && isDrawingStroke && pt) {
      sweepDeselectAtPoint(pt);
    } else if (isDrawingStroke && pt) {
      setCurrentPoints((prev) => [...prev, pt]);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (isPanning) {
      setIsPanning(false);
    }
    if (interactionTool === 'deselect-brush') {
      setIsDrawingStroke(false);
      return;
    }
    if (isDrawingStroke && currentPoints.length > 0) {
      onAddManualStroke({
        id: `stroke_${Date.now()}`,
        mode: interactionTool === 'brush-erase' ? 'erase' : 'add',
        radius: brushRadius,
        points: currentPoints,
      });
      setCurrentPoints([]);
      setIsDrawingStroke(false);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onUploadFile(file);
  };

  const getPrimaryImageUrl = (): string | null => {
    if (!urls) return null;
    if (overlayMode === 'bw-edge') {
      return urls.vizBwEdge;
    }
    if (comparisonMode === 'original-only') {
      return urls.previewOriginal;
    }
    if (
      (comparisonMode === 'healed-only' || comparisonMode === 'working') &&
      hasInpaintedResult &&
      urls.previewInpainted
    ) {
      return urls.previewInpainted;
    }
    return urls.previewOriginal;
  };

  return (
    <div
      ref={containerRef}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      onPointerMove={(e) => {
        if (isDraggingSplit && overlayCanvasRef.current) {
          const rect = overlayCanvasRef.current.getBoundingClientRect();
          const pct = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100;
          setSplitPosition(Math.max(2, Math.min(98, pct)));
        }
      }}
      onPointerUp={() => setIsDraggingSplit(false)}
      className="relative flex-1 h-full bg-[#121212] flex items-center justify-center overflow-hidden select-none"
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".rw2,.dng,.cr2,.cr3,.nef,.arw,.orf,.pef,.raf,.tif,.tiff,.png,.jpg,.jpeg"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUploadFile(f);
          e.target.value = '';
        }}
        className="hidden"
      />

      {!meta || !urls ? (
        <div
          onClick={() => fileInputRef.current?.click()}
          className={`flex flex-col items-center justify-center px-10 py-12 rounded-lg border transition-colors cursor-pointer ${
            isDragOver
              ? 'border-[#556042] bg-[#3A3A3D]'
              : 'border-[#535356] bg-[#3A3A3D]/70 hover:border-[#888783] hover:bg-[#3A3A3D]'
          }`}
        >
          <Upload className="w-7 h-7 text-[#C2C1BB] mb-3" />
          <span className="text-sm font-semibold text-[#F7F6F2] mb-1">
            사진 열기
          </span>
          <span className="text-xs text-[#888783] mb-5 tabular-nums">
            RW2 · DNG · CR2 · NEF · ARW · TIFF · PNG · JPG
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              fileInputRef.current?.click();
            }}
            className="px-4 py-2 rounded bg-[#556042] hover:bg-[#687652] text-[#F7F6F2] text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shadow-xs"
          >
            파일 선택
          </button>
        </div>
      ) : (
        <>
          <div
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: 'center center',
            }}
            className="relative inline-block shadow-2xl bg-[#0A0A0A]"
          >
            {comparisonMode === 'split' && hasInpaintedResult && urls.previewInpainted ? (
              <div className="relative select-none">
                <img
                  src={urls.previewInpainted}
                  alt={meta.originalFileName}
                  referrerPolicy="no-referrer"
                  className="block max-h-[calc(100dvh-130px)] md:max-h-[calc(100dvh-110px)] max-w-[calc(100vw-16px)] md:max-w-[calc(100vw-350px)] w-auto h-auto object-contain pointer-events-none"
                />
                <div
                  style={{ clipPath: `inset(0 ${100 - splitPosition}% 0 0)` }}
                  className="absolute inset-0 pointer-events-none"
                >
                  <img
                    src={urls.previewOriginal}
                    alt={meta.originalFileName}
                    referrerPolicy="no-referrer"
                    className="block w-full h-full object-contain"
                  />
                </div>
                <div
                  style={{ left: `${splitPosition}%` }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setIsDraggingSplit(true);
                  }}
                  className="absolute top-0 bottom-0 w-[1.5px] bg-white/90 cursor-ew-resize z-30"
                >
                  <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 rounded-full bg-[#1E1E1E] border border-white/80 flex items-center justify-center text-[9px] text-white shadow">
                    ↔
                  </div>
                </div>
              </div>
            ) : (
              <img
                src={getPrimaryImageUrl() || urls.previewOriginal}
                alt={meta.originalFileName}
                referrerPolicy="no-referrer"
                className="block max-h-[calc(100dvh-130px)] md:max-h-[calc(100dvh-110px)] max-w-[calc(100vw-16px)] md:max-w-[calc(100vw-350px)] w-auto h-auto object-contain pointer-events-none"
              />
            )}

            <canvas
              ref={overlayCanvasRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={() => {
                setCursorImgPos(null);
              }}
              className={`absolute inset-0 w-full h-full touch-none ${
                interactionTool === 'inspect' ? 'cursor-pointer' : 'cursor-crosshair'
              }`}
            />
          </div>

          {/* Unified Darkroom HUD Dock */}
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#3A3A3D]/95 backdrop-blur-md border border-[#535356] shadow-xl max-w-[96vw] overflow-x-auto text-[#E7E6E1]">
            {/* Tool Selection Segment */}
            <div className="flex items-center p-0.5 bg-[#2B2B2E] border border-[#535356] rounded shrink-0">
              <button
                type="button"
                onClick={() => onChangeInteractionTool('inspect')}
                title="스팟 선택 및 토글 (V)"
                className={`p-1.5 rounded-xs transition-colors cursor-pointer ${
                  interactionTool === 'inspect'
                    ? 'bg-[#556042] text-[#F7F6F2]'
                    : 'text-[#888783] hover:text-[#C2C1BB]'
                }`}
              >
                <MousePointer className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onChangeInteractionTool('deselect-brush')}
                title="스팟 해제 브러시 (D)"
                className={`p-1.5 rounded-xs transition-colors cursor-pointer ${
                  interactionTool === 'deselect-brush'
                    ? 'bg-[#556042] text-[#F7F6F2]'
                    : 'text-[#888783] hover:text-[#C2C1BB]'
                }`}
              >
                <Eraser className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onChangeInteractionTool('brush-add')}
                title="수동 복원 브러시 (B)"
                className={`p-1.5 rounded-xs transition-colors cursor-pointer ${
                  interactionTool === 'brush-add'
                    ? 'bg-[#556042] text-[#F7F6F2]'
                    : 'text-[#888783] hover:text-[#C2C1BB]'
                }`}
              >
                <Paintbrush className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onChangeInteractionTool('brush-erase')}
                title="마스크 지우개 (E)"
                className={`p-1.5 rounded-xs transition-colors cursor-pointer ${
                  interactionTool === 'brush-erase'
                    ? 'bg-[#556042] text-[#F7F6F2]'
                    : 'text-[#888783] hover:text-[#C2C1BB]'
                }`}
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Brush Radius Controls (Visible when a brush tool is active) */}
            {interactionTool !== 'inspect' && (
              <div className="flex items-center gap-1.5 px-2 py-0.5 bg-[#2B2B2E] border border-[#535356] rounded shrink-0">
                <button
                  type="button"
                  onClick={() => onChangeBrushRadius(Math.max(4, brushRadius - 4))}
                  title="반경 축소 ([)"
                  className="p-0.5 text-[#888783] hover:text-[#E7E6E1] cursor-pointer"
                >
                  <Minus className="w-3 h-3" />
                </button>
                <input
                  type="range"
                  min={4}
                  max={120}
                  value={brushRadius}
                  onChange={(e) => onChangeBrushRadius(Number(e.target.value))}
                  className="lr-slider w-14"
                  title="브러시 반경 조절"
                />
                <button
                  type="button"
                  onClick={() => onChangeBrushRadius(Math.min(120, brushRadius + 4))}
                  title="반경 확대 (])"
                  className="p-0.5 text-[#888783] hover:text-[#E7E6E1] cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                </button>
                <span className="text-[10px] font-medium text-[#E7E6E1] tabular-nums w-7 text-right">
                  {brushRadius}px
                </span>
              </div>
            )}

            {/* History Undo / Redo */}
            <div className="flex items-center gap-0.5 shrink-0">
              <button
                type="button"
                onClick={onUndo}
                disabled={!canUndo}
                title="되돌리기 (Ctrl+Z)"
                className="p-1.5 rounded text-[#C2C1BB] hover:text-[#F7F6F2] hover:bg-[#2B2B2E] disabled:opacity-30 transition-colors cursor-pointer"
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={onRedo}
                disabled={!canRedo}
                title="다시 실행 (Ctrl+Y)"
                className="p-1.5 rounded text-[#C2C1BB] hover:text-[#F7F6F2] hover:bg-[#2B2B2E] disabled:opacity-30 transition-colors cursor-pointer"
              >
                <Redo2 className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="w-[1px] h-4 bg-[#535356] mx-0.5 shrink-0" />

            {/* Dust Overlay Eye Toggle */}
            <button
              type="button"
              onClick={() => onToggleDustOverlay(!showDustOverlay)}
              title="오버레이 표시 (O)"
              className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                showDustOverlay
                  ? 'bg-[#556042] text-[#F7F6F2]'
                  : 'text-[#C2C1BB] hover:text-[#F7F6F2]'
              }`}
            >
              {showDustOverlay ? (
                <Eye className="w-3.5 h-3.5" />
              ) : (
                <EyeOff className="w-3.5 h-3.5" />
              )}
              <span className="hidden sm:inline">오버레이</span>
            </button>

            <button
              type="button"
              onClick={() => setShowSpotLabels(!showSpotLabels)}
              title="스팟 번호 라벨 토글"
              className={`px-2 py-1 rounded text-[11px] transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                showSpotLabels
                  ? 'bg-[#556042] text-[#F7F6F2]'
                  : 'text-[#888783] hover:text-[#F7F6F2]'
              }`}
            >
              #번호
            </button>

            <div className="w-[1px] h-4 bg-[#535356] mx-0.5 shrink-0" />

            {/* View Mode Selector */}
            <button
              type="button"
              onClick={() => {
                onChangeOverlayMode('red-circle');
                onChangeComparisonMode('working');
              }}
              className={`px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                overlayMode === 'red-circle' && comparisonMode !== 'original-only' && comparisonMode !== 'split'
                  ? 'bg-[#556042] text-[#F7F6F2]'
                  : 'text-[#888783] hover:text-[#F7F6F2]'
              }`}
            >
              {hasInpaintedResult ? '복원본' : '작업본'}
            </button>

            {hasInpaintedResult && (
              <button
                type="button"
                onClick={() => {
                  onChangeOverlayMode('red-circle');
                  onChangeComparisonMode('split');
                }}
                className={`px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  comparisonMode === 'split'
                    ? 'bg-[#556042] text-[#F7F6F2]'
                    : 'text-[#888783] hover:text-[#F7F6F2]'
                }`}
              >
                분할
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                onChangeOverlayMode('red-circle');
                onChangeComparisonMode('original-only');
              }}
              className={`px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                comparisonMode === 'original-only' && overlayMode !== 'bw-edge'
                  ? 'bg-[#556042] text-[#F7F6F2]'
                  : 'text-[#888783] hover:text-[#F7F6F2]'
              }`}
            >
              원본
            </button>

            <button
              type="button"
              onClick={() =>
                onChangeOverlayMode(overlayMode === 'bw-edge' ? 'red-circle' : 'bw-edge')
              }
              className={`px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                overlayMode === 'bw-edge'
                  ? 'bg-[#556042] text-[#F7F6F2]'
                  : 'text-[#888783] hover:text-[#F7F6F2]'
              }`}
            >
              엣지
            </button>

            {/* Sequence Tier Filter */}
            {isSequenceMode && onChangeFilterMode && (
              <>
                <div className="w-[1px] h-4 bg-[#535356] mx-0.5 shrink-0" />
                <button
                  type="button"
                  onClick={() => onChangeFilterMode('all')}
                  className={`px-1.5 py-0.5 rounded text-[10px] transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    filterMode === 'all' ? 'bg-[#556042] text-[#F7F6F2]' : 'text-[#888783]'
                  }`}
                >
                  전체
                </button>
                <button
                  type="button"
                  onClick={() => onChangeFilterMode('multi-confirmed')}
                  className={`px-1.5 py-0.5 rounded text-[10px] transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    filterMode === 'multi-confirmed'
                      ? 'bg-[#556042]/50 text-[#F7F6F2]'
                      : 'text-[#888783]'
                  }`}
                >
                  연속확정
                </button>
              </>
            )}

            <div className="w-[1px] h-4 bg-[#535356] mx-0.5 shrink-0" />

            {/* Zoom Controls */}
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
              className="p-1 text-[#C2C1BB] hover:text-[#F7F6F2] cursor-pointer shrink-0"
              title="축소"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="text-[11px] text-[#C2C1BB] tabular-nums w-10 text-center shrink-0">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(4.0, Number((z + 0.25).toFixed(2))))}
              className="p-1 text-[#C2C1BB] hover:text-[#F7F6F2] cursor-pointer shrink-0"
              title="확대"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
              className="p-1 text-[#C2C1BB] hover:text-[#F7F6F2] cursor-pointer shrink-0"
              title="화면 맞춤"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </>
      )}

      {/* Processing Modal Card with Progress Bar and Percentage */}
      {isProcessing && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px] flex items-center justify-center z-40 px-4">
          <div className="px-6 py-4.5 rounded-xl bg-[#3A3A3D] border border-[#535356] flex flex-col gap-3 shadow-2xl w-full max-w-sm">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 truncate">
                <div className="w-4 h-4 rounded-full border-2 border-[#556042] border-t-transparent animate-spin shrink-0" />
                <span className="text-xs font-semibold text-[#E7E6E1] leading-snug truncate">
                  {processingLabel || '처리 중...'}
                </span>
              </div>
              <span className="text-xs font-bold text-[#E7E6E1] shrink-0 tabular-nums">
                {Math.min(100, Math.max(0, Math.round(progressPercent)))}%
              </span>
            </div>

            {/* Progress Bar Track */}
            <div className="w-full bg-[#2B2B2E] h-2 rounded-full overflow-hidden border border-[#535356] p-0.5">
              <div
                style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
                className="bg-[#556042] h-full rounded-full transition-all duration-200 ease-out"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
