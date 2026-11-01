/**
 * 대본 + 파형 하이브리드 자막 정렬기 (Script-Waveform Aligner)
 *
 * 역할 분담:
 *  - 대본(script)  : 자막 글자. 받아쓰기 결과를 자막 글자로 쓰지 않는다.
 *  - 파형(waveform): 정확한 시간. 무음 구간 사이의 발화 덩어리(island) 경계에 자막 시작/끝을 둔다.
 *  - Whisper       : "이 문장은 대략 몇 초 근처"라는 위치 단서와 사후 검증에만 쓴다.
 *                    (Whisper 타임스탬프는 ±0.5초 오차 + 환각이 있어 시간 기준으로 쓰지 않는다.)
 *
 * 처리 흐름:
 *  1. 대본 정리   : "3초 : 1번 0~3초" 같은 메모 줄/제품명·링크 줄 제거, 빈 줄로 버전 구분,
 *                   문장부호로 문장 분리, 문장부호 없는 긴 덩어리는 대본 줄바꿈으로 분리.
 *  2. 매칭        : 이 음성 파일이 대본의 어느 버전, 몇 번째 문장부터 몇 번째까지인지 찾는다.
 *                   한 파일에 여러 버전이 들어 있으면(버전 순서가 대본과 달라도) 버전별 구간으로 나눈다.
 *  3. 발화 덩어리 : PCM 파형에서 무음(-30dB, 0.12초 이상)으로 나뉜 발화 구간을 찾는다.
 *  4. 한 호흡 묶음: Whisper 단서 위치 근처에 실제 쉼이 없는 문장은 앞 문장과 묶어 정렬한 뒤 글자 비율로 다시 나눈다.
 *  5. 동적계획법  : 문장(묶음) ↔ 발화 덩어리를 "글자 수 기반 길이" + "Whisper 위치 단서" 비용으로 배정한다.
 *  6. 검증        : 각 자막 구간에서 Whisper가 들은 글자와 대본을 비교해 확신도를 매기고, 낮으면 검토 표시.
 *
 * 2026-10-31 실제 외주 프로젝트 10개(음성 45개)로 검증: 내레이션 42/42 매칭, 288개 중 286개 텍스트 일치.
 */

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

export interface WhisperRawChunk {
  start: number;
  end: number | null;
  text: string;
}

export interface AlignedScriptCaption {
  text: string;
  start: number; // 클립(오디오) 기준 상대 초
  end: number; // 다음 자막 시작까지 이어 붙인 표시 종료 시점 (상대 초)
  voiceEnd: number; // 실제 목소리가 끝나는 시점 (상대 초)
  confidence: number; // 0~1, 해당 구간 Whisper 텍스트와 대본 일치도
  needsReview: boolean;
  inBreath: boolean; // 쉼 없이 이어 읽은 구간을 글자 비율로 나눈 자막인지
  variantIndex: number; // 대본 버전 번호 (0부터)
}

export interface ScriptAlignResult {
  mode: 'single' | 'multi' | 'none';
  captions: AlignedScriptCaption[];
  matchScore: number;
  variantOrder: Array<{ variantIndex: number; start: number }>;
  warnings: string[];
}

export interface ScriptAlignOptions {
  silenceThresholdDb?: number;
  minSilenceSec?: number;
  maxGapBridgeSec?: number;
}

// ---------------------------------------------------------------------------
// 문자열 유틸
// ---------------------------------------------------------------------------

export const normalizeKo = (t: string): string => t.replace(/[^가-힣0-9a-zA-Z]/g, '');

/** LCS 길이 (두 행만 사용하는 O(n*m) / O(m) 메모리) */
function lcsLength(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = ca === b.charCodeAt(j - 1) ? prev[j - 1] + 1 : cur[j - 1] > prev[j] ? cur[j - 1] : prev[j];
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[b.length];
}

/** 0~1 유사도 (difflib ratio와 같은 정의: 2*일치/전체) */
export function textSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  return (2 * lcsLength(a, b)) / (a.length + b.length);
}

