/**
 * 클립 변경 (장면 보관함, 2026-11-16 사용자 요청): 자동 배치 뒤 검수할 때 대본과 안 맞는 컷을 우클릭 → '클립 변경'
 *  → AI가 원본을 나눈 장면을 '단계'(문제상황/준비/실제사용/완성모습/기타) 칸으로 보여 줌. 편집자는 원본 전체를 보지 않고 그 칸만 비교.
 *  - 처음 여는 칸 = 대사로 추정한 단계 (컷이 어색한 이유가 '단계가 틀려서'인 경우가 많음)
 *  - 타임라인 길이는 안 바꿈. 장면이 길면 일부(핵심 순간 포함, 편집자가 시작점 조정), 짧으면 느리게 — 편집자가 고르면 그대로, 경고만
 * 이미 저장된 장면 분석만 쓴다 → AI 호출 없음, 비용 없음.
 */
import type { AutoEditShot, AutoEditShotDesc, TimelineClip } from '../types/editor';
import { descSim, focusWords, similarSituation } from './autoEdit';

const EDGE = 0.06; // autoEdit 과 같은 샷 경계 여유
/** 이 배속 이상이면 '충분' (눈에 거의 안 띔). 사용자와 정함 (2026-11-16) */
export const FIT_SPEED = 0.9;
const SOFT_EDGE = 0.15; // R28 과 같음

export const STAGES = ['문제상황', '준비', '실제사용', '완성모습', '기타'] as const;
export type Stage = (typeof STAGES)[number];
/** AI가 붙인 단계를 칸 이름으로 (비어 있거나 다른 말이면 기타) */
export const stageOf = (d?: Pick<AutoEditShotDesc, 'stage'>): Stage => ((STAGES as readonly string[]).includes(d?.stage || '') ? (d!.stage as Stage) : '기타');

// 대사 → 단계 (지시문 '고르는 순서 2'와 같은 기준: 문제·불편 → 문제상황, 해 보니/써 보니/붙이기만 → 실제사용, 장점·결론·감정·가격 → 완성모습)
const STAGE_WORDS: Array<[Stage, RegExp]> = [
  ['문제상황', /불편|귀찮|힘들|힘든|문제|짜증|고민|맨날|매번|흘러|떨어지|찢어|낡|헤진|버리|한숨|싫|답답|걱정|안 ?맞|못 ?쓰|아프|무릎이|울고|추켜|좁아|없어서|부족|지저분|어수선|엉망|곰팡/],
  ['실제사용', /해 ?보니|써 ?보니|해 ?봤|써 ?봤|붙이|당기|당겨|쓱|끼우|채우|눌러|누르|바르|발라|감아|감으|조이|조여|걸어|올려|넣어|넣으|넣기|꽂|돌리|돌려|사용|쓰면|하면|하니까|했더니|차고|신고|입고|대기만|두기만/],
  ['완성모습', /편해|편하|좋아|좋더|좋다|행복|깔끔|완벽|딱 ?맞|예뻐|예쁘|찰떡|만족|최고|달라져|달라졌|추천|사세요|사야|구매|가격|할인|링크|하나로|이것만|살아|살더|확 ?살|든든|튼튼|오래가|감성|분위기/],
  ['준비', /먼저|꺼내|준비|뜯어|뜯고|열어|포장|구성|들어 ?있|이렇게 ?생|소개/],
];

/** 대사로 단계 추정. 낱말이 가장 많이 걸린 단계, 하나도 없으면 undefined (그때는 지금 장면의 단계 칸) */
export function guessStage(text: string): Stage | undefined {
  let best: Stage | undefined;
  let bestN = 0;
  for (const [st, re] of STAGE_WORDS) {
    const n = (text.match(new RegExp(re.source, 'g')) || []).length;
    if (n > bestN) {
      bestN = n;
      best = st;
    }
  }
  return best;
}

export type SceneCandidate = {
  shot: AutoEditShot;
  desc?: AutoEditShotDesc;
  stage: Stage;
  /** 넣을 원본 시작(초)과 속도 (타임라인 길이는 그대로) */
  srcIn: number;
  speed: number;
  /** 길이: ok = 충분(0.9배 이상) / slow = 조금 짧아 느려짐 / short = 많이 짧음. 어느 것이든 편집자가 고르면 바꿈 */
  fit: 'ok' | 'slow' | 'short';
  /** 예전 이름 호환: 충분하면 true */
  ok: boolean;
  score: number;
  /** 지금 장면과 비슷한 상황 (주인공·단계가 같음) */
  similar: boolean;
  /** 이 시퀀스 / 다른 시퀀스에서 쓴 횟수 */
  usedHere: number;
  usedOther: number;
  /** 어디서 썼는지 (광고 구간 이름·시퀀스 이름) */
  usedIn: string[];
  /** 왜 이 순서인지 짧은 이유들 */
  reasons: string[];
};

