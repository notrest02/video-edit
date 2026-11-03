/**
 * 칸 경계선 손잡이: 끌면 크기 바꾸기, 더블클릭하면 기본 크기.
 * 포인터 캡처를 써서 미리보기 영상·타임라인 위로 지나가도 끌기가 끊기지 않고, 한 프레임에 한 번만 크기를 바꾼다.
 */
import React, { useRef } from 'react';

type Props = {
  /** col = 좌우로 끄는 세로 경계선, row = 위아래로 끄는 가로 경계선 */
  dir: 'col' | 'row';
  /** 끌기 시작할 때의 값 */
  getStart: () => number;
  /** 시작 값 + 움직인 거리(px) → 새 값 적용 */
  onDrag: (start: number, deltaPx: number) => void;
  onReset: () => void;
  title?: string;
};

export const Splitter: React.FC<Props> = ({ dir, getStart, onDrag, onReset, title }) => {
  const drag = useRef<{ x: number; y: number; start: number; raf: number; last: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, start: getStart(), raf: 0, last: 0 };
    document.body.style.cursor = dir === 'col' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.last = dir === 'col' ? e.clientX - d.x : e.clientY - d.y;
    if (d.raf) return;
    d.raf = requestAnimationFrame(() => {
      d.raf = 0;
      onDrag(d.start, d.last);
    });
  };
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.raf) cancelAnimationFrame(d.raf);
    onDrag(d.start, d.last);
    drag.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      role="separator"
      aria-orientation={dir === 'col' ? 'vertical' : 'horizontal'}
      title={title ?? '끌어서 크기 조절 · 더블클릭하면 기본 크기'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      className={`shrink-0 bg-[#0a0a0a] hover:bg-[#2d8ceb]/70 active:bg-[#2d8ceb] transition-colors ${
        dir === 'col' ? 'w-[5px] h-full cursor-col-resize' : 'h-[5px] w-full cursor-row-resize'
      }`}
    />
  );
};
