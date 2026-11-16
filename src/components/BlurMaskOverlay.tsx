/**
 * 미리보기 위 블러 마스크: 보이는 영상 클립의 마스크 영역만 흐리게(backdrop-filter) +
 * 그 클립을 선택했으면 꼭짓점 편집:
 *   - 점 클릭 = 그 점 선택 (Ctrl+클릭 = 추가/빼기), 마스크 안쪽 클릭 = 그 마스크 네 점 모두 선택
 *   - 빈 곳을 끌면 사각형 범위 안의 점들 선택 (Ctrl = 기존 선택에 더하기)
 *   - 선택된 점을 끌면 선택된 점들이 함께 이동, Shift 를 누르고 끌면 45도 간격 방향으로만 이동
 */
import React, { useRef, useState } from 'react';
import { useEditorStore } from '../store/useEditorStore';
import type { BlurMask, MaskPoint, TimelineClip } from '../types/editor';
import { blurPointsAt, maskPointsAt, maskSvgDataUrl } from '../utils/blurMask';
import { effectiveMasks } from '../utils/autoMask';

const key = (mi: number, k: number) => `${mi}:${k}`;

export const BlurMaskOverlay: React.FC<{
  clip: TimelineClip | undefined;
  width: number;
  height: number;
  canvasWidth: number;
  /** 영상 클립 모션(위치/크기/회전)과 같이 움직이게 */
  layerTransform?: string;
  /** 같은 모션의 숫자 (미리보기 px, 도, 배율) — 끌 때 마우스 위치를 클립 좌표로 되돌리는 데 씀 */
  motion?: { px: number; py: number; rot: number; sc: number };
}> = ({ clip, width, height, canvasWidth, layerTransform, motion }) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const currentTime = useEditorStore((s) => s.currentTime);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  // 원본 마스크(R41)가 바뀌면 다시 그림
  useEditorStore((s) => s.sourceMasks);
  const clipMasksOf = useEditorStore((s) => s.clipMasksOf);
  const setClipMasks = useEditorStore((s) => s.setClipMasks);
  const selectedMaskId = useEditorStore((s) => s.selectedMaskId);
  const setSelectedMaskId = useEditorStore((s) => s.setSelectedMaskId);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const masks = clip ? clipMasksOf(clip) : [];
  if (!clip || masks.length === 0) return null;
  const t = currentTime - clip.startTime;
  // 보이는 구간은 내보내기와 같은 계산 (자동 마스크: 컷 앞뒤 끝까지 늘림, 같은 자리 빈틈 잇기)
  const shown = new Map(effectiveMasks(masks, clip.duration).map((m) => [m.id, m]));
  const hiddenNow = (m: BlurMask) => {
    const e = shown.get(m.id) || m;
    return (e.from !== undefined && t < e.from) || (e.to !== undefined && t >= e.to);
  };
  const scale = canvasWidth / Math.max(1, width); // 출력 px → 미리보기 px
  const editing = selectedClipId === clip.id;

  // 기준 사각형 = 변형 안 된 미리보기 화면(부모). 마우스 위치 → 모션(이동·회전·크기)을 되돌려 클립 좌표로
  const rectOf = () => svgRef.current?.parentElement?.getBoundingClientRect();
  const toN = (rect: DOMRect, ev: { clientX: number; clientY: number }): MaskPoint => {
    const m = motion || { px: 0, py: 0, rot: 0, sc: 1 };
    let x = ev.clientX - (rect.left + rect.width / 2) - m.px;
    let y = ev.clientY - (rect.top + rect.height / 2) - m.py;
    const a = (-m.rot * Math.PI) / 180;
    [x, y] = [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
    x /= m.sc || 1;
    y /= m.sc || 1;
    return [(x + rect.width / 2) / rect.width, (y + rect.height / 2) / rect.height];
  };

  /** 선택된 점들 끌기 */
  const dragSelected = (e: React.PointerEvent, selection: Set<string>) => {
    const rect = rectOf();
    if (!rect) return;
    const start = toN(rect, e);
    const orig = masks.map((m) => maskPointsAt(m, t));
    useEditorStore.getState().recordHistorySnapshot(); // 되돌리기 지점
    const move = (ev: PointerEvent) => {
      const p = toN(rect, ev);
      let dx = (p[0] - start[0]) * rect.width; // 화면 px 기준으로 각도 계산 (가로세로 비율 반영)
      let dy = (p[1] - start[1]) * rect.height;
      if (ev.shiftKey && (dx || dy)) {
        const step = Math.PI / 4;
        const ang = Math.round(Math.atan2(dy, dx) / step) * step;
        const len = dx * Math.cos(ang) + dy * Math.sin(ang);
        dx = len * Math.cos(ang);
        dy = len * Math.sin(ang);
      }
      const nx = dx / rect.width;
      const ny = dy / rect.height;
      const st = useEditorStore.getState();
      const cc = st.clips.find((c) => c.id === clip.id);
      const cur = cc ? st.clipMasksOf(cc) : masks;
      const next: BlurMask[] = cur.map((m, mi) => {
        if (![0, 1, 2, 3].some((k) => selection.has(key(mi, k)))) return m;
        const pts = orig[mi].map((q, k) =>
          selection.has(key(mi, k))
            ? ([Math.min(1, Math.max(0, q[0] + nx)), Math.min(1, Math.max(0, q[1] + ny))] as MaskPoint)
            : q
        );
        // 키프레임이 있으면 지금 시각의 키프레임을 만들거나 고침, 없으면 고정 위치를 바꿈
        return m.keyframes?.length
          ? {
              ...m,
              keyframes: [
                ...m.keyframes.filter((f) => Math.abs(f.t - t) > 1 / 60),
                { t: +t.toFixed(3), points: pts, ease: m.keyframes.find((f) => Math.abs(f.t - t) <= 1 / 60)?.ease ?? 'linear' },
              ].sort((a, b) => a.t - b.t),
            }
          : { ...m, points: pts };
      });
      setClipMasks(clip.id, next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onPointDown = (e: React.PointerEvent, mi: number, k: number) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedMaskId(masks[mi].id);
    let next = new Set(sel);
    if (e.ctrlKey || e.metaKey) {
      next.has(key(mi, k)) ? next.delete(key(mi, k)) : next.add(key(mi, k));
    } else if (!next.has(key(mi, k))) {
      next = new Set([key(mi, k)]);
    }
    setSel(next);
    if (next.has(key(mi, k))) dragSelected(e, next);
  };

  const onBodyDown = (e: React.PointerEvent, mi: number) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedMaskId(masks[mi].id);
    const all = new Set([0, 1, 2, 3].map((k) => key(mi, k)));
    const next = [...all].every((x) => sel.has(x)) ? sel : e.ctrlKey || e.metaKey ? new Set([...sel, ...all]) : all;
    setSel(next);
    dragSelected(e, next);
  };

  // 빈 곳 끌기 = 사각형 범위 선택
  const onEmptyDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = rectOf();
    if (!rect) return;
    const [x0, y0] = toN(rect, e);
    const additive = e.ctrlKey || e.metaKey;
    setMarquee({ x0, y0, x1: x0, y1: y0 });
    const move = (ev: PointerEvent) => {
      const [x1, y1] = toN(rect, ev);
      setMarquee({ x0, y0, x1, y1 });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const [x1, y1] = toN(rect, ev);
      const [lx, hx, ly, hy] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
      const picked = new Set(additive ? sel : []);
      masks.forEach((m, mi) =>
        (hiddenNow(m) ? [] : maskPointsAt(m, t)).forEach(([x, y], k) => {
          if (x >= lx && x <= hx && y >= ly && y <= hy) picked.add(key(mi, k));
        })
      );
      setSel(picked);
      setMarquee(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <>
      {masks.filter((m) => !hiddenNow(m)).map((m) => (
        <div
          key={m.id}
          className="absolute inset-0 z-[5] pointer-events-none"
          style={{
            transform: layerTransform,
            backdropFilter: `blur(${(m.blur * scale).toFixed(2)}px)`,
            WebkitBackdropFilter: `blur(${(m.blur * scale).toFixed(2)}px)`,
            WebkitMaskImage: maskSvgDataUrl(blurPointsAt(m, t, width, height), width, height, m.feather),
            maskImage: maskSvgDataUrl(blurPointsAt(m, t, width, height), width, height, m.feather),
            WebkitMaskSize: '100% 100%',
            maskSize: '100% 100%',
          }}
        />
      ))}
      {editing && (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full z-20"
          style={{ pointerEvents: 'all', cursor: 'default', transform: layerTransform }}
          onPointerDown={onEmptyDown}
        >
          {masks.map((m, mi) => {
            if (hiddenNow(m)) return null; // 지금 안 보이는 마스크는 손잡이도 숨김
            const pts = maskPointsAt(m, t);
            const r = width * 0.018;
            return (
              <g key={m.id}>
                {!!m.expand && (
                  // 실제 흐려지는 영역 (블러 범위 적용) — 점선
                  <polygon
                    points={blurPointsAt(m, t, width, height).map(([x, y]) => `${x * width},${y * height}`).join(' ')}
                    fill="none"
                    stroke={m.id === selectedMaskId ? '#e5a038' : '#2d8ceb'}
                    strokeDasharray={`${width * 0.012} ${width * 0.008}`}
                    strokeWidth={width * 0.003}
                    style={{ pointerEvents: 'none' }}
                  />
                )}
                <polygon
                  points={pts.map(([x, y]) => `${x * width},${y * height}`).join(' ')}
                  fill={m.id === selectedMaskId ? 'rgba(229,160,56,0.18)' : 'rgba(45,140,235,0.12)'}
                  stroke={m.id === selectedMaskId ? '#e5a038' : '#2d8ceb'}
                  strokeWidth={width * (m.id === selectedMaskId ? 0.006 : 0.003)}
                  style={{ cursor: 'move' }}
                  onPointerDown={(e) => onBodyDown(e, mi)}
                />
                {pts.map(([x, y], k) => {
                  const on = sel.has(key(mi, k));
                  return (
                    <circle
                      key={k}
                      cx={x * width}
                      cy={y * height}
                      r={on ? r * 1.15 : r}
                      fill={on ? '#2d8ceb' : '#ffffff'}
                      stroke={on ? '#ffffff' : '#2d8ceb'}
                      strokeWidth={width * 0.004}
                      style={{ cursor: 'crosshair' }}
                      onPointerDown={(e) => onPointDown(e, mi, k)}
                    />
                  );
                })}
              </g>
            );
          })}
          {marquee && (
            <rect
              x={Math.min(marquee.x0, marquee.x1) * width}
              y={Math.min(marquee.y0, marquee.y1) * height}
              width={Math.abs(marquee.x1 - marquee.x0) * width}
              height={Math.abs(marquee.y1 - marquee.y0) * height}
              fill="rgba(255,255,255,0.08)"
              stroke="#ffffff"
              strokeDasharray={`${width * 0.01} ${width * 0.006}`}
              strokeWidth={width * 0.002}
              style={{ pointerEvents: 'none' }}
            />
          )}
        </svg>
      )}
    </>
  );
};
