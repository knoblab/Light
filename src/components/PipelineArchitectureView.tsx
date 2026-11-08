import React from 'react';
import { CheckCircle2, Cpu, Layers, Sliders, FileOutput } from 'lucide-react';

interface PipelineArchitectureViewProps {
  engineVersions: {
    opencv?: string;
    numpy?: string;
    rawpy?: string;
    tifffile?: string;
  } | null;
}

export const PipelineArchitectureView: React.FC<PipelineArchitectureViewProps> = ({
  engineVersions,
}) => {
  return (
    <div className="flex-1 overflow-y-auto p-6 bg-[#0B0C0E]">
      <div className="max-w-5xl mx-auto space-y-8">
        <div className="pb-5 border-b border-[#22262E]">
          <h2 className="text-2xl font-semibold text-white">
            16-bit 선형 RAW 처리 흐름
          </h2>
          <p className="text-sm text-neutral-400 mt-1.5 leading-relaxed">
            순수 Rust 엔진으로 원본 16-bit CFA Bayer RAW 센서 데이터를 디코딩하여 먼지 영역 픽셀만 정밀 치환하고, 원본 CFA 모자이크를 그대로 보존하는 16-bit DNG 및 TIFF/PNG 등으로 출력합니다.
          </p>
        </div>

        {/* Active Backend Python Runtime Verification */}
        <div className="p-5 rounded-xl bg-[#131519] border border-[#22262E] flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            <div>
              <div className="text-sm font-semibold text-white">
                백엔드 Python 16-bit 비전 엔진 활성 상태
              </div>
              <div className="text-xs text-neutral-400 mt-0.5">
                업로드 파일은 브라우저가 아닌 서버의 Python 엔진(NumPy `uint16` / `float32` 배열)에서 처리됩니다.
              </div>
            </div>
          </div>

          {engineVersions && (
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-neutral-300">
              <span>rawpy {engineVersions.rawpy}</span>
              <span aria-hidden="true">·</span>
              <span>OpenCV {engineVersions.opencv}</span>
              <span aria-hidden="true">·</span>
              <span>tifffile {engineVersions.tifffile}</span>
              <span aria-hidden="true">·</span>
              <span>NumPy {engineVersions.numpy}</span>
            </div>
          )}
        </div>

        {/* 4-Stage Pipeline Flow */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="p-5 rounded-xl bg-[#131519] border border-[#22262E] space-y-3">
            <div className="flex items-center gap-2.5 text-amber-400 font-semibold text-sm">
              <Cpu className="w-4 h-4" />
              <span>01. rawpy 16-bit 선형(Linear) 디모자이킹</span>
            </div>
            <p className="text-xs text-neutral-300 leading-relaxed">
              파나소닉 <code className="text-amber-300">.RW2</code> 등 RAW 파일 입력 시 자동 밝기 보정과 감마 커브를 비활성화하고 카메라 화이트밸런스만 반영된 순수 16-bit 선형 RGB 배열(`0 ~ 65535`)을 추출합니다.
            </p>
            <pre className="p-3 rounded-lg bg-[#0B0C0E] border border-[#22262E] text-[11px] font-mono text-neutral-300 overflow-x-auto">
{`with rawpy.imread(rw2_path) as raw:
    linear_rgb_16 = raw.postprocess(
        gamma=(1, 1),          # 선형 감마 1.0 유지
        no_auto_bright=True,   # 히스토그램 스트레칭 방지
        output_bps=16,         # 16-bit (uint16, 0~65535)
        use_camera_wb=True     # 촬영 당시 화이트밸런스 유지
    )`}
            </pre>
          </div>

          <div className="p-5 rounded-xl bg-[#131519] border border-[#22262E] space-y-3">
            <div className="flex items-center gap-2.5 text-amber-400 font-semibold text-sm">
              <Sliders className="w-4 h-4" />
              <span>02. DoG / Black-Hat 및 윤곽선 원형도 필터링</span>
            </div>
            <p className="text-xs text-neutral-300 leading-relaxed">
              16-bit 휘도 채널에서 렌즈 비네팅과 완만한 배경 그라데이션을 제거하고, 주변보다 어두운 반투명 원형 먼지 얼룩만 분리한 뒤 면적(반경 `5~40px`)과 원형도(`Circularity &gt; 0.6`)로 검증합니다.
            </p>
            <pre className="p-3 rounded-lg bg-[#0B0C0E] border border-[#22262E] text-[11px] font-mono text-neutral-300 overflow-x-auto">
{`# Black-Hat & DoG 대역 통과 필터
blackhat = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, kernel)
dog = np.maximum(cv2.GaussianBlur(gray, (0,0), σ2) -
                 cv2.GaussianBlur(gray, (0,0), σ1), 0)

# 원형도(Circularity) 및 반경 조건 필터링
eq_radius = math.sqrt(area / math.pi)  # 5px <= r <= 40px
circularity = (4 * math.pi * area) / (perimeter ** 2)  # > 0.6`}
            </pre>
          </div>

          <div className="p-5 rounded-xl bg-[#131519] border border-[#22262E] space-y-3">
            <div className="flex items-center gap-2.5 text-amber-400 font-semibold text-sm">
              <Layers className="w-4 h-4" />
              <span>03. OpenCV / NumPy 기반 16-bit Telea 인페인팅</span>
            </div>
            <p className="text-xs text-neutral-300 leading-relaxed">
              8-bit 변환으로 인한 계조 손실(Banding)을 방지하기 위해 16-bit 선형 RGB 각 채널을 32-bit 부동소수점(`float32`)으로 변환한 뒤 Fast Marching 기반 `cv2.INPAINT_TELEA`를 수행하고 `uint16`으로 복원합니다.
            </p>
            <pre className="p-3 rounded-lg bg-[#0B0C0E] border border-[#22262E] text-[11px] font-mono text-neutral-300 overflow-x-auto">
{`inpainted_16 = np.empty_like(linear_rgb_16, dtype=np.uint16)
for ch in range(3):
    ch_f32 = linear_rgb_16[:, :, ch].astype(np.float32)
    healed = cv2.inpaint(ch_f32, mask_u8, radius, cv2.INPAINT_TELEA)
    inpainted_16[:, :, ch] = np.clip(healed, 0, 65535).astype(np.uint16)`}
            </pre>
          </div>

          <div className="p-5 rounded-xl bg-[#131519] border border-[#22262E] space-y-3">
            <div className="flex items-center gap-2.5 text-amber-400 font-semibold text-sm">
              <FileOutput className="w-4 h-4" />
              <span>04. 선형 RGB DNG (LinearRaw, DNG 1.4) 패킹</span>
            </div>
            <p className="text-xs text-neutral-300 leading-relaxed">
              복원된 16-bit 선형 배열에 DNG 1.4 헤더 태그(`DNGVersion`, `UniqueCameraModel`, `BlackLevel`, `WhiteLevel`)와 카메라 메타데이터를 기록해 `.dng` 파일을 생성합니다.
            </p>
            <pre className="p-3 rounded-lg bg-[#0B0C0E] border border-[#22262E] text-[11px] font-mono text-neutral-300 overflow-x-auto">
{`extra_tags = [
    (50706, 'B', 4, b'\\x01\\x04\\x00\\x00', True), # DNGVersion 1.4.0.0
    (50707, 'B', 4, b'\\x01\\x01\\x00\\x00', True), # DNGBackwardVersion
    (50714, 'I', 3, (0, 0, 0), True),            # BlackLevel
    (50717, 'I', 3, (65535, 65535, 65535), True) # WhiteLevel (16-bit)
]
tifffile.imwrite(out_dng, inpainted_16, extratags=extra_tags)`}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
