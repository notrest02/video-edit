/**
 * STEP 0 '대본 만들기' 공용 규칙 (화면 + 메인 프로세스 둘 다 씀)
 * 규칙 원본: 사용자와 맞춘 것 (2026-11-04, 캐릭터흡착선반으로 시험)
 *  - 3버전은 후킹만 다른 게 아니라 이야기 자체가 다르게. 단 같은 제품 광고 시리즈라 말투·핵심 한 줄·마무리는 일관되게
 *  - TTS가 읽으므로 ㅋㅋ·ㅎㅎ·이모지·특수문자 금지
 *  - 후킹 장면 3~5초, 후킹 문장과 맞는 장면
 */

/** 후킹(첫 문장) 방식 — 고객 대본에서 뽑은 유형 */
export const HOOK_TYPES: Array<{ id: string; guide: string; example: string }> = [
  { id: '손해 고백형', guide: '몰라서 손해 보거나 고생했다고 고백하며 시작', example: '이거 몰라서 여태 손해봤어요' },
  { id: '지인 에피소드형', guide: '가족·친구·지인이 한 말이나 행동으로 시작', example: '엄마가 치약 때문에 저한테 화냈어요' },
  { id: '반전형', guide: '예상을 뒤집는 한마디로 시작', example: '아니 이런 게 있었다고?' },
  { id: '발견 감탄형', guide: '드디어 찾았다는 감탄으로 시작', example: '와 이거 드디어 찾았어요' },
  { id: '공감 질문형', guide: '시청자가 겪는 불편을 콕 집는 질문으로 시작', example: '벽 왜 뚫어요? 이거 하나 붙이면 끝인데' },
];
export const HOOK_AUTO = '자동';

/** 한 번에 만들 수 있는 버전 수 (사용자가 숫자로 입력. 너무 큰 실수 입력만 막는 상한 — 8개 넘으면 나눠서 쓴다) */
export const MAX_VERSIONS = 30;

/**
 * 버전 방식 (클라이언트마다 원하는 게 다름)
 *  distribute: 소구점을 버전마다 나눠 맡김 (올지 옷걸이 오더: "모든 영상에 동일하게 넣기보다 콘셉트에 맞게 나눠서")
 *  story:      이야기는 다르게, 핵심 한 줄·마무리는 공통 (기본)
 *  samebody:   본문은 같게, 후킹(앞부분)만 다르게 (루시아이 빨래바구니 대본 방식)
 */
export type ScriptMode = 'auto' | 'distribute' | 'story' | 'samebody';
export const SCRIPT_MODES: Array<{ id: ScriptMode; label: string }> = [
  { id: 'auto', label: '자동 (AI가 고름)' },
  { id: 'distribute', label: '소구점 나눠 쓰기' },
  { id: 'story', label: '이야기 다르게, 핵심은 공통' },
  { id: 'samebody', label: '본문 같게, 후킹만 다르게' },
];
export const modeLabel = (m: ScriptMode) => SCRIPT_MODES.find((x) => x.id === m)?.label ?? m;

export type ScriptTone = '' | '존댓말' | '반말';

/**
 * AI 음성(Typecast)이 1초에 읽는 글자 수 (공백·문장부호 제외).
 * 2026-11-04 측정: 고객 대본 9버전(길이조절거치대·치약 거치대·수납고리) ÷ 실제 음성 길이 = 5.8~7.7, 평균 약 7.1
 */
export const TTS_CHARS_PER_SEC = 7.1;

/** Haiku 5.5 가격 (1백만 토큰당 달러, 2026-10 기준) — 화면에 대략 비용 표시용 */
export const HAIKU_PRICE = { input: 0.1, output: 0.5 };
export const KRW_PER_USD = 1400;

export const countSpeechChars = (s: string) => s.replace(/[^가-힣0-9a-zA-Z]/g, '').length;
export const estimateSeconds = (lines: string[]) => countSpeechChars(lines.join('')) / TTS_CHARS_PER_SEC;
export const targetChars = (seconds: number) => Math.round(seconds * TTS_CHARS_PER_SEC);

