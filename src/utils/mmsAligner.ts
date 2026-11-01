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

/**
 * CTC 강제 정렬 (torchaudio.functional.forced_align 과 같은 비터비)
 * logProbs: [frames x numLabels] (행 우선), tokens: 라벨 인덱스 배열 (blank=0 제외)
 * 반환: 토큰별 시작 프레임 (정렬 불가능하면 null)
 */
export function ctcForcedAlignStarts(
  logProbs: Float32Array,
  frames: number,
  numLabels: number,
  tokens: number[]
): number[] | null {
  const L = tokens.length;
  if (L === 0) return [];
  const S = 2 * L + 1;
  // 필요한 최소 프레임 수 (같은 글자 연속이면 사이에 blank 필요)
  let minFrames = L;
  for (let i = 1; i < L; i++) if (tokens[i] === tokens[i - 1]) minFrames++;
  if (frames < minFrames) return null;

  const NEG = -1e30;
  let prev = new Float64Array(S).fill(NEG);
  let cur = new Float64Array(S).fill(NEG);
  // back[t*S + s] = 이전 상태로부터 몇 칸 왔는지 (0,1,2)
  const back = new Uint8Array(frames * S);
  const label = (s: number) => (s % 2 === 0 ? 0 : tokens[(s - 1) >> 1]);

  prev[0] = logProbs[0 * numLabels + 0];
  prev[1] = logProbs[0 * numLabels + tokens[0]];
  for (let t = 1; t < frames; t++) {
    const row = t * numLabels;
    // 남은 프레임으로 끝까지 갈 수 있는 상태만 (가지치기 없이도 충분히 빠름)
    for (let s = 0; s < S; s++) {
      let best = prev[s];
      let step = 0;
      if (s >= 1 && prev[s - 1] > best) {
        best = prev[s - 1];
        step = 1;
      }
      if (s >= 2 && s % 2 === 1 && tokens[(s - 1) >> 1] !== tokens[(s - 3) >> 1] && prev[s - 2] > best) {
        best = prev[s - 2];
        step = 2;
      }
      cur[s] = best <= NEG / 2 ? NEG : best + logProbs[row + label(s)];
      back[t * S + s] = step;
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  let s = prev[S - 1] >= prev[S - 2] ? S - 1 : S - 2;
  if (prev[s] <= NEG / 2) return null;

  const starts = new Array<number>(L).fill(-1);
  for (let t = frames - 1; t >= 0; t--) {
    if (s % 2 === 1) starts[(s - 1) >> 1] = t; // 거꾸로 가므로 마지막에 기록된 값이 첫 프레임
    if (t > 0) s -= back[t * S + s];
  }
  if (starts.some((v) => v < 0)) return null;
  return starts;
}

/**
 * 한 구간의 emission 과 단어 목록으로 단어별 시작 시점(구간 기준 초)을 구한다.
 * 로마자로 바꿀 수 없는 단어(기호 등)는 앞뒤 단어 사이로 보간.
 */
export function wordStartsFromEmission(
  logProbs: Float32Array,
  frames: number,
  numLabels: number,
  samples: number,
  words: string[]
): number[] | null {
  const romans = words.map(romanizeForMms);
  const tokens: number[] = [];
  const wordFirstToken: number[] = [];
  romans.forEach((r) => {
    wordFirstToken.push(r ? tokens.length : -1);
    for (const ch of r) tokens.push(LABEL_INDEX.get(ch) ?? 0);
  });
  if (tokens.length === 0) return null;
  const starts = ctcForcedAlignStarts(logProbs, frames, numLabels, tokens);
  if (!starts) return null;
  const secPerFrame = samples / frames / MMS_SAMPLE_RATE;
  const out = wordFirstToken.map((ti) => (ti >= 0 ? starts[ti] * secPerFrame : NaN));
  // 보간
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
