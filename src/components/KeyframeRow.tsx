/**
 * 속성 한 줄 (프리미어 효과 컨트롤처럼): 스톱워치(키프레임 켜기) · 값(슬라이더/숫자) · ◀ ◆ ▶ · 이지 · 키프레임 표시줄
 *  - 스톱워치를 켜면 지금 위치에 키프레임 생성, 그 뒤로 값을 바꾸면 지금 위치 키프레임이 생기거나 고쳐짐
 *  - 스톱워치를 끄면 키프레임을 모두 지우고 지금 값을 고정값으로
 */
import React from 'react';
import { Timer } from 'lucide-react';
import { useEditorStore } from '../store/useEditorStore';
import type { TimelineClip } from '../types/editor';
import { EASE_LABEL, keyframeAt, upsertKeyframe, valueAt, type KfEase } from '../utils/keyframes';
import { KeyframeStrip } from './KeyframeStrip';

export const KeyframeRow: React.FC<{
  clip: TimelineClip;
  prop: string;
  label: string;
  base: number;
  setBase: (v: number) => Partial<TimelineClip>;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** 모션 탭: 키프레임 표시줄을 한 줄 전체로 크게 */
  wide?: boolean;
}> = ({ clip, prop, label, base, setBase, min, max, step = 1, unit = '', wide = false }) => {
  const currentTime = useEditorStore((s) => s.currentTime);
  const updateClip = useEditorStore((s) => s.updateClip);
  const setCurrentTime = useEditorStore((s) => s.setCurrentTime);
  const kfs = clip.keyframes?.[prop];
  const on = Boolean(kfs && kfs.length);
  const t = Math.min(clip.duration, Math.max(0, currentTime - clip.startTime));
  const inside = currentTime >= clip.startTime && currentTime <= clip.startTime + clip.duration;
  const value = valueAt(kfs, t, base);
  const here = keyframeAt(kfs, t);

  const setKfs = (list: NonNullable<TimelineClip['keyframes']>[string] | undefined, history = false) => {
    const map = { ...(clip.keyframes || {}) };
    if (list && list.length) map[prop] = list;
    else delete map[prop];
    updateClip(clip.id, { keyframes: map }, history);
  };
  const change = (v: number, history = false) => {
    if (on) setKfs(upsertKeyframe(kfs, t, v), history);
    else updateClip(clip.id, setBase(v), history);
  };
  const toggle = () => {
    if (on) {
      const map = { ...(clip.keyframes || {}) };
      delete map[prop];
      updateClip(clip.id, { ...setBase(value), keyframes: map }, true);
    } else {
      setKfs(upsertKeyframe(undefined, t, value), true);
    }
  };
  const jump = (dir: -1 | 1) => {
    if (!kfs) return;
    const list = [...kfs].sort((a, b) => a.t - b.t);
    const k = dir < 0 ? [...list].reverse().find((f) => f.t < t - 1e-3) : list.find((f) => f.t > t + 1e-3);
    if (k) setCurrentTime(clip.startTime + k.t);
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <button
          onClick={toggle}
          className={`p-0.5 rounded ${on ? 'text-[#2d8ceb] bg-[#2d8ceb]/15' : 'text-[#777777] hover:text-white'}`}
          title={on ? '키프레임 끄기 (모두 지우고 지금 값으로 고정)' : '키프레임 켜기 (지금 위치에 키프레임)'}
        >
          <Timer className="w-3.5 h-3.5" />
        </button>
        <span className="text-[#bbbbbb] w-14 shrink-0">{label}</span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={on && !inside}
          onPointerDown={() => change(value, true)}
          onChange={(e) => change(Number(e.target.value))}
          className="flex-1 accent-[#2d8ceb] min-w-0"
        />
        <input
          type="number"
          value={Number(value.toFixed(step < 1 ? 2 : 0))}
          step={step}
          onChange={(e) => change(Number(e.target.value), true)}
          className="w-14 bg-[#111318] border border-[#333947] rounded px-1 py-0.5 text-[10px] text-white font-mono"
        />
        <span className="text-[#777777] w-4 text-[10px]">{unit}</span>
      </div>
      {on && (
        <div className="flex items-center gap-1 pl-6">
          <button onClick={() => jump(-1)} className="px-1 text-[#aaaaaa] hover:text-white" title="이전 키프레임">
            ◀
          </button>
          <button
            onClick={() => (here ? setKfs(kfs!.filter((f) => f !== here), true) : setKfs(upsertKeyframe(kfs, t, value), true))}
            className={`px-1 ${here ? 'text-[#2d8ceb]' : 'text-[#777777] hover:text-white'}`}
            title={here ? '이 위치 키프레임 지우기' : '이 위치에 키프레임 추가'}
          >
            ◆
          </button>
          <button onClick={() => jump(1)} className="px-1 text-[#aaaaaa] hover:text-white" title="다음 키프레임">
            ▶
          </button>
          {/* 키프레임 표시줄: 클릭 = 그 위치로, 끌기 = 키프레임 옮기기 */}
          {!wide && <KeyframeStrip
            clipStart={clip.startTime}
            duration={clip.duration}
            times={kfs!.map((f) => f.t)}
            onMove={(i, nt, history) => {
              // 끄는 동안 정렬하지 않음 (다른 키프레임을 지나쳐도 같은 키프레임을 계속 끌도록). 계산은 내부에서 시각 순으로 함
              setKfs(kfs!.map((f, j) => (j === i ? { ...f, t: nt } : f)), history);
            }}
          />}
          {wide && <div className="flex-1" />}
          <select
            value={here?.ease || 'linear'}
            disabled={!here}
            onChange={(e) => setKfs(kfs!.map((f) => (f === here ? { ...f, ease: e.target.value as KfEase } : f)), true)}
            className="bg-[#111318] border border-[#333947] rounded px-0.5 py-0.5 text-[9px] text-[#dddddd] disabled:opacity-40 max-w-[92px]"
            title="이 키프레임에서 다음 키프레임까지 움직임"
          >
            {(Object.keys(EASE_LABEL) as KfEase[]).map((k) => (
              <option key={k} value={k}>
                {EASE_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
      )}
      {on && wide && (
        <div className="pl-6">
          <KeyframeStrip
            tall
            clipStart={clip.startTime}
            duration={clip.duration}
            times={kfs!.map((f) => f.t)}
            onMove={(i, nt, history) => setKfs(kfs!.map((f, j) => (j === i ? { ...f, t: nt } : f)), history)}
          />
        </div>
      )}
    </div>
  );
};
