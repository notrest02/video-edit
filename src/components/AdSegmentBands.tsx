/**
 * 타임라인 눈금자 위 '광고 구간' 띠 (한 시퀀스에 광고 여러 개).
 * 구간 시작·사이 경계·끝을 끌어서 늘리거나 줄일 수 있음.
 * 경계는 끌 때 가까운(±0.15초) 자막 시작 3프레임 앞(= 컷 위치) 및 오디오/영상 끝점에 붙음.
 */
import React from 'react';
import { useEditorStore } from '../store/useEditorStore';

const COLORS = ['#2d8ceb', '#3fb950', '#e5a038', '#bc8cff', '#ff7b72', '#39c5cf'];

type DragTarget =
  | { kind: 'shared'; k: number } // segs[k-1].end 와 segs[k].start 를 동시에 이동
  | { kind: 'start'; k: number }  // segs[k].start 만 이동
  | { kind: 'end'; k: number };   // segs[k].end 만 이동

export const AdSegmentBands: React.FC<{ zoomPxPerSec: number }> = ({ zoomPxPerSec }) => {
  const segs = useEditorStore((s) => s.sequences.find((q) => q.id === s.activeSequenceId)?.adSegments);
  const setAdSegments = useEditorStore((s) => s.setAdSegments);
  if (!segs || segs.length < 1) return null;

  const startDrag = (e: React.MouseEvent, target: DragTarget) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    const st = useEditorStore.getState();
    const lead = 3 / Math.max(1, st.fps);
    const snapPoints = [
      0,
      ...st.clips.filter((c) => c.type === 'text').map((c) => Math.max(0, c.startTime - lead)),
      ...st.clips.filter((c) => c.type !== 'text').flatMap((c) => [c.startTime, c.startTime + c.duration]),
    ];

    const orig =
      target.kind === 'end' ? segs[target.k].end : segs[target.k].start;

    const move = (ev: MouseEvent) => {
      const cur = useEditorStore.getState().sequences.find((q) => q.id === useEditorStore.getState().activeSequenceId)?.adSegments;
      if (!cur) return;
      const raw = orig + (ev.clientX - x0) / zoomPxPerSec;

      let lo = 0;
      let hi = Infinity;
      if (target.kind === 'shared') {
        const k = target.k;
        if (!cur[k - 1] || !cur[k]) return;
        lo = cur[k - 1].start + 0.5;
        hi = cur[k].end - 0.5;
      } else if (target.kind === 'start') {
        const k = target.k;
        if (!cur[k]) return;
        lo = k > 0 ? cur[k - 1].end : 0;
        hi = cur[k].end - 0.5;
      } else {
        const k = target.k;
        if (!cur[k]) return;
        lo = cur[k].start + 0.5;
        hi = k + 1 < cur.length ? cur[k + 1].start : Infinity;
      }

      let t = Math.min(hi, Math.max(lo, raw));
      const near = snapPoints.reduce((a, c) => (Math.abs(c - t) < Math.abs(a - t) ? c : a), Infinity);
      if (Math.abs(near - t) < 0.15 && near >= lo && near <= hi) t = near;
      t = Number(t.toFixed(4));

      if (target.kind === 'shared') {
        const k = target.k;
        setAdSegments(cur.map((g, i) => (i === k - 1 ? { ...g, end: t } : i === k ? { ...g, start: t } : g)));
      } else if (target.kind === 'start') {
        const k = target.k;
        setAdSegments(cur.map((g, i) => (i === k ? { ...g, start: t } : g)));
      } else {
        const k = target.k;
        setAdSegments(cur.map((g, i) => (i === k ? { ...g, end: t } : g)));
      }
    };

    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // 모든 조절 가능한 경계 목록 (첫 구간 시작, 구간 사이 경계, 마지막 구간 끝 포함)
  const handles: Array<{ key: string; time: number; target: DragTarget; label: string }> = [];
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i];
    if (i === 0) {
      handles.push({
        key: `start_${g.id}`,
        time: g.start,
        target: { kind: 'start', k: 0 },
        label: `${g.name} 시작 위치 조절`,
      });
    } else {
      const prev = segs[i - 1];
      if (Math.abs(g.start - prev.end) < 0.05) {
        handles.push({
          key: `shared_${g.id}`,
          time: g.start,
          target: { kind: 'shared', k: i },
          label: `${prev.name} ↔ ${g.name} 경계 조절 (좌우로 드래그)`,
        });
      } else {
        handles.push({
          key: `end_${prev.id}`,
          time: prev.end,
          target: { kind: 'end', k: i - 1 },
          label: `${prev.name} 끝 위치 조절`,
        });
        handles.push({
          key: `start_${g.id}`,
          time: g.start,
          target: { kind: 'start', k: i },
          label: `${g.name} 시작 위치 조절`,
        });
      }
    }
    if (i === segs.length - 1) {
      handles.push({
        key: `end_${g.id}`,
        time: g.end,
        target: { kind: 'end', k: i },
        label: `${g.name} 끝 위치 조절 (좌우로 드래그)`,
      });
    }
  }

  // 상단 광고 구간 레일(0~22px) 클릭 시: 인디케이터(재생헤드)가 잡히지 않도록 막고, 경계 근처(±20px)면 바로 해당 경계 드래그 시작
  const handleBandMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!rect) return;
    const clickX = e.clientX - rect.left;
    let best: (typeof handles)[number] | null = null;
    let bestDist = Infinity;
    for (const h of handles) {
      const dist = Math.abs(h.time * zoomPxPerSec - clickX);
      if (dist < bestDist) {
        bestDist = dist;
        best = h;
      }
    }
    if (best && bestDist <= 20) {
      startDrag(e, best.target);
    }
  };

  return (
    <>
      {/* 상단 22px 전체 보호 영역 — 광고 구간 끝 바깥쪽을 조금 벗어나 클릭해도 인디케이터가 잡히지 않게 보호 */}
      <div
        onMouseDown={handleBandMouseDown}
        className="absolute inset-x-0 top-0 h-[22px] z-20"
      />
      {segs.map((g, i) => (
        <div
          key={g.id}
          onMouseDown={handleBandMouseDown}
          style={{
            left: `${g.start * zoomPxPerSec}px`,
            width: `${Math.max(2, (g.end - g.start) * zoomPxPerSec)}px`,
            background: `${COLORS[i % COLORS.length]}45`,
            borderColor: COLORS[i % COLORS.length],
          }}
          className="absolute top-0 h-[20px] border-t-2 overflow-hidden z-30 select-none flex items-center"
          title={`${g.name}${g.hook ? ` · 후킹 ${g.hook.fileNo}번 ${g.hook.from}~${g.hook.to}초` : ''}`}
        >
          <span className="px-2 text-[9px] font-semibold text-white whitespace-nowrap pointer-events-none">
            {g.name}
            {g.hook ? ` · 후킹 ${g.hook.fileNo}번 ${g.hook.from}~${g.hook.to}초` : ''}
          </span>
        </div>
      ))}
      {handles.map((h) => (
        <div
          key={h.key}
          onMouseDown={(e) => startDrag(e, h.target)}
          style={{ left: `${h.time * zoomPxPerSec - 14}px` }}
          className="group absolute top-0 h-[22px] w-7 cursor-ew-resize z-40 flex items-center justify-center"
          title={h.label}
        >
          <div className="w-[2px] h-full bg-white group-hover:bg-[#ffdf5d] shadow-[0_0_4px_rgba(0,0,0,0.8)]" />
          <div className="absolute top-[2px] w-2.5 h-3.5 rounded-xs bg-white group-hover:bg-[#ffdf5d] border border-black/40 shadow-sm" />
        </div>
      ))}
    </>
  );
};
