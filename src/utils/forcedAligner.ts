/**
 * 강제 정렬(Forced Alignment) 순수 로직 — 렌더러/메인 공용 (모델 실행은 메인 프로세스)
 *
 * 자막 글자가 음성의 정확히 어디서 발음되는지 찾는다.
 * - 모델: kresnik/wav2vec2-large-xlsr-korean (Apache-2.0, 한글 음절 CTC) → ONNX int8
 *   입력 16kHz 음성 → 20ms 프레임마다 음절 1,205개의 log 확률(emission)
 * - 음성 클립 하나의 emission 은 한 번만 계산해 두고(긴 음성은 20초 단위로 나눠 계산 후 이어 붙임),
 *   자막 구간마다 필요한 프레임만 잘라 CTC 비터비 정렬을 돌린다.
 */

export const ALIGN_SAMPLE_RATE = 16000;

const DIGIT_KO = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const LETTER_KO: Record<string, string> = {
  a: '에이', b: '비', c: '씨', d: '디', e: '이', f: '에프', g: '지', h: '에이치', i: '아이', j: '제이',
  k: '케이', l: '엘', m: '엠', n: '엔', o: '오', p: '피', q: '큐', r: '알', s: '에스', t: '티',
  u: '유', v: '브이', w: '더블유', x: '엑스', y: '와이', z: '지',
};

/** 정수를 한자어 수사로 읽기 (예: 360 → 삼백육십, 120 → 백이십) */
function readSinoNumber(n: number): string {
  if (n === 0) return '영';
  const units = ['', '십', '백', '천'];
  const big = ['', '만', '억', '조'];
  let out = '';
  let groupIdx = 0;
  while (n > 0 && groupIdx < big.length) {
    const group = n % 10000;
    if (group > 0) {
      let g = '';
      String(group)
        .padStart(4, '0')
        .split('')
        .map(Number)
        .forEach((d, i) => {
          if (d === 0) return;
          const unit = units[3 - i];
          g += (d === 1 && unit ? '' : DIGIT_KO[d]) + unit;
        });
      out = g + big[groupIdx] + out;
    }
    n = Math.floor(n / 10000);
    groupIdx++;
  }
  return out;
}

/** 단어 속 숫자/영문/기호를 한국어 읽기로 바꿈 (4.8 → 사점팔, 100% → 백퍼센트, LED → 엘이디) */
function spokenForm(word: string): string {
  return word
    .replace(/(\d+)\.(\d+)/g, (_, a, b) => readSinoNumber(Number(a)) + '점' + b.split('').map((d: string) => DIGIT_KO[Number(d)]).join(''))
    .replace(/\d+/g, (m) => (m.length > 12 ? m.split('').map((d) => DIGIT_KO[Number(d)]).join('') : readSinoNumber(Number(m))))
    .replace(/%/g, '퍼센트')
    .replace(/[a-zA-Z]/g, (c) => LETTER_KO[c.toLowerCase()] || '');
}

/**
 * 글자 → 모델 토큰 규칙
 * - blank: CTC 빈칸 토큰 번호
 * - tokenizeWord: 단어 하나 → 토큰 배열 (모델 사전에 없는 음절은 -1 = 아무 글자)
 * - wordDelimiter: 단어 사이에 넣을 구분 토큰 (없으면 넣지 않음)
 */
export type AlignTokenizer = {
  blank: number;
  tokenizeWord: (word: string) => number[];
  wordDelimiter?: number;
};

/** 한글 음절 사전 모델용 토크나이저 (vocab.json: 음절 → 번호, 빈칸 [PAD], 단어 구분 '|') */
export function createSyllableTokenizer(
  vocab: Record<string, number>,
  opts: { useWordDelimiter?: boolean } = {}
): AlignTokenizer {
  const blank = vocab['[PAD]'] ?? vocab['<pad>'] ?? 0;
  const delimiter = vocab['|'];
  return {
    blank,
    wordDelimiter: opts.useWordDelimiter && delimiter !== undefined ? delimiter : undefined,
    tokenizeWord: (word) => {
      const out: number[] = [];
      for (const ch of spokenForm(word)) {
        if (/[가-힣]/.test(ch)) out.push(vocab[ch] ?? -1);
      }
      return out;
    },
  };
}

