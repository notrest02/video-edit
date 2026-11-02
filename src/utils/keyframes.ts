/**
 * 공통 키프레임 (프리미어 '효과 컨트롤'의 스톱워치/키프레임과 같은 개념)
 *  - 클립마다 속성 이름 → [{t: 클립 안 시각(초), v: 값, ease}] 목록
 *  - ease 는 '이 키프레임에서 다음 키프레임까지' 움직임: 선형 / 천천히 시작(easeIn) / 천천히 끝(easeOut) / 둘 다 / 멈춤(hold)
 *  - 미리보기는 valueAt, 내보내기(ffmpeg)는 같은 계산을 식으로 만든 ffExpr 를 씀 → 결과가 같음
 * 이 파일은 화면(DOM)에 의존하지 않음 (electron 메인 프로세스에서도 import)
 */
export type KfEase = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold';
export type Keyframe = { t: number; v: number; ease?: KfEase };
export type KeyframeMap = Record<string, Keyframe[]>;

export const EASE_LABEL: Record<KfEase, string> = {
  linear: '선형',
  easeIn: '천천히 시작 (Ease In)',
  easeOut: '천천히 끝 (Ease Out)',
  easeInOut: '천천히 시작·끝 (Ease In/Out)',
  hold: '멈춤 (Hold)',
};

export function easeFn(e: KfEase | undefined, r: number): number {
  const x = Math.min(1, Math.max(0, r));
  switch (e) {
    case 'easeIn':
      return x * x;
    case 'easeOut':
      return 1 - (1 - x) * (1 - x);
    case 'easeInOut':
      return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
    case 'hold':
      return 0;
    default:
      return x;
  }
}

const sorted = (kfs: Keyframe[]) => [...kfs].sort((a, b) => a.t - b.t);

/** 클립 안 시각 t 의 값. 키프레임이 없으면 base */
export function valueAt(kfs: Keyframe[] | undefined, t: number, base: number): number {
  if (!kfs || kfs.length === 0) return base;
  const ks = sorted(kfs);
  if (t <= ks[0].t) return ks[0].v;
  const last = ks[ks.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i + 1 < ks.length; i++) {
    const [a, b] = [ks[i], ks[i + 1]];
    if (t >= a.t && t < b.t) return a.v + (b.v - a.v) * easeFn(a.ease, (t - a.t) / Math.max(1e-6, b.t - a.t));
  }
  return last.v;
}

/** 진행률 r(0~1, ffmpeg 식) 에 ease 를 적용한 ffmpeg 식 */
function ffEase(e: KfEase | undefined, r: string): string {
  switch (e) {
    case 'easeIn':
      return `(${r})*(${r})`;
    case 'easeOut':
      return `(1-(1-(${r}))*(1-(${r})))`;
    case 'easeInOut':
      return `if(lt(${r},0.5),2*(${r})*(${r}),1-2*(1-(${r}))*(1-(${r})))`;
    case 'hold':
      return '0';
    default:
      return `(${r})`;
  }
}

const n = (x: number) => (Math.abs(x) < 1e-9 ? '0' : Number(x.toFixed(5)).toString());

/**
 * valueAt 과 같은 값을 내는 ffmpeg 식. T = 클립 안 시각을 나타내는 식 (예: '(t-12.5)')
 * 반드시 작은따옴표 안에 넣어 쓸 것 (쉼표 포함)
 */
export function ffExpr(kfs: Keyframe[] | undefined, base: number, T: string): string {
  if (!kfs || kfs.length === 0) return n(base);
  const ks = sorted(kfs);
  if (ks.length === 1) return n(ks[0].v);
  let expr = n(ks[ks.length - 1].v);
  for (let i = ks.length - 2; i >= 0; i--) {
    const [a, b] = [ks[i], ks[i + 1]];
    const r = `((${T})-${n(a.t)})/${n(Math.max(1e-6, b.t - a.t))}`;
    const seg = `${n(a.v)}+${n(b.v - a.v)}*${ffEase(a.ease, r)}`;
    expr = `if(lt(${T},${n(b.t)}),${seg},${expr})`;
  }
  return `if(lt(${T},${n(ks[0].t)}),${n(ks[0].v)},${expr})`;
}

/** t 에 키프레임을 넣거나(같은 시각이면 값만) 바꿈 */
export function upsertKeyframe(kfs: Keyframe[] | undefined, t: number, v: number, ease?: KfEase): Keyframe[] {
  const list = (kfs || []).filter((k) => Math.abs(k.t - t) > 1 / 120);
  const prev = (kfs || []).find((k) => Math.abs(k.t - t) <= 1 / 120);
  return sorted([...list, { t: +t.toFixed(4), v, ease: ease ?? prev?.ease ?? 'linear' }]);
}

export const keyframeAt = (kfs: Keyframe[] | undefined, t: number) => (kfs || []).find((k) => Math.abs(k.t - t) <= 1 / 120);

/** 클립 앞을 잘라낼 때(구간 내보내기 등) 키프레임 시각을 그만큼 당김 */
export function shiftKeyframes(map: KeyframeMap | undefined, dt: number): KeyframeMap | undefined {
  if (!map) return map;
  const out: KeyframeMap = {};
  for (const [k, list] of Object.entries(map)) out[k] = list.map((f) => ({ ...f, t: f.t - dt }));
  return out;
}

/** 자막 모션 속성 (위치는 화면 %, 크기 %, 회전 도, 불투명도 %) */
export const TEXT_MOTION = ['positionX', 'positionY', 'textScale', 'rotation', 'opacity'] as const;

/** 자막 클립의 t(클립 안 초) 시점 모습: 키프레임이 있는 속성만 그 시점 값으로 바꾼 사본 */
export function resolveTextAt<C extends {
  keyframes?: KeyframeMap;
  positionX?: number;
  positionY?: number;
  textScale?: number;
  rotation?: number;
  opacity?: number;
}>(clip: C, t: number): C {
  const kf = clip.keyframes;
  if (!kf || !TEXT_MOTION.some((k) => kf[k]?.length)) return clip;
  return {
    ...clip,
    positionX: valueAt(kf.positionX, t, clip.positionX ?? 50),
    positionY: valueAt(kf.positionY, t, clip.positionY ?? 86),
    textScale: valueAt(kf.textScale, t, clip.textScale ?? 100),
    rotation: valueAt(kf.rotation, t, clip.rotation ?? 0),
    opacity: Math.min(1, Math.max(0, valueAt(kf.opacity, t, (clip.opacity ?? 1) * 100) / 100)),
  };
}

export const hasTextMotionKeyframes = (clip: { keyframes?: KeyframeMap }) =>
  Boolean(clip.keyframes && TEXT_MOTION.some((k) => clip.keyframes![k]?.length));

/** 영상 클립 모션 속성: 이름 → [기본값 읽기] */
export const VIDEO_MOTION = ['posX', 'posY', 'scale', 'rotation', 'opacity'] as const;
export type VideoMotionKey = (typeof VIDEO_MOTION)[number];
