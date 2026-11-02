/**
 * 타임라인 눈금자 위 '광고 구간' 띠 (한 시퀀스에 광고 여러 개). 구간 사이 경계를 끌어서 옮길 수 있음.
 * 경계는 끌 때 가까운(±0.15초) 자막 시작 3프레임 앞(= 컷 위치)에 붙음.
 */
import React from 'react';
import { useEditorStore } from '../store/useEditorStore';

const COLORS = ['#2d8ceb', '#3fb950', '#e5a038', '#bc8cff', '#ff7b72', '#39c5cf'];

export const AdSegmentBands: React.FC<{ zoomPxPerSec: number }> = ({ zoomPxPerSec }) => {
  const segs = useEditorStore((s) => s.sequences.find((q) => q.id === s.activeSequenceId)?.adSegments);
  const setAdSegments = useEditorStore((s) => s.setAdSegments);
  if (!segs || segs.length < 2) return null;

  const startDrag = (e: React.MouseEvent, k: number) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    const orig = segs[k].start;
    const lo = segs[k - 1].start + 0.5;
    const hi = segs[k].end - 0.5;
    const st = useEditorStore.getState();
    const lead = 3 / Math.max(1, st.fps);
    const capCuts = st.clips.filter((c) => c.type === 'text').map((c) => c.startTime - lead);
    const move = (ev: MouseEvent) => {
      let t = Math.min(hi, Math.max(lo, orig + (ev.clientX - x0) / zoomPxPerSec));
      const near = capCuts.reduce((a, c) => (Math.abs(c - t) < Math.abs(a - t) ? c : a), Infinity);
      if (Math.abs(near - t) < 0.15) t = near;
      const cur = useEditorStore.getState().sequences.find((q) => q.id === useEditorStore.getState().activeSequenceId)?.adSegments;
      if (!cur) return;
      setAdSegments(cur.map((g, i) => (i === k - 1 ? { ...g, end: t } : i === k ? { ...g, start: t } : g)));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <>
      {segs.map((g, i) => (
        <div
          key={g.id}
          style={{
            left: `${g.start * zoomPxPerSec}px`,
            width: `${Math.max(2, (g.end - g.start) * zoomPxPerSec)}px`,
            background: `${COLORS[i % COLORS.length]}40`,
            borderColor: COLORS[i % COLORS.length],
          }}
          className="absolute top-0 h-[15px] border-t-2 pointer-events-none overflow-hidden"
          title={`${g.name}${g.hook ? ` · 후킹 ${g.hook.fileNo}번 ${g.hook.from}~${g.hook.to}초` : ''}`}
        >
          <span className="px-1 text-[9px] font-semibold text-white whitespace-nowrap">
            {g.name}
            {g.hook ? ` · 후킹 ${g.hook.fileNo}번 ${g.hook.from}~${g.hook.to}초` : ''}
          </span>
        </div>
      ))}
      {segs.slice(1).map((g, j) => (
        <div
          key={`h_${g.id}`}
          onMouseDown={(e) => startDrag(e, j + 1)}
          style={{ left: `${g.start * zoomPxPerSec - 4}px` }}
          className="absolute top-0 h-[15px] w-2 cursor-ew-resize z-20 flex justify-center"
          title="광고 경계 (끌어서 옮기기)"
        >
          <div className="w-[2px] h-full bg-white/80" />
        </div>
      ))}
    </>
  );
};
