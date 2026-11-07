import React, { useState } from 'react';
import { X, Cpu, Check, Copy, Shield, Box, Sparkles, Terminal } from 'lucide-react';
import { detectRuntimeTransport } from '../services/sensorEngine';
import { SessionMetadata } from '../types/sensor';

interface EngineInspectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  meta: SessionMetadata | null;
}

export const EngineInspectorModal: React.FC<EngineInspectorModalProps> = ({
  isOpen,
  onClose,
  meta,
}) => {
  const [copied, setCopied] = useState(false);
  const transport = detectRuntimeTransport();

  if (!isOpen) return null;

  const transportLabel =
    transport === 'tauri'
      ? 'Tauri v2 Native (sensorclean:// scheme, 0-copy RAM)'
      : 'Pure-Rust WebAssembly (wasm32-unknown-unknown, Serverless)';

  const diagnostics = JSON.stringify(
    {
      engine: 'SensorClean Pure-Rust Engine',
      version: '0.1.0',
      transport: transportLabel,
      safety: '#![forbid(unsafe_code)] across all 12 crates',
      crates: [
        'sc-core',
        'sc-decode',
        'sc-detect',
        'sc-heal',
        'sc-dng',
        'sc-color',
        'sc-imgproc',
        'sc-session',
        'sc-server',
        'sc-cli',
        'sc-wasm',
        'sc-tauri',
      ],
      bitExactnessInvariant: 'diff == 0 outside healed ROIs',
      activeSession: meta
        ? {
            fileName: meta.originalFileName,
            fullResolution: `${meta.fullWidth} x ${meta.fullHeight}`,
            bayerPattern: meta.bayerPattern,
            bitDepth: meta.bitDepth,
            colorSpace: meta.colorSpace,
            isRaw: meta.isRaw,
            whiteLevel: meta.whiteLevel,
            blackLevel: meta.blackLevel,
          }
        : null,
    },
    null,
    2
  );

  const handleCopy = () => {
    navigator.clipboard.writeText(diagnostics);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-[#1E1E20] border border-[#3A3A3D] rounded-xl shadow-2xl overflow-hidden flex flex-col text-[#F7F6F2]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#3A3A3D] bg-[#242426]">
          <div className="flex items-center gap-2.5">
            <Cpu className="w-5 h-5 text-[#889B6E]" />
            <h2 className="text-sm font-semibold tracking-wide">
              엔진 진단 인스펙터 (Rust Engine Inspector)
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-[#888783] hover:text-[#F7F6F2] hover:bg-[#3A3A3D] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 overflow-y-auto max-h-[70vh]">
          {/* Active Transport Card */}
          <div className="p-4 rounded-lg bg-[#242426] border border-[#3A3A3D] flex items-start gap-3">
            <Box className="w-5 h-5 text-[#889B6E] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <span className="text-xs font-semibold text-[#F7F6F2]">런타임 실행 환경</span>
              <p className="text-xs text-[#C2C1BB] font-mono">{transportLabel}</p>
            </div>
          </div>

          {/* Safety & Invariant Badges */}
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-lg bg-[#242426] border border-[#3A3A3D] flex items-center gap-2.5">
              <Shield className="w-4 h-4 text-[#889B6E]" />
              <span className="text-xs text-[#C2C1BB]">100% #![forbid(unsafe_code)]</span>
            </div>
            <div className="p-3 rounded-lg bg-[#242426] border border-[#3A3A3D] flex items-center gap-2.5">
              <Sparkles className="w-4 h-4 text-[#889B6E]" />
              <span className="text-xs text-[#C2C1BB]">diff == 0 무손실 보존</span>
            </div>
          </div>

          {/* Session Diagnostics JSON */}
          <div className="relative">
            <div className="flex items-center justify-between text-xs text-[#888783] mb-1.5">
              <span className="flex items-center gap-1 font-mono">
                <Terminal className="w-3.5 h-3.5" /> engine_state.json
              </span>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 text-[11px] text-[#C2C1BB] hover:text-white transition-colors cursor-pointer"
              >
                {copied ? <Check className="w-3 h-3 text-[#889B6E]" /> : <Copy className="w-3 h-3" />}
                <span>{copied ? '복사됨' : '복사'}</span>
              </button>
            </div>
            <pre className="p-3.5 rounded-lg bg-[#141416] border border-[#2D2D30] text-[11px] font-mono text-[#C2C1BB] overflow-x-auto max-h-56 leading-relaxed">
              {diagnostics}
            </pre>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-[#3A3A3D] bg-[#242426] flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded bg-[#3A3A3D] hover:bg-[#48484B] text-xs font-medium text-[#F7F6F2] transition-colors cursor-pointer"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
};
