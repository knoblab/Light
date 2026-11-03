import React, { useState, useEffect } from 'react';
import { Copy, Check, Download, Terminal, Code2 } from 'lucide-react';
import { DetectionParams } from '../types/sensor';

interface PythonCodeViewProps {
  params: DetectionParams;
}

export const PythonCodeView: React.FC<PythonCodeViewProps> = ({ params }) => {
  const [activeFile, setActiveFile] = useState<'streamlit' | 'pipeline' | 'requirements'>('streamlit');
  const [sourceFiles, setSourceFiles] = useState<{
    streamlitApp: string;
    rawPipeline: string;
    requirements: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/python-source')
      .then(async (r) => {
        const text = await r.text();
        if (!text || text.trim().startsWith('<')) return null;
        return JSON.parse(text);
      })
      .then((data) => {
        if (data?.streamlitApp) {
          setSourceFiles(data);
        }
      })
      .catch((err) => console.error('Failed to load Python source:', err));
  }, []);

  const getActiveCode = (): string => {
    if (!sourceFiles) return '# Loading Python source code...';
    if (activeFile === 'requirements') return sourceFiles.requirements;
    if (activeFile === 'pipeline') return sourceFiles.rawPipeline;

    // Inject user's current slider defaults into the Streamlit app.py source
    return sourceFiles.streamlitApp
      .replace('value=62', `value=${params.sensitivity}`)
      .replace('value=(5, 40)', `value=(${params.minRadius}, ${params.maxRadius})`)
      .replace('value=0.60', `value=${params.minCircularity.toFixed(2)}`)
      .replace('value=6', `value=${params.inpaintRadius}`);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(getActiveCode());
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleDownloadFile = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const currentFileName =
    activeFile === 'streamlit'
      ? 'app.py'
      : activeFile === 'pipeline'
      ? 'raw_pipeline.py'
      : 'requirements.txt';

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-[#0B0C0E]">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-[#22262E]">
          <div>
            <h2 className="text-xl font-semibold text-white">
              Python + Streamlit + OpenCV + rawpy 원본 소스 코드
            </h2>
            <p className="text-sm text-neutral-400 mt-1">
              현재 웹 스튜디오의 백엔드에서 실행 중인 16-bit 선형 RW2 → Linear DNG 엔진 및 단독 실행형 Streamlit 앱(`app.py`) 코드입니다.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-[#131519] border border-[#2B303B] text-xs font-medium text-neutral-200 hover:text-white cursor-pointer"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-300">복사 완료</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>현재 파일 복사</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => handleDownloadFile(currentFileName, getActiveCode())}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500 text-neutral-950 text-xs font-semibold hover:bg-amber-400 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{currentFileName} 다운로드</span>
            </button>
          </div>
        </div>

        {/* Local Execution Quick Commands */}
        <div className="p-4 rounded-xl bg-[#131519] border border-[#22262E] flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Terminal className="w-5 h-5 text-amber-400 shrink-0" />
            <div className="text-xs font-mono text-neutral-300">
              <span className="text-neutral-500">$</span> pip install -r requirements.txt &amp;&amp; streamlit run app.py
            </div>
          </div>
          <div className="text-xs text-neutral-400 font-mono">
            동기화된 파라미터: 민감도 {params.sensitivity} · 반경 {params.minRadius}~{params.maxRadius}px · 원형도 &gt; {params.minCircularity.toFixed(2)}
          </div>
        </div>

        {/* File Selector Tabs */}
        <div className="flex items-center gap-2 border-b border-[#22262E] pb-3">
          <button
            type="button"
            onClick={() => setActiveFile('streamlit')}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-mono transition-colors cursor-pointer ${
              activeFile === 'streamlit'
                ? 'bg-amber-500 text-neutral-950 font-semibold'
                : 'bg-[#131519] text-neutral-400 hover:text-white border border-[#22262E]'
            }`}
          >
            <Code2 className="w-3.5 h-3.5" />
            <span>app.py (Streamlit UI + 16-bit RW2 파이프라인)</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveFile('pipeline')}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-mono transition-colors cursor-pointer ${
              activeFile === 'pipeline'
                ? 'bg-amber-500 text-neutral-950 font-semibold'
                : 'bg-[#131519] text-neutral-400 hover:text-white border border-[#22262E]'
            }`}
          >
            <Code2 className="w-3.5 h-3.5" />
            <span>raw_pipeline.py (백엔드 CLI 코어 엔진)</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveFile('requirements')}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-mono transition-colors cursor-pointer ${
              activeFile === 'requirements'
                ? 'bg-amber-500 text-neutral-950 font-semibold'
                : 'bg-[#131519] text-neutral-400 hover:text-white border border-[#22262E]'
            }`}
          >
            <Code2 className="w-3.5 h-3.5" />
            <span>requirements.txt</span>
          </button>
        </div>

        {/* Source Code Viewer */}
        <div className="rounded-xl bg-[#0D0F13] border border-[#22262E] overflow-hidden">
          <div className="px-4 py-2.5 bg-[#131519] border-b border-[#22262E] flex items-center justify-between text-xs font-mono text-neutral-400">
            <span>{currentFileName}</span>
            <span>Python 3.10+ · UTF-8</span>
          </div>
          <pre className="p-5 text-xs font-mono text-neutral-200 overflow-x-auto leading-relaxed max-h-[620px]">
            <code>{getActiveCode()}</code>
          </pre>
        </div>
      </div>
    </div>
  );
};
