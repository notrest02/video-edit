/**
 * AI 자동 배치 — 컷 자리 만들기와 배정 결과 맞추기 (tools/premiere/slot_plan.py 를 옮긴 것, 규칙/값 같음)
 *
 * 컷 자리(슬롯): 타임라인 자막이 바뀌는 시점에서만 (영상 컷 = 자막 전환, 사용자 2026-11-02).
 *   문장 끝을 가장 선호, 말끝(~서/~고/조사) 뒤 자막 경계 다음, 말 덩어리 중간 경계는 피함.
 *   한 컷 1.3초 미만 금지, ~상한(원본 샷 길이로 정함)까지 자연스러움. 한 컷이 문장 끝을 걸치지 않게.
 *   컷은 자막 전환보다 3프레임 앞 (편집자 방식) → 이후 '클립에 자막 맞추기'가 자막을 컷에 붙임
 * 맞추기(fit): 샷 경계를 절대 넘지 않음(다음 장면이 1~2프레임 비치는 것 방지), 모자라면 느리게(최저 0.6배 근처),
 *   다른 광고에서 쓴 구간과 덜 겹치는 시작점, 후킹은 지정 구간 안에서만(나눌 땐 1초 이상 조각).
 */
import type { AutoEditPlan, AutoEditShot, AutoEditSlot, TimelineClip } from '../types/editor';