const norm = (p?: string) => (p || '').replace(/\\/g, '/').toLowerCase();
type UseClip = Pick<TimelineClip, 'type' | 'sourcePath' | 'sourceStart' | 'duration' | 'speed'> & { label?: string };

/** 클립이 지금 쓰고 있는 장면 (원본 경로 + 클립 가운데 시각이 들어 있는 샷) */
export function shotOfClip(clip: Pick<TimelineClip, 'sourcePath' | 'sourceStart' | 'duration' | 'speed'>, shots: AutoEditShot[]): AutoEditShot | undefined {
  const mid = clip.sourceStart + (clip.duration * (clip.speed || 1)) / 2;
  return shots.find((s) => norm(s.path) === norm(clip.sourcePath) && s.start <= mid && mid < s.end);
}

/** 영상 클립들이 장면마다 몇 번 쓰였는지 (0.3초 이상 겹치면 쓴 것) + 어디서 썼는지 + 쓴 원본 구간 */
export function shotUsage(clips: UseClip[], shots: AutoEditShot[]) {
  const count = new Map<string, number>();
  const labels = new Map<string, string[]>();
  const ranges: Array<[string, number, number]> = [];
  for (const c of clips) {
    if (c.type !== 'video' || !c.sourcePath) continue;
    const a = c.sourceStart;
    const b = a + c.duration * (c.speed || 1);
    ranges.push([norm(c.sourcePath), a, b]);
    for (const s of shots) {
      if (norm(s.path) !== norm(c.sourcePath)) continue;
      if (Math.min(b, s.end) - Math.max(a, s.start) < 0.3) continue;
      count.set(s.id, (count.get(s.id) || 0) + 1);
      if (c.label) {
        const l = labels.get(s.id) || [];
        if (!l.includes(c.label)) l.push(c.label);
        labels.set(s.id, l);
      }
    }
  }
  return { count, labels, ranges };
}

/** 장면 안에서 시작점 고르기: 핵심 순간(key)이 들어가고, 이미 쓴 부분과 덜 겹치고, 약한 화면 전환이 컷 처음·끝에 안 걸리는 곳 */
function pickIn(sh: AutoEditShot, need: number, key: number | undefined, used: Array<[string, number, number]>): number {
  const s0 = sh.start + EDGE;
  const s1 = sh.end - EDGE;
  if (s1 - s0 <= need) return +s0.toFixed(3);
  const over = (t: number) => used.reduce((n, [p, a, b]) => n + (p === norm(sh.path) ? Math.max(0, Math.min(t + need, b) - Math.max(t, a)) : 0), 0);
  let lo = s0;
  let hi = s1 - need;
  if (typeof key === 'number' && key > s0 && key < s1) {
    const lo2 = Math.max(lo, key - need + 0.15);
    const hi2 = Math.min(hi, key - 0.15);
    if (lo2 <= hi2) [lo, hi] = [lo2, hi2];
  }
  let best = lo;
  let bestKey = [Infinity, Infinity];
  for (let t = lo; t <= hi + 1e-6; t += 0.05) {
    const k = [softAt(sh, t, t + need) ? 1 : 0, Math.round(over(t) * 10)];
    if (k[0] < bestKey[0] || (k[0] === bestKey[0] && k[1] < bestKey[1])) {
      bestKey = k;
      best = t;
    }
  }
  return +best.toFixed(3);
}

/** 약한 화면 전환이 컷 처음·끝 0.15초 안에 걸리는지 (R28: 다음 화면 1~3프레임 번쩍임) */
export function softAt(sh: AutoEditShot, a: number, b: number): boolean {
  return (sh.soft || []).some((x) => (x > a + 1e-3 && x < a + SOFT_EDGE) || (x > b - SOFT_EDGE && x < b - 1e-3));
}

/**
 * 편집자가 고른 시작점으로 놓기: 타임라인 길이 D 는 그대로, 원본이 모자라면 그만큼 느리게.
 * 시작점은 장면 안으로만 (경계를 넘으면 다른 장면이 보임). 경고는 막지 않고 알려 주기만
 */
export function placeAt(sh: AutoEditShot, D: number, start: number, minSpeed = 0.1): { srcIn: number; speed: number; warnings: string[] } {
  const s0 = sh.start + EDGE;
  const s1 = sh.end - EDGE;
  const srcIn = +Math.min(Math.max(start, s0), Math.max(s0, s1 - 0.05)).toFixed(3);
  const avail = s1 - srcIn;
  const raw = avail / D;
  const speed = Math.max(minSpeed, Math.min(1, Math.floor(raw * 100) / 100));
  const warnings: string[] = [];
  if (raw < minSpeed) warnings.push('장면이 너무 짧아 컷 끝에 다음 장면이 보입니다');
  else if (speed < FIT_SPEED) warnings.push(`장면이 짧아 ${speed.toFixed(2)}배로 느려집니다`);
  if (softAt(sh, srcIn, srcIn + D * speed)) warnings.push('원본의 화면 전환이 컷 처음·끝에 걸려 1~3프레임 번쩍일 수 있습니다');
  return { srcIn, speed, warnings };
}

