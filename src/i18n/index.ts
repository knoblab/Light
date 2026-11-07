/**
 * Lightweight internationalization dictionary for SensorClean (Korean & English).
 */

export type Locale = 'ko' | 'en';

export const DICTIONARY = {
  ko: {
    appTitle: 'SensorClean',
    tagline: '전문가용 카메라 RAW 센서 먼지 탐지 및 복원 엔진',
    openFile: 'RAW · TIFF · 사진 열기',
    fileSupportSummary: 'Canon · Nikon · Sony · Fujifilm · Panasonic · Olympus · Pentax · 16-bit DNG/TIFF',
    selectFile: '파일 선택',
    batchQueue: '일괄 배치 대기열',
    addFolder: '폴더 / 사진 추가',
    batchRun: '일괄 실행',
    original: '원본',
    healed: '복원',
    split: '분할',
    edge: '엣지',
    holdToCompare: '누르면 원본',
    inpaint16Bit: '16-bit 복원',
    export: '내보내기',
    sensitivity: '민감도',
    cloudProtection: '구름/경계 보호',
    inpaintRadius: '복원 반경',
    grainPreservation: '자연 센서 그레인 보존',
    zoomIn: '확대',
    zoomOut: '축소',
    fitScreen: '화면 맞춤 (100%)',
    processing: '처리 중...',
    pureRustEngine: '100% Pure Rust WebAssembly / Tauri Engine',
  },
  en: {
    appTitle: 'SensorClean',
    tagline: 'Professional Camera RAW Sensor Dust Detection & Restoration Engine',
    openFile: 'Open RAW / TIFF / Image',
    fileSupportSummary: 'Canon · Nikon · Sony · Fujifilm · Panasonic · Olympus · Pentax · 16-bit DNG/TIFF',
    selectFile: 'Select File',
    batchQueue: 'Batch Queue',
    addFolder: 'Add Folder / Files',
    batchRun: 'Run Batch',
    original: 'Original',
    healed: 'Healed',
    split: 'Split',
    edge: 'Edge',
    holdToCompare: 'Hold for Original',
    inpaint16Bit: '16-bit Heal',
    export: 'Export',
    sensitivity: 'Sensitivity',
    cloudProtection: 'Cloud Protection',
    inpaintRadius: 'Inpaint Radius',
    grainPreservation: 'Preserve Sensor Grain',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    fitScreen: 'Fit Screen (100%)',
    processing: 'Processing...',
    pureRustEngine: '100% Pure Rust WebAssembly / Tauri Engine',
  },
} as const;

export type TranslationKey = keyof typeof DICTIONARY['ko'];

export function t(key: TranslationKey, locale: Locale = 'ko'): string {
  return DICTIONARY[locale]?.[key] || DICTIONARY['ko'][key] || key;
}