/**
 * CTC 강제 정렬 (torchaudio.functional.forced_align 과 같은 비터비)
 * logProbs: [frames x numLabels] (행 우선), tokens: 라벨 번호 (-1 = 아무 글자)
 * 반환: 토큰별 시작/끝 프레임 (정렬 불가능하면 null)
 */
export function ctcForcedAlignSpans(
  logProbs: Float32Array,
  frames: number,
  numLabels: number,
  tokens: number[],
  blank = 0
): { starts: number[]; ends: number[] } | null {
  const L = tokens.length;
  if (L === 0) return { starts: [], ends: [] };
  const S = 2 * L + 1;
  let minFrames = L;
  for (let i = 1; i < L; i++) if (tokens[i] === tokens[i - 1] && tokens[i] >= 0) minFrames++;
  if (frames < minFrames) return null;

  // 아무 글자(-1)용: 프레임별 빈칸 외 최대 확률
  let wildcard: Float32Array | null = null;
  if (tokens.some((t) => t < 0)) {
    wildcard = new Float32Array(frames);
    for (let t = 0; t < frames; t++) {
      let m = -Infinity;
      const row = t * numLabels;
      for (let c = 0; c < numLabels; c++) if (c !== blank && logProbs[row + c] > m) m = logProbs[row + c];
      wildcard[t] = m;
    }
  }
  const emit = (t: number, s: number) => {
    if (s % 2 === 0) return logProbs[t * numLabels + blank];
    const tok = tokens[(s - 1) >> 1];
    return tok < 0 ? wildcard![t] : logProbs[t * numLabels + tok];
  };

  const NEG = -1e30;
  let prev = new Float64Array(S).fill(NEG);
  let cur = new Float64Array(S).fill(NEG);
  const back = new Uint8Array(frames * S);
  prev[0] = emit(0, 0);
  prev[1] = emit(0, 1);
  for (let t = 1; t < frames; t++) {
    for (let s = 0; s < S; s++) {
      let best = prev[s];
      let step = 0;
      if (s >= 1 && prev[s - 1] > best) {
        best = prev[s - 1];
        step = 1;
      }
      if (s >= 3 && s % 2 === 1) {
        const a = tokens[(s - 1) >> 1];
        const b = tokens[(s - 3) >> 1];
        if ((a !== b || a < 0) && prev[s - 2] > best) {
          best = prev[s - 2];
          step = 2;
        }
      }
      cur[s] = best <= NEG / 2 ? NEG : best + emit(t, s);
      back[t * S + s] = step;
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  let s = prev[S - 1] >= prev[S - 2] ? S - 1 : S - 2;
  if (prev[s] <= NEG / 2) return null;

  const starts = new Array<number>(L).fill(-1);
  const ends = new Array<number>(L).fill(-1);
  for (let t = frames - 1; t >= 0; t--) {
    if (s % 2 === 1) {
      const k = (s - 1) >> 1;
      starts[k] = t; // 거꾸로 가므로 마지막에 기록된 값이 첫 프레임
      if (ends[k] < 0) ends[k] = t + 1;
    }
    if (t > 0) s -= back[t * S + s];
  }
  if (starts.some((v) => v < 0)) return null;
  return { starts, ends };
}

/** 음성 클립 하나의 emission (프레임별 log 확률 + 프레임 시각표) */
export type Emission = {
  data: Float32Array; // [frames x labels]
  frames: number;
  labels: number;
  frameTime: Float64Array; // 길이 frames + 1, 프레임 시작 시각(초), 마지막은 음성 끝
};

export type RunModel = (chunk: Float32Array) => Promise<{ data: Float32Array; frames: number; labels: number }>;

/** 긴 음성은 20초 단위로 나눠 모델을 돌리고 이어 붙인다 (메모리 절약) */
export async function computeEmission(runModel: RunModel, pcm: Float32Array, chunkSec = 20): Promise<Emission | null> {
  const chunkLen = Math.round(chunkSec * ALIGN_SAMPLE_RATE);
  const parts: Array<{ data: Float32Array; frames: number; startSec: number; secPerFrame: number }> = [];
  let labels = 0;
  for (let s0 = 0; s0 < pcm.length; s0 += chunkLen) {
    const chunk = pcm.subarray(s0, Math.min(pcm.length, s0 + chunkLen));
    if (chunk.length < ALIGN_SAMPLE_RATE * 0.1) break;
    const r = await runModel(chunk);
    labels = r.labels;
    parts.push({
      data: r.data,
      frames: r.frames,
      startSec: s0 / ALIGN_SAMPLE_RATE,
      secPerFrame: chunk.length / r.frames / ALIGN_SAMPLE_RATE,
    });
  }
  if (parts.length === 0) return null;
  const frames = parts.reduce((a, p) => a + p.frames, 0);
  const data = new Float32Array(frames * labels);
  const frameTime = new Float64Array(frames + 1);
  let f0 = 0;
  for (const p of parts) {
    data.set(p.data.subarray(0, p.frames * labels), f0 * labels);
    for (let f = 0; f < p.frames; f++) frameTime[f0 + f] = p.startSec + f * p.secPerFrame;
    f0 += p.frames;
  }
  frameTime[frames] = pcm.length / ALIGN_SAMPLE_RATE;
  return { data, frames, labels, frameTime };
}

/**
 * emission 의 [startSec, endSec] 구간에 단어들을 정렬해 단어별 [시작, 끝] 초(클립 기준)를 돌려준다.
 * 토큰으로 바꿀 수 없는 단어(기호 등)는 null.
 */
export function wordSpansInRange(
  em: Emission,
  startSec: number,
  endSec: number,
  words: string[],
  tokenizer: AlignTokenizer
): Array<[number, number] | null> | null {
  // 구간에 해당하는 프레임 범위
  let f0 = 0;
  while (f0 < em.frames && em.frameTime[f0 + 1] <= startSec) f0++;
  let f1 = f0;
  while (f1 < em.frames && em.frameTime[f1] < endSec) f1++;
  const frames = f1 - f0;
  if (frames <= 0) return null;

  const tokens: number[] = [];
  const wordTok: Array<[number, number] | null> = [];
  words.forEach((w) => {
    const wt = tokenizer.tokenizeWord(w);
    if (wt.length > 0 && tokens.length > 0 && tokenizer.wordDelimiter !== undefined) {
      tokens.push(tokenizer.wordDelimiter);
    }
    wordTok.push(wt.length ? [tokens.length, tokens.length + wt.length - 1] : null);
    tokens.push(...wt);
  });
  if (tokens.length === 0) return null;
  const slice = em.data.subarray(f0 * em.labels, f1 * em.labels);
  const al = ctcForcedAlignSpans(slice, frames, em.labels, tokens, tokenizer.blank);
  if (!al) return null;
  return wordTok.map((r) =>
    r ? [em.frameTime[f0 + al.starts[r[0]]], em.frameTime[Math.min(em.frames, f0 + al.ends[r[1]])]] : null
  );
}

/** 음성 클립 식별 키 (같은 파일·같은 구간이면 같은 키 → 메인 프로세스 emission 캐시 재사용) */
export function clipAudioKey(sourcePath: string, sourceStart: number, duration: number): string {
  return `${sourcePath}|${sourceStart.toFixed(3)}|${duration.toFixed(3)}`;
}
