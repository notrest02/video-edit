import React, { useState, useEffect } from 'react';
import {
  X,
  Sliders,
  Monitor,
  Smartphone,
  Square,
  ArrowLeftRight,
  Check,
  Layers,
} from 'lucide-react';
import { useEditorStore } from '../store/useEditorStore';

interface PresetItem {
  id: string;
  label: string;
  desc: string;
  width: number;
  height: number;
  ratio: string;
  icon: 'landscape' | 'portrait' | 'square';
}

const SEQUENCE_PRESETS: PresetItem[] = [
  {
    id: 'fhd-16-9',
    label: 'YouTube / 표준 가로 (1080p)',
    desc: '1920 × 1080 · 16:9 와이드스크린',
    width: 1920,
    height: 1080,
    ratio: '16:9',
    icon: 'landscape',
  },
  {
    id: 'shorts-9-16',
    label: '쇼츠 / 릴스 / 틱톡 세로 (Shorts)',
    desc: '1080 × 1920 · 9:16 세로형 영상',
    width: 1080,
    height: 1920,
    ratio: '9:16',
    icon: 'portrait',
  },
  {
    id: 'square-1-1',
    label: '인스타그램 / 정방형 (1:1)',
    desc: '1080 × 1080 · 1:1 정사각형',
    width: 1080,
    height: 1080,
    ratio: '1:1',
    icon: 'square',
  },
  {
    id: 'insta-4-5',
    label: '인스타그램 피드 세로 (4:5)',
    desc: '1080 × 1350 · 4:5 세로형',
    width: 1080,
    height: 1350,
    ratio: '4:5',
    icon: 'portrait',
  },
  {
    id: 'uhd-4k',
    label: '4K UHD 고화질 가로 (2160p)',
    desc: '3840 × 2160 · 16:9 초고화질',
    width: 3840,
    height: 2160,
    ratio: '16:9',
    icon: 'landscape',
  },
  {
    id: 'hd-720p',
    label: 'HD 720p 경량 가로',
    desc: '1280 × 720 · 16:9 빠른 렌더링',
    width: 1280,
    height: 720,
    ratio: '16:9',
    icon: 'landscape',
  },
];