/** a의 각 글자 → b의 글자 인덱스 매핑 (LCS 역추적). 매칭 안 된 글자는 -1 */
function lcsMapping(a: string, b: string): Int32Array {
  const n = a.length;
  const m = b.length;
  const map = new Int32Array(n).fill(-1);
  if (!n || !m) return map;
  const W = m + 1;
  const dp = new Uint16Array((n + 1) * W);
  for (let i = 1; i <= n; i++) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      dp[i * W + j] =
        ca === b.charCodeAt(j - 1)
          ? dp[(i - 1) * W + j - 1] + 1
          : Math.max(dp[(i - 1) * W + j], dp[i * W + j - 1]);
    }
  }
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
      map[i - 1] = j - 1;
      i--;
      j--;
    } else if (dp[(i - 1) * W + j] >= dp[i * W + j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// 1. 대본 정리
// ---------------------------------------------------------------------------

const SECTION_HEADER = /^\s*\d+\s*초\s*:/; // "3초 : 1번 0~3초" (영상 장면 지시 메모, 읽지 않음)
const META_LINE = /(https?:\/\/|^\s*\d+\s*초\s*:|^\s*\d+\s*번\s)/;
const MAX_UNIT_CHARS = 45;

/** 대본 텍스트 → 버전(빈 줄/메모 줄로 구분)별 문장 목록 */
export function parseScriptVariants(raw: string): string[][] {
  let lines = raw.replace(/\r/g, '').split('\n');
  const firstHeader = lines.findIndex((l) => SECTION_HEADER.test(l));
  if (firstHeader >= 0) lines = lines.slice(firstHeader); // 헤더 앞의 제품명/링크 줄 무시

  const variants: string[][] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) {
      const text = cur.join('\n').replace(/["“”'‘’]/g, '');
      const sents: string[] = [];
      for (const piece of text.split(/(?<=[.?!~])\s+/)) {
        if (normalizeKo(piece).length > MAX_UNIT_CHARS) {
          sents.push(...piece.split('\n').filter((x) => normalizeKo(x)));
        } else if (normalizeKo(piece)) {
          sents.push(piece);
        }
      }
      const cleaned = sents.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (cleaned.length) variants.push(cleaned);
    }
    cur = [];
  };
  for (const line of lines) {
    if (META_LINE.test(line) || !line.trim()) {
      flush();
      continue;
    }
    cur.push(line.trim());
  }
  flush();
  return variants;
}

// ---------------------------------------------------------------------------
// 2. Whisper 결과 정리
// ---------------------------------------------------------------------------

/** 사람이 말할 수 없는 속도의 받아쓰기 기준 (TTS 한국어는 초당 약 8글자) */
const MAX_PLAUSIBLE_CHARS_PER_SEC = 16;

/**
 * 환각 청크 제거
 *  - "이건데 이건데 이건데 ..." 같은 반복
 *  - 2.6초 구간에 80글자처럼 물리적으로 불가능한 속도 (같은 문장을 반복해 받아쓴 경우)
 */
export function dropHallucinatedChunks(chunks: WhisperRawChunk[]): WhisperRawChunk[] {
  return chunks.filter((c) => {
    const toks = c.text.trim().split(/\s+/).filter(Boolean);
    if (toks.length >= 6 && new Set(toks).size <= Math.max(2, Math.floor(toks.length / 4))) return false;
    const dur = c.end != null ? c.end - c.start : 0;
    if (dur > 0.5 && normalizeKo(c.text).length / dur > MAX_PLAUSIBLE_CHARS_PER_SEC) return false;
    return true;
  });
}

/** 각 문장의 대략적인 시작 시간을 Whisper 글자 위치로 추정 (모르면 null) */
function whisperAnchorTimes(sents: string[], chunks: WhisperRawChunk[]): Array<number | null> {
  const wchars: string[] = [];
  const wtimes: number[] = [];
  for (const c of chunks) {
    const t = normalizeKo(c.text);
    if (!t || c.end == null) continue;
    for (let k = 0; k < t.length; k++) {
      wchars.push(t[k]);
      wtimes.push(c.start + ((c.end - c.start) * k) / t.length);
    }
  }
  const normed = sents.map(normalizeKo);
  const script = normed.join('');
  const map = lcsMapping(script, wchars.join(''));
  const out: Array<number | null> = [];
  let pos = 0;
  for (const s of normed) {
    let found: number | null = null;
    // 신뢰도 검사: 문장 글자의 절반 이상이 Whisper 글자와 연결되고,
    // 연결된 글자들이 문장 길이에 걸맞은 시간 범위 안에 모여 있어야 단서로 쓴다.
    // (환각 구간을 걸러낸 빈자리나 Whisper의 반복 받아쓰기 때문에 엉뚱한 위치와 연결되는 것을 막는다)
    const mapped: number[] = [];
    for (let q = pos; q < pos + s.length; q++) if (map[q] >= 0) mapped.push(wtimes[map[q]]);
    const coverage = mapped.length / Math.max(1, s.length);
    const spread = mapped.length ? mapped[mapped.length - 1] - mapped[0] : Infinity;
    const reliable = coverage >= 0.5 && spread <= s.length * 0.25 + 1.5;
    if (reliable) {
      for (let q = pos; q < pos + Math.max(1, Math.min(s.length, 6)); q++) {
        if (q < map.length && map[q] >= 0) {
          found = wtimes[map[q]] - (q - pos) * 0.12;
          break;
        }
      }
    }
    out.push(found);
    pos += s.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. 파형 발화 덩어리 (ffmpeg silencedetect 와 같은 정의)
// ---------------------------------------------------------------------------

type Island = [number, number];

export function detectSpeechIslands(
  pcm: Float32Array,
  sampleRate: number,
  thresholdDb = -30,
  minSilenceSec = 0.12
): Island[] {
  const thr = Math.pow(10, thresholdDb / 20);
  const minRun = Math.round(minSilenceSec * sampleRate);
  const total = pcm.length / sampleRate;
  const islands: Island[] = [];
  let cursor = 0; // 직전 무음이 끝난 시점 (초)
  let runStart = -1;
  for (let i = 0; i <= pcm.length; i++) {
    const quiet = i < pcm.length && Math.abs(pcm[i]) < thr;
    if (quiet) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (i - runStart >= minRun) {
        const silStart = runStart / sampleRate;
        if (silStart - cursor > 0.05) islands.push([cursor, silStart]);
        cursor = i / sampleRate;
      }
      runStart = -1;
    }
  }
  if (total - cursor > 0.05) islands.push([cursor, total]);
  return islands;
}

/** 지정 시점 근처(±radius)에서 에너지가 가장 낮은 10ms 지점 (한 호흡 안 자막 분할점 다듬기) */
function snapToLocalValley(pcm: Float32Array, sampleRate: number, t: number, lo: number, hi: number, radius = 0.2): number {
  const win = Math.round(0.01 * sampleRate);
  const from = Math.max(lo + 0.1, t - radius);
  const to = Math.min(hi - 0.1, t + radius);
  if (to <= from) return t;
  let best = t;
  let bestE = Infinity;
  for (let s = from; s <= to; s += 0.005) {
    const i0 = Math.floor(s * sampleRate);
    let e = 0;
    for (let i = i0; i < i0 + win && i < pcm.length; i++) e += pcm[i] * pcm[i];
    // 원래 비율 지점에서 멀어질수록 약간의 벌점
    const score = e * (1 + Math.abs(s - t) * 2);
    if (score < bestE) {
      bestE = score;
      best = s;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 자막 한 개를 여러 줄 조각으로 나눌 때의 분할 시점 (한 줄 / 두 줄 재구성용)
// ---------------------------------------------------------------------------

/** 단어 하나를 읽는 데 드는 대략의 음절 수 (한글 1, 숫자 1.3, 영문 0.5) */
function spokenSyllables(word: string): number {
  let n = 0;
  for (const ch of word) {
    if (/[가-힣]/.test(ch)) n += 1;
    else if (/[0-9]/.test(ch)) n += 1.3;
    else if (/[a-zA-Z]/.test(ch)) n += 0.5;
  }
  // 단어 끝 음절 늘임(+ 단어 사이 미세 간격), 문장부호 뒤 호흡
  n += 0.35;
  if (/[,.?!~…]$/.test(word)) n += 0.4;
  return Math.max(0.5, n);
}

/**
 * 자막 문장 하나의 단어별 시작 시점(pcm 기준 초)을 추정한다.
 *
 * - 구간 안의 말소리 덩어리(쉼으로 구분)를 찾고,
 * - 단어들을 순서대로 덩어리 묶음에 배정하되 각 묶음의 "말하는 시간 ÷ 음절 수"가
 *   문장 평균 속도와 가장 비슷해지도록 동적계획법으로 고른다 (쉼은 단어 사이에만 생긴다는 가정).
 * - 한 묶음 안의 단어들은 음절 비율로 시간을 나눈다.
 */
function estimateWordStarts(
  pcm: Float32Array,
  sampleRate: number,
  spanStart: number,
  voiceEnd: number,
  words: string[],
  /** pauseBonus[w] = 단어 w 바로 앞에 쉼이 오는 배정을 선호하는 정도 (자막 조각 경계·쉼표·연결어미) */
  pauseBonus: number[]
): number[] | null {
  const i0 = Math.max(0, Math.floor(spanStart * sampleRate));
  const i1 = Math.min(pcm.length, Math.ceil(voiceEnd * sampleRate));
  if (i1 - i0 < sampleRate * 0.3 || words.length === 0) return null;
  const seg = pcm.subarray(i0, i1);
  let peak = 0;
  for (let i = 0; i < seg.length; i++) {
    const a = Math.abs(seg[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-4) return null;
  const islands = detectSpeechIslands(seg, sampleRate, 20 * Math.log10(peak) - 30, 0.12).map(
    ([s, e]) => [s + spanStart, e + spanStart] as Island
  );
  if (islands.length === 0) return null;

  const syl = words.map(spokenSyllables);
  const W = words.length;
  const I = islands.length;
  const speechTotal = islands.reduce((a, [s, e]) => a + (e - s), 0);
  const sylTotal = syl.reduce((a, b) => a + b, 0);
  const rate = speechTotal / sylTotal; // 음절당 초

  const sylPrefix = [0];
  for (const v of syl) sylPrefix.push(sylPrefix[sylPrefix.length - 1] + v);
  const durPrefix = [0];
  for (const [s, e] of islands) durPrefix.push(durPrefix[durPrefix.length - 1] + (e - s));

  // dp[w][i] = 단어 w개, 덩어리 i개를 소비했을 때 최소 비용
  const INF = Infinity;
  const dp = Array.from({ length: W + 1 }, () => new Array<number>(I + 1).fill(INF));
  const back = Array.from({ length: W + 1 }, () => new Array<[number, number] | null>(I + 1).fill(null));
  dp[0][0] = 0;
  for (let w = 0; w < W; w++) {
    for (let i = 0; i < I; i++) {
      if (dp[w][i] === INF) continue;
      for (let w2 = w + 1; w2 <= W; w2++) {
        const s = sylPrefix[w2] - sylPrefix[w];
        const expected = s * rate;
        for (let i2 = i + 1; i2 <= I; i2++) {
          const d = durPrefix[i2] - durPrefix[i];
          if (d > expected * 3 + 1) break;
          const z = (d - expected) / (0.3 * expected + 0.12);
          // 덩어리 여러 개를 한 묶음으로 합치면(단어 중간의 짧은 끊김) 약간의 벌점,
          // 묶음 끝(= 쉼)이 끊어 읽기 자연스러운 자리면 가산점
          const v =
            dp[w][i] + z * z + 0.15 * (i2 - i - 1) - (w2 < W && i2 < I ? pauseBonus[w2] : 0);
          if (v < dp[w2][i2]) {
            dp[w2][i2] = v;
            back[w2][i2] = [w, i];
          }
        }
      }
    }
  }
  if (dp[W][I] === INF) return null;

  const groups: Array<{ w0: number; w1: number; i0: number; i1: number }> = [];
  let cw = W;
  let ci = I;
  while (cw > 0) {
    const b = back[cw][ci];
    if (!b) return null;
    groups.unshift({ w0: b[0], w1: cw, i0: b[1], i1: ci });
    [cw, ci] = b;
  }

  const starts = new Array<number>(W).fill(0);
  for (const g of groups) {
    // 묶음 안: 말하는 시간(덩어리 사이 짧은 끊김 제외)을 음절 비율로 나눔
    const isl = islands.slice(g.i0, g.i1);
    const speech = isl.reduce((a, [s, e]) => a + (e - s), 0);
    const gSyl = sylPrefix[g.w1] - sylPrefix[g.w0];
    let acc = 0;
    for (let w = g.w0; w < g.w1; w++) {
      let pos = (speech * acc) / gSyl;
      let t = isl[0][0];
      for (const [s, e] of isl) {
        if (pos <= e - s) {
          t = s + pos;
          break;
        }
        pos -= e - s;
        t = e;
      }
      starts[w] = t;
      acc += syl[w];
    }
    // 묶음 안쪽 단어 경계는 근처(±0.12초)에서 가장 조용한 지점으로 다듬음
    for (let w = g.w0 + 1; w < g.w1; w++) {
      starts[w] = snapToLocalValley(pcm, sampleRate, starts[w], starts[w - 1], isl[isl.length - 1][1], 0.12);
    }
  }
  return starts;
}

const PIECE_PAUSE_BONUS = 0.5;
const PUNCT_PAUSE_BONUS = 0.5;
const CONNECTIVE_PAUSE_BONUS = 0;

/**
 * 자막 하나(pcm 기준 [spanStart, voiceEnd])를 pieces 텍스트 조각들로 나눌 때,
 * 각 조각(2번째부터)이 화면에 나타날 시점을 돌려준다 = 그 조각 첫 단어의 시작 시점.
 * 음성 분석이 안 되면 글자 비율로 나눈다.
 */
export function chooseCaptionSplitTimes(
  pcm: Float32Array,
  sampleRate: number,
  spanStart: number,
  voiceEnd: number,
  pieces: string[]
): number[] {
  const n = pieces.length;
  if (n <= 1) return [];
  const cleanPieces = pieces.map((p) => p.replace(/\s+/g, ' ').trim());
  const words: string[] = [];
  const pieceFirstWord: number[] = [];
  for (const p of cleanPieces) {
    pieceFirstWord.push(words.length);
    words.push(...p.split(' ').filter(Boolean));
  }

  // 쉼이 오기 자연스러운 자리: 자막 조각 경계(가장 강함), 쉼표/문장부호, 연결어미 뒤
  const pieceStartSet = new Set(pieceFirstWord.slice(1));
  const pauseBonus = words.map((_, w) => {
    if (w === 0) return 0;
    if (pieceStartSet.has(w)) return PIECE_PAUSE_BONUS;
    const prev = words[w - 1];
    if (/[,.?!~…]$/.test(prev)) return PUNCT_PAUSE_BONUS;
    if (/(니까|는데|지만|다가|면서|하고|해서|어서|아서|라서|고|며|면|요)$/.test(prev)) return CONNECTIVE_PAUSE_BONUS;
    return 0;
  });
  const starts = estimateWordStarts(pcm, sampleRate, spanStart, voiceEnd, words, pauseBonus);
  if (!starts) {
    const syl = cleanPieces.map(spokenSyllables);
    const total = syl.reduce((a, b) => a + b, 0);
    const out: number[] = [];
    let acc = 0;
    for (let k = 0; k < n - 1; k++) {
      acc += syl[k];
      out.push(spanStart + ((voiceEnd - spanStart) * acc) / total);
    }
    return out;
  }
  const out: number[] = [];
  for (let k = 1; k < n; k++) {
    const t = starts[Math.min(starts.length - 1, pieceFirstWord[k])];
    const prev = out.length ? out[out.length - 1] : spanStart;
    out.push(Math.max(prev + 0.1, t));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4~5. 동적계획법 배정
// ---------------------------------------------------------------------------

const ANCHOR_WEIGHT = 1.0;
const ANCHOR_SIGMA = 0.6; // Whisper 위치 오차 허용 (초)

/** 글자 수 C[i]인 단위들을 연속된 발화 덩어리 묶음에 배정. 반환: 단위별 [첫 덩어리, 끝 덩어리+1) */
function dpAlign(C: number[], sub: Island[], rate: number, anchors: Array<number | null>): Array<[number, number]> {
  const N = C.length;
  const M = sub.length;
  const pre = [0];
  for (const [a, b] of sub) pre.push(pre[pre.length - 1] + (b - a));
  const INF = 1e18;
  const dp: Float64Array[] = Array.from({ length: N + 1 }, () => new Float64Array(M + 1).fill(INF));
  const bk: Int32Array[] = Array.from({ length: N + 1 }, () => new Int32Array(M + 1));
  dp[0][0] = 0;
  for (let i = 1; i <= N; i++) {
    const e = Math.max(C[i - 1] * rate, 0.05);
    const an = anchors[i - 1];
    for (let k = i; k <= M - (N - i); k++) {
      for (let j = i - 1; j < k; j++) {
        if (dp[i - 1][j] >= INF) continue;
        let c = dp[i - 1][j] + ((pre[k] - pre[j] - e) / e) ** 2;
        if (an != null) c += ANCHOR_WEIGHT * ((sub[j][0] - an) / ANCHOR_SIGMA) ** 2;
        if (c < dp[i][k]) {
          dp[i][k] = c;
          bk[i][k] = j;
        }
      }
    }
  }
  const seg: Array<[number, number]> = [];
  let k = M;
  for (let i = N; i > 0; i--) {
    const j = bk[i][k];
    seg.push([j, k]);
    k = j;
  }
  return seg.reverse();
}

/** 한 구간(버전 하나 또는 그 일부)의 문장들을 발화 덩어리에 정렬 */
function alignSpan(
  sents: string[],
  sub: Island[],
  chunks: WhisperRawChunk[],
  pcm: Float32Array,
  sampleRate: number,
  variantIndex: number
): AlignedScriptCaption[] {
  if (!sents.length || !sub.length) return [];
  const anchors = whisperAnchorTimes(sents, chunks);

  // 한 호흡 묶음: 위치 단서 근처(±0.5초)에 쉼이 없는 문장은 앞 문장과 함께 정렬
  let groups: number[][] = [[0]];
  for (let k = 1; k < sents.length; k++) {
    const an = anchors[k];
    const nearPause = an != null && sub.slice(1).some((iv) => Math.abs(iv[0] - an) <= 0.5);
    if (an != null && !nearPause) groups[groups.length - 1].push(k);
    else groups.push([k]);
  }
  const groupChars = (g: number[]) => g.reduce((acc, x) => acc + normalizeKo(sents[x]).length, 0);
  while (groups.length > sub.length && groups.length > 1) {
    let q = 0;
    let best = Infinity;
    for (let x = 0; x < groups.length - 1; x++) {
      const v = groupChars(groups[x]) + groupChars(groups[x + 1]);
      if (v < best) {
        best = v;
        q = x;
      }
    }
    groups = [...groups.slice(0, q), [...groups[q], ...groups[q + 1]], ...groups.slice(q + 2)];
  }

  const C = groups.map(groupChars);
  const speech = sub.reduce((acc, [a, b]) => acc + (b - a), 0);
  const rate = speech / Math.max(1, C.reduce((a, b) => a + b, 0));
  const gseg = dpAlign(C, sub, rate, groups.map((g) => anchors[g[0]]));

  const out: AlignedScriptCaption[] = [];
  groups.forEach((g, gi) => {
    const [a, b] = gseg[gi];
    const gst = sub[a][0];
    const gen = sub[b - 1][1];
    const groupSpeech = sub.slice(a, b).reduce((acc, [x, y]) => acc + (y - x), 0);
    const ratio = groupSpeech / Math.max(0.05, C[gi] * rate);
    const tot = C[gi];
    let acc = 0;
    let prevEnd = gst;
    g.forEach((x, idx) => {
      const L = normalizeKo(sents[x]).length;
      acc += L;
      let splitEnd = idx === g.length - 1 ? gen : gst + ((gen - gst) * acc) / tot;
      if (idx < g.length - 1) splitEnd = snapToLocalValley(pcm, sampleRate, splitEnd, prevEnd, gen);
      out.push({
        text: sents[x],
        start: prevEnd,
        end: splitEnd,
        voiceEnd: splitEnd,
        confidence: 0,
        needsReview: !(ratio >= 0.6 && ratio <= 1.6),
        inBreath: g.length > 1,
        variantIndex,
      });
      prevEnd = splitEnd;
    });
  });

  // 6. 검증: 자막 구간 안에서 Whisper가 들은 글자와 대본 일치도
  for (const cap of out) {
    const heard = normalizeKo(
      chunks
        .filter((c) => c.end != null && (c.end as number) > cap.start + 0.05 && c.start < cap.voiceEnd - 0.05)
        .map((c) => c.text)
        .join('')
    );
    const s = normalizeKo(cap.text);
    let best = 0;
    for (let k = 0; k <= Math.max(0, heard.length - s.length); k += 2) {
      best = Math.max(best, textSimilarity(s, heard.slice(k, k + s.length)));
      if (best >= 0.999) break;
    }
    cap.confidence = Number(best.toFixed(3));
    if (best < 0.6) cap.needsReview = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 메인
// ---------------------------------------------------------------------------

export function alignScriptToAudio(params: {
  pcm: Float32Array;
  sampleRate: number;
  scriptText: string;
  whisperChunks: WhisperRawChunk[];
  options?: ScriptAlignOptions;
}): ScriptAlignResult {
  const { pcm, sampleRate, scriptText, options = {} } = params;
  const { silenceThresholdDb = -30, minSilenceSec = 0.12, maxGapBridgeSec = 2.2 } = options;
  const warnings: string[] = [];
  const variants = parseScriptVariants(scriptText);
  const empty = (msg: string, score = 0): ScriptAlignResult => ({
    mode: 'none',
    captions: [],
    matchScore: score,
    variantOrder: [],
    warnings: [msg],
  });
  if (!variants.length) return empty('대본에서 읽을 문장을 찾지 못했습니다.');

  const chunks = dropHallucinatedChunks(params.whisperChunks).filter((c) => normalizeKo(c.text));
  if (chunks.length < params.whisperChunks.length) {
    warnings.push(`Whisper 반복 환각 ${params.whisperChunks.length - chunks.length}구간을 위치 단서에서 제외했습니다.`);
  }
  const heard = normalizeKo(chunks.map((c) => c.text).join(''));
  if (!heard) return empty('음성에서 말소리를 찾지 못했습니다.');

  const islands = detectSpeechIslands(pcm, sampleRate, silenceThresholdDb, minSilenceSec);
  if (!islands.length) return empty('파형에서 발화 구간을 찾지 못했습니다.');

  // --- 한 파일 안에 여러 버전이 있는지: 각 버전 고유 문장(다른 버전에 없는 문장)의 위치를 찾는다
  const allNormed = variants.flatMap((v) => v.map(normalizeKo));
  const found: Array<{ variantIndex: number; t: number; score: number }> = [];
  variants.forEach((v, vi) => {
    const hookIdx = v.findIndex((s) => {
      const n = normalizeKo(s);
      return n.length >= 6 && allNormed.filter((x) => x === n).length === 1;
    });
    if (hookIdx < 0) return;
    const hook = normalizeKo(v[hookIdx]);
    let best = { t: 0, score: 0 };
    for (const c of chunks) {
      const ct = normalizeKo(c.text);
      const sc = textSimilarity(hook.slice(0, ct.length + 5), ct);
      if (sc > best.score) best = { t: c.start, score: sc };
    }
    if (best.score >= 0.75) {
      const before = v.slice(0, hookIdx).reduce((acc, s) => acc + normalizeKo(s).length, 0);
      found.push({ variantIndex: vi, t: Math.max(0, best.t - before * 0.12), score: best.score });
    }
  });

  let captions: AlignedScriptCaption[] = [];
  let mode: ScriptAlignResult['mode'] = 'single';
  let matchScore = 0;
  let variantOrder: ScriptAlignResult['variantOrder'] = [];

  if (found.length >= 2) {
    // ---- 여러 버전이 한 파일에: 버전별 구간으로 잘라 각각 정렬
    mode = 'multi';
    found.sort((a, b) => a.t - b.t);
    const nearestIslandStart = (t: number) =>
      islands.reduce((best, iv) => (Math.abs(iv[0] - t) < Math.abs(best - t) ? iv[0] : best), islands[0][0]);
    const bounds = found.map((f) => nearestIslandStart(f.t));
    bounds[0] = 0;
    found.forEach((f, n) => {
      const lo = bounds[n] - 0.05;
      const hi = n + 1 < bounds.length ? bounds[n + 1] - 0.05 : Infinity;
      const sub = islands.filter((iv) => iv[0] >= lo && iv[0] < hi);
      const spanChunks = chunks.filter((c) => c.start >= lo - 0.5 && c.start < hi);
      captions.push(...alignSpan(variants[f.variantIndex], sub, spanChunks, pcm, sampleRate, f.variantIndex));
    });
    matchScore = Math.min(...found.map((f) => f.score));
    variantOrder = found.map((f, n) => ({ variantIndex: f.variantIndex, start: bounds[n] }));
  } else {
    // ---- 한 파일 = 대본 한 버전의 연속된 문장들 (전체 또는 일부)
    let best = { score: 0, vi: -1, i: 0, j: 0 };
    variants.forEach((v, vi) => {
      for (let i = 0; i < v.length; i++) {
        let acc = '';
        for (let j = i; j < v.length; j++) {
          acc += normalizeKo(v[j]);
          if (acc.length > heard.length * 1.6) break;
          if (acc.length < heard.length * 0.4) continue;
          const sc = textSimilarity(acc, heard);
          if (sc > best.score) best = { score: sc, vi, i, j };
        }
      }
    });
    matchScore = best.score;
    if (best.vi < 0 || best.score < 0.3) {
      return empty(`대본과 일치하지 않는 음성입니다(일치도 ${best.score.toFixed(2)}). 배경음악이거나 다른 대본일 수 있습니다.`, best.score);
    }
    if (best.score < 0.6) warnings.push(`대본 일치도가 낮습니다(${best.score.toFixed(2)}). 대본이 수정되었는지 확인하세요.`);
    const sents = variants[best.vi].slice(best.i, best.j + 1);
    captions = alignSpan(sents, islands, chunks, pcm, sampleRate, best.vi);
    variantOrder = [{ variantIndex: best.vi, start: captions[0]?.start ?? 0 }];
  }

  // 자막 사이 짧은 공백은 다음 자막 시작까지 이어서 표시 (깜빡임 방지)
  captions.sort((a, b) => a.start - b.start);
  for (let k = 0; k < captions.length; k++) {
    const next = captions[k + 1];
    if (next) {
      const gap = next.start - captions[k].voiceEnd;
      captions[k].end = gap >= 0 && gap <= maxGapBridgeSec ? next.start : Math.min(next.start, captions[k].voiceEnd + 0.6);
    } else {
      captions[k].end = Math.min(pcm.length / sampleRate, captions[k].voiceEnd + 0.6);
    }
  }
  for (const c of captions) {
    c.start = Number(c.start.toFixed(3));
    c.end = Number(c.end.toFixed(3));
    c.voiceEnd = Number(c.voiceEnd.toFixed(3));
  }

  const review = captions.filter((c) => c.needsReview).length;
  if (review) warnings.push(`확신도가 낮은 자막 ${review}개에 검토 표시를 했습니다.`);
  return { mode, captions, matchScore, variantOrder, warnings };
}
