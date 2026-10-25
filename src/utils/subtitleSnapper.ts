import { SnapResultSummary, TimelineClip } from '../types/editor';

export interface SnapSubtitlesOptions {
  /** 허용할 프레임 오차 범위 (예: 6프레임 = 30fps 기준 ±0.2초) */
  thresholdFrames: number;
  /** 기준 FPS (기본 30fps) */
  fps: number;
  /** 연속된 자막 사이의 미세한 1~3프레임 빈틈(깜빡임)도 자동으로 이어붙일지 여부 */
  closeMicroGaps: boolean;
  /** 클립과 자막이 많이 겹칠 때 클립의 첫/끝 경계에 강제 정렬할지 여부 */
  alignClipdominantSubtitles: boolean;
}

/**
 * 컷 편집된 비디오/오디오 클립들의 시작점과 끝점(Cut Boundaries)에
 * 자막 클립들의 시작/끝 지점을 프레임 단위로 칼같이 일치시킵니다.
 */
export function snapSubtitleClipsToMediaCuts(
  allClips: TimelineClip[],
  options: SnapSubtitlesOptions
): { updatedClips: TimelineClip[]; summary: SnapResultSummary } {
  const {
    thresholdFrames = 6,
    fps = 30,
    closeMicroGaps = true,
    alignClipdominantSubtitles = true,
  } = options;

  const frameSec = 1 / Math.max(1, fps);
  const maxSnapSec = thresholdFrames * frameSec + 0.002; // 부동소수점 오차 여유분 2ms

  // 기준이 되는 미디어(비디오/오디오) 클립들 추출
  const mediaClips = allClips
    .filter((c) => c.type === 'video' || c.type === 'audio')
    .sort((a, b) => a.startTime - b.startTime);

  if (mediaClips.length === 0) {
    return {
      updatedClips: allClips,
      summary: {
        snappedCount: 0,
        snappedStartCount: 0,
        snappedEndCount: 0,
        gapClosedCount: 0,
        thresholdFrames,
        fps,
      },
    };
  }

  // 모든 컷 경계선(시작점, 끝점) 수집
  const cutBoundaries = new Set<number>();
  const clipIntervals: Array<{ start: number; end: number }> = [];

  for (const mc of mediaClips) {
    const s = Number(mc.startTime.toFixed(5));
    const e = Number((mc.startTime + mc.duration).toFixed(5));
    cutBoundaries.add(s);
    cutBoundaries.add(e);
    clipIntervals.push({ start: s, end: e });
  }

  const sortedBoundaries = Array.from(cutBoundaries).sort((a, b) => a - b);

  let snappedCount = 0;
  let snappedStartCount = 0;
  let snappedEndCount = 0;
  let gapClosedCount = 0;

  // 먼저 각 자막 클립을 가장 가까운 미디어 컷 경계선에 스냅
  const updatedClips = allClips.map((clip) => {
    if (clip.type !== 'text') return clip;

    let newStart = clip.startTime;
    let newEnd = clip.startTime + clip.duration;
    let startSnapped = false;
    let endSnapped = false;

    // 1. 가장 가까운 컷 경계선 찾기 (시작점)
    let closestStartBoundary: number | null = null;
    let minStartDiff = Infinity;
    for (const b of sortedBoundaries) {
      const diff = Math.abs(newStart - b);
      if (diff < minStartDiff) {
        minStartDiff = diff;
        closestStartBoundary = b;
      }
    }

    if (closestStartBoundary !== null && minStartDiff <= maxSnapSec) {
      if (Math.abs(newStart - closestStartBoundary) > 0.0001) {
        snappedStartCount++;
      }
      newStart = closestStartBoundary;
      startSnapped = true;
    }

    // 2. 가장 가까운 컷 경계선 찾기 (끝점)
    let closestEndBoundary: number | null = null;
    let minEndDiff = Infinity;
    for (const b of sortedBoundaries) {
      const diff = Math.abs(newEnd - b);
      if (diff < minEndDiff) {
        minEndDiff = diff;
        closestEndBoundary = b;
      }
    }

    if (closestEndBoundary !== null && minEndDiff <= maxSnapSec && closestEndBoundary > newStart + frameSec) {
      if (Math.abs(newEnd - closestEndBoundary) > 0.0001) {
        snappedEndCount++;
      }
      newEnd = closestEndBoundary;
      endSnapped = true;
    }

    // 3. 만약 특정 단일 미디어 클립과 자막이 75% 이상 겹치는데 시작/끝이 미세하게(최대 thresholdFrames * 2) 어긋나 있다면 해당 클립에 강제 일치
    if (alignClipdominantSubtitles) {
      const extendedSnapSec = maxSnapSec * 2;
      for (const interval of clipIntervals) {
        const overlapStart = Math.max(newStart, interval.start);
        const overlapEnd = Math.min(newEnd, interval.end);
        const overlap = Math.max(0, overlapEnd - overlapStart);
        const subDur = Math.max(0.05, newEnd - newStart);

        if (overlap / subDur >= 0.7) {
          if (!startSnapped && Math.abs(newStart - interval.start) <= extendedSnapSec) {
            newStart = interval.start;
            startSnapped = true;
            snappedStartCount++;
          }
          if (!endSnapped && Math.abs(newEnd - interval.end) <= extendedSnapSec && interval.end > newStart + frameSec) {
            newEnd = interval.end;
            endSnapped = true;
            snappedEndCount++;
          }
        }
      }
    }

    const finalDuration = Math.max(frameSec * 2, newEnd - newStart);
    const wasModified = startSnapped || endSnapped;
    if (wasModified) {
      snappedCount++;
    }

    return {
      ...clip,
      startTime: Number(newStart.toFixed(5)),
      duration: Number(finalDuration.toFixed(5)),
      snappedToClip: wasModified || clip.snappedToClip,
    };
  });

  // 4. 동일 자막 트랙 내에서 연속된 자막 간 1~thresholdFrames 이내의 미세 빈틈(또는 미세 겹침) 정리
  if (closeMicroGaps) {
    const textClipsByTrack = new Map<string, TimelineClip[]>();
    for (const c of updatedClips) {
      if (c.type === 'text') {
        const list = textClipsByTrack.get(c.trackId) || [];
        list.push(c);
        textClipsByTrack.set(c.trackId, list);
      }
    }

    for (const [, trackTextClips] of textClipsByTrack) {
      trackTextClips.sort((a, b) => a.startTime - b.startTime);
      for (let i = 0; i < trackTextClips.length - 1; i++) {
        const curr = trackTextClips[i];
        const next = trackTextClips[i + 1];
        const currEnd = curr.startTime + curr.duration;
        const gap = next.startTime - currEnd;

        // 두 자막이 미세하게 겹치거나(음수) 미세한 틈(1~3프레임)이 있는 경우
        if (gap !== 0 && Math.abs(gap) <= maxSnapSec) {
          // 만약 next.startTime이 이미 미디어 컷 경계선 위에 있다면 curr의 끝점을 next.startTime에 맞춤
          curr.duration = Math.max(frameSec * 2, Number((next.startTime - curr.startTime).toFixed(5)));
          curr.snappedToClip = true;
          gapClosedCount++;
        }
      }
    }
  }

  return {
    updatedClips,
    summary: {
      snappedCount,
      snappedStartCount,
      snappedEndCount,
      gapClosedCount,
      thresholdFrames,
      fps,
    },
  };
}

/**
 * 초(sec)를 SMPTE 타임코드 `MM:SS:FF` (분:초:프레임) 형식으로 변환합니다.
 */
export function formatTimecodeWithFrames(seconds: number, fps = 30): string {
  const safeSec = Math.max(0, seconds);
  const mins = Math.floor(safeSec / 60);
  const secs = Math.floor(safeSec % 60);
  const frames = Math.min(Math.floor(fps) - 1, Math.floor((safeSec % 1) * fps + 1e-4));

  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}

/**
 * 초(sec)를 프리미어 프로 스타일 4단 타임코드 `HH:MM:SS:FF` 형식으로 변환합니다.
 */
export function formatFullTimecode(seconds: number, fps = 30): string {
  const safeSec = Math.max(0, seconds);
  const hours = Math.floor(safeSec / 3600);
  const mins = Math.floor((safeSec % 3600) / 60);
  const secs = Math.floor(safeSec % 60);
  const frames = Math.min(Math.floor(fps) - 1, Math.floor((safeSec % 1) * fps + 1e-4));

  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${String(Math.max(0, frames)).padStart(2, '0')}`;
}
