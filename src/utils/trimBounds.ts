import { TimelineClip } from '../types/editor';

export interface TrimBounds {
  /** trim-start 시 startTime 이 이동할 수 있는 최소 델타(초, 음수 = 왼쪽으로 늘리기) */
  minStartDelta: number;
  /** trim-end 시 duration 이 늘어날 수 있는 최대 길이(초) */
  maxDuration: number;
}

/**
 * 클립 양끝 늘리기(trim-start / trim-end) 한계 계산:
 * - 같은 트랙에 앞/뒤 클립이 있으면 그 경계까지만 늘어남
 * - 미디어 클립은 원본 파일 범위(0초 ~ assetDuration) 안에서만 늘어남
 */
export function computeTrimBounds(
  clip: Pick<TimelineClip, 'id' | 'type' | 'trackId' | 'startTime' | 'duration' | 'sourceStart' | 'speed' | 'reverse'>,
  allClips: ReadonlyArray<Pick<TimelineClip, 'id' | 'trackId' | 'startTime' | 'duration'>>,
  assetDuration?: number
): TrimBounds {
  const sp = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const clipEnd = clip.startTime + clip.duration;

  let prevEnd = 0;
  let nextStart = Infinity;

  for (const other of allClips) {
    if (other.id === clip.id || other.trackId !== clip.trackId) continue;
    const otherEnd = other.startTime + other.duration;
    if (otherEnd <= clip.startTime + 1e-4) {
      if (otherEnd > prevEnd) prevEnd = otherEnd;
    } else if (other.startTime >= clipEnd - 1e-4) {
      if (other.startTime < nextStart) nextStart = other.startTime;
    }
  }

  const safePrevEnd = Math.min(clip.startTime, prevEnd);
  const byNeighborStart = safePrevEnd - clip.startTime;
  // 거꾸로 재생: 왼쪽 끝 = 원본 구간의 끝, 오른쪽 끝 = 원본 구간의 처음 → 늘릴 수 있는 한계가 서로 바뀜
  const spanEnd = clip.sourceStart + clip.duration * sp;
  const hasAsset = typeof assetDuration === 'number' && assetDuration > 0;
  const bySourceStart =
    clip.type === 'text'
      ? -clip.startTime
      : clip.reverse
        ? hasAsset
          ? -(assetDuration! - spanEnd) / sp
          : -Infinity
        : -clip.sourceStart / sp;
  const minStartDelta = Math.max(byNeighborStart, bySourceStart);

  const safeNextStart = Math.max(clipEnd, nextStart);
  const byNeighborEnd = safeNextStart - clip.startTime;
  const bySourceEnd =
    clip.type === 'text'
      ? Infinity
      : clip.reverse
        ? clip.duration + clip.sourceStart / sp
        : hasAsset
          ? Math.max(clip.duration, (assetDuration! - clip.sourceStart) / sp)
          : Infinity;
  const maxDuration = Math.min(byNeighborEnd, bySourceEnd);

  return { minStartDelta, maxDuration };
}