/** "3초 : 2번 4~7초" — scriptAligner.parseScriptBlocks 의 후킹 줄과 같은 모양 */
export const HOOK_SPEC = /^\s*(\d+(?:\.\d+)?)\s*초\s*[:：]\s*(\d+)\s*번(?:\s*영상)?\s*(\d+(?:\.\d+)?)\s*[~\-]\s*(\d+(?:\.\d+)?)\s*초?(.*)$/;

// 자음·모음만 있는 글자(ㅋㅋ ㅎㅎ ㅠㅠ), 이모지, 장식 특수문자
const BANNED = /[ㄱ-ㅎㅏ-ㅣ]+|\p{Extended_Pictographic}️?|[~♥♡★☆♪]/gu;

/** 금지 글자를 지운 줄과, 지웠는지 여부 */
export function cleanLine(line: string): { line: string; removed: boolean } {
  const out = line.replace(BANNED, '').replace(/\s{2,}/g, ' ').replace(/!{2,}/g, '!').trim();
  return { line: out, removed: out !== line.trim() };
}

export type ScriptVersion = {
  hookType: string;
  angle: string;
  hookSpec: string;
  lines: string[];
  warnings: string[];
  /** lines 와 같은 순서: 문장마다 근거 장면 (영상을 보고 쓴 경우만) */
  basis?: ScriptBasisScene[][];
};

/** 줄 목록 → 한 줄에 하나씩 (앞의 번호·기호 떼고, 빈 줄 빼고) */
export const splitList = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•·]|\d+[.)]|\[\d+\])\s*/, '').trim())
    .filter(Boolean);

const squash = (s: string) => s.replace(/[\s.,!?~'"“”‘’·…()\[\]-]/g, '');

/** 숫자 표현 (100만, 360, 4.8, 120 등) — 대본에서 바뀌면 안 되는 것. 단위는 TTS가 읽기 좋게 바뀔 수 있어(L→리터) 숫자만 본다 */
export function numberTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?(?:\s*[만천백억])?/g)) out.add(m[0].replace(/[\s,]/g, ''));
  return [...out];
}

const KOREAN_SMALL: Record<string, string[]> = {
  '1': ['한', '하나'],
  '2': ['두', '둘', '이중'],
  '3': ['세', '셋', '삼중'],
  '4': ['네', '넷'],
  '5': ['다섯'],
  '6': ['여섯'],
  '7': ['일곱'],
  '8': ['여덟'],
  '9': ['아홉'],
  '10': ['열'],
};

export type CheckOptions = {
  /** 모든 버전에 그대로 들어가야 하는 문장 */
  mustInclude?: string[];
  /** 이 버전이 맡은 소구점 원문 (숫자 검사용) */
  points?: string[];
  /** 장면(샷) 경계 — 후킹 구간 안에서 장면이 바뀌면 경고 (다음 장면이 잠깐 비침) */
  shots?: Array<{ no: number; start: number; end: number }>;
};

