import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Eye,
  EyeOff,
  Upload,
  Eraser,
  PlusCircle,
  Undo2,
  Redo2,
  Minus,
  Plus,
  Hand,
} from 'lucide-react';
import {
  DetectedDustSpot,
  DetailedProgressInfo,
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
  manualStrokes: ManualBrushStroke[];
  onPenAddCommit: (payload: {
    newSpot?: DetectedDustSpot;
    reenableSpotId?: string;
    newStroke?: ManualBrushStroke;
  }) => void;
  onPenRemoveCommit: (payload: {
    disableSpotIds: string[];
    deleteManualSpotIds: string[];
    updatedStrokes: ManualBrushStroke[];
  }) => void;
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
  isIncrementalSyncing?: boolean;
  processingLabel: string;
  progressPercent?: number;
  progressInfo?: DetailedProgressInfo | null;
  onUploadFile: (file: File) => void;
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
  manualStrokes,
  onPenAddCommit,
  onPenRemoveCommit,
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
  isIncrementalSyncing = false,
  processingLabel,
  progressPercent = 0,
  progressInfo = null,
  onUploadFile,
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
  const [isSpacePressed, setIsSpacePressed] = useState<boolean>(false);
  const [panStart, setPanStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDrawingStroke, setIsDrawingStroke] = useState<boolean>(false);
  const [currentPoints, setCurrentPoints] = useState<Array<{ x: number; y: number }>>([]);
  const [cursorImgPos, setCursorImgPos] = useState<{ x: number; y: number } | null>(null);
  const [splitPosition, setSplitPosition] = useState<number>(50);
  const [isDraggingSplit, setIsDraggingSplit] = useState<boolean>(false);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const [showSpotLabels, setShowSpotLabels] = useState<boolean>(false);

  const clampPanOffset = useCallback(
    (nextX: number, nextY: number, targetZoom: number) => {
      if (targetZoom <= 1) {
        return { x: 0, y: 0 };
      }
      const container = containerRef.current;
      const maxX = container ? Math.max(240, container.clientWidth * (targetZoom - 0.35)) : 1200;
      const maxY = container ? Math.max(240, container.clientHeight * (targetZoom - 0.35)) : 1200;
      return {
        x: Math.max(-maxX, Math.min(maxX, nextX)),
        y: Math.max(-maxY, Math.min(maxY, nextY)),
      };
    },
    []
  );

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [meta?.originalFileName]);

  // Keyboard shortcuts for 2-pen + Hand pan workflow, Spacebar panning, and Arrow key movement
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.code === 'Space') {
        e.preventDefault();
        setIsSpacePressed(true);
        return;
      }

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

      // When zoomed in, allow Up/Down/Left/Right arrow keys to move the image smoothly
      if (zoom > 1 && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const step = e.shiftKey ? 120 : 48;
        setPan((prev) => {
          const dx = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0;
          const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
          return clampPanOffset(prev.x + dx, prev.y + dy, zoom);
        });
        return;
      }

      if (e.key === '[') {
        onChangeBrushRadius(Math.max(4, brushRadius - 4));
      } else if (e.key === ']') {
        onChangeBrushRadius(Math.min(120, brushRadius + 4));
      } else if (k === 'o') {
        onToggleDustOverlay(!showDustOverlay);
      } else if (k === 'b' || k === '1' || k === 'a') {
        onChangeInteractionTool('pen-add');
      } else if (k === 'e' || k === '2' || k === 'd') {
        onChangeInteractionTool('pen-remove');
      } else if (k === 'h' || k === '3') {
        onChangeInteractionTool('pan');
      } else if (k === '\\') {
        onChangeComparisonMode(
          comparisonMode === 'original-only' ? 'healed-only' : 'original-only'
        );
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setIsSpacePressed(false);
        setIsPanning(false);
      }
    };

    const handleWindowBlur = () => {
      setIsSpacePressed(false);
      setIsPanning(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [
    brushRadius,
    showDustOverlay,
    comparisonMode,
    zoom,
    clampPanOffset,
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

  // Distance from point P to segment AB
  const distPointToSegment = (
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number
  ): number => {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-6) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  const isPointHitByPath = useCallback(
    (
      px: number,
      py: number,
      targetRadius: number,
      pathPts: Array<{ x: number; y: number }>,
      penRadius: number
    ): boolean => {
      const hitThreshold = targetRadius + penRadius;
      if (pathPts.length === 1) {
        return Math.hypot(px - pathPts[0].x, py - pathPts[0].y) <= hitThreshold;
      }
      for (let i = 0; i < pathPts.length - 1; i++) {
        const d = distPointToSegment(
          px,
          py,
          pathPts[i].x,
          pathPts[i].y,
          pathPts[i + 1].x,
          pathPts[i + 1].y
        );
        if (d <= hitThreshold) return true;
      }
      return false;
    },
    []
  );

  // Render overlay markers and active pen cursor
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || !meta) return;
    canvas.width = meta.workWidth;
    canvas.height = meta.workHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const scale = meta.workScale;

    // Preview which spots are currently being swept by pen-remove
    const activelyRemovedSpotIds = new Set<string>();
    if (isDrawingStroke && interactionTool === 'pen-remove' && currentPoints.length > 0) {
      for (const spot of spots) {
        if (!spot.enabled && !spot.isManual) continue;
        if (isPointHitByPath(spot.cx, spot.cy, spot.radius, currentPoints, brushRadius)) {
          activelyRemovedSpotIds.add(spot.id);
        }
      }
    }

    if (showDustOverlay || isDrawingStroke) {
      const allStrokes = [
        ...manualStrokes,
        ...(isDrawingStroke && currentPoints.length > 0
          ? [
              {
                id: 'temp_active_stroke',
                mode: interactionTool === 'pen-remove' ? ('erase' as const) : ('add' as const),
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
        const isErasePreview = st.mode === 'erase';
        ctx.strokeStyle = isErasePreview
          ? 'rgba(56, 189, 248, 0.42)'
          : 'rgba(255, 69, 58, 0.45)';
        ctx.fillStyle = isErasePreview
          ? 'rgba(56, 189, 248, 0.42)'
          : 'rgba(255, 69, 58, 0.45)';

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
    }

    if (showDustOverlay) {
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
        const isBeingRemoved = activelyRemovedSpotIds.has(spot.id);
        const isMulti = spot.tier === 'multi-confirmed' || Boolean(spot.isMultiConfirmed);
        const isProj = spot.tier === 'projected' || Boolean(spot.isProjected);
        const isManual = Boolean(spot.isManual);

        let strokeColor = isManual ? '#FF9F0A' : '#FF453A';
        let fillColor = isManual ? 'rgba(255, 159, 10, 0.16)' : 'rgba(255, 69, 58, 0.12)';
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

        if (spot.enabled && !isBeingRemoved) {
          ctx.fillStyle = fillColor;
          ctx.fill();
          ctx.lineWidth = isSelected ? 2.2 : 1.5;
          ctx.strokeStyle = strokeColor;
          if (isProj) ctx.setLineDash([3, 3]);
          ctx.stroke();
        } else {
          ctx.lineWidth = 1.2;
          ctx.setLineDash([2, 3]);
          ctx.strokeStyle = isBeingRemoved
            ? 'rgba(56, 189, 248, 0.85)'
            : 'rgba(160, 160, 160, 0.38)';
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

    // Active pen cursor ring (hidden when using Hand Pan tool or holding Spacebar)
    if (cursorImgPos && interactionTool !== 'pan' && !isSpacePressed && !isPanning) {
      const cursorX = cursorImgPos.x * scale;
      const cursorY = cursorImgPos.y * scale;
      const r = Math.max(4, brushRadius * scale);

      ctx.save();
      ctx.beginPath();
      ctx.arc(cursorX, cursorY, r, 0, Math.PI * 2);
      ctx.lineWidth = 1.6;
      if (interactionTool === 'pen-add') {
        ctx.strokeStyle = '#FF453A';
        ctx.fillStyle = isDrawingStroke ? 'rgba(255, 69, 58, 0.22)' : 'rgba(255, 69, 58, 0.08)';
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cursorX, cursorY, r * 0.72, 0, Math.PI * 2);
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
        ctx.stroke();
      } else {
        // pen-remove
        ctx.strokeStyle = '#38BDF8';
        ctx.setLineDash([4, 3]);
        ctx.fillStyle = isDrawingStroke
          ? 'rgba(56, 189, 248, 0.24)'
          : 'rgba(56, 189, 248, 0.10)';
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    // Pixel grid overlay at >= 400% zoom (Phase 5.4)
    if (zoom >= 4.0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 0.5;
      const step = 8;
      ctx.beginPath();
      for (let x = 0; x <= canvas.width; x += step) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
      }
      for (let y = 0; y <= canvas.height; y += step) {
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
      }
      ctx.stroke();
      ctx.restore();
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
    isSpacePressed,
    isPanning,
    isPointHitByPath,
    zoom,
  ]);

  // Wheel handler: vertical/horizontal movement when zoomed in, or Ctrl+Wheel for zoom (up to 800%)
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!meta || isProcessing) return;
    e.preventDefault();

    if (e.ctrlKey || e.metaKey) {
      const zoomDelta = e.deltaY < 0 ? 0.25 : -0.25;
      setZoom((prevZoom) => {
        const nextZoom = Math.max(0.5, Math.min(8.0, Number((prevZoom + zoomDelta).toFixed(2))));
        setPan((prevPan) => clampPanOffset(prevPan.x, prevPan.y, nextZoom));
        return nextZoom;
      });
      return;
    }

    // When zoomed in, scrolling the wheel moves the photo up/down (or left/right with Shift / trackpad)
    if (zoom > 1) {
      const deltaX = e.shiftKey && Math.abs(e.deltaX) < 1 ? e.deltaY : e.deltaX;
      const deltaY = e.shiftKey && Math.abs(e.deltaX) < 1 ? 0 : e.deltaY;
      setPan((prev) => clampPanOffset(prev.x - deltaX, prev.y - deltaY, zoom));
    } else if (Math.abs(e.deltaY) > 15) {
      // If at 100% zoom and scrolling up, allow zooming in smoothly
      if (e.deltaY < 0) {
        setZoom((z) => Math.min(8.0, Number((z + 0.25).toFixed(2))));
      }
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!meta || isProcessing) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (
      interactionTool === 'pan' ||
      isSpacePressed ||
      e.button === 1 ||
      e.shiftKey
    ) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      return;
    }

    const pt = clientToFullCoords(e.clientX, e.clientY);
    if (!pt) return;
    setCursorImgPos(pt);
    setIsDrawingStroke(true);
    setCurrentPoints([pt]);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!meta) return;

    if (isPanning) {
      const nextX = e.clientX - panStart.x;
      const nextY = e.clientY - panStart.y;
      setPan(clampPanOffset(nextX, nextY, Math.max(1.15, zoom)));
      return;
    }

    const pt = clientToFullCoords(e.clientX, e.clientY);
    setCursorImgPos(pt);

    if (isDrawingStroke && pt) {
      setCurrentPoints((prev) => {
        if (prev.length === 0) return [pt];
        const last = prev[prev.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) < 1.5) return prev;
        return [...prev, pt];
      });
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
      return;
    }
    if (!isDrawingStroke || currentPoints.length === 0 || !meta) {
      setIsDrawingStroke(false);
      setCurrentPoints([]);
      return;
    }

    const pts = currentPoints;
    setIsDrawingStroke(false);
    setCurrentPoints([]);

    // Measure total drag distance in screen/work pixels
    let totalDragWorkPx = 0;
    for (let i = 1; i < pts.length; i++) {
      totalDragWorkPx +=
        Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) * meta.workScale;
    }
    const isSingleClick = totalDragWorkPx < 6.0;

    if (interactionTool === 'pen-add') {
      if (isSingleClick) {
        const pt = pts[0];
        // Check if clicking on a disabled auto-detected spot to re-enable it
        let disabledHit: DetectedDustSpot | null = null;
        let minDist = Infinity;
        for (const s of spots) {
          if (s.enabled) continue;
          const d = Math.hypot(s.cx - pt.x, s.cy - pt.y);
          if (d <= s.radius + brushRadius && d < minDist) {
            minDist = d;
            disabledHit = s;
          }
        }
        if (disabledHit) {
          onSelectSpot(disabledHit.id);
          onPenAddCommit({ reenableSpotId: disabledHit.id });
          return;
        }

        // Otherwise create a single circular manual spot at click position
        const nextIndex =
          spots.reduce((maxIdx, s) => Math.max(maxIdx, s.index || 0), 0) + 1;
        const rFull = Math.max(2, Math.round(brushRadius * 10) / 10);
        const workR = Math.max(3, Math.round((rFull * meta.workScale * 1.55 + 2.0) * 10) / 10);
        const newSpot: DetectedDustSpot = {
          id: `manual_spot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          index: nextIndex,
          cx: Math.round(pt.x * 10) / 10,
          cy: Math.round(pt.y * 10) / 10,
          workCx: Math.round(pt.x * meta.workScale * 10) / 10,
          workCy: Math.round(pt.y * meta.workScale * 10) / 10,
          radius: rFull,
          workRadius: workR,
          area: Math.round(Math.PI * rFull * rFull * 10) / 10,
          perimeter: Math.round(2 * Math.PI * rFull * 10) / 10,
          circularity: 1.0,
          contrastDropPct: 0,
          spotType: rFull > 10 ? 'bokeh' : 'sharp',
          enabled: true,
          isManual: true,
        };
        onSelectSpot(newSpot.id);
        onPenAddCommit({ newSpot });
      } else {
        // Continuous drag brush stroke
        const newStroke: ManualBrushStroke = {
          id: `stroke_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          mode: 'add',
          radius: brushRadius,
          points: pts,
        };
        onPenAddCommit({ newStroke });
      }
    } else {
      // interactionTool === 'pen-remove' (Click or Drag both supported!)
      const disableSpotIds: string[] = [];
      const deleteManualSpotIds: string[] = [];

      for (const s of spots) {
        if (isPointHitByPath(s.cx, s.cy, s.radius, pts, brushRadius)) {
          if (s.isManual) {
            deleteManualSpotIds.push(s.id);
          } else if (s.enabled) {
            disableSpotIds.push(s.id);
          }
        }
      }

      // Also check manual add strokes: remove or split any stroke points hit by the remove pen
      let strokesChanged = false;
      const updatedStrokes: ManualBrushStroke[] = [];
      for (const st of manualStrokes) {
        if (st.mode !== 'add' || st.points.length === 0) {
          updatedStrokes.push(st);
          continue;
        }
        const survivingSegments: Array<Array<{ x: number; y: number }>> = [];
        let currentSeg: Array<{ x: number; y: number }> = [];

        for (const p of st.points) {
          const hit = isPointHitByPath(p.x, p.y, st.radius, pts, brushRadius);
          if (hit) {
            strokesChanged = true;
            if (currentSeg.length > 0) {
              survivingSegments.push(currentSeg);
              currentSeg = [];
            }
          } else {
            currentSeg.push(p);
          }
        }
        if (currentSeg.length > 0) {
          survivingSegments.push(currentSeg);
        }

        if (survivingSegments.length === 1 && survivingSegments[0].length === st.points.length) {
          updatedStrokes.push(st);
        } else {
          strokesChanged = true;
          survivingSegments.forEach((seg, segIdx) => {
            if (seg.length > 0) {
              updatedStrokes.push({
                ...st,
                id: `${st.id}_seg${segIdx}_${Date.now()}`,
                points: seg,
              });
            }
          });
        }
      }

      if (
        disableSpotIds.length > 0 ||
        deleteManualSpotIds.length > 0 ||
        strokesChanged
      ) {
        onPenRemoveCommit({
          disableSpotIds,
          deleteManualSpotIds,
          updatedStrokes: strokesChanged ? updatedStrokes : manualStrokes,
        });
      }
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
    if (isSpacePressed || comparisonMode === 'original-only') {
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
      onWheel={handleWheel}
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
        accept=".rw2,.dng,.cr2,.cr3,.nef,.nrw,.raf,.arw,.orf,.pef,.srw,.3fr,.iiq,.rwl,.mos,.mrw,.fff,.tif,.tiff,.png,.jpg,.jpeg,image/*"
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
            RAW · TIFF · 사진 열기
          </span>
          <span className="text-xs text-[#888783] mb-5 tabular-nums text-center max-w-sm">
            Canon · Nikon · Sony · Fujifilm · Panasonic · Olympus · Pentax · 16-bit DNG/TIFF
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
            {comparisonMode === 'split' && hasInpaintedResult && urls.previewInpainted && !isSpacePressed ? (
              <div className="relative select-none">
                <img
                  src={urls.previewInpainted}
                  alt={meta.originalFileName}
                  referrerPolicy="no-referrer"
                  className="block max-h-[calc(100dvh-130px)] md:max-h-[calc(100dvh-110px)] max-w-[calc(100vw-16px)] md:max-w-[calc(100vw-380px)] w-auto h-auto object-contain pointer-events-none"
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
                className="block max-h-[calc(100dvh-130px)] md:max-h-[calc(100dvh-110px)] max-w-[calc(100vw-16px)] md:max-w-[calc(100vw-380px)] w-auto h-auto object-contain pointer-events-none"
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
                isPanning
                  ? 'cursor-grabbing'
                  : interactionTool === 'pan' || isSpacePressed
                  ? 'cursor-grab'
                  : 'cursor-crosshair'
              }`}
            />
          </div>

          {/* Subtle non-blocking indicator when real-time ROI checkpoint healing is syncing */}
          {isIncrementalSyncing && !isProcessing && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 px-3 py-1 rounded bg-[#2B2B2E]/90 border border-[#535356] text-[11px] text-[#E7E6E1] flex items-center gap-2 shadow-lg pointer-events-none">
              <div className="w-2.5 h-2.5 rounded-full border-2 border-[#556042] border-t-transparent animate-spin" />
              <span>임시 저장본 국소 영역 실시간 반영 중...</span>
            </div>
          )}

          {/* 1. LEFT VERTICAL TOOLBAR: Pens, Hand (Move) Tool, Pen Size, Undo/Redo */}
          <div className="hidden md:flex absolute left-3 top-1/2 -translate-y-1/2 z-20 flex-col items-center gap-1.5 p-1.5 rounded-lg bg-[#3A3A3D]/95 backdrop-blur-md border border-[#535356] shadow-xl text-[#E7E6E1]">
            {/* Tool Selector Stack */}
            <div className="flex flex-col items-center p-0.5 bg-[#2B2B2E] border border-[#535356] rounded gap-1 w-full">
              <button
                type="button"
                onClick={() => onChangeInteractionTool('pen-add')}
                title="스팟 추가 펜 (B) — 클릭: 단일 원형 스팟 찍기 / 드래그: 연속 브러시 칠하기"
                className={`w-14 py-2 rounded-xs flex flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  interactionTool === 'pen-add' && !isSpacePressed
                    ? 'bg-[#556042] text-[#F7F6F2]'
                    : 'text-[#888783] hover:text-[#C2C1BB]'
                }`}
              >
                <PlusCircle className="w-4 h-4" />
                <span>추가 펜</span>
              </button>

              <button
                type="button"
                onClick={() => onChangeInteractionTool('pen-remove')}
                title="스팟 제거 펜 (E) — 클릭 또는 드래그로 자동 인식 먼지 해제 및 수동 스팟 원복"
                className={`w-14 py-2 rounded-xs flex flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  interactionTool === 'pen-remove' && !isSpacePressed
                    ? 'bg-[#556042] text-[#F7F6F2]'
                    : 'text-[#888783] hover:text-[#C2C1BB]'
                }`}
              >
                <Eraser className="w-4 h-4" />
                <span>제거 펜</span>
              </button>

              <button
                type="button"
                onClick={() => onChangeInteractionTool('pan')}
                title="손바닥 이동 도구 (H 또는 Space+드래그) — 드래그하여 확대된 사진을 상하좌우로 이동"
                className={`w-14 py-2 rounded-xs flex flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  interactionTool === 'pan' || isSpacePressed
                    ? 'bg-[#556042] text-[#F7F6F2]'
                    : 'text-[#888783] hover:text-[#C2C1BB]'
                }`}
              >
                <Hand className="w-4 h-4" />
                <span>이동</span>
              </button>
            </div>

            <div className="w-full h-[1px] bg-[#535356]" />

            {/* Compact Vertical Pen Radius Control */}
            <div className="flex flex-col items-center gap-1 py-1 px-1 bg-[#2B2B2E] border border-[#535356] rounded w-full">
              <span className="text-[9px] text-[#888783] whitespace-nowrap">펜 크기</span>
              <button
                type="button"
                onClick={() => onChangeBrushRadius(Math.min(120, brushRadius + 4))}
                title="펜 크기 확대 (])"
                className="w-full py-1 rounded hover:bg-[#3A3A3D] text-[#C2C1BB] hover:text-[#F7F6F2] flex items-center justify-center cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
              <span className="text-[11px] font-semibold text-[#E7E6E1] tabular-nums">
                {brushRadius}px
              </span>
              <button
                type="button"
                onClick={() => onChangeBrushRadius(Math.max(4, brushRadius - 4))}
                title="펜 크기 축소 ([)"
                className="w-full py-1 rounded hover:bg-[#3A3A3D] text-[#C2C1BB] hover:text-[#F7F6F2] flex items-center justify-center cursor-pointer"
              >
                <Minus className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="w-full h-[1px] bg-[#535356]" />

            {/* Undo / Redo Row */}
            <div className="grid grid-cols-2 gap-1 w-full">
              <button
                type="button"
                onClick={onUndo}
                disabled={!canUndo}
                title="되돌리기 (Ctrl+Z)"
                className="py-1.5 rounded bg-[#2B2B2E] border border-[#535356] text-[#C2C1BB] hover:text-[#F7F6F2] hover:bg-[#535356] disabled:opacity-30 flex items-center justify-center transition-colors cursor-pointer"
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={onRedo}
                disabled={!canRedo}
                title="다시 실행 (Ctrl+Y)"
                className="py-1.5 rounded bg-[#2B2B2E] border border-[#535356] text-[#C2C1BB] hover:text-[#F7F6F2] hover:bg-[#535356] disabled:opacity-30 flex items-center justify-center transition-colors cursor-pointer"
              >
                <Redo2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* 2. BOTTOM VIEW & ZOOM BAR (Compact, Zero Horizontal Scroll) */}
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex flex-wrap items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#3A3A3D]/95 backdrop-blur-md border border-[#535356] shadow-xl max-w-[95vw] text-[#E7E6E1]">
            {/* Dust Overlay Eye Toggle */}
            <button
              type="button"
              onClick={() => onToggleDustOverlay(!showDustOverlay)}
              title="먼지 마커 오버레이 표시 (O)"
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
              <span>오버레이</span>
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
                overlayMode === 'red-circle' &&
                comparisonMode !== 'original-only' &&
                comparisonMode !== 'split'
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

            {hasInpaintedResult && (
              <button
                type="button"
                onPointerDown={() => setIsSpacePressed(true)}
                onPointerUp={() => setIsSpacePressed(false)}
                onPointerLeave={() => setIsSpacePressed(false)}
                className={`px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 select-none ${
                  isSpacePressed
                    ? 'bg-[#E5484D] text-[#F7F6F2]'
                    : 'text-[#888783] hover:text-[#F7F6F2]'
                }`}
                title="누르고 있는 동안 원본 사진 표시 (Space 키 동일)"
              >
                누르면 원본
              </button>
            )}

            <div className="w-[1px] h-4 bg-[#535356] mx-0.5 shrink-0" />

            {/* Zoom Controls (Up to 800%) */}
            <button
              type="button"
              onClick={() =>
                setZoom((z) => {
                  const next = Math.max(0.5, Number((z - 0.25).toFixed(2)));
                  setPan((p) => clampPanOffset(p.x, p.y, next));
                  return next;
                })
              }
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
              onClick={() =>
                setZoom((z) => {
                  const next = Math.min(8.0, Number((z + 0.25).toFixed(2)));
                  setPan((p) => clampPanOffset(p.x, p.y, next));
                  return next;
                })
              }
              className="p-1 text-[#C2C1BB] hover:text-[#F7F6F2] cursor-pointer shrink-0"
              title="확대 (최대 800%)"
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
              title="화면 맞춤 (100%)"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </>
      )}

      {/* Compact Minimal Progress Indicator */}
      {isProcessing && (
        <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px] flex items-center justify-center z-50 px-4 pointer-events-auto select-none">
          <div className="px-4 py-3 rounded-xl bg-[#2B2B2E]/95 backdrop-blur-md border border-[#535356] shadow-2xl flex flex-col gap-2 w-72 text-[#E7E6E1]">
            <div className="flex items-center justify-between gap-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-3.5 h-3.5 rounded-full border-2 border-[#556042] border-t-transparent animate-spin shrink-0" />
                <div className="truncate">
                  <span className="text-xs font-semibold text-[#F7F6F2] truncate block">
                    {processingLabel || '처리 중...'}
                  </span>
                  {progressInfo?.stepName && progressInfo.stepName !== processingLabel && (
                    <span className="text-[10px] text-[#888783] truncate block">
                      {progressInfo.stepName}
                    </span>
                  )}
                </div>
              </div>
              <span className="text-xs font-bold text-[#F7F6F2] tabular-nums shrink-0">
                {Math.min(100, Math.max(0, Math.round(progressPercent)))}%
              </span>
            </div>

            <div className="w-full bg-[#1E1E20] h-1.5 rounded-full overflow-hidden">
              <div
                style={{
                  width: `${Math.min(100, Math.max(0, Math.round(progressPercent)))}%`,
                }}
                className="bg-[#556042] h-full rounded-full transition-all duration-150 ease-out"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
