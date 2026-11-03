export type DetectionMethod = 'dual' | 'sharp' | 'bokeh' | 'multiscale' | 'hybrid' | 'blackhat' | 'dog';

export type OverlayMode = 'red-circle' | 'bw-edge';

export type InteractionTool = 'inspect' | 'deselect-brush' | 'brush-add' | 'brush-erase';

export type ViewComparisonMode = 'working' | 'split' | 'original-only' | 'healed-only';

export type StudioMode = 'single' | 'sequence';

export type SpotFilterMode = 'all' | 'multi-confirmed' | 'single-frame';

export interface DetectionParams {
  method: DetectionMethod;
  sensitivity: number;
  cloudProtection: number;
  minRadius: number;
  maxRadius: number;
  minCircularity: number;
  inpaintRadius: number;
  preserveGrain: boolean;
}

export interface DetectedDustSpot {
  id: string;
  index: number;
  cx: number;
  cy: number;
  workCx: number;
  workCy: number;
  radius: number;
  workRadius: number;
  area: number;
  perimeter: number;
  circularity: number;
  contrastDropPct: number;
  spotType?: 'sharp' | 'bokeh';
  confidence?: number;
  enabled: boolean;
  isManual?: boolean;
  tier?: 'multi-confirmed' | 'single-frame' | 'projected';
  isMultiConfirmed?: boolean;
  isProjected?: boolean;
  clusterId?: number;
  matchCount?: number;
  totalFrames?: number;
}

export interface ManualBrushStroke {
  id: string;
  mode: 'add' | 'erase';
  radius: number; // in full image pixels
  points: Array<{ x: number; y: number }>; // in full image coordinates
}

export interface ExifMetadata {
  make: string;
  model: string;
  iso: number | null;
  fNumber: number | null;
  exposureTime: string | null;
  focalLength: string | null;
  dateTime: string | null;
  software: string;
}

export interface SessionMetadata {
  originalFileName: string;
  extension: string;
  isRaw: boolean;
  fullWidth: number;
  fullHeight: number;
  workWidth: number;
  workHeight: number;
  workScale: number;
  exposureScale: number;
  bitDepth: string;
  colorSpace: string;
  cameraWb: number[];
  colorMatrix: number[][];
  blackLevel: number[];
  whiteLevel: number;
  bayerPattern: string;
  stats16Bit: {
    minCodeValue: number;
    maxCodeValue: number;
    meanCodeValue: number;
    estimatedDynamicRangeEv: number;
  };
  exif: ExifMetadata;
}

export interface DetectionResult {
  method: string;
  sensitivity: number;
  thresholdValue: number;
  minRadius: number;
  maxRadius: number;
  minCircularity: number;
  totalDetected: number;
  spots: DetectedDustSpot[];
}

export interface InpaintResult {
  healedSpotsCount: number;
  inpaintedPixels: number;
  inpaintedAreaPct: number;
  bitDepth: string;
  inpaintMethod: string;
  inpaintRadius: number;
  fullWidth: number;
  fullHeight: number;
}

export interface SessionUrls {
  previewOriginal: string;
  vizBwEdge: string;
  maskAuto: string;
  previewInpainted?: string;
  maskFinal?: string;
}

export interface MultiFrameItem {
  sessionId: string;
  meta: SessionMetadata;
  detection: DetectionResult;
  urls: SessionUrls;
  spots: DetectedDustSpot[];
  manualStrokes: ManualBrushStroke[];
  inpaintResult: InpaintResult | null;
}

export interface MultiFrameCluster {
  clusterId: number;
  matchCount: number;
  totalFrames: number;
  matchRatio: number;
  isMultiConfirmed: boolean;
  meanCx: number;
  meanCy: number;
  meanRadius: number;
  meanConfidence: number;
  framesPresent: number[];
}

export interface MultiFrameReport {
  totalFrames: number;
  totalClusters: number;
  multiConfirmedClusters: number;
  clusters: MultiFrameCluster[];
}
