/**
 * 화면 칸 크기 (경계선을 끌어서 바꿈) — App.tsx 의 Splitter 와 각 패널이 같이 읽는다.
 * localStorage 에 저장해서 다음에 켜도 같은 크기. 경계선을 더블클릭하면 기본 크기로.
 * 칸마다 최소/최대가 있고, 가운데 미리보기·타임라인은 최소 폭을 남긴다 (창이 작아져도 깨지지 않게 그릴 때 다시 맞춤).
 */
import { create } from 'zustand';

export type InspectorTab = 'props' | 'motion';

type Sizes = {
  leftW: number; // 왼쪽 패널 (대본·캡션 STEP)
  rightW: Record<InspectorTab, number>; // 오른쪽 속성 패널 (탭마다 따로: 모션 탭은 키프레임 때문에 넓게)
  topFrac: number; // 위쪽(패널·미리보기) 높이 비율
  binW: number; // 아래 왼쪽 미디어 목록
};

export const LAYOUT_DEFAULT: Sizes = { leftW: 430, rightW: { props: 310, motion: 460 }, topFrac: 0.54, binW: 430 };

export const LIMITS = {
  leftW: [430, 760], // 430(기본) 아래로 가면 STEP 탭 이름이 잘림
  rightW: { props: [260, 640], motion: [400, 820] },
  topFrac: [0.28, 0.8],
  binW: [360, 760],
  centerMin: 360, // 미리보기가 최소한 남길 폭
  timelineMin: 560, // 타임라인이 최소한 남길 폭 (도구 막대가 잘리지 않게)
} as const;

const KEY = 'layout.sizes.v1';
const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

function load(): Sizes {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!s) return LAYOUT_DEFAULT;
    return {
      leftW: clamp(Number(s.leftW) || LAYOUT_DEFAULT.leftW, LIMITS.leftW),
      rightW: {
        props: clamp(Number(s.rightW?.props) || LAYOUT_DEFAULT.rightW.props, LIMITS.rightW.props),
        motion: clamp(Number(s.rightW?.motion) || LAYOUT_DEFAULT.rightW.motion, LIMITS.rightW.motion),
      },
      topFrac: clamp(Number(s.topFrac) || LAYOUT_DEFAULT.topFrac, LIMITS.topFrac),
      binW: clamp(Number(s.binW) || LAYOUT_DEFAULT.binW, LIMITS.binW),
    };
  } catch {
    return LAYOUT_DEFAULT;
  }
}

type LayoutState = Sizes & {
  inspectorTab: InspectorTab;
  setInspectorTab: (t: InspectorTab) => void;
  set: (patch: Partial<Sizes>) => void;
  reset: (key: keyof Sizes) => void;
};

let saveTimer: ReturnType<typeof setTimeout> | undefined;
const save = (s: Sizes) => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(s)), 300);
};
const pick = (s: LayoutState): Sizes => ({ leftW: s.leftW, rightW: s.rightW, topFrac: s.topFrac, binW: s.binW });

export const useLayoutStore = create<LayoutState>((setState, get) => ({
  ...load(),
  inspectorTab: (() => {
    try {
      return localStorage.getItem('agy_inspector_tab') === 'motion' ? 'motion' : 'props';
    } catch {
      return 'props';
    }
  })(),
  setInspectorTab: (t) => setState({ inspectorTab: t }),
  set: (patch) => {
    setState(patch);
    save(pick(get()));
  },
  reset: (key) => {
    setState({ [key]: key === 'rightW' ? { ...get().rightW, [get().inspectorTab]: LAYOUT_DEFAULT.rightW[get().inspectorTab] } : LAYOUT_DEFAULT[key] } as Partial<Sizes>);
    save(pick(get()));
  },
}));

/** 창 폭에 맞춰 실제로 쓸 위쪽 줄 폭: 미리보기가 centerMin 이상 남도록 왼쪽·오른쪽을 줄인다 */
export function fitTopRow(winW: number, leftW: number, rightW: number): { left: number; right: number } {
  const room = winW - LIMITS.centerMin - 12; // 경계선 두 개
  if (leftW + rightW <= room) return { left: leftW, right: rightW };
  const over = leftW + rightW - room;
  const l = Math.max(LIMITS.leftW[0], leftW - over * (leftW / (leftW + rightW)));
  return { left: l, right: Math.max(240, room - l) };
}

/** 아래 줄: 타임라인이 timelineMin 이상 남도록 미디어 목록 폭을 줄인다 */
export const fitBin = (winW: number, binW: number) => Math.max(260, Math.min(binW, winW - LIMITS.timelineMin - 6));