/**
 * 후보 순위 (같은 칸 안에서). 점수가 높을수록 위:
 *  + 지금 장면과 비슷한 상황 (R39 와 같은 판단), 자막 낱말이 장면 주인공·장소·설명에 있음, 지금 장면과 같은 단계
 *  - 이 시퀀스에서 이미 씀 (겹침), 다른 시퀀스에서 씀 (약하게), 카메라 보고 말하는 장면 (R17), 짧아서 느려짐
 *  편집자가 고를 수 있게 못 쓰는 장면도 목록에 남김 (길이 표시만)
 */
export function rankSceneCandidates(params: {
  clip: Pick<TimelineClip, 'sourcePath' | 'sourceStart' | 'duration' | 'speed'>;
  text: string;
  shots: AutoEditShot[];
  descs: AutoEditShotDesc[];
  /** 이 시퀀스의 다른 영상 클립 (이 클립 제외). label = 광고 구간 이름 */
  hereClips: UseClip[];
  /** 다른 시퀀스의 영상 클립. label = 시퀀스 이름 */
  otherClips: UseClip[];
}): { current?: AutoEditShot; currentDesc?: AutoEditShotDesc; list: SceneCandidate[] } {
  const { clip, shots, descs } = params;
  const descById = new Map(descs.map((d) => [d.id, d]));
  const current = shotOfClip(clip, shots);
  const cd = current ? descById.get(current.id) : undefined;
  const words = focusWords(params.text);
  const here = shotUsage(params.hereClips, shots);
  const other = shotUsage(params.otherClips, shots);
  const D = clip.duration;
  const list: SceneCandidate[] = [];
  for (const sh of shots) {
    if (current && sh.id === current.id) continue;
    const d = descById.get(sh.id);
    const usable = sh.end - sh.start - 2 * EDGE;
    const speed = Math.max(0.1, Math.min(1, Math.floor((usable / D) * 100) / 100));
    const fit: SceneCandidate['fit'] = speed >= FIT_SPEED ? 'ok' : speed >= 0.6 ? 'slow' : 'short';
    const reasons: string[] = [];
    let score = 0;
    const similar = similarSituation(cd, d, words);
    if (similar) {
      score += 3;
      reasons.push('지금 장면과 비슷한 상황');
    } else if (cd && d) {
      // 지금 장면의 단계 = AI(또는 편집자)가 이 대사에 맞다고 본 단계 → 같은 단계를 크게 (R30: 단계가 안 맞으면 '대체')
      if (cd.stage && cd.stage === d.stage) score += 1.5;
      if (cd.subject && d.subject && descSim(cd.subject, d.subject) >= 0.5) score += 0.8;
    }
    const hits = words.filter((w) => [d?.subject, d?.place, d?.desc].some((t) => (t || '').includes(w)));
    if (hits.length) {
      score += Math.min(3, hits.length);
      reasons.push(`자막 낱말 '${hits.slice(0, 3).join(', ')}'`);
    }
    // 카메라 보고 말하는 장면은 소개 대사에만 (R17) → 지금 장면이 말하는 장면이 아니면 크게 낮춤
    if (d?.talk && !cd?.talk) {
      score -= 2;
      reasons.push('카메라 보고 말하는 장면');
    }
    const uh = here.count.get(sh.id) || 0;
    const uo = other.count.get(sh.id) || 0;
    if (uh) score -= 2 * uh;
    if (uo) score -= 0.5 * Math.min(uo, 3);
    const usedIn = [...(here.labels.get(sh.id) || []), ...(other.labels.get(sh.id) || [])];
    if (uh || uo) reasons.push(usedIn.length ? `${usedIn.join('·')}에서 씀` : uh ? `이 시퀀스에서 ${uh}번 씀` : `다른 시퀀스에서 ${uo}번 씀`);
    if (fit === 'slow') {
      score -= 1;
      reasons.push(`${speed.toFixed(2)}배로 느려짐`);
    } else if (fit === 'short') {
      score -= 3;
      reasons.push(`짧음 (${usable.toFixed(1)}초 / 필요 ${D.toFixed(1)}초)`);
    }
    const srcIn = pickIn(sh, D * speed, d?.key, [...here.ranges, ...other.ranges]);
    list.push({ shot: sh, desc: d, stage: stageOf(d), srcIn, speed, fit, ok: fit === 'ok', score, similar, usedHere: uh, usedOther: uo, usedIn, reasons });
  }
  const fitRank = { ok: 0, slow: 1, short: 2 } as const;
  list.sort((a, b) => fitRank[a.fit] - fitRank[b.fit] || b.score - a.score || b.shot.dur - a.shot.dur);
  return { current, currentDesc: cd, list };
}
