/**
 * 손으로 편집할 때 원본 장면 경계 지키기 (R36, 사용자 2026-11-12)
 *  - 클립 끝을 끌어서 늘리면 원본 장면이 바뀌기 직전에서 멈춤 (예: 운동화키트 02 마지막 클립이 원본 다음 장면 2프레임을 보여 줌)
 *  - 클립 앞을 끌어서 늘리면 원본 장면이 시작되는 곳에서 멈춤
 *  - 미디어에서 영상을 넣으면 원본 맨 앞·맨 뒤 표지(제목 카드)를 건너뜀 (예: 운동화키트 02 31.05초 제목 카드 2프레임)
 *  Alt 를 누르고 끌면 무시. 장면 구간은 메인 프로세스가 ffmpeg 로만 찾음 (비용 없음) — 아직 없으면 제한 없이 동작
 */
export type SceneCuts = { shots: Array<[number, number]>; intro: number; outro: number };

/** 자동 배치와 같은 여유 (autoEdit.ts EDGE): 장면 경계에서 이만큼 안쪽까지만 */
export const CUT_EDGE = 0.06;

const cache = new Map<string, SceneCuts>();
const pending = new Set<string>();
const key = (p: string) => p.replace(/\\/g, '/').toLowerCase();

export function getSceneCuts(path?: string): SceneCuts | undefined {
  return path ? cache.get(key(path)) : undefined;
}

/** 미리 받아 두기 (프로젝트 열 때·클립 끌기 시작할 때) */
export function prefetchSceneCuts(path: string | undefined, duration: number | undefined): void {
  if (!path || !duration || !window.electronAPI?.getSceneCuts) return;
  const k = key(path);
  if (cache.has(k) || pending.has(k)) return;
  pending.add(k);
  window.electronAPI
    .getSceneCuts({ path, duration })
    .then((c) => {
      if (c?.shots?.length) cache.set(k, c);
    })
    .catch(() => {})
    .finally(() => pending.delete(k));
}

/** 원본 시각 t 가 들어 있는 장면 구간 */
export function shotAt(cuts: SceneCuts, t: number): [number, number] | undefined {
  return cuts.shots.find(([a, b]) => t >= a - 1e-3 && t <= b + 1e-3);
}

/**
 * 클립 끝을 늘릴 때 최대 타임라인 길이. 지금 길이보다 줄이지는 않음 (이미 넘어 있는 클립도 줄이기는 자유)
 * @returns undefined 면 제한 없음
 */
export function maxDurationInShot(cuts: SceneCuts | undefined, sourceStart: number, speed: number, currentDur: number): number | undefined {
  if (!cuts) return undefined;
  const shot = shotAt(cuts, sourceStart + 0.01);
  if (!shot) return undefined;
  const sp = speed > 0 ? speed : 1;
  return Math.max(currentDur, (shot[1] - CUT_EDGE - sourceStart) / sp);
}

/**
 * 클립 앞을 늘릴 때(왼쪽으로) 가장 이른 원본 시작점. 지금보다 늦추지는 않음
 * @returns undefined 면 제한 없음
 */
export function minSourceStartInShot(cuts: SceneCuts | undefined, sourceStart: number, sourceEnd: number): number | undefined {
  if (!cuts) return undefined;
  const shot = shotAt(cuts, sourceEnd - 0.01);
  if (!shot) return undefined;
  return Math.min(sourceStart, shot[0] + CUT_EDGE);
}

/** 미디어에서 영상을 통째로 넣을 때 쓸 구간 (앞뒤 표지 제외) */
export function usableRange(cuts: SceneCuts | undefined, duration: number): [number, number] {
  if (!cuts) return [0, duration];
  const a = Math.max(0, cuts.intro || 0);
  const b = Math.min(duration, cuts.outro || duration);
  return b - a > 0.5 ? [a, b] : [0, duration];
}
