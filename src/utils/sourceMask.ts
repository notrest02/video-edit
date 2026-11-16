/**
 * 원본 마스크 (R41, 2026-11-16): 마스크를 클립마다 복사하지 않고 '원본마다 하나'로 저장한다.
 *  - 저장 (프로젝트 파일 sourceMasks): 원본 경로 → 마스크 목록. 시간 = 원본 초, 꼭짓점 = 원본 화면 기준 0~1
 *  - 클립에 보일 때: 그 클립이 쓰는 원본 구간과 겹치는 원본 마스크를 클립 안 시각·클립 기본 화면 좌표로 바꿔 보여 줌
 *    (클립 기본 화면 = 움직임(위치·크기·회전) 적용 전, 원본을 시퀀스 화면에 맞춘 것. 움직임은 미리보기·내보내기가 이미 따라감)
 *  - '이 클립만' 마스크(clipOnly)는 지금처럼 클립(blurMasks)에 저장 — 예외용
 *  - 클립에서 고치면 원본 마스크로 되돌려 저장 → 그 원본을 쓰는 모든 컷에 바로 반영 (손으로 고친 자동 마스크 포함, 사용자 결정)
 * 미리보기·편집·타임라인 막대·내보내기가 모두 resolveClipMasks 를 거친다 (같은 계산).
 */
import type { AutoTextTrack, BlurMask, MaskPoint, TimelineClip } from '../types/editor';
import { tracksToMasks } from './autoMask';

export type SourceMaskMap = Record<string, BlurMask[]>;
type Dim = { w: number; h: number };

/** 원본 마스크 저장 키 (경로 대소문자·슬래시 차이 무시) */
export const srcKeyOf = (p?: string) => (p || '').split('\\').join('/').toLowerCase();

/** 원본 화면(0~1) ↔ 클립 기본 화면(0~1): 원본을 시퀀스 화면 안에 맞춤 (내보내기 scale=decrease + pad 와 같음) */
export function fitMapper(src: Dim, out: Dim) {
  const sw = src.w || out.w;
  const sh = src.h || out.h;
  const k = Math.min(out.w / sw, out.h / sh);
  const ox = (out.w - sw * k) / 2;
  const oy = (out.h - sh * k) / 2;
  return {
    toOut: ([x, y]: MaskPoint): MaskPoint => [(ox + x * sw * k) / out.w, (oy + y * sh * k) / out.h],
    toSrc: ([x, y]: MaskPoint): MaskPoint => [(x * out.w - ox) / (sw * k), (y * out.h - oy) / (sh * k)],
  };
}

const speedOf = (c: Pick<TimelineClip, 'speed'>) => (c.speed && c.speed > 0 ? c.speed : 1);

/** 이 원본 마스크가 클립 구간(원본 초 s0~s1)에 걸리는지 — resolve 와 되돌려 저장이 같은 판단을 써야 함 */
function touches(m: BlurMask, s0: number, s1: number) {
  return (m.from === undefined || m.from < s1 - 1e-6) && (m.to === undefined || m.to > s0 + 1e-6);
}

/** 원본 마스크 하나 → 클립에서 보이는 모습 (클립 안 초, 클립 기본 화면 좌표). from/to 는 클립 밖이어도 자르지 않음 (되돌릴 때 원본 구간이 줄지 않게) */
type Dir = { rev: boolean; dur: number };
function toClip(m: BlurMask, key: string, s0: number, sp: number, fit: ReturnType<typeof fitMapper>, d: Dir = { rev: false, dur: 0 }): BlurMask {
  const t = (s: number) => +(d.rev ? d.dur - (s - s0) / sp : (s - s0) / sp).toFixed(4);
  const [fa, ta] = d.rev ? [m.to, m.from] : [m.from, m.to];
  const out: BlurMask = {
    ...m,
    points: m.points.map(fit.toOut),
    from: fa === undefined ? undefined : t(fa),
    to: ta === undefined ? undefined : t(ta),
    keyframes: m.keyframes?.map((f) => ({ ...f, t: t(f.t), points: f.points.map(fit.toOut) })).sort((a, b) => a.t - b.t),
    src: key,
  };
  if (!out.keyframes) delete out.keyframes;
  delete out.clipOnly;
  return out;
}

