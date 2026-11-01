/**
 * MMS 강제 정렬(Forced Alignment) 순수 로직 — 렌더러/메인 공용 (모델 실행은 메인 프로세스)
 *
 * 자막 글자가 음성의 정확히 어디서 시작하는지 찾는다.
 * - 모델: Meta MMS forced aligner(wav2vec2, torchaudio MMS_FA)를 ONNX(int8)로 변환한 것.
 *   입력 16kHz 음성 → 20ms 프레임마다 로마자 28개 기호의 log 확률(emission)
 * - 한글은 모델 학습 때와 같은 uroman 규칙으로 로마자 변환 (자모 표는 uroman 에서 그대로 추출, 11,172자 전수 일치)
 * - CTC 비터비 정렬로 각 글자(로마자)가 처음 나타나는 프레임을 찾아 단어 시작 시점을 얻는다.
 */

export const MMS_SAMPLE_RATE = 16000;
export const MMS_LABELS = ['-', 'a', 'i', 'e', 'n', 'o', 'u', 't', 's', 'r', 'm', 'k', 'l', 'd', 'g', 'h', 'y', 'b', 'p', 'w', 'c', 'v', 'j', 'z', 'f', "'", 'q', 'x'];
const LABEL_INDEX = new Map(MMS_LABELS.map((l, i) => [l, i]));

// uroman 한글 자모 로마자 표 (초성 19 / 중성 21 / 종성 28)
const INI = ['g', 'gg', 'n', 'd', 'dd', 'r', 'm', 'b', 'bb', 's', 'ss', '', 'j', 'jj', 'c', 'k', 't', 'p', 'h'];
const VOW = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wai', 'oe', 'yo', 'u', 'weo', 'we', 'wi', 'yu', 'eu', 'yi', 'i'];
const FIN = ['', 'g', 'gg', 'gs', 'n', 'nj', 'nh', 'd', 'l', 'lg', 'lm', 'lb', 'ls', 'lt', 'lp', 'lh', 'm', 'b', 'bs', 's', 'ss', 'ng', 'j', 'c', 'k', 't', 'p', 'h'];

const DIGIT_KO = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];

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
      const digits = String(group).padStart(4, '0').split('').map(Number);
      digits.forEach((d, i) => {
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

/** 단어 속 숫자/기호를 한국어 읽기로 바꿈 (4.8 → 사점팔, 100% → 백퍼센트) */
function spellOutNumbers(word: string): string {
  return word
    .replace(/(\d+)\.(\d+)/g, (_, a, b) => readSinoNumber(Number(a)) + '점' + b.split('').map((d: string) => DIGIT_KO[Number(d)]).join(''))
    .replace(/\d+/g, (m) => (m.length > 12 ? m.split('').map((d) => DIGIT_KO[Number(d)]).join('') : readSinoNumber(Number(m))))
    .replace(/%/g, '퍼센트');
}

/** 단어 하나를 MMS 모델 기호(a-z, ')로 변환. 읽을 게 없으면 빈 문자열 */
export function romanizeForMms(word: string): string {
  let out = '';
  for (const ch of spellOutNumbers(word)) {
    const code = ch.codePointAt(0)!;
    if (code >= 0xac00 && code <= 0xd7a3) {
      const o = code - 0xac00;
      out += INI[Math.floor(o / 588)] + VOW[Math.floor((o % 588) / 28)] + FIN[o % 28];
    } else if (/[a-zA-Z']/.test(ch)) {
      out += ch.toLowerCase();
    }
  }
  return out;
}

const LETTER_KO: Record<string, string> = {
  a: '에이', b: '비', c: '씨', d: '디', e: '이', f: '에프', g: '지', h: '에이치', i: '아이', j: '제이',
  k: '케이', l: '엘', m: '엠', n: '엔', o: '오', p: '피', q: '큐', r: '알', s: '에스', t: '티',
  u: '유', v: '브이', w: '더블유', x: '엑스', y: '와이', z: '지',
};

/**
 * 정렬 모델별 "글자 → 모델 토큰" 규칙
 * - blank: CTC 빈칸 토큰 번호
 * - tokenizeWord: 단어 하나 → 토큰 배열 (모델 사전에 없는 글자는 -1 = 아무 글자)
 * - wordDelimiter: 단어 사이에 넣을 구분 토큰 (없으면 넣지 않음)
 */
export type AlignTokenizer = {
  blank: number;
  tokenizeWord: (word: string) => number[];
  wordDelimiter?: number;
};

/** Meta MMS(로마자 28기호) 모델용 (CC-BY-NC — 테스트 전용) */
export const MMS_TOKENIZER: AlignTokenizer = {
  blank: 0,
  tokenizeWord: (w) => Array.from(romanizeForMms(w)).map((ch) => LABEL_INDEX.get(ch) ?? 0),
};

/**
 * 한글 음절 사전을 쓰는 wav2vec2 CTC 모델용 (예: kresnik/wav2vec2-large-xlsr-korean, Apache-2.0)
 * vocab: 모델 vocab.json (음절 → 번호), 빈칸은 [PAD], 단어 구분은 '|'
 */
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
      const spoken = spellOutNumbers(word).replace(/[a-zA-Z]/g, (c) => LETTER_KO[c.toLowerCase()] || '');
      const out: number[] = [];
      for (const ch of spoken) {
        if (/[가-힣]/.test(ch)) out.push(vocab[ch] ?? -1);
      }
      return out;
    },
  };
}

