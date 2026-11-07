import React, { useState } from 'react';
import { Sliders, Eye, EyeOff, Layers, Sparkles, Check, ChevronUp, ChevronDown } from 'lucide-react';
import { DetectionParams, OverlayMode, ViewComparisonMode } from '../types/sensor';

interface MobileDarkroomControlsProps {
  params: DetectionParams;
  onChangeParams: (p: DetectionParams) => void;
  overlayMode: OverlayMode;
  onChangeOverlayMode: (m: OverlayMode) => void;
  comparisonMode: ViewComparisonMode;
  onChangeComparisonMode: (m: ViewComparisonMode) => void;
  hasInpaintedResult: boolean;
  onTriggerInpaint: () => void;
  isProcessing: boolean;
}

export const MobileDarkroomControls: React.FC<MobileDarkroomControlsProps> = ({
  params,
  onChangeParams,
  overlayMode,
  onChangeOverlayMode,
  comparisonMode,
  onChangeComparisonMode,
  hasInpaintedResult,
  onTriggerInpaint,
  isProcessing,
}) => {
  const [isSheetExpanded, setIsSheetExpanded] = useState(false);

  return (
    <div className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-[#1E1E20]/95 backdrop-blur-md border-t border-[#3A3A3D] text-[#F7F6F2]">
      {/* Bottom Sheet Header Handle */}
      <div
        onClick={() => setIsSheetExpanded(!isSheetExpanded)}
        className="flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-[#2D2D30]"
      >
        <div className="flex items-center gap-2">
          <Sliders className="w-4 h-4 text-[#889B6E]" />
          <span className="text-xs font-semibold">먼지 탐지 및 복원 파라미터</span>
        </div>
        <button className="text-[#888783] hover:text-[#F7F6F2]">
          {isSheetExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
        </button>
      </div>

      {/* Expanded Sheet Content */}
      {isSheetExpanded && (
        <div className="p-4 space-y-4 max-h-[50vh] overflow-y-auto">
          {/* Sensitivity */}
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-[#C2C1BB]">민감도 (Sensitivity)</span>
              <span className="font-mono text-[#889B6E]">{params.sensitivity}</span>
            </div>
            <input
              type="range"
              min="1"
              max="10"
              value={params.sensitivity}
              onChange={(e) =>
                onChangeParams({ ...params, sensitivity: parseInt(e.target.value, 10) })
              }
              className="w-full accent-[#556042]"
            />
          </div>

          {/* Cloud Protection */}
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-[#C2C1BB]">구름/경계 보호 (Cloud Protection)</span>
              <span className="font-mono text-[#889B6E]">{params.cloudProtection}</span>
            </div>
            <input
              type="range"
              min="1"
              max="10"
              value={params.cloudProtection}
              onChange={(e) =>
                onChangeParams({ ...params, cloudProtection: parseInt(e.target.value, 10) })
              }
              className="w-full accent-[#556042]"
            />
          </div>

          {/* Inpaint Radius */}
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-[#C2C1BB]">복원 반경 (Inpaint Radius)</span>
              <span className="font-mono text-[#889B6E]">{params.inpaintRadius || 6}px</span>
            </div>
            <input
              type="range"
              min="2"
              max="20"
              value={params.inpaintRadius || 6}
              onChange={(e) =>
                onChangeParams({ ...params, inpaintRadius: parseInt(e.target.value, 10) })
              }
              className="w-full accent-[#556042]"
            />
          </div>

          {/* Grain Preservation */}
          <div className="flex items-center justify-between pt-1">
            <span className="text-xs text-[#C2C1BB]">센서 자연 그레인 보존</span>
            <input
              type="checkbox"
              checked={params.preserveGrain ?? true}
              onChange={(e) =>
                onChangeParams({ ...params, preserveGrain: e.target.checked })
              }
              className="w-4 h-4 accent-[#556042] rounded"
            />
          </div>
        </div>
      )}

      {/* Persistent Quick Action Bar */}
      <div className="px-4 py-2.5 flex items-center justify-between gap-2 bg-[#1A1A1C]">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() =>
              onChangeOverlayMode(overlayMode === 'bw-edge' ? 'red-circle' : 'bw-edge')
            }
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              overlayMode === 'bw-edge'
                ? 'bg-[#556042] text-white'
                : 'bg-[#2D2D30] text-[#C2C1BB]'
            }`}
          >
            엣지
          </button>
          <button
            onClick={() =>
              onChangeComparisonMode(
                comparisonMode === 'original-only' ? 'healed-only' : 'original-only'
              )
            }
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              comparisonMode === 'original-only'
                ? 'bg-[#556042] text-white'
                : 'bg-[#2D2D30] text-[#C2C1BB]'
            }`}
          >
            원본비교
          </button>
        </div>

        <button
          onClick={onTriggerInpaint}
          disabled={isProcessing}
          className={`flex items-center gap-1.5 px-4 py-1.5 rounded text-xs font-semibold shadow-xs ${
            isProcessing
              ? 'bg-[#3A3A3D] text-[#888783]'
              : 'bg-[#556042] text-[#F7F6F2] hover:bg-[#687652]'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>{isProcessing ? '처리 중' : '16-bit 복원'}</span>
        </button>
      </div>
    </div>
  );
};
