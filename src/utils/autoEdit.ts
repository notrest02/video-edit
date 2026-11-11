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
import type { AutoEditPlan, AutoEditShot, AutoEditShotDesc, AutoEditSlot, TimelineClip } from '../types/editor';

const CLAUSE_END = /(서|고|데|니|까|면|도|며|만|라|요|다|지|,)$/;
const BREAK_END = /(서|고|데|니|까|면|도|며|만|라|요|다|지|,|랑|은|는|을|를|에|로|게|와|과|나)$/;
/** '다'로 끝나도 말끝(했다/좋다/한다…)일 때만 끊김. 베란다·바다·사이다·때마다·거기다 같은 낱말은 끊김 아님 */
const DA_OK = /(했|었|았|였|겠|니|는|한|된|진|졌|렸|봤|왔|갔|줬|났|웠|냈|섰|켰|하|좋|크|쉽|많|없|있|같|싶|길|짧|넓|좁|높|낮|깊|싸|쁘|르|답|롭|럽|맵|짜|놓|넣|쓰|보|주|가|온|간|운|른|든|낸|난|된|썼|샀|맞|않)다$/;
/** '나'는 ~이나/~거나 같은 말끝일 때만 (인형 하나 ✗) */
const NA_OK = /(이|거|든|으|던|는|었|았|했|겠|지)나$/;
/** '요'로 끝나는 낱말 (필요·중요…)은 문장 끝 아님 */
const YO_NOUN = /(필|중|주|소)요$/;
const CUT_LEAD_FRAMES = 3;
const MIN_SPEED = 0.8;
const MIN_SPEED_HARD = 0.6;
const EDGE = 0.06;
/** 컷 처음·끝에서 이만큼(초) 안에 원본의 약한 화면 전환이 있으면 그 자리에 놓지 않음 (R28) */
const SOFT_EDGE = 0.15;
/** 절대 선: 컷 최소 길이(초) */
const MIN_CUT = 1.3;
const MIN_CUT_HARD = 1.2;
/** 점수로는 넘을 수 없게 하는 큰 벌점 */
const HARD = 40;

const lastWord = (t: string) => (t || '').trim().split(/\s+/).pop() || '';