/** 클립에서 보이는 모습 → 원본 마스크 */
function toSource(m: BlurMask, s0: number, sp: number, fit: ReturnType<typeof fitMapper>, d: Dir = { rev: false, dur: 0 }): BlurMask {
  const s = (t: number) => +(d.rev ? s0 + (d.dur - t) * sp : s0 + t * sp).toFixed(4);
  const [fa, ta] = d.rev ? [m.to, m.from] : [m.from, m.to];
  const out: BlurMask = {
    ...m,
    points: m.points.map(fit.toSrc),
    from: fa === undefined ? undefined : s(fa),
    to: ta === undefined ? undefined : s(ta),
    keyframes: m.keyframes?.map((f) => ({ ...f, t: s(f.t), points: f.points.map(fit.toSrc) })).sort((a, b) => a.t - b.t),
  };
  if (!out.keyframes) delete out.keyframes;
  delete out.src;
  delete out.clipOnly;
  return out;
}

/** 두 마스크가 같은지 (항목 순서·빈 값·표시용 항목(src, clipOnly) 무시) */
function same(a: BlurMask, b: BlurMask): boolean {
  const canon = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(canon)
      : x && typeof x === 'object'
        ? Object.keys(x as object)
            .filter((k) => k !== 'src' && k !== 'clipOnly' && (x as Record<string, unknown>)[k] !== undefined)
            .sort()
            .map((k) => [k, canon((x as Record<string, unknown>)[k])])
        : x;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** 클립에 보일 마스크 = 원본 마스크(바꿔서) + 이 클립만 마스크. 순서: 원본 마스크 먼저 */
export function resolveClipMasks(
  clip: Pick<TimelineClip, 'sourcePath' | 'sourceStart' | 'duration' | 'speed' | 'blurMasks' | 'reverse'>,
  map: SourceMaskMap | undefined,
  src: Dim,
  out: Dim
): BlurMask[] {
  const key = srcKeyOf(clip.sourcePath);
  const sp = speedOf(clip);
  const s0 = clip.sourceStart;
  const s1 = s0 + clip.duration * sp;
  const fit = fitMapper(src, out);
  const dir = { rev: !!clip.reverse, dur: clip.duration };
  const fromSrc = (map?.[key] || []).filter((m) => touches(m, s0, s1)).map((m) => toClip(m, key, s0, sp, fit, dir));
  const own = (clip.blurMasks || []).map((m) => ({ ...m, clipOnly: true }));
  return [...fromSrc, ...own];
}

/**
 * 클립 화면에서 고친 마스크 목록(next) → 원본 마스크 목록 + 이 클립만 마스크로 나눠 저장.
 *  - clipOnly=true → 클립에. 그 밖(원본에서 온 것, 새로 만든 것, '이 클립만'을 끈 것) → 원본에
 *  - 이 클립에 보이던 원본 마스크가 next 에 없으면 원본에서 지움 (모든 컷에서 지워짐)
 *  - 바뀌지 않은 원본 마스크는 저장된 값을 그대로 둠 (좌표 변환 반올림이 쌓이지 않게)
 */
export function writeBackClipMasks(
  clip: Pick<TimelineClip, 'sourcePath' | 'sourceStart' | 'duration' | 'speed' | 'blurMasks' | 'reverse'>,
  next: BlurMask[],
  map: SourceMaskMap | undefined,
  src: Dim,
  out: Dim
): { map: SourceMaskMap; clipMasks: BlurMask[] | undefined } {
  const key = srcKeyOf(clip.sourcePath);
  const sp = speedOf(clip);
  const s0 = clip.sourceStart;
  const s1 = s0 + clip.duration * sp;
  const fit = fitMapper(src, out);
  const list = map?.[key] || [];
  const shownIds = new Set(list.filter((m) => touches(m, s0, s1)).map((m) => m.id));
  const byId = new Map(list.map((m) => [m.id, m]));
  const nextSrc: BlurMask[] = [];
  const clipMasks: BlurMask[] = [];
  for (const m of next) {
    if (m.clipOnly) {
      const c = { ...m };
      delete c.clipOnly;
      delete c.src;
      clipMasks.push(c);
      continue;
    }
    const orig = byId.get(m.id);
    const dir = { rev: !!clip.reverse, dur: clip.duration };
    const unchanged = !!orig && same(toClip(orig, key, s0, sp, fit, dir), m);
    const sm = unchanged ? orig! : toSource(m, s0, sp, fit, dir);
    // '이 클립만' → 원본으로 옮길 때는 새 id (자르기·복사로 같은 id 의 이 클립만 마스크가 다른 클립에도 있을 수 있음 → id 가 겹치면 지우기·고치기가 둘 다에 걸림)
    if (!orig && m.clipOnly === false) sm.id = `${m.id}_s${Math.random().toString(36).slice(2, 7)}`;
    nextSrc.push(sm);
  }
  const keepIds = new Set(nextSrc.map((m) => m.id));
  // 이 클립에서 안 보이던 원본 마스크는 그대로, 보이던 것 중 next 에 없는 것은 지움
  const kept = list.filter((m) => !shownIds.has(m.id) && !keepIds.has(m.id));
  // 원래 순서 유지: 기존 목록 순서대로 바뀐 것을 끼우고, 새 것은 뒤에
  const merged: BlurMask[] = [];
  for (const m of list) {
    if (keepIds.has(m.id)) merged.push(nextSrc.find((x) => x.id === m.id)!);
    else if (kept.includes(m)) merged.push(m);
  }
  for (const m of nextSrc) if (!byId.has(m.id)) merged.push(m);
  const outMap = { ...(map || {}) };
  if (merged.length) outMap[key] = merged;
  else delete outMap[key];
  return { map: outMap, clipMasks: clipMasks.length ? clipMasks : undefined };
}

/** 자동 마스크를 원본 단위로 다시 넣기: 그 원본의 예전 자동 마스크만 바꾸고, 손으로 만든 원본 마스크는 그대로 */
export function replaceSourceAutoMasks(map: SourceMaskMap | undefined, path: string, auto: BlurMask[]): SourceMaskMap {
  const key = srcKeyOf(path);
  const manual = (map?.[key] || []).filter((m) => !m.auto);
  const out = { ...(map || {}) };
  const list = [...manual, ...auto];
  if (list.length) out[key] = list;
  else delete out[key];
  return out;
}

/**
 * 찾은 글자 → 원본 마스크 (원본 초, 원본 화면 좌표). 클립용 계산(tracksToMasks)에 '원본 전체 = 클립 하나'를 넣어 그대로 씀
 *  → 앞당김·늦춤, 같은 자리 합치기(R38), 움직이는 글자 따라가기가 예전과 같다. 컷 앞뒤 늘리기(R26)는 클립마다 effectiveMasks 가 함
 */
export function sourceMasksFromTracks(tracks: AutoTextTrack[], src: Dim, duration: number, margin?: number): BlurMask[] {
  const whole = { sourceStart: 0, duration: Math.max(0.1, duration), speed: 1 } as TimelineClip;
  const dims = { w: src.w || 1080, h: src.h || 1920 };
  return tracksToMasks(tracks.flatMap(splitAtJumps), whole, dims, dims, margin);
}

/**
 * 한 글자 덩어리가 화면의 다른 자리로 '뛰어' 옮겨 가면(구석을 오가는 워터마크 등) 그 지점에서 나눔.
 * 원본 전체를 한 번에 계산하면, 예전(클립 구간 안의 글자만 봄)과 달리 모든 자리를 감싸는 큰 고정 상자 하나가 되어
 * 모든 컷에 크게 가려짐 (11-16 검토). 같은 순간에 조각으로 잡힌 상자는 먼저 합친 뒤 비교. 천천히 움직이는 글자는 그대로 (키프레임)
 */
function splitAtJumps(t: AutoTextTrack): AutoTextTrack[] {
  const byT = new Map<string, { t: number; box: [number, number, number, number] }>();
  for (const p of t.samples) {
    const k = p.t.toFixed(3);
    const o = byT.get(k);
    if (!o) byT.set(k, { t: p.t, box: [...p.box] as [number, number, number, number] });
    else o.box = [Math.min(o.box[0], p.box[0]), Math.min(o.box[1], p.box[1]), Math.max(o.box[2], p.box[2]), Math.max(o.box[3], p.box[3])];
  }
  const ss = [...byT.values()].sort((a, b) => a.t - b.t);
  if (ss.length < 2) return [t];
  const groups: (typeof ss)[] = [[ss[0]]];
  for (let i = 1; i < ss.length; i++) {
    const [p, q] = [ss[i - 1], ss[i]];
    const pw = p.box[2] - p.box[0];
    const ph = p.box[3] - p.box[1];
    const dx = Math.abs((q.box[0] + q.box[2] - p.box[0] - p.box[2]) / 2);
    const dy = Math.abs((q.box[1] + q.box[3] - p.box[1] - p.box[3]) / 2);
    if (dx > Math.max(0.05, pw * 0.8) || dy > Math.max(0.05, ph * 0.8)) groups.push([q]);
    else groups[groups.length - 1].push(q);
  }
  if (groups.length === 1) return [t];
  return groups.map((g, i) => ({
    ...t,
    id: `${t.id}_j${i}`,
    start: i === 0 ? t.start : g[0].t,
    end: i === groups.length - 1 ? t.end : g[g.length - 1].t,
    samples: g,
  }));
}