/** 코드로 하는 검사: 후킹 줄 모양·길이·영상 번호, 전체 길이, 꼭 넣을 문장, 맡은 소구점의 숫자 */
export function checkVersion(
  v: Pick<ScriptVersion, 'hookSpec' | 'lines'>,
  media: Array<{ no: number; duration: number }>,
  seconds: number,
  opts: CheckOptions = {}
): string[] {
  const warn: string[] = [];
  const body = squash(v.lines.join(''));
  for (const phrase of opts.mustInclude || []) {
    if (squash(phrase) && !body.includes(squash(phrase))) warn.push(`꼭 넣을 문장이 빠졌어요: "${phrase}"`);
  }
  const han = v.lines.join(' ').match(/[㐀-鿿]+/g);
  if (han) warn.push(`한자(중국어 글자)가 들어 있어요: ${[...new Set(han)].join(', ')} — AI 음성이 이상하게 읽어요`);
  const nums = new Set((opts.points || []).flatMap(numberTokens));
  const bodyNums = new Set(numberTokens(v.lines.join(' ')));
  // 작은 수는 TTS용으로 한글로 쓰기도 한다 (2가지 → 두 가지)
  const spoken = v.lines.join(' ');
  const saidInKorean = (n: string) => (KOREAN_SMALL[n] || []).some((w) => new RegExp(`${w}\\s?(?:가지|개|단|칸|번|겹|중|배|명|인)`).test(spoken));
  for (const n of nums) if (!bodyNums.has(n) && !saidInKorean(n)) warn.push(`맡은 소구점의 숫자 "${n}"이(가) 대본에 없어요 (숫자를 바꿨거나 뺐는지 확인)`);
  const m = v.hookSpec.match(HOOK_SPEC);
  if (!m) warn.push('후킹 지정 줄 모양이 "3초 : n번 a~b초"가 아니에요');
  else if (media.length) {
    // 영상 없이 쓴 대본은 후킹 줄이 임시값("3초 : 1번 0~3초")이라 검사하지 않는다 — 영상을 받으면 고쳐 쓴다
    const [no, from, to] = [Number(m[2]), Number(m[3]), Number(m[4])];
    const vid = media.find((x) => x.no === no);
    if (!vid) warn.push(`후킹에 쓴 ${no}번 영상이 고른 영상 목록에 없어요`);
    else if (to > vid.duration + 0.5) warn.push(`후킹 구간(${from}~${to}초)이 ${no}번 영상 길이(${vid.duration.toFixed(1)}초)를 넘어요`);
    const len = to - from;
    if (len < 3 || len > 5) warn.push(`후킹 장면이 ${len.toFixed(1)}초예요 (3~5초 권장)`);
    const cut = (opts.shots || []).find((s) => s.no === no && s.start > from + 0.1 && s.start < to - 0.1);
    if (cut) warn.push(`후킹 구간(${from}~${to}초) 안에서 ${cut.start}초에 장면이 바뀌어요 (다음 장면이 잠깐 비침)`);
  }
  const est = estimateSeconds(v.lines);
  if (est > seconds * 1.15) warn.push(`예상 길이 약 ${Math.round(est)}초 — 목표(${seconds}초)보다 길어요`);
  else if (est < seconds * 0.8) warn.push(`예상 길이 약 ${Math.round(est)}초 — 목표(${seconds}초)보다 짧아요`);
  return warn;
}

/**
 * 대본의 'n번' 영상 번호 — 대본 만들기·음성 만들기·자동 배치 구간 후킹이 같이 쓴다.
 * 이름이 숫자로 시작하면 그 숫자(예: 2.mp4 → 2번), 아니면 미디어 영상 순서 (겹치면 다음 빈 번호)
 */
export function videoNumbers(videos: Array<{ id: string; name: string }>): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  videos.forEach((v) => {
    const m = v.name.match(/^(\d+)(\D|$)/);
    if (m && !used.has(Number(m[1]))) {
      out.set(v.id, Number(m[1]));
      used.add(Number(m[1]));
    }
  });
  videos.forEach((v, i) => {
    if (out.has(v.id)) return;
    let n = i + 1;
    while (used.has(n)) n++;
    out.set(v.id, n);
    used.add(n);
  });
  return out;
}

/** 고객 대본과 같은 형식: 버전마다 후킹 지정 줄 + 대사, 버전 사이 빈 줄 (STEP 2 대본 칸이 그대로 읽음) */
export function scriptToText(versions: Array<Pick<ScriptVersion, 'hookSpec' | 'lines'>>): string {
  return versions.map((v) => [v.hookSpec.trim(), ...v.lines.map((l) => l.trim()).filter(Boolean)].join('\n')).join('\n\n\n');
}

/** 대본 문장의 근거 장면 (대본을 쓸 때 AI가 보고 쓴 원본 장면). 영상 번호 대신 파일 경로로 저장 → 미디어 순서가 바뀌어도 같은 장면 */
export type ScriptBasisScene = { path: string; from: number; to: number };

/** "2번 4.5~7초; 3번 0~2초" → 근거 장면들 (영상 번호 → 경로) */
export function parseSceneRefs(text: string, media: Array<{ no: number; path: string }>): ScriptBasisScene[] {
  const out: ScriptBasisScene[] = [];
  // "2번 4.5~7초" 또는 장면 목록 형식 그대로 "2번 영상 4.5~7초" 둘 다
  const re = /(\d+)\s*번\s*(?:영상\s*)?(\d+(?:\.\d+)?)\s*초?\s*~\s*(\d+(?:\.\d+)?)/g;
  for (const m of (text || '').matchAll(re)) {
    const v = media.find((x) => x.no === Number(m[1]));
    const from = Number(m[2]);
    const to = Number(m[3]);
    if (v && to > from) out.push({ path: v.path, from, to });
  }
  return out;
}