export const SequenceSettingsModal: React.FC = () => {
  const {
    sequences,
    editingSequenceId,
    isSequenceModalOpen,
    setIsSequenceModalOpen,
    createNewSequence,
    updateSequenceItem,
  } = useEditorStore();

  const editingSeq = editingSequenceId
    ? sequences.find((s) => s.id === editingSequenceId) || null
    : null;

  const [name, setName] = useState('시퀀스 01');
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [fps, setFps] = useState(30);
  const [fitMode, setFitMode] = useState<'contain' | 'cover'>('contain');

  useEffect(() => {
    if (isSequenceModalOpen) {
      if (editingSeq) {
        setName(editingSeq.name);
        setWidth(editingSeq.width);
        setHeight(editingSeq.height);
        setFps(editingSeq.fps);
        setFitMode(editingSeq.fitMode);
      } else {
        setName(`시퀀스 0${sequences.length + 1}`);
        setWidth(1920);
        setHeight(1080);
        setFps(30);
        setFitMode('contain');
      }
    }
  }, [isSequenceModalOpen, editingSeq, sequences.length]);

  if (!isSequenceModalOpen) return null;

  const handleApply = () => {
    const safeW = Math.max(240, Math.min(7680, Math.round(Number(width) / 2) * 2));
    const safeH = Math.max(240, Math.min(7680, Math.round(Number(height) / 2) * 2));
    const cleanName = name.trim() || `시퀀스 0${sequences.length + 1}`;

    if (editingSeq) {
      updateSequenceItem(editingSeq.id, {
        name: cleanName,
        width: safeW,
        height: safeH,
        fps: Number(fps) || 30,
        fitMode,
      });
    } else {
      createNewSequence({
        name: cleanName,
        width: safeW,
        height: safeH,
        fps: Number(fps) || 30,
        fitMode,
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 select-none">
      <div className="w-full max-w-[640px] bg-[#1e1e1e] border border-[#3a3a3a] rounded-lg shadow-2xl overflow-hidden text-[#dddddd]">
        {/* 모달 상단 헤더 */}
        <div className="px-4 py-3 bg-[#161616] border-b border-[#2e2e2e] flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-bold text-white">
            <Layers className="w-4 h-4 text-[#2ea043]" />
            <span>{editingSeq ? `'${editingSeq.name}' 시퀀스 규격 수정` : '새 시퀀스 만들기'}</span>
          </div>
          <button
            onClick={() => setIsSequenceModalOpen(false)}
            className="p-1 rounded hover:bg-[#2b2b2b] text-[#999999] hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 모달 본문 */}
        <div className="p-4 space-y-4 max-h-[80vh] overflow-y-auto">
          <div className="bg-[#162334] border border-[#2d8ceb]/40 rounded p-2.5 text-xs text-[#9ecbff] leading-relaxed">
            💡 시퀀스를 생성하면 <strong>왼쪽 하단 프로젝트 목록에 시퀀스 항목이 추가</strong>되며, 클릭해서 그 시퀀스 안으로 들어가 작업할 수 있습니다.
          </div>

          {/* 1. 규격 프리셋 선택 */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-white block">시퀀스 규격 프리셋</label>
            <div className="grid grid-cols-2 gap-2">
              {SEQUENCE_PRESETS.map((preset) => {
                const isSelected = width === preset.width && height === preset.height;
                return (
                  <button
                    key={preset.id}
                    onClick={() => {
                      setWidth(preset.width);
                      setHeight(preset.height);
                    }}
                    className={`p-2.5 rounded border text-left flex items-center justify-between transition ${
                      isSelected
                        ? 'bg-[#2d8ceb]/20 border-[#2d8ceb] text-white'
                        : 'bg-[#151515] border-[#2e2e2e] hover:border-[#444444] text-[#cccccc]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-7 h-7 rounded bg-[#252525] flex items-center justify-center text-[#2d8ceb] shrink-0">
                        {preset.icon === 'landscape' && <Monitor className="w-4 h-4" />}
                        {preset.icon === 'portrait' && <Smartphone className="w-4 h-4" />}
                        {preset.icon === 'square' && <Square className="w-4 h-4" />}
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold truncate">{preset.label}</div>
                        <div className="text-[11px] text-[#888888] font-mono">{preset.desc}</div>
                      </div>
                    </div>
                    {isSelected && <Check className="w-4 h-4 text-[#2d8ceb] shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. 사용자 직접 커스텀 입력 */}
          <div className="bg-[#151515] border border-[#2e2e2e] rounded p-3.5 space-y-3">
            <div className="text-xs font-semibold text-white flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5 text-[#2d8ceb]" />
              시퀀스 이름 및 해상도 직접 입력
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[11px] text-[#999999] block">시퀀스 이름</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-[#0e0e0e] border border-[#333333] focus:border-[#2d8ceb] rounded px-2.5 py-1.5 text-xs text-white focus:outline-none select-text"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[11px] text-[#999999] block">프레임 속도 (FPS)</label>
                <select
                  value={fps}
                  onChange={(e) => setFps(Number(e.target.value))}
                  className="w-full bg-[#0e0e0e] border border-[#333333] focus:border-[#2d8ceb] rounded px-2.5 py-1.5 text-xs text-white focus:outline-none"
                >
                  <option value={23.98}>23.976 fps</option>
                  <option value={24}>24.00 fps</option>
                  <option value={25}>25.00 fps</option>
                  <option value={29.97}>29.97 fps</option>
                  <option value={30}>30.00 fps</option>
                  <option value={60}>60.00 fps</option>
                </select>
              </div>
            </div>

            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <label className="text-[11px] text-[#999999] block">가로 (Width px)</label>
                <input
                  type="number"
                  min={240}
                  max={7680}
                  step={2}
                  value={width}
                  onChange={(e) => setWidth(Number(e.target.value))}
                  className="w-full bg-[#0e0e0e] border border-[#333333] focus:border-[#2d8ceb] rounded px-2.5 py-1.5 text-xs font-mono text-white focus:outline-none select-text"
                />
              </div>

              <button
                onClick={() => {
                  setWidth(height);
                  setHeight(width);
                }}
                className="px-2.5 py-1.5 rounded bg-[#252525] hover:bg-[#333333] border border-[#3a3a3a] text-xs text-[#cccccc] flex items-center gap-1 mb-[1px]"
              >
                <ArrowLeftRight className="w-3.5 h-3.5 text-[#2d8ceb]" />
                가로↔세로
              </button>

              <div className="flex-1 space-y-1">
                <label className="text-[11px] text-[#999999] block">세로 (Height px)</label>
                <input
                  type="number"
                  min={240}
                  max={7680}
                  step={2}
                  value={height}
                  onChange={(e) => setHeight(Number(e.target.value))}
                  className="w-full bg-[#0e0e0e] border border-[#333333] focus:border-[#2d8ceb] rounded px-2.5 py-1.5 text-xs font-mono text-white focus:outline-none select-text"
                />
              </div>
            </div>

            <div className="space-y-1 pt-1">
              <label className="text-[11px] text-[#999999] block">영상 맞춤 방식</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setFitMode('contain')}
                  className={`py-1.5 px-2.5 rounded border text-xs font-medium transition ${
                    fitMode === 'contain'
                      ? 'bg-[#2d8ceb]/20 border-[#2d8ceb] text-white'
                      : 'bg-[#0e0e0e] border-[#333333] text-[#999999]'
                  }`}
                >
                  시퀀스 프레임 안에 맞추기 (Contain)
                </button>
                <button
                  onClick={() => setFitMode('cover')}
                  className={`py-1.5 px-2.5 rounded border text-xs font-medium transition ${
                    fitMode === 'cover'
                      ? 'bg-[#2d8ceb]/20 border-[#2d8ceb] text-white'
                      : 'bg-[#0e0e0e] border-[#333333] text-[#999999]'
                  }`}
                >
                  시퀀스 프레임 꽉 채우기 (Cover)
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* 모달 하단 액션 바 */}
        <div className="px-4 py-3 bg-[#161616] border-t border-[#2e2e2e] flex items-center justify-end gap-2">
          <button
            onClick={() => setIsSequenceModalOpen(false)}
            className="px-3.5 py-1.5 rounded bg-[#2b2b2b] hover:bg-[#383838] text-xs text-[#dddddd]"
          >
            취소
          </button>
          <button
            onClick={handleApply}
            className="px-4 py-1.5 rounded bg-[#2ea043] hover:bg-[#268c39] text-xs font-bold text-white shadow transition"
          >
            {editingSeq ? `시퀀스 규격 변경 (${width}×{height})` : `+ 새 시퀀스 생성 (${width}×{height})`}
          </button>
        </div>
      </div>
    </div>
  );
};
