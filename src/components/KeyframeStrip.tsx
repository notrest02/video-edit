/**
 * 키프레임 표시줄: ◆ 클릭 = 그 위치로 이동, ◆ 끌기 = 키프레임 시각을 앞뒤로 옮김
 *  - 프레임 단위(1/fps)로 맞춤, 재생헤드 가까이(±3px) 가면 재생헤드에 붙음
 *  - 끌기 시작할 때 한 번만 되돌리기 지점
 */
import React, { useRef } from 'react';
import { useEditorStore } from '../store/useEditorStore';

export const KeyframeStrip: React.FC<{
  clipStart: number;
  duration: number;
  times: number[];
  /** i 번째 키프레임을 t 로 (history = 되돌리기 지점) */
  onMove: (i: number, t: number, history: boolean) => void;
  /** 모션 탭: 높고 눈금 있는 표시줄 */
  tall?: boolean;
}> = ({ clipStart, duration, times, onMove, tall = false }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const currentTime = useEditorStore((s) => s.currentTime);
  const setCurrentTime = useEditorStore((s) => s.setCurrentTime);
  const fps = useEditorStore((s) => s.fps) || 30;
  const dur = Math.max(1e-6, duration);
  const playT = Math.min(dur, Math.max(0, currentTime - clipStart));

  const startDrag = (e: React.PointerEvent, i: number) => {
    e.stopPropagation();
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x0 = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      let t = ((ev.clientX - rect.left) / rect.width) * dur;
      t = Math.min(dur, Math.max(0, Math.round(t * fps) / fps));
      if (Math.abs(((t - playT) / dur) * rect.width) <= 3) t = +playT.toFixed(4); // 재생헤드에 붙기
      onMove(i, +t.toFixed(4), !moved);
      moved = true;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) setCurrentTime(clipStart + times[i]); // 끌지 않고 놓으면 = 클릭 → 그 위치로
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      ref={ref}
      className={`relative flex-1 ${tall ? 'h-6' : 'h-3'} bg-[#141414] border border-[#2a2a2a] rounded ${tall ? '' : 'mx-1'} select-none`}
    >
      {tall &&
        Array.from({ length: Math.floor(dur * 2) + 1 }, (_, k) => (
          <div
            key={`g${k}`}
            className={`absolute bottom-0 w-[1px] ${k % 2 === 0 ? 'h-2 bg-[#444444]' : 'h-1 bg-[#333333]'} pointer-events-none`}
            style={{ left: `${((k * 0.5) / dur) * 100}%` }}
          />
        ))}
      <div className="absolute top-0 bottom-0 w-[1px] bg-[#e5a038] pointer-events-none" style={{ left: `${(playT / dur) * 100}%` }} />
      {times.map((t, i) => (
        <div
          key={i}
          onPointerDown={(e) => startDrag(e, i)}
          className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 ${tall ? 'text-[13px]' : 'text-[9px]'} leading-none text-[#2d8ceb] hover:text-white cursor-ew-resize px-0.5`}
          style={{ left: `${(t / dur) * 100}%` }}
          title={`${t.toFixed(2)}초 — 클릭: 이동 · 끌기: 키프레임 옮기기`}
        >
          ◆
        </div>
      ))}
    </div>
  );
};
