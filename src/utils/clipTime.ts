/**
 * 클립 시각 ↔ 원본 초 (거꾸로 재생 포함, 2026-11-16 사용자 요청)
 *  저장은 늘 '원본 구간 = sourceStart ~ sourceStart + duration×speed'. 거꾸로 재생(reverse)이면 재생 방향만 반대:
 *  클립 처음 = 원본 구간의 끝, 클립 끝 = 원본 구간의 처음.
 *  자르기·다듬기·무음 제거·구간 내보내기·미리보기·마스크가 모두 이 함수를 써야 앞으로/거꾸로가 어긋나지 않음
 */
import type { TimelineClip } from '../types/editor';

type C = Pick<TimelineClip, 'sourceStart' | 'duration' | 'speed' | 'reverse'>;
const spd = (c: Pick<TimelineClip, 'speed'>) => (c.speed && c.speed > 0 ? c.speed : 1);

/** 클립 안 시각 t(초) → 원본 초. 거꾸로면 끝에서부터 (마지막 프레임을 넘지 않게 아주 조금 안쪽) */
export function srcAt(c: C, t: number): number {
  const sp = spd(c);
  if (!c.reverse) return c.sourceStart + t * sp;
  return Math.max(c.sourceStart, c.sourceStart + (c.duration - t) * sp - 1 / 60);
}

/** 원본 초 → 클립 안 시각 (srcAt 의 반대, 마스크·미리보기 시계용) */
export function clipTimeOf(c: C, s: number): number {
  const sp = spd(c);
  return c.reverse ? c.duration - (s - c.sourceStart) / sp : (s - c.sourceStart) / sp;
}

/** 클립 앞쪽을 cut 초 잘라낼 때(또는 cut<0 이면 늘릴 때) 새 sourceStart — 앞으로: 원본 앞이 줄어듦 / 거꾸로: 원본 끝이 줄어들어 그대로 */
export function srcAfterFrontCut(c: C, cut: number): number {
  return c.reverse ? c.sourceStart : c.sourceStart + cut * spd(c);
}

/** 클립 뒤쪽 길이가 d 초 바뀔 때(늘면 +) 새 sourceStart — 앞으로: 그대로 / 거꾸로: 원본 앞쪽이 늘거나 줄어듦 */
export function srcAfterBackChange(c: C, d: number): number {
  return c.reverse ? c.sourceStart - d * spd(c) : c.sourceStart;
}

/** 클립 안 [a, b] 조각을 새 클립으로 만들 때 그 조각의 sourceStart (자르기·무음 제거·구간 내보내기) */
export function srcOfPiece(c: C, a: number, b: number): number {
  return c.reverse ? c.sourceStart + (c.duration - b) * spd(c) : c.sourceStart + a * spd(c);
}
