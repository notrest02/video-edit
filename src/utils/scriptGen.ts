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
};

/** 코드로 하는 검사: 후킹 줄 모양·길이·영상 번호, 전체 길이 */
export function checkVersion(
  v: Pick<ScriptVersion, 'hookSpec' | 'lines'>,
  media: Array<{ no: number; duration: number }>,
  seconds: number
): string[] {
  const warn: string[] = [];
  const m = v.hookSpec.match(HOOK_SPEC);
  if (!m) warn.push('후킹 지정 줄 모양이 "3초 : n번 a~b초"가 아니에요');
  else {
    const [no, from, to] = [Number(m[2]), Number(m[3]), Number(m[4])];
    const vid = media.find((x) => x.no === no);
    if (!vid) warn.push(`후킹에 쓴 ${no}번 영상이 고른 영상 목록에 없어요`);
    else if (to > vid.duration + 0.5) warn.push(`후킹 구간(${from}~${to}초)이 ${no}번 영상 길이(${vid.duration.toFixed(1)}초)를 넘어요`);
    const len = to - from;
    if (len < 3 || len > 5) warn.push(`후킹 장면이 ${len.toFixed(1)}초예요 (3~5초 권장)`);
  }
  const est = estimateSeconds(v.lines);
  if (est > seconds * 1.15) warn.push(`예상 길이 약 ${Math.round(est)}초 — 목표(${seconds}초)보다 길어요`);
  else if (est < seconds * 0.8) warn.push(`예상 길이 약 ${Math.round(est)}초 — 목표(${seconds}초)보다 짧아요`);
  return warn;
}

/** 고객 대본과 같은 형식: 버전마다 후킹 지정 줄 + 대사, 버전 사이 빈 줄 (STEP 2 대본 칸이 그대로 읽음) */
export function scriptToText(versions: Array<Pick<ScriptVersion, 'hookSpec' | 'lines'>>): string {
  return versions.map((v) => [v.hookSpec.trim(), ...v.lines.map((l) => l.trim()).filter(Boolean)].join('\n')).join('\n\n\n');
}
