/**
 * 장면 바꾸기 도우미 (2026-11-16 사용자 요청): 편집자가 마음에 안 드는 컷을 우클릭하면
 * 그 컷 자막에 어울리는 다른 장면 후보를 순서대로 보여 준다. 원본을 처음부터 다시 보지 않아도 되게.
 * 이미 저장된 장면 분석(주인공·단계·장소·설명)만 쓴다 → AI 호출 없음, 비용 없음.
 */
import type { AutoEditShot, AutoEditShotDesc, TimelineClip } from '../types/editor';
import { descSim, focusWords, similarSituation } from './autoEdit';

const EDGE = 0.06; // autoEdit 과 같은 샷 경계 여유
const MIN_SPEED_HARD = 0.6;
const MIN_SPEED = 0.8;

export type SceneCandidate = {
  shot: AutoEditShot;
  desc?: AutoEditShotDesc;
  /** 넣을 원본 시작(초)과 속도 (타임라인 길이는 그대로) */
  srcIn: number;
  speed: number;
  /** 쓸 수 있는지 (0.6배보다 느려지면 못 씀) */
  ok: boolean;
  score: number;
  /** 지금 장면과 비슷한 상황 (주인공·단계가 같음) */
  similar: boolean;
  /** 이 시퀀스 / 다른 시퀀스에서 쓴 횟수 */
  usedHere: number;
  usedOther: number;
  /** 왜 이 순서인지 짧은 이유들 */
  reasons: string[];
};

const norm = (p?: string) => (p || '').replace(/\\/g, '/').toLowerCase();

/** 클립이 지금 쓰고 있는 장면 (원본 경로 + 클립 가운데 시각이 들어 있는 샷) */
export function shotOfClip(clip: Pick<TimelineClip, 'sourcePath' | 'sourceStart' | 'duration' | 'speed'>, shots: AutoEditShot[]): AutoEditShot | undefined {
  const mid = clip.sourceStart + (clip.duration * (clip.speed || 1)) / 2;
  return shots.find((s) => norm(s.path) === norm(clip.sourcePath) && s.start <= mid && mid < s.end);
}

/** 영상 클립들이 장면마다 몇 번 쓰였는지 (0.3초 이상 겹치면 쓴 것) + 쓴 원본 구간 */
export function shotUsage(clips: Array<Pick<TimelineClip, 'type' | 'sourcePath' | 'sourceStart' | 'duration' | 'speed'>>, shots: AutoEditShot[]) {
  const count = new Map<string, number>();
  const ranges: Array<[string, number, number]> = [];
  for (const c of clips) {
    if (c.type !== 'video' || !c.sourcePath) continue;
    const a = c.sourceStart;
    const b = a + c.duration * (c.speed || 1);
    ranges.push([norm(c.sourcePath), a, b]);
    for (const s of shots) {
      if (norm(s.path) !== norm(c.sourcePath)) continue;
      if (Math.min(b, s.end) - Math.max(a, s.start) >= 0.3) count.set(s.id, (count.get(s.id) || 0) + 1);
    }
  }
  return { count, ranges };
}

/** 장면 안에서 시작점 고르기: 핵심 순간(key)이 들어가고, 이미 쓴 부분과 덜 겹치는 곳 */
function pickIn(sh: AutoEditShot, need: number, key: number | undefined, used: Array<[string, number, number]>): number {
  const s0 = sh.start + EDGE;
  const s1 = sh.end - EDGE;
  if (s1 - s0 <= need) return s0;
  const over = (t: number) => used.reduce((n, [p, a, b]) => n + (p === norm(sh.path) ? Math.max(0, Math.min(t + need, b) - Math.max(t, a)) : 0), 0);
  let lo = s0;
  let hi = s1 - need;
  if (typeof key === 'number' && key > s0 && key < s1) {
    const lo2 = Math.max(lo, key - need + 0.15);
    const hi2 = Math.min(hi, key - 0.15);
    if (lo2 <= hi2) [lo, hi] = [lo2, hi2];
  }
  let best = lo;
  let bestOver = Infinity;
  for (let t = lo; t <= hi + 1e-6; t += 0.1) {
    const o = over(t);
    if (o < bestOver - 1e-6) {
      bestOver = o;
      best = t;
    }
  }
  return +best.toFixed(3);
}

/**
 * 후보 순위. 점수가 높을수록 위:
 *  + 지금 장면과 비슷한 상황 (R39 와 같은 판단) — 바꿔도 대사와 어긋날 위험이 적음
 *  + 자막 낱말이 장면 주인공·장소·설명에 있음
 *  - 이 시퀀스에서 이미 씀 (겹침), 다른 시퀀스에서 씀 (약하게)
 *  - 느려짐 (0.8배 아래), 0.6배 아래는 못 씀
 */
export function rankSceneCandidates(params: {
  clip: Pick<TimelineClip, 'sourcePath' | 'sourceStart' | 'duration' | 'speed'>;
  text: string;
  shots: AutoEditShot[];
  descs: AutoEditShotDesc[];
  /** 이 시퀀스의 다른 영상 클립 (이 클립 제외) */
  hereClips: Array<Pick<TimelineClip, 'type' | 'sourcePath' | 'sourceStart' | 'duration' | 'speed'>>;
  /** 다른 시퀀스의 영상 클립 */
  otherClips: Array<Pick<TimelineClip, 'type' | 'sourcePath' | 'sourceStart' | 'duration' | 'speed'>>;
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
    const speed = Math.min(1, Math.floor((usable / D) * 100) / 100);
    const ok = speed >= MIN_SPEED_HARD;
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
    if (uh) {
      score -= 2 * uh;
      reasons.push(`이 시퀀스에서 ${uh}번 씀`);
    }
    if (uo) {
      score -= 0.5 * Math.min(uo, 3);
      reasons.push(`다른 시퀀스에서 ${uo}번 씀`);
    }
    if (!ok) reasons.push('너무 짧음 (0.6배보다 느려짐)');
    else if (speed < MIN_SPEED) {
      score -= 1;
      reasons.push(`${speed.toFixed(2)}배로 느려짐`);
    }
    const srcIn = pickIn(sh, D * speed, d?.key, [...here.ranges, ...other.ranges]);
    list.push({ shot: sh, desc: d, srcIn, speed, ok, score, similar, usedHere: uh, usedOther: uo, reasons });
  }
  list.sort((a, b) => Number(b.ok) - Number(a.ok) || b.score - a.score || b.shot.dur - a.shot.dur);
  return { current, currentDesc: cd, list };
}