const CLAUSE_END = /(서|고|데|니|까|면|도|며|만|라|요|다|지|,)$/;
const BREAK_END = /(서|고|데|니|까|면|도|며|만|라|요|다|지|,|랑|은|는|을|를|에|로|게|와|과|나)$/;
const SENT_END = /([.?!…]["'”’]*|요)$/; // '~다'는 '때마다' 같은 말이 걸려서 뺌
const CUT_LEAD_FRAMES = 3;
const MIN_SPEED = 0.8;
const MIN_SPEED_HARD = 0.6;
const EDGE = 0.05;

const lastWord = (t: string) => (t || '').trim().split(/\s+/).pop() || '';

function lenCost(L: number, hi: number) {
  const lo = Math.min(2.2, hi - 0.6);
  if (L < 1.3) return 8 + (1.3 - L) * 10;
  if (L < lo) return (lo - L) * 2;
  if (L <= hi) return 0;
  return (L - hi) * 1.2;
}

/** 컷 길이 상한: 원본 샷이 짧은 프로젝트는 컷도 짧게 (샷 길이 상위 25% + 0.5초, 2.4~4.0초) */
export function shotLenCap(shots: AutoEditShot[]): number {
  if (!shots.length) return 4;
  const d = shots.map((s) => s.dur).sort((a, b) => a - b);
  return Math.min(4, Math.max(2.4, d[Math.floor(d.length * 0.75)] + 0.5));
}

/** 타임라인 자막(시간순)으로 컷 자리 */
export function buildSlotsFromCaptions(
  caps: Array<Pick<TimelineClip, 'startTime' | 'duration' | 'text'>>,
  total: number,
  opts: { hookSec?: number; hi: number; fps: number }
): AutoEditSlot[] {
  const hookSec = opts.hookSec ?? 3;
  type Cand = { t: number; bonus: number; end: boolean };
  const cands: Cand[] = [];
  for (let i = 1; i < caps.length; i++) {
    const prev = (caps[i - 1].text || '').replace(/\n/g, ' ').trim();
    const w = lastWord(prev);
    const t = caps[i].startTime;
    if (SENT_END.test(prev)) cands.push({ t, bonus: 2.5 + 0.3, end: true });
    else if (BREAK_END.test(w.replace(/["'”’]+$/, ''))) cands.push({ t, bonus: 0.6 + (CLAUSE_END.test(w) ? 0.6 : 0), end: false });
    else cands.push({ t, bonus: -2.5, end: false }); // 말 덩어리 중간 자막 경계 → 영상은 되도록 안 바꿈
  }
  if (!cands.length) return [{ slot: 0, start: 0, end: total, dur: total, text: caps.map((c) => c.text).join(' '), hook: true, captionStart: 0 }];
  const ends = cands.filter((c) => c.end && c.t >= 1.0 && c.t <= hookSec + 0.6);
  const pool = ends.length ? ends : cands;
  const hookEnd = pool.reduce((a, c) => (Math.abs(c.t - hookSec) < Math.abs(a.t - hookSec) ? c : a), pool[0]).t;
  const pts: Cand[] = [{ t: hookEnd, bonus: 0, end: true }, ...cands.filter((c) => c.t > hookEnd + 0.5), { t: total, bonus: 0, end: true }];
  const send = cands.filter((c) => c.end).map((c) => c.t);
  const n = pts.length;
  const best = new Array<number>(n).fill(Infinity);
  const prevIdx = new Array<number>(n).fill(-1);
  best[0] = 0;
  for (let j = 1; j < n; j++) {
    for (let i = 0; i < j; i++) {
      const L = pts[j].t - pts[i].t;
      if (L > 9) continue;
      let c = best[i] + lenCost(L, opts.hi) + 1.0 - (j < n - 1 ? pts[j].bonus : 0);
      if (send.some((e) => pts[i].t + 0.8 < e && e < pts[j].t - 0.8)) c += 3.0; // 문장 끝을 걸치지 않게
      if (c < best[j]) {
        best[j] = c;
        prevIdx[j] = i;
      }
    }
  }
  const idx: number[] = [];
  for (let j = n - 1; j > 0; j = prevIdx[j]) idx.push(j);
  const times = [0, pts[0].t, ...idx.reverse().map((k) => pts[k].t)];
  const lead = (t: number) =>
    t <= 0 || t >= total - 1e-6 ? t : Math.max(0, (Math.round(t * opts.fps) - CUT_LEAD_FRAMES) / opts.fps);
  const slots: AutoEditSlot[] = [];
  for (let k = 0; k + 1 < times.length; k++) {
    const [a, b] = [times[k], times[k + 1]];
    const text = caps
      .filter((c) => c.startTime >= a - 0.02 && c.startTime < b - 0.02)
      .map((c) => (c.text || '').replace(/\n/g, ' '))
      .join(' ');
    const [la, lb] = [lead(a), lead(b)];
    slots.push({ slot: k, start: la, end: lb, dur: lb - la, text, hook: k === 0, captionStart: a });
  }
  return slots;
}

type PlanClip = AutoEditPlan['clips'][number];
type HookSpec = { path: string; from: number; to: number };
const overlap = (path: string, t0: number, t1: number, avoid: Array<[string, number, number]>) =>
  avoid.reduce((s, [p, a, b]) => s + (p === path ? Math.max(0, Math.min(t1, b) - Math.max(t0, a)) : 0), 0);

/** 후킹: 지정 구간 안 샷만 순서대로. 모자라면 나누되(1초 이상 조각) 자막 전환이면 조금 선호 */
export function hookPieces(slot: AutoEditSlot, hs: HookSpec, shots: AutoEditShot[], caps: number[]): PlanClip[] {
  const seg = shots.filter((x) => x.path === hs.path && x.end > hs.from && x.start < hs.to).sort((a, b) => a.start - b.start);
  let src = seg
    .map((x) => ({ x, a0: Math.max(x.start, hs.from), a1: Math.min(x.end, hs.to + 0.5) }))
    .filter((s) => s.a1 - s.a0 >= 0.3);
  if (src.length > 1 && src[0].a1 - src[0].a0 < 0.5) src = src.slice(1); // 지정 시각이 샷 끝자락이면 다음 샷부터
  if (!src.length) return [];
  const S = slot.start;
  const E = slot.end;
  const capset = caps.filter((c) => c >= S + 1 && c <= E - 1);
  const grid = Array.from(new Set([...Array.from({ length: Math.max(0, Math.floor((E - S - 2) / 0.1) + 1) }, (_, i) => +(S + 1 + i * 0.1).toFixed(3)), ...capset])).sort((a, b) => a - b);
  type Best = { pen: number; edges: number[]; pick: number[]; sps: number[] };
  let best: Best | null = null;
  const combos = <T,>(arr: T[], k: number): T[][] =>
    k === 0 ? [[]] : arr.flatMap((v, i) => combos(arr.slice(i + 1), k - 1).map((r) => [v, ...r]));
  for (let m = 1; m <= Math.min(3, src.length); m++) {
    for (const cut of combos(grid, m - 1)) {
      const edges = [S, ...cut, E];
      if (edges.some((e, i) => i > 0 && e - edges[i - 1] < 1 - 1e-6)) continue;
      for (const pick of combos(src.map((_, i) => i), m)) {
        let pen = 0;
        const sps = pick.map((j, k) => {
          const dur = edges[k + 1] - edges[k];
          const sp = Math.min(2, (src[j].a1 - src[j].a0 - 0.1) / dur);
          pen += dur * (Math.max(0, 0.6 - sp) * 10 + Math.max(0, 0.8 - sp) * 2);
          return sp;
        });
        pen += 0.5 * (m - 1) + 1.0 * pick[0] - 0.2 * cut.filter((c) => capset.some((x) => Math.abs(c - x) < 0.02)).length;
        if (!best || pen < best.pen) best = { pen, edges, pick, sps };
      }
    }
  }
  if (!best) return [];
  const b = best;
  return b.pick.map((j, k) => {
    const { x, a0 } = src[j];
    const sp = Math.max(0.3, Math.floor(b.sps[k] * 100) / 100);
    const dur = b.edges[k + 1] - b.edges[k];
    const srcIn = a0 + (a0 <= x.start + 0.01 ? EDGE : 0);
    return { path: x.path, file: x.file, start: b.edges[k], end: b.edges[k + 1], srcIn, speed: sp, shot: x.id, text: slot.text, hook: true };
  });
}

/** 배정 → 원본 구간/속도. 샷 경계를 넘지 않음. 같은 샷이 이어지면 이어서 재생 */
export function fitAssignment(
  slots: AutoEditSlot[],
  assign: Array<{ slot: number; shot: string; in: number }>,
  shots: AutoEditShot[],
  hook: HookSpec | null,
  avoidIn: Array<[string, number, number]>,
  caps: number[]
): { clips: PlanClip[]; warnings: string[] } {
  const byId = new Map(shots.map((s) => [s.id, s]));
  const amap = new Map(assign.map((a) => [a.slot, a]));
  const avoid = [...avoidIn];
  const clips: PlanClip[] = [];
  const warnings: string[] = [];
  let prev: PlanClip | null = null;
  for (const s of slots) {
    const D = s.end - s.start;
    if (s.hook && hook) {
      const pieces = hookPieces(s, hook, shots, caps);
      if (pieces.length) {
        for (const p of pieces) {
          clips.push(p);
          avoid.push([p.path, p.srcIn, p.srcIn + (p.end - p.start) * p.speed]);
        }
        prev = null;
        continue;
      }
      warnings.push('후킹 지정 구간에서 쓸 장면을 찾지 못해 AI 배정으로 대신함');
    }
    const a = amap.get(s.slot);
    const sh = a ? byId.get(a.shot) : undefined;
    if (!a || !sh) {
      warnings.push(`컷 ${s.slot}: 배정 없음`);
      continue;
    }
    const s0 = sh.start + EDGE;
    const s1 = sh.end - EDGE;
    const want = Math.min(Math.max(Number(a.in) || s0, s0), s1 - 0.3);
    let t0: number;
    let sp = 1;
    if (prev && prev.shot === sh.id) {
      const prevOut = prev.srcIn + (prev.end - prev.start) * prev.speed;
      if (prevOut < s1 - 0.3) {
        t0 = prevOut;
        if (s1 - t0 < D) sp = Math.max(MIN_SPEED_HARD, Math.floor(((s1 - t0) / D) * 20) / 20);
      } else t0 = s0;
    } else if (s1 - s0 >= D) {
      let bestT = want;
      let bestKey: [number, number] = [Infinity, Infinity];
      for (let t = s0; t <= s1 - D + 1e-6; t += 0.1) {
        const key: [number, number] = [Math.round(overlap(sh.path, t, t + D, avoid) * 10) / 10, Math.abs(t - want)];
        if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
          bestKey = key;
          bestT = t;
        }
      }
      t0 = bestT;
    } else {
      t0 = s0;
      sp = Math.max(MIN_SPEED_HARD, Math.floor(((s1 - s0) / D) * 20) / 20);
    }
    // 최종 안전장치: 샷 끝을 넘으면(다음 장면이 비침) 더 느리게
    if (t0! + D * sp > s1) sp = Math.floor(((s1 - t0!) / D) * 100) / 100;
    if (sp < MIN_SPEED) warnings.push(`컷 ${s.slot}: 장면 ${sh.id} 이 짧아 ${sp.toFixed(2)}배속`);
    const c: PlanClip = { path: sh.path, file: sh.file, start: s.start, end: s.end, srcIn: t0!, speed: sp, shot: sh.id, text: s.text, hook: s.hook };
    clips.push(c);
    avoid.push([sh.path, t0!, t0! + D * sp]);
    prev = c;
  }
  // 후킹 조각도 샷 경계 안전장치
  for (const c of clips) {
    const sh = c.shot ? byId.get(c.shot) : undefined;
    if (!sh) continue;
    const hi = sh.end - EDGE;
    const dur = c.end - c.start;
    if (c.srcIn + dur * c.speed > hi) c.speed = Math.floor(((hi - c.srcIn) / dur) * 100) / 100;
  }
  return { clips, warnings };
}

/** 다른 시퀀스(같은 원본으로 만든 다른 광고)에서 쓴 원본 구간 → 샷 id 별 사용 구간 */
export function usedRangesFromClips(
  clips: Array<Pick<TimelineClip, 'type' | 'sourcePath' | 'sourceStart' | 'duration' | 'speed'>>,
  shots: AutoEditShot[]
): { ranges: Array<[string, number, number]>; byShot: Array<{ shot: string; from: number; to: number }> } {
  const key = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const ranges: Array<[string, number, number]> = [];
  const byShot: Array<{ shot: string; from: number; to: number }> = [];
  for (const c of clips) {
    if (c.type !== 'video' || !c.sourcePath) continue;
    const a = c.sourceStart;
    const b = a + c.duration * (c.speed ?? 1);
    for (const s of shots) {
      if (key(s.path) !== key(c.sourcePath) || s.end <= a || s.start >= b) continue;
      ranges.push([s.path, Math.max(a, s.start), Math.min(b, s.end)]);
      byShot.push({ shot: s.id, from: +Math.max(a, s.start).toFixed(2), to: +Math.min(b, s.end).toFixed(2) });
    }
  }
  return { ranges, byShot };
}
