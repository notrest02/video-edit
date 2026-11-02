/**
 * 모션 (영상 클립): 위치 X/Y, 크기, 회전, 불투명도 — 속성마다 키프레임(스톱워치) + 이지 인/아웃
 * 위치는 출력 화면 기준 px (0 = 가운데), 크기 %, 회전 도, 불투명도 %
 */
import React from 'react';
import { useEditorStore } from '../store/useEditorStore';
import type { TimelineClip } from '../types/editor';
import { KeyframeRow } from './KeyframeRow';

export const MotionPanel: React.FC<{ clip: TimelineClip; wide?: boolean }> = ({ clip, wide }) => {
  const sequence = useEditorStore((s) => s.sequence);
  const updateClip = useEditorStore((s) => s.updateClip);
  const W = sequence.width || 1080;
  const H = sequence.height || 1920;
  return (
    <div className="bg-[#202020] border border-[#2e2e2e] rounded p-2.5 space-y-2 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-white">모션</span>
        <button
          onClick={() =>
            updateClip(clip.id, { posX: 0, posY: 0, scale: 100, rotation: 0, opacity: 1, keyframes: undefined }, true)
          }
          className="px-2 py-0.5 rounded bg-[#141414] border border-[#333333] text-[#cccccc] text-[10px]"
          title="위치·크기·회전·불투명도와 키프레임을 모두 처음으로"
        >
          초기화
        </button>
      </div>
      <KeyframeRow wide={wide} clip={clip} prop="posX" label="위치 X" base={clip.posX ?? 0} setBase={(v) => ({ posX: v })} min={-W} max={W} unit="px" />
      <KeyframeRow wide={wide} clip={clip} prop="posY" label="위치 Y" base={clip.posY ?? 0} setBase={(v) => ({ posY: v })} min={-H} max={H} unit="px" />
      <KeyframeRow wide={wide} clip={clip} prop="scale" label="크기" base={clip.scale ?? 100} setBase={(v) => ({ scale: v })} min={10} max={300} unit="%" />
      <KeyframeRow wide={wide} clip={clip} prop="rotation" label="회전" base={clip.rotation ?? 0} setBase={(v) => ({ rotation: v })} min={-360} max={360} unit="°" />
      <KeyframeRow
        wide={wide}
        clip={clip}
        prop="opacity"
        label="불투명도"
        base={(clip.opacity ?? 1) * 100}
        setBase={(v) => ({ opacity: v / 100 })}
        min={0}
        max={100}
        unit="%"
      />
    </div>
  );
};

/** 자막 모션: 위치 X/Y(화면 %), 크기(%), 회전, 불투명도 — 키프레임 */
export const TextMotionPanel: React.FC<{ clip: TimelineClip; wide?: boolean }> = ({ clip, wide }) => {
  const updateClip = useEditorStore((s) => s.updateClip);
  return (
    <div className="bg-[#202020] border border-[#2e2e2e] rounded p-2.5 space-y-2 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-white">자막 모션 (키프레임)</span>
        <button
          onClick={() => updateClip(clip.id, { textScale: 100, rotation: 0, opacity: 1, keyframes: undefined }, true)}
          className="px-2 py-0.5 rounded bg-[#141414] border border-[#333333] text-[#cccccc] text-[10px]"
          title="크기·회전·불투명도와 키프레임을 모두 처음으로 (위치 고정값은 그대로)"
        >
          초기화
        </button>
      </div>
      <KeyframeRow wide={wide} clip={clip} prop="positionX" label="위치 X" base={clip.positionX ?? 50} setBase={(v) => ({ positionX: v })} min={0} max={100} step={0.1} unit="%" />
      <KeyframeRow wide={wide} clip={clip} prop="positionY" label="위치 Y" base={clip.positionY ?? 86} setBase={(v) => ({ positionY: v })} min={0} max={100} step={0.1} unit="%" />
      <KeyframeRow wide={wide} clip={clip} prop="textScale" label="크기" base={clip.textScale ?? 100} setBase={(v) => ({ textScale: v })} min={10} max={400} unit="%" />
      <KeyframeRow wide={wide} clip={clip} prop="rotation" label="회전" base={clip.rotation ?? 0} setBase={(v) => ({ rotation: v })} min={-360} max={360} unit="°" />
      <KeyframeRow
        wide={wide}
        clip={clip}
        prop="opacity"
        label="불투명도"
        base={(clip.opacity ?? 1) * 100}
        setBase={(v) => ({ opacity: v / 100 })}
        min={0}
        max={100}
        unit="%"
      />
    </div>
  );
};