/** 자막 끝 말투: 문장 끝 / 말끝(쉬어도 되는 자리) / 약한 끊김 / 말 덩어리 중간. 문장 끝과 끊김 판단이 같은 기준을 씀 */
export function endKind(text: string): 'sent' | 'clause' | 'break' | 'mid' {
  const t = (text || '').replace(/\n/g, ' ').trim();
  if (/[.?!…]["'”’]*$/.test(t)) return 'sent';
  const w = lastWord(t).replace(/["'”’]+$/, '');
  if (/요$/.test(w)) return YO_NOUN.test(w) ? 'mid' : 'sent';
  if (/다$/.test(w)) return DA_OK.test(w) ? 'clause' : 'mid';
  if (/나$/.test(w)) return NA_OK.test(w) ? 'break' : 'mid';
  if (CLAUSE_END.test(w)) return 'clause';
  if (BREAK_END.test(w)) return 'break';
  return 'mid';
}

/** 절대 선: 컷 최대 길이(초). 원본 샷이 짧은 프로젝트는 상한도 짧게 */
export const maxCutLen = (hi: number) => Math.max(4.0, hi + 1.6);

function lenCost(L: number, hi: number) {
  const lo = Math.min(2.2, hi - 0.6);
  // 1.2초 미만은 절대 금지, 1.2~1.3초는 '되도록 피함' (말이 짧게 끊기는 자리를 억지로 피하다 말 중간에서 자르는 것보다 나음)
  if (L < MIN_CUT_HARD) return HARD + (MIN_CUT_HARD - L) * 10;
  if (L < MIN_CUT) return 2 + (MIN_CUT - L) * 20;
  if (L > maxCutLen(hi)) return HARD + (L - maxCutLen(hi)) * 10;
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

/** 후킹 지정 구간에서 실제로 쓸 수 있는 원본 길이(초). 샷 경계 안쪽만, 큰 조각 3개까지 (hookPieces와 같은 기준) */
export function hookCapacity(hs: HookSpec, shots: AutoEditShot[]): number {
  const lens = shots
    .filter((x) => x.path === hs.path && x.end - EDGE > hs.from && x.start + EDGE < hs.to)
    .map((x) => Math.min(x.end - EDGE, hs.to + 0.5) - Math.max(x.start + EDGE, hs.from))
    .filter((l) => l >= 0.3)
    .sort((a, b) => b - a);
  return lens.slice(0, 3).reduce((a, b) => a + b, 0);
}

/** 후킹도 일반 컷과 같은 최저 속도 (사용자 2026-11-07: 모든 컷 최저 0.6배로 안정성) */
const HOOK_MIN_SPEED = MIN_SPEED_HARD;
/** 후킹 장면이 자리보다 길 때 빠르게 하는 한도 (그보다 길면 장면 일부만 씀) */
const HOOK_MAX_SPEED = 1.5;
/** 문장 끝 이 시간(초) 안쪽에서 새 컷을 시작하지 않음 → "하더라고요." 같은 맺음말만 잠깐 보이고 다시 넘어가는 컷 방지 */
const TAIL_SEC = 1.1;

/** 타임라인 자막(시간순)으로 컷 자리 */
export function buildSlotsFromCaptions(
  caps: Array<Pick<TimelineClip, 'startTime' | 'duration' | 'text'> & { voiceEndTime?: number }>,
  total: number,
  opts: { hookSec?: number; hookCap?: number; hi: number; fps: number }
): AutoEditSlot[] {
  const hookSec = opts.hookSec ?? 3;
  type Cand = { t: number; bonus: number; end: boolean; mid: boolean; pseudo?: boolean };
  const cands: Cand[] = [];
  const MAXL = maxCutLen(opts.hi);
  for (let i = 0; i < caps.length; i++) {
    const cur = caps[i];
    // 아주 긴 자막(쉬지 않고 길게 말함): 자막 경계만으로는 자를 곳이 없어 컷이 너무 길어짐
    //  → 띄어쓰기 자리(글자 수 비율로 시간 추정)를 '최후의 컷 자리'로 추가. 점수가 가장 낮아 꼭 필요할 때만 쓰임
    const vEnd = cur.voiceEndTime ?? cur.startTime + cur.duration;
    if (vEnd - cur.startTime > MAXL * 0.75) {
      const words = (cur.text || '').replace(/\n/g, ' ').trim().split(/\s+/);
      const totalChars = words.join('').length || 1;
      let acc = 0;
      for (let k = 0; k < words.length - 1; k++) {
        acc += words[k].length;
        const kind = endKind(words[k]);
        cands.push({ t: cur.startTime + (vEnd - cur.startTime) * (acc / totalChars), bonus: kind === 'mid' ? -6 : -4, end: false, mid: true, pseudo: true });
      }
    }
    if (i === 0) continue;
    const prev = caps[i - 1].text || '';
    const t = cur.startTime;
    // 말 쉼(앞 자막 목소리 끝 → 다음 자막 시작): 길면 아주 조금 선호, 목소리가 다음 말과 겹치면(쉼 없음) 끊김 점수를 낮춤
    const pv = caps[i - 1];
    const gap = t - (pv.voiceEndTime ?? pv.startTime + pv.duration);
    const pause = Math.min(0.35, Math.max(0, gap - 0.1) * 0.7) - (gap < -0.05 ? 0.6 : 0);
    const kind = endKind(prev);
    if (kind === 'sent') cands.push({ t, bonus: 2.5 + 0.3 + Math.max(0, pause), end: true, mid: false });
    else if (kind === 'clause') cands.push({ t, bonus: 1.2 + pause, end: false, mid: false });
    else if (kind === 'break') cands.push({ t, bonus: 0.6 + pause, end: false, mid: false });
    else cands.push({ t, bonus: -2.5, end: false, mid: true }); // 말 덩어리 중간 자막 경계 → 영상은 되도록 안 바꿈
  }
  cands.sort((a, b) => a.t - b.t);
  const whole = (): AutoEditSlot[] => [{ slot: 0, start: 0, end: total, dur: total, text: caps.map((c) => c.text).join(' '), hook: true, captionStart: 0 }];
  if (!cands.length) return whole();
  const send = cands.filter((c) => c.end).map((c) => c.t);
  const sendAll = [...send, total];
  // 이 시점에서 다음 문장 끝까지 남은 시간 (문장 끝 바로 위면 0)
  const toEnd = (t: number) => {
    const e = sendAll.find((x) => x > t + 0.02);
    return send.some((x) => Math.abs(x - t) < 0.02) ? 0 : e === undefined ? Infinity : e - t;
  };
  const isTail = (t: number) => {
    const r = toEnd(t);
    return r > 0 && r < TAIL_SEC;
  };
  // 후킹 끝 (사용자 2026-11-07: 후킹은 '3초'가 아니라 '지정 장면이 자연스럽게 담기는 길이')
  //  기준 길이 = 지정 장면을 보통 속도로 틀었을 때 길이(hookCap). 장면이 아주 길면(긴 원본) 일부만 쓰므로 대본의 초를 기준으로.
  //  후보(자막 경계) 중: 0.6배(모든 컷 공통 최저)~1.5배로 채울 수 있고, 뒤에 1.3초 이상 남고, 맺음말 꼬리가 아닌 곳.
  //  점수 = 자리 종류(문장 끝 > 말끝 > 약한 끊김 > 말 중간) + 기준 길이에서 멀어진 정도 → 가장 낮은 곳
  const cap = opts.hookCap && opts.hookCap > 0.5 ? opts.hookCap : undefined;
  const target = cap ? (cap <= 4.5 ? Math.max(1.5, cap) : hookSec) : hookSec;
  const longest = cap ? cap / HOOK_MIN_SPEED : Math.max(hookSec + 0.6, MAXL);
  const kindPen = (c: Cand) => (c.end ? 0 : !c.mid ? (c.bonus >= 1.2 ? 0.5 : 1.0) : c.pseudo ? 6 : 3);
  const hookScore = (c: Cand) => kindPen(c) + 2.5 * Math.abs(Math.log(c.t / target)) + (isTail(c.t) ? 4 : 0);
  const pool1 = cands.filter((c) => c.t >= 1.0 && c.t <= total - MIN_CUT && c.t <= longest && !c.pseudo);
  // 광고가 너무 짧아 나눌 수 없으면 광고 전체가 후킹 한 컷 / 긴 자막뿐이면 자막 중간 자리도
  const pool = pool1.length ? pool1 : total > MAXL ? cands.filter((c) => c.t >= 1.0 && c.t <= Math.min(MAXL, total - MIN_CUT)) : [];
  if (!pool.length) return whole();
  const hookEnd = pool.reduce((x, c) => (hookScore(c) < hookScore(x) ? c : x), pool[0]).t;
  const pts: Cand[] = [{ t: hookEnd, bonus: 0, end: true, mid: false }, ...cands.filter((c) => c.t > hookEnd + 0.5), { t: total, bonus: 0, end: true, mid: false }];
  const n = pts.length;
  const best = new Array<number>(n).fill(Infinity);
  const prevIdx = new Array<number>(n).fill(-1);
  best[0] = 0;
  for (let j = 1; j < n; j++) {
    const tail = j < n - 1 && isTail(pts[j].t) ? 6.0 : 0; // 맺음말 꼬리에서 새 컷 시작 금지에 가깝게
    for (let i = 0; i < j; i++) {
      const L = pts[j].t - pts[i].t;
      // 길이 절대 선(1.3초~최대 길이)은 lenCost 의 큰 벌점으로: 어떤 경우에도 길이 바깥 컷이 생기지 않음 (경로는 항상 있음)
      let c = best[i] + lenCost(L, opts.hi) + 1.0 - (j < n - 1 ? pts[j].bonus : 0) + tail;
      // 문장 끝을 걸치지 않게 (꼬리 컷보다 약간 덜 나쁨: 둘 다 피할 수 없을 때 꼬리 컷을 더 피함)
      if (send.some((e) => pts[i].t + 0.8 < e && e < pts[j].t - 0.8)) c += 4.5;
      // 한 문장 = 한 흐름: 앞뒤가 모두 문장 중간인 컷(한 문장을 3컷 이상으로 쪼갬)은 되도록 피함 (사용자 2026-11-05: 템포가 너무 빠름)
      const isEnd = (t: number) => t <= 0 || t >= total - 1e-6 || send.some((e) => Math.abs(e - t) < 0.02);
      if (j < n - 1 && !isEnd(pts[i].t) && !isEnd(pts[j].t) && !send.some((e) => pts[i].t + 0.02 < e && e < pts[j].t - 0.02)) c += 1.8;
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
    t <= 0 || t >= total - 1e-6 ? t : Math.max(0, (Math.round(t * opts.fps + 0.001) - CUT_LEAD_FRAMES) / opts.fps); // +0.001: 반 프레임 경계에서 소수점 오차로 반올림이 뒤집히지 않게
  const slots: AutoEditSlot[] = [];
  for (let k = 0; k + 1 < times.length; k++) {
    const [a, b] = [times[k], times[k + 1]];
    // 자막이 이 컷 안에서 시작하거나, 긴 자막 중간에서 잘린 경우 그 자막도 (AI가 대사를 알아야 함)
    const text = caps
      .filter((c) => (c.startTime >= a - 0.02 && c.startTime < b - 0.02) || (c.startTime < a - 0.02 && c.startTime + c.duration > a + 0.3))
      .map((c) => (c.text || '').replace(/\n/g, ' '))
      .join(' ');
    const [la, lb] = [lead(a), lead(b)];
    slots.push({ slot: k, start: la, end: lb, dur: lb - la, text, hook: k === 0, captionStart: a });
  }
  // 문장 단위 정보: 문장 = 문장 끝 자막까지 묶음
  const sents: Array<{ a: number; b: number; text: string }> = [];
  let cur: string[] = [];
  let sa = caps.length ? caps[0].startTime : 0;
  caps.forEach((c, i) => {
    cur.push((c.text || '').replace(/\n/g, ' ').trim());
    const last = i === caps.length - 1;
    if (endKind(c.text || '') === 'sent' || last) {
      sents.push({ a: sa, b: last ? total : caps[i + 1].startTime, text: cur.join(' ') });
      cur = [];
      if (!last) sa = caps[i + 1].startTime;
    }
  });
  slots.forEach((s, k) => {
    const a0 = s.captionStart;
    const b0 = times[k + 1];
    s.sentence = sents.filter((x) => x.b > a0 + 0.02 && x.a < b0 - 0.02).map((x) => x.text).join(' ');
    s.cont = k > 0 && !send.some((e) => Math.abs(e - a0) < 0.02);
    s.next = slots[k + 1]?.text;
  });
  return slots;
}

type PlanClip = AutoEditPlan['clips'][number];
type HookSpec = { path: string; from: number; to: number };
const overlap = (path: string, t0: number, t1: number, avoid: Array<[string, number, number]>) =>
  avoid.reduce((s, [p, a, b]) => s + (p === path ? Math.max(0, Math.min(t1, b) - Math.max(t0, a)) : 0), 0);

/** 후킹: 지정 구간 안 샷만 순서대로. 모자라면 나누되(1초 이상 조각) 자막 전환이면 조금 선호 */
export function hookPieces(slot: AutoEditSlot, hs: HookSpec, shots: AutoEditShot[], caps: number[]): PlanClip[] {
  const seg = shots.filter((x) => x.path === hs.path && x.end - EDGE > hs.from && x.start + EDGE < hs.to).sort((a, b) => a.start - b.start);
  let src = seg
    .map((x) => ({ x, a0: Math.max(x.start + EDGE, hs.from), a1: Math.min(x.end - EDGE, hs.to + 0.5) }))
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
          const sp = Math.min(HOOK_MAX_SPEED, (src[j].a1 - src[j].a0) / dur);
          // 0.6배 아래는 사실상 금지, 그 위에서는 보통 속도(1배)에 가까울수록 좋게 (느린 쪽은 아주 약하게)
          pen += dur * (Math.max(0, HOOK_MIN_SPEED - sp) * 10 + Math.max(0, 0.8 - sp) * 0.8);
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
    const { x, a1 } = src[j];
    let { a0 } = src[j];
    const dur = b.edges[k + 1] - b.edges[k];
    let sp = Math.max(MIN_SPEED_HARD, Math.floor(b.sps[k] * 100) / 100);
    // 0.6배로도 모자라면: 같은 샷 안에서 시작을 조금 앞당김 (지정 시각보다 약간 앞이라도 같은 장면). 그래도 모자라면 그만큼만 느리게 (검사기가 알림)
    if (a0 + dur * sp > x.end - EDGE) {
      a0 = Math.max(x.start + EDGE, Math.min(a1, x.end - EDGE) - dur * sp);
      if (a0 + dur * sp > x.end - EDGE) sp = Math.floor(((x.end - EDGE - a0) / dur) * 100) / 100;
    }
    return { path: x.path, file: x.file, start: b.edges[k], end: b.edges[k + 1], srcIn: a0, speed: sp, shot: x.id, text: slot.text, hook: true };
  });
}

/**
 * 배정 → 원본 구간/속도. 절대 선:
 *  - 빈 자리 없음: AI 답이 없거나 틀리면 2순위(alt) → 같은 영상 이어지는 장면 → 다른 장면 순으로 코드가 대신 고름
 *  - 0.6배보다 느리게 늘이지 않음: 장면이 자리보다 너무 짧으면 그 장면은 쓰지 않음
 *  - 샷 경계를 넘지 않음 (다음 장면 1~2프레임 비침 방지): 넘을 것 같으면 느리게가 아니라 시작을 앞당김
 *  - 한 광고 안에서 같은 장면 부분을 다시 쓰지 않음 (바로 앞 컷을 이어서 재생하는 건 허용)
 */
export function fitAssignment(
  slots: AutoEditSlot[],
  assign: Array<{ slot: number; shot: string; in: number; alt?: string; focus?: string }>,
  shots: AutoEditShot[],
  hook: HookSpec | null,
  avoidIn: Array<[string, number, number]>,
  caps: number[],
  descs?: AutoEditShotDesc[]
): { clips: PlanClip[]; warnings: string[] } {
  const byId = new Map(shots.map((s) => [s.id, s]));
  const descById = new Map((descs || []).map((d) => [d.id, d]));
  const amap = new Map(assign.map((a) => [a.slot, a]));
  const avoid = [...avoidIn];
  const usedHere: Array<[string, number, number]> = []; // 이 광고 안에서 쓴 원본 구간
  const clips: PlanClip[] = [];
  const warnings: string[] = [];
  let prev: PlanClip | null = null;
  // 후킹 바로 다음 컷은 후킹에 쓴 샷을 (다른 부분이라도) 쓰지 않음 → 후킹 장면이 그대로 이어져 보이는 것 방지 (사용자 2026-11-07)
  let hookShots = new Set<string>();
  let afterHook = false;
  type Place = { sh: AutoEditShot; t0: number; sp: number; ok: boolean; why?: 'soft' };
  // 한 장면을 이 자리에 놓는 방법: 이어서 재생 / 자리보다 길면 겹침 적은 시작점 / 짧으면 느리게(0.6배까지만)
  // 같은 영상의 '다른' 샷을 바로 이어 붙이면 같은 컷이 두 번 나온 것처럼 보임 (사용자 2026-11-08). 이어 쓰기·시간상 바로 다음 샷은 괜찮음
  const shotNo = (id: string) => Number(id.split('-').pop());
  // R13 (사용자 2026-11-11): 같은 영상이라도 '바로 앞 컷과 똑같아 보일 때'만 막음 (창문 유리 문장처럼 같은 장소를 이어 가야 할 때가 있음).
  //  장면 분석이 없으면 판단할 수 없으니 예전처럼 같은 영상의 다른 부분은 모두 막음
  const jumpsSameVideo = (sh: AutoEditShot) =>
    !!prev &&
    prev.path === sh.path &&
    prev.shot !== sh.id &&
    !(prev.shot && shotNo(sh.id) === shotNo(prev.shot) + 1) &&
    looksSameShot(prev.shot ? descById.get(prev.shot) : undefined, descById.get(sh.id));
  // 약한 화면 전환(sh.soft)이 컷의 처음·끝 SOFT_EDGE 초 안에 걸리면 원본의 다음 화면이 1~3프레임 번쩍임 (R28)
  const flashes = (sh: AutoEditShot, a: number, b: number) =>
    (sh.soft || []).some((x) => (x > a + 1e-3 && x < a + SOFT_EDGE) || (x > b - SOFT_EDGE && x < b - 1e-3));
  const place = (sh: AutoEditShot, D: number, wantIn: number): Place => {
    const p = placeRaw(sh, D, wantIn);
    if (p.ok && flashes(sh, p.t0, p.t0 + D * p.sp)) return { ...p, ok: false, why: 'soft' };
    return p;
  };
  const placeRaw = (sh: AutoEditShot, D: number, wantIn: number): Place => {
    if (afterHook && hookShots.has(sh.id)) return { sh, t0: sh.start + EDGE, sp: 1, ok: false };
    if (jumpsSameVideo(sh)) return { sh, t0: sh.start + EDGE, sp: 1, ok: false };
    const s0 = sh.start + EDGE;
    const s1 = sh.end - EDGE;
    if (prev && prev.shot === sh.id) {
      const t0 = prev.srcIn + (prev.end - prev.start) * prev.speed;
      const sp = Math.min(1, Math.floor(((s1 - t0) / D) * 20) / 20);
      return { sh, t0, sp, ok: sp >= MIN_SPEED_HARD };
    }
    if (s1 - s0 >= D) {
      // 핵심 순간(분석의 key)이 있으면 그 순간이 컷 안(앞뒤 0.15초 여유)에 들어가는 시작점만 고려
      const key = descById.get(sh.id)?.key;
      let lo = s0;
      let hiT = s1 - D;
      if (typeof key === 'number' && key > s0 && key < s1) {
        const lo2 = Math.max(lo, key - D + 0.15);
        const hi2 = Math.min(hiT, key - 0.15);
        if (lo2 <= hi2) [lo, hiT] = [lo2, hi2];
      }
      const want = Math.min(Math.max(wantIn || lo, lo), hiT);
      let bestT = want;
      let bestKey: [number, number, number] = [Infinity, Infinity, Infinity];
      for (let t = lo; t <= hiT + 1e-6; t += 0.05) {
        if (flashes(sh, t, t + D)) continue; // 약한 전환이 컷 처음·끝에 걸리는 시작점은 건너뜀
        const key: [number, number, number] = [
          Math.round(overlap(sh.path, t, t + D, usedHere) * 10),
          Math.round(overlap(sh.path, t, t + D, avoid) * 10),
          Math.abs(t - want),
        ];
        if (key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
          bestKey = key;
          bestT = t;
        }
      }
      return { sh, t0: bestT, sp: 1, ok: overlap(sh.path, bestT, bestT + D, usedHere) <= 0.2 };
    }
    const sp = Math.floor(((s1 - s0) / D) * 20) / 20;
    return { sh, t0: s0, sp, ok: sp >= MIN_SPEED_HARD && overlap(sh.path, s0, s1, usedHere) <= 0.2 };
  };
  const why = (sh: AutoEditShot | undefined, p: Place | null) =>
    !sh ? '없는 장면' : afterHook && hookShots.has(sh.id) ? '후킹과 같은 장면' : jumpsSameVideo(sh) ? '앞 컷과 같은 영상의 다른 부분' : p && p.sp < MIN_SPEED_HARD ? '자리보다 너무 짧음' : p && (sh.soft || []).length && p.why === 'soft' ? '원본 화면 전환이 컷 끝에 걸림' : '이미 이 광고에서 씀';
  const put = (s: AutoEditSlot, p: Place) => {
    const D = s.end - s.start;
    const c: PlanClip = { path: p.sh.path, file: p.sh.file, start: s.start, end: s.end, srcIn: p.t0, speed: p.sp, shot: p.sh.id, text: s.text, hook: s.hook };
    clips.push(c);
    avoid.push([p.sh.path, p.t0, p.t0 + D * p.sp]);
    usedHere.push([p.sh.path, p.t0, p.t0 + D * p.sp]);
    if (p.sp < MIN_SPEED) warnings.push(`컷 ${s.slot}: 장면 ${p.sh.id} 이 짧아 ${p.sp.toFixed(2)}배속`);
    prev = c;
    afterHook = false;
  };
  for (const s of slots) {
    const D = s.end - s.start;
    if (s.hook && hook) {
      const pieces = hookPieces(s, hook, shots, caps);
      if (pieces.length) {
        for (const p of pieces) {
          clips.push(p);
          avoid.push([p.path, p.srcIn, p.srcIn + (p.end - p.start) * p.speed]);
          usedHere.push([p.path, p.srcIn, p.srcIn + (p.end - p.start) * p.speed]);
        }
        hookShots = new Set(pieces.map((p) => p.shot || ''));
        afterHook = true;
        prev = pieces[pieces.length - 1];
        continue;
      }
      warnings.push('⚠️ 후킹 지정 구간에서 쓸 장면을 찾지 못함 (영상·초 확인) → 다른 장면으로 채움');
    }
    const a = amap.get(s.slot);
    const first = a ? byId.get(a.shot) : undefined;
    const p1 = first ? place(first, D, Number(a!.in)) : null;
    if (p1?.ok) {
      put(s, p1);
      continue;
    }
    const alt = a?.alt ? byId.get(a.alt) : undefined;
    // 1순위를 못 쓰면: AI가 적은 문장의 핵심(focus)과 화면 주인공(subject)이 맞는 장면이 먼저 (예: 핵심 '인형' → 주인공이 인형인 장면)
    //  같은 맞음 정도 안에서는 AI 2순위 → 1순위(또는 바로 앞 컷)와 같은 영상에서 이어지는 장면 → 같은 영상 → 나머지(긴 장면부터)
    const ref = first || (prev ? byId.get((prev as PlanClip).shot || '') : undefined);
    const words = (a?.focus || '').split(/[\s,·()/]+/).map((w) => w.replace(/(을|를|이|가|은|는|에|로|으로|과|와|의|도)$/, '')).filter((w) => w.length >= 2);
    const focusRank = (x: AutoEditShot) => {
      const d = descById.get(x.id);
      if (!d || !words.length) return 1;
      const hit = (t?: string) => words.some((w) => (t || '').includes(w));
      // 주인공 + 장소가 맞으면 가장 먼저, 그다음 주인공만, 장소·설명만, 아무것도 안 맞음
      if (hit(d.subject) && hit(d.place)) return 0;
      if (hit(d.subject)) return 0.5;
      if (hit(d.place) || hit(d.desc)) return 1;
      return 2;
    };
    const near = (x: AutoEditShot) =>
      x === alt ? -1 : ref && x.path === ref.path ? (x.start >= ref.start ? x.start - ref.start : 1000 + ref.start - x.start) : 1e6 - x.dur;
    const basisSet = new Set(s.basis || []); // 대본 근거 장면은 가장 먼저 (R25)
    const rank = (x: AutoEditShot) => (basisSet.has(x.id) ? -1 : focusRank(x)) * 1e7 + near(x);
    const pool = shots.filter((x) => x !== first).sort((x, y) => rank(x) - rank(y));
    const p3 = pool.map((x) => place(x, D, x === alt ? x.start + EDGE : x.start + EDGE)).find((p) => p.ok);
    const p2 = alt && alt !== first ? place(alt, D, alt.start + EDGE) : null;
    if (p3) {
      warnings.push(
        p3.sh === alt
          ? `컷 ${s.slot}: AI 1순위 ${a?.shot || '-'}(${why(first, p1)}) → 2순위 ${alt!.id}`
          : `컷 ${s.slot}: ${a ? `AI가 고른 ${a.shot}(${why(first, p1)})` : 'AI 답 없음'} → ${p3.sh.id} 로 대신함${words.length && focusRank(p3.sh) === 0 ? ` (핵심 '${a?.focus}' 장면)` : ''} (확인 권장)`
      );
      put(s, p3);
      continue;
    }
    // 최후: 절대 선을 지킬 장면이 하나도 없음 → 가장 덜 느린 장면으로 채우고 크게 알림 (빈 화면보다는 나음)
    const last = [p1, p2, ...pool.map((x) => place(x, D, x.start + EDGE))].filter((p): p is Place => !!p).sort((x, y) => y.sp - x.sp)[0];
    if (!last) {
      warnings.push(`⚠️ 컷 ${s.slot}: 쓸 수 있는 장면이 없음 (빈 화면)`);
      continue;
    }
    warnings.push(`⚠️ 컷 ${s.slot}: 맞는 장면이 없어 ${last.sh.id} 를 ${last.sp.toFixed(2)}배로 씀`);
    put(s, last);
  }
  // 샷 경계 안전장치: 넘으면 먼저 시작을 앞당기고, 그래도 넘을 때만 느리게
  for (const c of clips) {
    const sh = c.shot ? byId.get(c.shot) : undefined;
    if (!sh) continue;
    const hi = sh.end - EDGE;
    const dur = c.end - c.start;
    if (c.srcIn + dur * c.speed > hi) {
      c.srcIn = Math.max(sh.start + EDGE, hi - dur * c.speed);
      if (c.srcIn + dur * c.speed > hi) c.speed = Math.floor(((hi - c.srcIn) / dur) * 100) / 100;
    }
  }
  return { clips, warnings };
}

/** 장면 설명 두 개가 얼마나 비슷한지 (글자 두 개씩 묶어 겹치는 비율, 0~1) */
/**
 * 같은 영상의 두 샷을 바로 이어 붙였을 때 '같은 컷이 두 번 나온 것처럼' 보이는지 (R13).
 * 장면 분석이 없으면 판단 못 함 → 보인다고 봄. 같은 묶음(group)이거나, 첫 화면 설명이 비슷하거나,
 * 같은 장소에서 동작 설명까지 비슷하면 같아 보임. 같은 장소라도 동작·첫 화면이 다르면 괜찮음.
 */
export function looksSameShot(a?: Pick<AutoEditShotDesc, 'group' | 'firstFrame' | 'place' | 'desc'>, b?: Pick<AutoEditShotDesc, 'group' | 'firstFrame' | 'place' | 'desc'>): boolean {
  if (!a || !b) return true;
  if (!a.group && !a.firstFrame && !b.group && !b.firstFrame) return true; // 예전 분석(묶음·첫 화면 없음)
  if (a.group && a.group === b.group) return true;
  if (a.firstFrame && b.firstFrame && descSim(a.firstFrame, b.firstFrame) >= 0.5) return true;
  if (a.place && a.place === b.place && descSim(a.desc || '', b.desc || '') >= 0.5) return true;
  return false;
}

export function descSim(a: string, b: string): number {
  const bg = (t: string) => {
    const x = t.replace(/\s+/g, '');
    const out = new Set<string>();
    for (let i = 0; i + 1 < x.length; i++) out.add(x.slice(i, i + 2));
    return out;
  };
  const [A, B] = [bg(a), bg(b)];
  if (!A.size || !B.size) return 0;
  let n = 0;
  A.forEach((g) => B.has(g) && n++);
  return n / Math.min(A.size, B.size);
}
const SIM_WARN = 0.4;

/** 검사기에서 쓰는 문제 하나 */
export type PlanIssue = { level: 'error' | 'warn'; at: number; msg: string };

/**
 * 결과 검사기: 배치가 끝난 뒤 절대 선을 하나씩 확인 (점수와 상관없이 결과만 봄)
 *  error = 빈 화면 · 0.6배보다 느림 · 샷 경계 넘음 · 1초보다 짧은 조각 / warn = 컷 길이 범위 밖 · 같은 장면 반복 · 맺음말 꼬리 컷 · 낱말 중간 컷
 */
export function auditPlan(
  slots: AutoEditSlot[],
  clips: PlanClip[],
  shots: AutoEditShot[],
  opts: { hi: number; fps: number; caps?: Array<Pick<TimelineClip, 'startTime' | 'duration' | 'text'>>; descs?: AutoEditShotDesc[] }
): PlanIssue[] {
  const out: PlanIssue[] = [];
  const byId = new Map(shots.map((s) => [s.id, s]));
  const f = 1 / opts.fps;
  const fmt = (t: number) => `${t.toFixed(2)}초`;
  if (!slots.length) return out;
  const S = slots[0].start;
  const E = slots[slots.length - 1].end;
  // 빈 화면
  const cs = [...clips].sort((a, b) => a.start - b.start);
  let cur = S;
  for (const c of cs) {
    if (c.start > cur + f * 0.5) out.push({ level: 'error', at: cur, msg: `${fmt(cur)}~${fmt(c.start)} 빈 화면` });
    cur = Math.max(cur, c.end);
  }
  if (cur < E - f * 0.5) out.push({ level: 'error', at: cur, msg: `${fmt(cur)}~${fmt(E)} 빈 화면` });
  for (const c of cs) {
    const dur = c.end - c.start;
    if (c.speed < MIN_SPEED_HARD - 1e-6) out.push({ level: 'error', at: c.start, msg: `${fmt(c.start)} 컷이 ${c.speed.toFixed(2)}배로 너무 느림` });
    if (c.hook && dur < 1 - 1e-6) out.push({ level: 'error', at: c.start, msg: `${fmt(c.start)} 후킹 조각이 ${dur.toFixed(2)}초로 너무 짧음` });
    const sh = c.shot ? byId.get(c.shot) : undefined;
    if (sh && (c.srcIn < sh.start - 1e-3 || c.srcIn + dur * c.speed > sh.end + 1e-3))
      out.push({ level: 'error', at: c.start, msg: `${fmt(c.start)} 컷이 장면 경계를 넘음 (다른 장면이 비칠 수 있음)` });
  }
  // 컷 길이 (후킹 조각은 따로 봄)
  for (const s of slots) {
    if (s.hook) continue;
    if (s.dur < MIN_CUT - 0.15) out.push({ level: 'warn', at: s.start, msg: `${fmt(s.start)} 컷이 ${s.dur.toFixed(2)}초로 짧음` });
    if (s.dur > maxCutLen(opts.hi) + 0.15) out.push({ level: 'warn', at: s.start, msg: `${fmt(s.start)} 컷이 ${s.dur.toFixed(2)}초로 김` });
  }
  // 후킹 바로 다음 컷이 후킹과 같은 샷이면 후킹 장면이 그대로 이어져 보임
  const hookClips = cs.filter((c) => c.hook);
  const nextAfterHook = cs.find((c) => !c.hook && hookClips.length && c.start >= Math.max(...hookClips.map((h) => h.end)) - 0.02);
  if (nextAfterHook && hookClips.some((h) => h.shot && h.shot === nextAfterHook.shot))
    out.push({ level: 'warn', at: nextAfterHook.start, msg: `${fmt(nextAfterHook.start)} 후킹 바로 다음 컷이 후킹과 같은 장면 (후킹이 그대로 이어져 보임)` });
  // 같은 장면 반복 (바로 앞 컷을 이어서 재생하는 건 괜찮음)
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      const [a, b] = [cs[i], cs[j]];
      if (a.path !== b.path) continue;
      const ov = Math.min(a.srcIn + (a.end - a.start) * a.speed, b.srcIn + (b.end - b.start) * b.speed) - Math.max(a.srcIn, b.srcIn);
      if (ov > 0.3) out.push({ level: 'warn', at: b.start, msg: `${fmt(b.start)} 컷이 ${fmt(a.start)} 컷과 같은 장면을 다시 씀` });
    }
  }
  // 한 문장 = 한 흐름: 한 문장 안에서 영상이 2번 넘게 바뀌면 템포가 너무 빠름
  const slotOf = (c: PlanClip) => slots.find((x) => c.start >= x.start - 0.02 && c.start < x.end - 0.02);
  let group: PlanClip[] = [];
  const flush = () => {
    const changes = group.filter((c, i) => i > 0 && c.path !== group[i - 1].path).length;
    if (changes >= 2) out.push({ level: 'warn', at: group[0].start, msg: `${fmt(group[0].start)}부터 한 문장 안에서 다른 영상으로 ${changes}번 바뀜 (템포가 빠를 수 있음)` });
    group = [];
  };
  for (const c of cs) {
    const s = slotOf(c);
    if (group.length && !(s?.cont || c.hook === group[group.length - 1].hook && c.hook)) flush();
    group.push(c);
  }
  flush();
  // 바로 앞 컷과 같은 영상·같은 장소에서 시간을 건너뛰어 붙임 → 두 컷 첫 화면이 비슷해 보임
  // 같은 영상의 다른 부분을 연달아 (장면 분석이 없어도 확인, 규칙 R13). 이어 쓰기·바로 다음 장면은 괜찮음
  const sameVideoJump = new Set<number>();
  const descMap = new Map((opts.descs || []).map((d) => [d.id, d]));
  for (let i = 1; i < cs.length; i++) {
    const [a, b] = [cs[i - 1], cs[i]];
    if (!a.shot || !b.shot || a.shot === b.shot || a.path !== b.path) continue;
    if (Number(b.shot.split('-').pop()) === Number(a.shot.split('-').pop()) + 1) continue;
    if (!looksSameShot(descMap.get(a.shot), descMap.get(b.shot))) continue; // 같은 영상이라도 확실히 달라 보이면 괜찮음 (R13)
    sameVideoJump.add(i);
    out.push({ level: 'warn', at: b.start, msg: `${fmt(b.start)} 앞 컷과 같은 영상의 다른 부분을 연달아 씀 (같은 컷이 두 번 나온 것처럼 보일 수 있음)` });
  }
  if (opts.descs?.length) {
    const place = new Map(opts.descs.map((d) => [d.id, d.place]));
    const descOf = new Map(opts.descs.map((d) => [d.id, d.desc]));
    const groupOf = new Map(opts.descs.map((d) => [d.id, d.group || '']));
    for (let i = 1; i < cs.length; i++) {
      const [a, b] = [cs[i - 1], cs[i]];
      if (!a.shot || !b.shot || a.shot === b.shot || sameVideoJump.has(i)) continue;
      // 새 분석(비슷한 장면 묶음)이 있으면 그걸로 판단: 영상이 달라도 같은 묶음이면 비슷해 보임
      const ga = groupOf.get(a.shot);
      if (ga && ga === groupOf.get(b.shot)) {
        out.push({ level: 'warn', at: b.start, msg: `${fmt(b.start)} 앞 컷과 비슷한 장면(「${ga}」)이 연달아 나옴 (첫 화면이 비슷해 보일 수 있음)` });
        continue;
      }
      if (ga || a.path !== b.path) continue;
      const aOut = a.srcIn + (a.end - a.start) * a.speed;
      const jump = b.srcIn - aOut;
      const pa = place.get(a.shot);
      const sim = descSim(descOf.get(a.shot) || '', descOf.get(b.shot) || '');
      if (pa && pa === place.get(b.shot) && (jump > 1.0 || jump < -0.3) && sim >= SIM_WARN)
        out.push({ level: 'warn', at: b.start, msg: `${fmt(b.start)} 앞 컷과 같은 영상·같은 장소(${pa})의 비슷한 동작을 건너뛰어 붙임 (첫 화면이 비슷해 보일 수 있음)` });
    }
  }
  // 자막 기준: 맺음말 꼬리 컷, 낱말 중간 컷
  if (opts.caps?.length) {
    const caps = [...opts.caps].sort((a, b) => a.startTime - b.startTime);
    const ends: number[] = [];
    for (let i = 1; i < caps.length; i++) if (endKind(caps[i - 1].text || '') === 'sent') ends.push(caps[i].startTime);
    ends.push(caps[caps.length - 1].startTime + caps[caps.length - 1].duration);
    for (const s of slots.slice(1)) {
      const t = s.captionStart;
      const i = caps.findIndex((c) => Math.abs(c.startTime - t) < 0.02);
      if (i < 0) {
        out.push({ level: 'warn', at: s.start, msg: `${fmt(s.start)} 컷이 자막 한 줄 중간에서 바뀜 (긴 자막이라 나눔)` });
        continue;
      }
      if (ends.some((e) => Math.abs(e - t) < 0.02)) continue;
      const e = ends.find((x) => x > t + 0.02);
      if (e !== undefined && e - t < TAIL_SEC)
        out.push({ level: 'warn', at: s.start, msg: `${fmt(s.start)} 맺음말 「${(caps[i].text || '').replace(/\n/g, ' ')}」만 ${(e - t).toFixed(2)}초 보이고 넘어감` });
      if (i > 0 && endKind(caps[i - 1].text || '') === 'mid')
        out.push({ level: 'warn', at: s.start, msg: `${fmt(s.start)} 말 덩어리 중간에서 컷 「${(caps[i - 1].text || '').replace(/\n/g, ' ')} | ${(caps[i].text || '').replace(/\n/g, ' ')}」` });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * 대본 만들기가 저장한 '근거 장면'(문장 → 원본 경로·초) 중 이 컷 자리의 문장에 해당하는 것을 찾아, 지금 미디어의 샷 id 로 바꿈 (규칙 R25)
 *  문장 찾기: 글자만 남겨 비교. 자리의 문장(sentence) 안에 대본 문장이 들어 있거나 아주 비슷하고, 그중 자리 대사와 가장 많이 겹치는 것
 */
export function basisShotIds(
  slot: Pick<AutoEditSlot, 'text' | 'sentence'>,
  entries: Array<{ text: string; scenes: Array<{ path: string; from: number; to: number }> }>,
  shots: AutoEditShot[]
): string[] {
  if (!entries?.length) return [];
  const key = (t: string) => (t || '').replace(/[^가-힣a-zA-Z0-9]/g, '');
  const tk = key(slot.text);
  const sk = key(slot.sentence || slot.text);
  if (!tk) return [];
  let best: (typeof entries)[number] | null = null;
  let bestScore = 0;
  for (const e of entries) {
    const ek = key(e.text);
    if (!ek || !e.scenes?.length) continue;
    const inSentence = sk.includes(ek) || ek.includes(sk) || descSim(ek, sk) >= 0.7;
    if (!inSentence) continue;
    const score = descSim(ek, tk) + (ek.includes(tk) ? 0.5 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  if (!best || bestScore < 0.4) return [];
  const norm = (p: string) => p.split('\\').join('/').toLowerCase();
  const ids: string[] = [];
  for (const sc of best.scenes) {
    for (const sh of shots) {
      if (norm(sh.path) !== norm(sc.path)) continue;
      const ov = Math.min(sh.end, sc.to) - Math.max(sh.start, sc.from);
      if (ov >= Math.min(0.3, (sh.end - sh.start) * 0.5) && !ids.includes(sh.id)) ids.push(sh.id);
    }
  }
  return ids;
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
