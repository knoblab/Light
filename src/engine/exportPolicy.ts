import type { SessionMetadata } from '../types/sensor';

/** DNG output is only offered when the session holds real RAW-derived 16-bit data. */
export function isDngExportAllowed(meta: SessionMetadata | null | undefined): boolean {
  if (!meta) return false;
  switch (meta.decodeKind) {
    case 'raw-linear16':
    case 'raw-developed':
      return true;
    case undefined:
      return meta.isRaw;
    default:
      return false;
  }
}

export const DNG_DISABLED_REASON =
  'RAW 센서 데이터가 아닌 이미지는 DNG로 내보낼 수 없습니다. TIFF 또는 PNG를 사용해 주세요.';

/** User-facing note about how the file was decoded, or null when nothing needs to be said. */
export function getDecodeNotice(meta: SessionMetadata | null | undefined): string | null {
  switch (meta?.decodeKind) {
    case 'embedded-preview':
      return '이 RAW의 센서 데이터를 읽지 못해 카메라 내장 미리보기(8-bit JPEG)로 열렸습니다. 검출·복원은 미리보기 화질 기준이며 DNG 내보내기는 사용할 수 없습니다. 전체 RAW 처리는 Python 엔진(npm run setup:python)이 필요합니다.';
    case 'raw-developed':
      return 'RAW를 LibRaw로 현상(디모자이크)한 선형 RGB 데이터로 작업 중입니다. 내보낸 DNG는 원본 RAW가 아니라 현상된 선형 RGB 이미지입니다.';
    default:
      return null;
  }
}