/**
 * CTC 강제 정렬 (torchaudio.functional.forced_align 과 같은 비터비)
 * logProbs: [frames x numLabels] (행 우선)
 * tokens: 라벨 번호 배열 (-1 = 아무 글자: 그 프레임에서 빈칸 외 가장 높은 확률 사용)
 * 반환: 토큰별 시작 프레임 (정렬 불가능하면 null)
 */
export function ctcForcedAlignStarts(
  logProbs: Float32Array,
  frames: number,
  numLabels: number,
  tokens: number[],
  blank = 0
): number[] | null {
  return ctcForcedAlignSpans(logProbs, frames, numLabels, tokens, blank)?.starts ?? null;
}

/** ctcForcedAlignStarts 와 같지만 토큰별 시작/끝 프레임을 함께 돌려준다 */
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

/**
 * 단어별 [시작, 끝] (구간 기준 초). 토큰이 없는 단어는 null.
 * secPerFrame: 프레임 하나의 길이 (초)
 */
export function wordSpansFromEmission(
  logProbs: Float32Array,
  frames: number,
  numLabels: number,
  secPerFrame: number,
  words: string[],
  tokenizer: AlignTokenizer
): Array<[number, number] | null> | null {
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
  const al = ctcForcedAlignSpans(logProbs, frames, numLabels, tokens, tokenizer.blank);
  if (!al) return null;
  return wordTok.map((r) => (r ? [al.starts[r[0]] * secPerFrame, al.ends[r[1]] * secPerFrame] : null));
}

/**
 * 한 구간의 emission 과 단어 목록으로 단어별 시작 시점(구간 기준 초)을 구한다.
 * 토큰으로 바꿀 수 없는 단어(기호 등)는 앞뒤 단어 사이로 보간.
 */
export function wordStartsFromEmission(
  logProbs: Float32Array,
  frames: number,
  numLabels: number,
  samples: number,
  words: string[],
  tokenizer: AlignTokenizer = MMS_TOKENIZER
): number[] | null {
  const tokens: number[] = [];
  const wordFirstToken: number[] = [];
  words.forEach((w) => {
    const wt = tokenizer.tokenizeWord(w);
    if (wt.length > 0 && tokens.length > 0 && tokenizer.wordDelimiter !== undefined) {
      tokens.push(tokenizer.wordDelimiter);
    }
    wordFirstToken.push(wt.length ? tokens.length : -1);
    tokens.push(...wt);
  });
  if (tokens.length === 0) return null;
  const starts = ctcForcedAlignStarts(logProbs, frames, numLabels, tokens, tokenizer.blank);
  if (!starts) return null;
  const secPerFrame = samples / frames / MMS_SAMPLE_RATE;
  const out = wordFirstToken.map((ti) => (ti >= 0 ? starts[ti] * secPerFrame : NaN));
  for (let i = 0; i < out.length; i++) {
    if (!Number.isNaN(out[i])) continue;
    let j = i + 1;
    while (j < out.length && Number.isNaN(out[j])) j++;
    const left = i > 0 ? out[i - 1] : 0;
    const right = j < out.length ? out[j] : samples / MMS_SAMPLE_RATE;
    for (let k = i; k < j; k++) out[k] = left + ((right - left) * (k - i + 1)) / (j - i + 1);
    i = j - 1;
  }
  return out;
}

/**
 * 긴 음성(광고 한 편 전체 등)의 단어별 [시작, 끝] 초.
 * 모델은 긴 입력을 한 번에 넣으면 메모리를 많이 쓰므로 20초 단위로 나눠 emission 을 구한 뒤
 * 이어 붙여서 한 번의 CTC 정렬로 처리한다 (글자 순서가 음성 전체에 걸쳐 일관되게 맞춰짐).
 */
export async function alignWordSpansLong(
  runModel: (chunk: Float32Array) => Promise<{ data: Float32Array; frames: number; labels: number }>,
  pcm: Float32Array,
  words: string[],
  tokenizer: AlignTokenizer,
  chunkSec = 20
): Promise<Array<[number, number] | null> | null> {
  const chunkLen = Math.round(chunkSec * MMS_SAMPLE_RATE);
  const parts: Array<{ data: Float32Array; frames: number; startSec: number; secPerFrame: number }> = [];
  let labels = 0;
  for (let s0 = 0; s0 < pcm.length; s0 += chunkLen) {
    const chunk = pcm.subarray(s0, Math.min(pcm.length, s0 + chunkLen));
    if (chunk.length < MMS_SAMPLE_RATE * 0.1) break;
    const r = await runModel(chunk);
    labels = r.labels;
    parts.push({ data: r.data, frames: r.frames, startSec: s0 / MMS_SAMPLE_RATE, secPerFrame: chunk.length / r.frames / MMS_SAMPLE_RATE });
  }
  if (parts.length === 0) return null;
  const frames = parts.reduce((a, p) => a + p.frames, 0);
  const all = new Float32Array(frames * labels);
  const frameTime = new Float64Array(frames + 1);
  let f0 = 0;
  for (const p of parts) {
    all.set(p.data.subarray(0, p.frames * labels), f0 * labels);
    for (let f = 0; f < p.frames; f++) frameTime[f0 + f] = p.startSec + f * p.secPerFrame;
    f0 += p.frames;
  }
  frameTime[frames] = pcm.length / MMS_SAMPLE_RATE;
  const spansF = wordSpansFromEmission(all, frames, labels, 1, words, tokenizer);
  if (!spansF) return null;
  return spansF.map((sp) => (sp ? [frameTime[sp[0]], frameTime[Math.min(frames, sp[1])]] : null));
}
