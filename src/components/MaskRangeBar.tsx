/**
 * 블러 마스크 구간(클립 안 from~to) 막대
 *  - 막대 = 마스크가 보이는 시간. 양 끝을 끌면 시작/끝 조절, 가운데를 끌면 구간 통째로 이동
 *  - 클릭 = 그 마스크 선택 + (안 보이는 시간이면) 시작 위치로 이동
 *  - 프레임 단위로 맞춤, 재생헤드 가까이(±4px) 가면 재생헤드에 붙음
 */
import React, { useRef } from 'react';
import { useEditorStore } from '../store/useEditorStore';

export const MaskRangeBar: React.FC<{
  clipStart: number;
  duration: number;
  from?: number;
  to?: number;
  selected: boolean;
  label?: string;
  onSelect: () => void;
  /** history = 되돌리기 지점 (끌기 시작할 때 한 번) */
  onChange: (from: number, to: number, history: boolean) => void;
}> = ({ clipStart, duration, from, to, selected, label, onSelect, onChange }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const currentTime = useEditorStore((s) => s.currentTime);
  const fps = useEditorStore((s) => s.fps) || 30;
  const dur = Math.max(1e-6, duration);
  const f = Math.max(0, from ?? 0);
  const e = Math.min(dur, to ?? dur);
  const playT = Math.min(dur, Math.max(0, currentTime - clipStart));
  const minLen = 1 / fps;

  const start = (ev0: React.PointerEvent, mode: 'from' | 'to' | 'move') => {
    ev0.stopPropagation();
    ev0.preventDefault();
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x0 = ev0.clientX;
    const t0 = ((x0 - rect.left) / rect.width) * dur;
    let moved = false;
    const snap = (t: number) => {
      t = Math.round(t * fps) / fps;
      if (Math.abs(((t - playT) / dur) * rect.width) <= 4) t = playT; // 재생헤드에 붙기
      return Math.min(dur, Math.max(0, t));
    };
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      const t = ((ev.clientX - rect.left) / rect.width) * dur;
      let nf = f;
      let nt = e;
      if (mode === 'from') nf = Math.min(snap(t), e - minLen);
      else if (mode === 'to') nt = Math.max(snap(t), f + minLen);
      else {
        const len = e - f;
        nf = Math.min(dur - len, Math.max(0, snap(f + (t - t0))));
        nt = nf + len;
      }
      onChange(+nf.toFixed(4), +nt.toFixed(4), !moved);
      moved = true;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) onSelect();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const color = selected ? 'bg-[#e5a038]/70 border-[#e5a038]' : 'bg-[#2d8ceb]/45 border-[#2d8ceb]';
  return (
    <div ref={ref} className="relative flex-1 h-4 bg-[#141414] border border-[#2a2a2a] rounded select-none">
      <div
        onPointerDown={(ev) => start(ev, 'move')}
        className={`absolute top-0 bottom-0 border rounded-sm cursor-grab ${color}`}
        style={{ left: `${(f / dur) * 100}%`, width: `${Math.max(0.5, ((e - f) / dur) * 100)}%` }}
        title={`${f.toFixed(2)}~${e.toFixed(2)}초 — 끝을 끌어 시작/끝 조절, 가운데를 끌어 옮기기, 클릭 = 선택`}
      >
        {label && <span className="absolute inset-0 flex items-center px-1 text-[9px] text-white truncate pointer-events-none">{label}</span>}
        <div onPointerDown={(ev) => start(ev, 'from')} className="absolute -left-1 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/60" />
        <div onPointerDown={(ev) => start(ev, 'to')} className="absolute -right-1 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/60" />
      </div>
      <div className="absolute -top-0.5 -bottom-0.5 w-[1px] bg-[#ff4d4d] pointer-events-none" style={{ left: `${(playT / dur) * 100}%` }} />
    </div>
  );
};
