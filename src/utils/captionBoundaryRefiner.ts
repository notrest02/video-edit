import { detectSpeechIslands } from './scriptWaveformAligner';
/**
 * 자막 시작/끝을 강제 정렬로 실제 발음 위치에 맞춘다.
 * 대본 + 파형 정렬기는 쉼과 글자 수로 위치를 추정하므로, 쉼을 잘못 고르거나
 * 쉼 없이 이어 말한 구간의 문장 경계에서 1초 가까이 어긋날 수 있다.
 */

export type RefinableCaption = {
  text: string;
  start: number; // pcm 기준 초
  end: number;
  voiceEnd: number;
  inBreath: boolean;
};

/**
 * 클립 전체 정렬: 모든 자막 글자를 음성 전체에 한 번에 강제 정렬해 시작/끝을 실제 발음 위치로 맞춘다.
 * (대본 정렬기가 엉뚱한 쉼을 문장 경계로 고른 경우까지 바로잡음)
 * alignSpans: (전체 pcm, 단어들) → 단어별 [시작, 끝] 초 (메인 프로세스 모델)
 */
const wordsOf = (t: string) => t.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

export type AlignSpansFn = (
  pcm: Float32Array,
  words: string[]
) => Promise<{ available: boolean; spans: Array<[number, number] | null> | null }>;

export async function refineCaptionsByFullAlignment<T extends RefinableCaption>(
  pcm: Float32Array,
  sampleRate: number,
  captions: T[],
  alignSpans: AlignSpansFn,
  opts: { maxGapBridgeSec?: number; maxShiftSec?: number } = {}
): Promise<{ captions: T[]; moved: number; available: boolean }> {
  const { maxGapBridgeSec = 2.2, maxShiftSec = 3 } = opts;
  const caps = captions.map((c) => ({ ...c }));
  if (caps.length === 0) return { captions: caps, moved: 0, available: true };
  const order = caps.map((_, i) => i).sort((a, b) => caps[a].start - caps[b].start);
  const words: string[] = [];
  const range: Array<[number, number]> = new Array(caps.length);
  for (const i of order) {
    const w = wordsOf(caps[i].text);
    range[i] = [words.length, words.length + w.length];
    words.push(...w);
  }
  const res = await alignSpans(pcm, words).catch(() => null);
  if (!res || !res.available) return { captions: caps, moved: 0, available: false };
  if (!res.spans) return { captions: caps, moved: 0, available: true };
  const spans = res.spans;

  // 목소리 끝은 파형 기준(소리가 실제로 잦아드는 지점)이 더 정확: 정렬 끝 근처의 말소리 덩어리 끝으로 맞춤
  let peak = 0;
  for (let k = 0; k < pcm.length; k++) {
    const v = Math.abs(pcm[k]);
    if (v > peak) peak = v;
  }
  const islands = peak > 1e-4 ? detectSpeechIslands(pcm, sampleRate, 20 * Math.log10(peak) - 30, 0.12) : [];
  const acousticEnd = (t: number, limit: number) => {
    for (const [s0, e0] of islands) {
      if (s0 <= t + 0.02 && e0 >= t - 0.02) return e0 - t < 0.5 && e0 <= limit ? Math.max(t, e0) : t;
      if (s0 > t) break;
    }
    return t;
  };

  let moved = 0;
  let prevStart = -Infinity;
  for (const i of order) {
    const [a, b] = range[i];
    let first: [number, number] | null = null;
    let last: [number, number] | null = null;
    for (let k = a; k < b; k++) {
      const sp = spans[k];
      if (!sp) continue;
      if (!first) first = sp;
      last = sp;
    }
    if (!first || !last) continue;
    const c = caps[i];
    // 너무 멀리 옮겨지는 경우(대본에 없는 말 등으로 정렬이 흔들린 경우)는 원래 값 유지
    if (Math.abs(first[0] - c.start) > maxShiftSec || first[0] <= prevStart) continue;
    if (Math.abs(first[0] - c.start) > 0.02 || Math.abs(last[1] - c.voiceEnd) > 0.02) moved++;
    c.start = first[0];
    c.voiceEnd = Math.max(first[0] + 0.1, last[1]);
    prevStart = c.start;
  }
  order.forEach((i, idx) => {
    const next = idx + 1 < order.length ? caps[order[idx + 1]] : null;
    caps[i].voiceEnd = acousticEnd(caps[i].voiceEnd, next ? next.start : pcm.length / sampleRate);
  });
  // 끝 시점: 다음 자막까지 간격이 짧으면 이어 붙이고, 길면 목소리 끝 + 0.6초 (대본 정렬기와 같은 규칙)
  const total = pcm.length / sampleRate;
  order.forEach((i, idx) => {
    const c = caps[i];
    const next = idx + 1 < order.length ? caps[order[idx + 1]] : null;
    if (next) {
      const gap = next.start - c.voiceEnd;
      c.end = gap >= 0 && gap <= maxGapBridgeSec ? next.start : Math.min(next.start, c.voiceEnd + 0.6);
    } else {
      c.end = Math.min(total, c.voiceEnd + 0.6);
    }
    if (c.end <= c.start) c.end = c.start + 0.2;
  });
  return { captions: caps, moved, available: true };
}
