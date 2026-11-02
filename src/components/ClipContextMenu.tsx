import React, { useEffect, useRef, useState } from 'react';
import { useEditorStore, clipSpeed, MIN_CLIP_SPEED, MAX_CLIP_SPEED } from '../store/useEditorStore';
import { displayBinding, getShortcutMap } from '../utils/shortcuts';

const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * 타임라인 클립 우클릭 메뉴
 * - 속도 프리셋 / 직접 입력(%) / 길이 직접 입력(초)
 * - 다음 클립까지 채우기, 인디케이터까지 맞추기 (장면은 괜찮은데 대사가 길 때 늘리는 용도)
 * - 인디케이터 위치에서 자르기 (D)
 */
export const ClipContextMenu: React.FC<{ clipId: string; x: number; y: number; onClose: () => void }> = ({
  clipId,
  x,
  y,
  onClose,
}) => {
  const clip = useEditorStore((st) => st.clips.find((c) => c.id === clipId));
  const ref = useRef<HTMLDivElement | null>(null);
  const [speedInput, setSpeedInput] = useState('');
  const [lenInput, setLenInput] = useState('');

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  useEffect(() => {
    if (clip) {
      setSpeedInput(String(Math.round(clipSpeed(clip) * 100)));
      setLenInput(clip.duration.toFixed(2));
    }
    // 메뉴를 연 클립 기준으로 한 번만 채움
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId]);

  if (!clip) return null;
  const st = useEditorStore.getState();
  const isText = clip.type === 'text';
  const cur = clipSpeed(clip);
  const run = (fn: () => void) => {
    fn();
    onClose();
  };

  // 화면 밖으로 나가지 않게 위치 보정
  const W = 250;
  const H = isText ? 60 : 300;
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - H - 8);

  return (
    <div
      ref={ref}
      style={{ left, top, width: W }}
      className="fixed z-[100] bg-[#232323] border border-[#3d3d3d] rounded shadow-2xl text-[11px] text-[#dddddd] py-1 select-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      {!isText && (
        <>
          <div className="px-3 py-1 text-[10px] text-[#999999]">
            속도 / 길이 — 지금 {Math.round(cur * 100)}% · {clip.duration.toFixed(2)}초
          </div>
          <div className="px-2 pb-1.5 grid grid-cols-6 gap-1">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => run(() => st.setClipSpeed(clipId, p))}
                className={`py-1 rounded border text-[10px] ${
                  Math.abs(cur - p) < 1e-3
                    ? 'bg-[#2d8ceb] border-[#2d8ceb] text-white'
                    : 'bg-[#1b1b1b] border-[#3a3a3a] hover:bg-[#2e2e2e]'
                }`}
                title={p < 1 ? '느리게 (길이가 늘어남)' : p > 1 ? '빠르게 (길이가 줄어듦)' : '원래 속도'}
              >
                {Math.round(p * 100)}%
              </button>
            ))}
          </div>
          <button
            onClick={() => run(() => st.fitClipLength(clipId, 'next-clip'))}
            className="w-full text-left px-3 py-1.5 hover:bg-[#2d8ceb] hover:text-white"
            title="같은 트랙의 다음 클립 시작까지 딱 맞게 속도를 조절합니다"
          >
            다음 클립까지 채우기
          </button>
          <button
            onClick={() => run(() => st.fitClipLength(clipId, 'playhead'))}
            className="w-full text-left px-3 py-1.5 hover:bg-[#2d8ceb] hover:text-white"
            title="클립 끝이 인디케이터 위치에 오도록 속도를 조절합니다"
          >
            인디케이터까지 맞추기
          </button>
          <div className="px-3 py-1.5 flex items-center gap-1.5">
            <span className="w-12 text-[#aaaaaa]">속도</span>
            <input
              value={speedInput}
              onChange={(e) => setSpeedInput(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') run(() => st.setClipSpeed(clipId, Number(speedInput) / 100));
              }}
              className="w-16 bg-[#121212] border border-[#3a3a3a] rounded px-1.5 py-0.5 text-right"
            />
            <span className="text-[#888888]">%</span>
            <button
              onClick={() => run(() => st.setClipSpeed(clipId, Number(speedInput) / 100))}
              className="ml-auto px-2 py-0.5 rounded bg-[#333333] hover:bg-[#2d8ceb]"
            >
              적용
            </button>
          </div>
          <div className="px-3 py-1.5 flex items-center gap-1.5">
            <span className="w-12 text-[#aaaaaa]">길이</span>
            <input
              value={lenInput}
              onChange={(e) => setLenInput(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') run(() => st.fitClipLength(clipId, Number(lenInput)));
              }}
              className="w-16 bg-[#121212] border border-[#3a3a3a] rounded px-1.5 py-0.5 text-right"
            />
            <span className="text-[#888888]">초</span>
            <button
              onClick={() => run(() => st.fitClipLength(clipId, Number(lenInput)))}
              className="ml-auto px-2 py-0.5 rounded bg-[#333333] hover:bg-[#2d8ceb]"
            >
              적용
            </button>
          </div>
          <div className="px-3 pb-1 text-[9px] text-[#777777]">
            {Math.round(MIN_CLIP_SPEED * 100)}~{Math.round(MAX_CLIP_SPEED * 100)}% · 뒤 클립과는 겹치지 않게 맞춰요
          </div>
          <div className="h-px bg-[#3a3a3a] my-1" />
        </>
      )}
      <button
        onClick={() => run(() => st.splitClipAtPlayhead())}
        className="w-full text-left px-3 py-1.5 hover:bg-[#2d8ceb] hover:text-white flex justify-between"
      >
        <span>인디케이터 위치에서 자르기</span>
        <span className="text-[#888888]">
          {getShortcutMap().splitAtPlayhead.map(displayBinding).join(' / ')}
        </span>
      </button>
    </div>
  );
};
