/**
 * STEP 0 '대본 만들기' (메인 프로세스): Claude(Haiku)로 광고 대본 여러 버전
 *  0) 오더 읽기 (선택): 클라이언트가 보낸 오더 글 → 제품·소구점·꼭 넣을 문장·말투·버전 방식
 *  1) 버전 기획 (선택): 버전마다 콘셉트·후킹 유형·맡을 소구점 → 화면에서 사람이 고친 뒤 쓰기
 *  2) 쓰기: 버전 방식(소구점 나눠 쓰기 / 이야기 다르게 / 본문 같게 후킹만 다르게)에 맞춰
 *  3) 검수: 뜻 뒤집힘·논리·사실 밖 주장·금지 글자·버전끼리 겹치는 문장
 *  4) 코드 검사: 금지 글자 지우기, 후킹 줄, 길이, 꼭 넣을 문장, 맡은 소구점의 숫자 (src/utils/scriptGen.ts)
 * 규칙은 사용자와 맞춘 것 (메모리 script-generation-rules, client-script-orders). 바꿀 때 src/utils/scriptGen.ts 와 함께 볼 것.
 */
import fs from 'fs';
import path from 'path';
import { claudeJson, type UsageTotal } from './claudeService';
import { analyzeMedia, ensureSheet } from './sceneAnalyzer';
import {
  HOOK_AUTO,
  HOOK_TYPES,
  MAX_VERSIONS,
  TTS_CHARS_PER_SEC,
  checkVersion,
  cleanLine,
  modeLabel,
  targetChars,
  type ScriptMode,
  type ScriptTone,
  type ScriptVersion,
} from '../src/utils/scriptGen';

type ConcreteMode = Exclude<ScriptMode, 'auto'>;

export type ScriptGenParams = {
  product: string;
  facts: string;
  /** 소구점 목록 (한 줄 하나, 번호는 1부터 = 배열 순서) */
  sellingPoints: string[];
  mustInclude: string[];
  tone: ScriptTone;
  mode: ScriptMode;
  space: string;
  target: string;
  seconds: number;
  /** points = 이 버전이 맡은 소구점 번호(1부터) */
  versions: Array<{ hookType: string; story: string; focus: string; points: number[] }>;
  /** no = 대본의 "n번" (AI 자동 배치가 찾는 번호와 같게 화면에서 정해 보냄) */
  media: Array<{ no: number; path: string; duration: number; name: string }>;
  examplePaths: string[];
};

export type ScriptGenResult = {
  versions: ScriptVersion[];
  fixes: Array<{ version: number; before: string; after: string; reason: string }>;
  usage: UsageTotal;
  exampleCount: number;
  mode: ConcreteMode;
  /** 장면 경계 (화면에서 후킹 줄을 고쳤을 때 다시 검사하려고) */
  shots: ShotBound[];
};

const EXAMPLE_MAX_EACH = 4000;
const EXAMPLE_MAX_TOTAL = 14000;

function readExamples(paths: string[]): { text: string; count: number } {
  let total = 0;
  const parts: string[] = [];
  for (const p of paths) {
    if (total >= EXAMPLE_MAX_TOTAL) break;
    let t: string;
    try {
      t = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
    } catch {
      continue;
    }
    t = t.replace(/https?:\/\/\S+/g, '').trim().slice(0, Math.min(EXAMPLE_MAX_EACH, EXAMPLE_MAX_TOTAL - total));
    if (!t) continue;
    total += t.length;
    parts.push(`----- 예시: ${path.basename(p, path.extname(p))}\n${t}`);
  }
  return { text: parts.join('\n\n'), count: parts.length };
}

/** '자동' 후킹 유형을 다른 버전과 겹치지 않게 채운다 */
function resolveHookTypes(specs: Array<{ hookType: string }>): string[] {
  const chosen = specs.map((s) => (s.hookType && s.hookType !== HOOK_AUTO ? s.hookType : ''));
  const pool = HOOK_TYPES.map((h) => h.id).filter((id) => !chosen.includes(id));
  // 버전이 후킹 유형 수(5)보다 많으면 유형을 다시 돌려 쓴다 (이야기는 다르게)
  let k = 0;
  return chosen.map((c) => c || pool.shift() || HOOK_TYPES[k++ % HOOK_TYPES.length].id);
}

/** 자동이면: 소구점이 있으면 나눠 쓰기, 없으면 이야기 다르게 */
const concreteMode = (m: ScriptMode, pointCount: number): ConcreteMode => (m === 'auto' ? (pointCount ? 'distribute' : 'story') : m);

const numbered = (pts: string[]) => pts.map((t, i) => `${i + 1}. ${t}`).join('\n');

function factsBlock(p: Pick<ScriptGenParams, 'product' | 'facts' | 'sellingPoints' | 'mustInclude' | 'tone' | 'space' | 'target'>) {
  return `제품: ${p.product || '(이름 없음)'}
공간: ${p.space || '(미지정)'}
타겟: ${p.target || '(미지정)'}
말투: ${p.tone || '자동 (고객 대본 예시처럼 존댓말 경험담이 기본)'}
공통 사실 (그대로 읽지 말 것):
${p.facts.trim() || '(없음)'}
소구점:
${p.sellingPoints.length ? numbered(p.sellingPoints) : '(따로 없음 — 공통 사실과 영상에서 고른다)'}
꼭 넣을 문장 (모든 버전에 글자 그대로):
${p.mustInclude.length ? p.mustInclude.map((x) => `- ${x}`).join('\n') : '(없음)'}`;
}

// ---------------------------------------------------------------- 0) 오더 읽기

export type OrderParseResult = {
  product: string;
  facts: string;
  sellingPoints: string[];
  target: string;
  mustInclude: string[];
  tone: ScriptTone;
  mode: ConcreteMode;
  modeReason: string;
  versionCount: number;
  seconds: number;
  notes: string;
  usage: UsageTotal;
};

const ORDER_SYSTEM = `너는 광고 대본 외주 편집자의 비서다. 클라이언트가 보낸 대본 요청(오더) 글을 읽고, 대본 작성에 필요한 정보를 빠짐없이 정리한다.
- 원문 표현과 숫자(100만 개, 360°, 4.8점, 100L 등)를 바꾸지 말고 그대로 옮긴다. 없는 내용은 지어내지 않는다.
- selling_points: 소구점·강조 요청·셀링포인트 목록을 모두 하나씩 (여러 목록이면 합친다. 같은 내용이 겹치면 하나로). 앞 번호는 뺀다.
  "강조해 달라"는 항목(예: 누적 판매량, 리뷰 평점)도 selling_points 에 넣는다.
- facts: selling_points 에 없는 공통 정보만 (회사·브랜드, 인증·등록, 가격·할인, 옵션·크기 등). 한 줄에 하나.
  selling_points 에 넣은 내용(기능·소재·디자인·색상·판매량 등)은 facts 에 다시 넣지 않는다. 버전마다 소구점을 나눠 쓸 때 facts 는 모든 버전이 쓰기 때문이다.
- must_include: "그대로 써 달라", "꼭 넣어 달라"고 지정한 문장만. 없으면 빈 배열.
- tone: 반말/존댓말 지시가 있거나 예시 멘트가 분명히 반말이면 그 값, 아니면 빈 문자열.
- mode: 버전 방식.
  distribute = 소구점을 버전마다 나눠 써 달라는 지시(예: "모든 영상에 동일하게 넣기보다 콘셉트에 맞게 나눠서")가 있을 때
  samebody = 본문은 같고 첫 부분(후킹)만 다르게 해 달라는 지시가 있을 때
  story = 지시가 없을 때 (이야기는 다르게, 핵심은 공통)
  mode_reason 에 오더의 어떤 문장을 보고 골랐는지 한 줄로.
- version_count: 영상(버전) 개수를 지정했으면 그 숫자, 아니면 0. seconds: 길이를 초로 지정했으면 그 숫자, 아니면 0.
- notes: 위에 안 들어간 요청·주의사항 (촬영 지시는 AI 음성 대본에 안 쓰므로 짧게만).`;

const ORDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['product', 'facts', 'selling_points', 'target', 'must_include', 'tone', 'mode', 'mode_reason', 'version_count', 'seconds', 'notes'],
  properties: {
    product: { type: 'string' },
    facts: { type: 'array', items: { type: 'string' } },
    selling_points: { type: 'array', items: { type: 'string' } },
    target: { type: 'string' },
    must_include: { type: 'array', items: { type: 'string' } },
    tone: { type: 'string', enum: ['', '존댓말', '반말'] },
    mode: { type: 'string', enum: ['distribute', 'story', 'samebody'] },
    mode_reason: { type: 'string' },
    version_count: { type: 'integer' },
    seconds: { type: 'integer' },
    notes: { type: 'string' },
  },
};

export async function parseOrder(order: string): Promise<OrderParseResult> {
  const r = await claudeJson<{
    product: string;
    facts: string[];
    selling_points: string[];
    target: string;
    must_include: string[];
    tone: ScriptTone;
    mode: ConcreteMode;
    mode_reason: string;
    version_count: number;
    seconds: number;
    notes: string;
  }>({ system: ORDER_SYSTEM, text: `## 클라이언트 오더\n${order.trim()}`, schema: ORDER_SCHEMA, maxTokens: 16000 });
  const d = r.data;
  return {
    product: d.product.trim(),
    facts: d.facts.map((x) => x.trim()).filter(Boolean).map((x) => `- ${x}`).join('\n'),
    sellingPoints: d.selling_points.map((x) => x.trim()).filter(Boolean),
    target: d.target.trim(),
    mustInclude: d.must_include.map((x) => x.trim()).filter(Boolean),
    tone: d.tone,
    mode: d.mode,
    modeReason: d.mode_reason,
    versionCount: Math.max(0, Math.min(MAX_VERSIONS, d.version_count || 0)),
    seconds: d.seconds || 0,
    notes: d.notes,
    usage: r.usage,
  };
}

// ---------------------------------------------------------------- 장면 분석 (AI 자동 배치와 공유)

/** 영상 n번의 장면(샷) 구간 — 후킹 장면이 장면 전환을 넘지 않는지 검사할 때 씀 */
export type ShotBound = { no: number; start: number; end: number };

/**
 * 대본을 영상 보고 만들 때만: AI 자동 배치와 똑같은 장면 분석(sceneAnalyzer.analyzeMedia)을 먼저 한다.
 * 파일마다 userData/scene-cache 에 저장되므로 같은 영상은 다시 보지 않고, 나중에 STEP 3 자동 배치도 이 결과를 그대로 쓴다.
 * 결과: AI에게 줄 장면 목록 글 + 장면 경계 + 사용량
 */
async function sceneList(
  ffmpegPath: string,
  media: ScriptGenParams['media'],
  product: string,
  onProgress: (msg: string) => void
): Promise<{ text: string; bounds: ShotBound[]; usage: UsageTotal }> {
  const r = await analyzeMedia(
    ffmpegPath,
    media.map((m) => ({ path: m.path, duration: m.duration })),
    product,
    onProgress
  );
  const noOfPath = new Map(media.map((m) => [m.path.replace(/\\/g, '/').toLowerCase(), m.no]));
  const descOf = new Map(r.descs.map((d) => [d.id, d]));
  const bounds: ShotBound[] = [];
  const lines: string[] = [];
  for (const s of r.shots) {
    const no = noOfPath.get(s.path.replace(/\\/g, '/').toLowerCase()) ?? 0;
    bounds.push({ no, start: s.start, end: s.end });
    const d = descOf.get(s.id);
    const parts = d?.parts?.length ? ` / 세부: ${d.parts.map((x) => `${x.from}~${x.to}초 ${x.desc}`).join('; ')}` : '';
    lines.push(`${no}번 영상 ${s.start}~${s.end}초 (${s.dur}초, 움직임 ${d?.motion === 'high' ? '많음' : '적음'}): ${d?.desc || '(설명 없음)'}${d?.place ? ` [${d.place}]` : ''}${parts}`);
  }
  const head = media.map((m) => `${m.no}번 영상: 파일 이름 "${m.name}" (${m.duration.toFixed(1)}초)`).join('\n');
  return { text: `${head}\n\n장면(샷) 목록 — 화면 전환 없이 이어지는 구간:\n${lines.join('\n')}`, bounds, usage: r.usage };
}

// ---------------------------------------------------------------- 0-b) 영상 보고 제품 정보 채우기 (오더가 없을 때)

export type VideoFactsResult = {
  product: string;
  facts: string;
  sellingPoints: string[];
  target: string;
  notes: string;
  usage: UsageTotal;
};

const VIDEO_FACTS_SYSTEM = `너는 숏폼 제품 광고 대본 작가의 조수다. 제품 원본 영상들의 장면표와 파일 이름을 보고, 대본에 쓸 제품 정보를 정리한다.
- 장면표는 영상 하나를 0.5초마다 한 칸씩 펼친 것이다 (칸 왼쪽 아래 노란 숫자 = 원본 초).
- 파일 이름은 원래 영상의 제목·설명(중국어일 수 있음)일 때가 많다. 뜻을 한국어로 풀어 참고한다.
- 모든 항목은 한국어로만 쓴다. 중국어 글자(한자)를 그대로 옮기지 않는다 (예: 台面 → 세면대 위).
- 화면에 실제로 보이는 것과 파일 이름에 적힌 것만 쓴다. 보이지 않는 크기·무게·소재·수치·인증은 지어내지 않는다.
  짐작한 내용은 끝에 "(확인 필요)"를 붙인다.
- product: 제품을 부르는 쉬운 한국어 이름 (예: 캐릭터 흡착 수납함). 이미 이름을 알려 줬으면 그 이름.
- selling_points: 광고에서 내세울 만한 장점·사용 장면을 하나씩 (5~8개). 가장 큰 매력이 있으면 맨 앞에 "매력: "을 붙인다.
- facts: 소구점이 아닌 공통 정보 (설치 방법, 놓는 곳, 쓰는 공간 등). selling_points 와 겹치지 않게.
- target: 영상 분위기로 보아 어울리는 사용자 (짐작이면 "(확인 필요)").
- notes: 영상에 박힌 글자·워터마크, 화질 문제 등 참고할 점.`;

const VIDEO_FACTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['product', 'facts', 'selling_points', 'target', 'notes'],
  properties: {
    product: { type: 'string' },
    facts: { type: 'array', items: { type: 'string' } },
    selling_points: { type: 'array', items: { type: 'string' } },
    target: { type: 'string' },
    notes: { type: 'string' },
  },
};

export async function factsFromVideos(
  ffmpegPath: string,
  p: { product: string; media: ScriptGenParams['media'] },
  onProgress: (msg: string) => void
): Promise<VideoFactsResult> {
  if (!p.media.length) throw new Error('고른 영상이 없습니다.');
  // 1) 장면 분석 (자동 배치와 공유, 이미 했으면 저장된 것)
  const scenes = await sceneList(ffmpegPath, p.media, p.product, onProgress);
  // 2) 제품 정보는 눈으로 봐야 아는 매력(디자인 등)을 놓치지 않게 장면표 사진도 같이 본다
  const images: Array<{ label: string; path: string }> = [];
  for (const m of p.media) {
    images.push({ label: `${m.no}번 영상 장면표 — 파일 이름: ${m.name} (${m.duration.toFixed(1)}초)`, path: await ensureSheet(ffmpegPath, m.path, m.duration) });
  }
  onProgress('AI가 영상을 보고 제품 정보를 정리하는 중...');
  const r = await claudeJson<{ product: string; facts: string[]; selling_points: string[]; target: string; notes: string }>({
    system: VIDEO_FACTS_SYSTEM,
    text: `제품 이름(알려 준 경우): ${p.product.trim() || '(모름)'}\n\n## 장면 분석 (참고)\n${scenes.text}\n\n영상 ${p.media.length}개의 장면표와 장면 분석을 보고 정리해라.`,
    images,
    schema: VIDEO_FACTS_SCHEMA,
    maxTokens: 16000,
  });
  const d = r.data;
  return {
    product: d.product.trim(),
    facts: d.facts.map((x) => x.trim()).filter(Boolean).map((x) => `- ${x}`).join('\n'),
    sellingPoints: d.selling_points.map((x) => x.trim()).filter(Boolean),
    target: d.target.trim(),
    notes: d.notes.trim(),
    usage: { input: scenes.usage.input + r.usage.input, output: scenes.usage.output + r.usage.output },
  };
}

// ---------------------------------------------------------------- 1) 버전 기획

export type PlanResult = {
  mode: ConcreteMode;
  versions: Array<{ hookType: string; story: string; focus: string; points: number[] }>;
  usage: UsageTotal;
};

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['versions'],
  properties: {
    versions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['hook_type', 'concept', 'focus', 'points'],
        properties: {
          hook_type: { type: 'string', enum: HOOK_TYPES.map((h) => h.id) },
          concept: { type: 'string', description: '이야기·콘셉트 한 줄 (화자 상황 + 고민)' },
          focus: { type: 'string', description: '본문에서 깊게 다룰 장점 한 줄' },
          points: { type: 'array', items: { type: 'integer' }, description: '맡은 소구점 번호 (1부터)' },
        },
      },
    },
  },
};

const modeRule = (mode: ConcreteMode, n: number) =>
  mode === 'distribute'
    ? `소구점 나눠 쓰기: 소구점을 버전 ${n}개에 나눠 맡긴다. 모든 소구점이 최소 한 버전에 들어가야 하고, 한 버전은 콘셉트에 맞는 2~4개를 깊게 다룬다. 같은 소구점을 여러 버전에 반복하지 않는다(정말 핵심인 1개만 예외).`
    : mode === 'samebody'
      ? `본문 같게, 후킹만 다르게: 모든 버전이 같은 본문(모든 소구점)을 쓰고, 첫 1~3문장(후킹·도입 상황)만 다르다. points 는 모든 버전에 전부 넣는다.`
      : `이야기 다르게, 핵심은 공통: 버전마다 이야기와 중심 장점이 다르고, 제품의 가장 핵심 장점 한 줄과 마무리만 공통. points 에는 그 버전의 중심 장점에 해당하는 소구점을 넣는다.`;

export async function planVersions(
  p: Pick<ScriptGenParams, 'product' | 'facts' | 'sellingPoints' | 'mustInclude' | 'tone' | 'mode' | 'space' | 'target' | 'versions'>
): Promise<PlanResult> {
  const n = Math.max(1, Math.min(MAX_VERSIONS, p.versions.length));
  const mode = concreteMode(p.mode, p.sellingPoints.length);
  const fixed = p.versions.slice(0, n).map((v, i) => {
    const parts = [
      v.hookType && v.hookType !== HOOK_AUTO ? `후킹 유형 = ${v.hookType} (바꾸지 말 것)` : '',
      v.story.trim() ? `이야기 = ${v.story.trim()} (바꾸지 말 것)` : '',
    ].filter(Boolean);
    return parts.length ? `버전 ${i + 1}: ${parts.join(' / ')}` : '';
  });
  const r = await claudeJson<{ versions: Array<{ hook_type: string; concept: string; focus: string; points: number[] }> }>({
    system: `너는 숏폼 제품 광고(AI 음성 내레이션) 기획자다. 같은 제품의 광고 ${n}개를 기획한다.
- 버전 방식: ${modeRule(mode, n)}
- 버전마다 후킹 유형이 서로 다르게 고른다 (버전이 5개보다 많으면 겹쳐도 되지만 같은 유형끼리 이야기는 확실히 다르게). 후킹 유형: ${HOOK_TYPES.map((h) => `${h.id}(${h.guide})`).join(', ')}
- 콘셉트는 실제 사용자가 겪는 구체적인 상황으로, 맡은 소구점이 자연스럽게 해결책이 되게 잡는다. 버전끼리 콘셉트가 겹치지 않게.
- 버전이 3개 이상이면 그중 하나는 제품의 가장 큰 매력(사실 목록의 '매력:' 또는 신뢰도·디자인 같은 핵심)을 중심으로.`,
    text: `## 제품 정보\n${factsBlock(p)}\n\n${fixed.some(Boolean) ? `## 사람이 정해 둔 것\n${fixed.filter(Boolean).join('\n')}\n\n` : ''}버전 ${n}개를 기획해라.`,
    schema: PLAN_SCHEMA,
    maxTokens: 16000,
  });
  const valid = (k: number) => Number.isInteger(k) && k >= 1 && k <= p.sellingPoints.length;
  const versions = Array.from({ length: n }, (_, i) => {
    const v = r.data.versions[i];
    const keep = p.versions[i];
    const pts = mode === 'samebody' ? p.sellingPoints.map((_, k) => k + 1) : [...new Set((v?.points || []).filter(valid))].sort((a, b) => a - b);
    return {
      hookType: keep?.hookType && keep.hookType !== HOOK_AUTO ? keep.hookType : v?.hook_type || HOOK_AUTO,
      story: keep?.story.trim() ? keep.story : v?.concept || '',
      focus: v?.focus || '',
      points: pts,
    };
  });
  return { mode, versions, usage: r.usage };
}

// ---------------------------------------------------------------- 2) 쓰기

function buildSystem(seconds: number, mode: ConcreteMode, n: number) {
  const chars = targetChars(seconds);
  const modeBlock =
    mode === 'distribute'
      ? `[버전 방식: 소구점 나눠 쓰기]
- 클라이언트가 소구점을 모든 영상에 똑같이 넣지 말고 콘셉트에 맞게 나눠 달라고 했다.
- 각 버전은 '맡은 소구점'만 깊게 다룬다. 다른 버전이 맡은 소구점은 쓰지 않는다. 공통 사실(브랜드·신뢰 정보)은 어느 버전에서 써도 된다.
- 버전끼리 이야기·첫 문장·본문 문장이 겹치지 않게 쓴다. 마무리 권유 한 줄만 비슷해도 된다.`
      : mode === 'samebody'
        ? `[버전 방식: 본문 같게, 후킹만 다르게]
- 모든 버전의 본문(제품 설명 부분)은 같은 문장으로 쓴다. 모든 소구점을 본문에 넣는다.
- 버전마다 첫 1~3문장(후킹과 도입 상황)만 다르게 쓰고, 그 도입이 본문으로 자연스럽게 이어지게 한다.`
        : `[버전 방식: 이야기 다르게, 핵심은 공통]
- 버전마다 이야기·첫 문장·중심 장점이 다르다.
- 공통으로 유지: 같은 말투와 화자 느낌, 제품의 가장 핵심 장점 한 줄을 버전마다 한 번씩(표현은 조금씩 달라도 됨), 비슷한 권유형 마무리 한 줄.
- 핵심 한 줄과 마무리 외의 본문 문장은 다른 버전과 겹치지 않게 쓴다.
- 버전이 3개 이상이면 그중 1개는 제품의 가장 큰 매력을 중심으로 한 이야기.`;
  return `너는 한국 숏폼 제품 광고(메타 광고, 세로 영상, AI 음성 내레이션) 대본 작가다. 대본 ${n}개를 쓴다.
'고객 대본 예시'가 있으면 그 말투와 호흡을 따라 쓴다. 예시는 말투 참고용이며 문장·표현을 가져오지 않는다.

[말투]
- 실제 사용자가 신나서 경험담을 말하는 구어체. "~더라고요", "~잖아요", "진짜", "대박", "완전" 같은 생생한 말투. 말투 지정(반말/존댓말)이 있으면 그대로 따른다.
- 제품 설명서처럼 생김새나 기능을 나열하지 않는다. 사실 목록을 그대로 읽지 말고 경험 속에 녹인다.
- AI 음성(TTS)이 읽는다. "ㅋㅋ", "ㅎㅎ", "ㅠㅠ" 같은 자음·모음만 있는 글자, 이모지, 특수문자(~, ♥, ! 반복)는 절대 쓰지 않는다. 예시에 있어도 쓰지 않는다.
- 한국어로만 쓴다. 장면 설명이나 파일 이름에 중국어(한자)가 있어도 대본에는 옮기지 않는다.

${modeBlock}

[버전 지정]
- 아래 '버전별 지정'의 후킹 유형, 이야기, 중심 장점, 맡은 소구점을 반드시 따른다. '자동'이라고 된 칸은 다른 버전과 겹치지 않게 네가 정한다.
- 첫 문장은 지정된 후킹 유형으로, 3초 안에 멈춰 보게 만든다. 후킹 유형의 참고 문장이나 예시 대본의 첫 문장을 그대로 쓰지 말고, 이 제품의 구체적인 상황(물건·장소·사람)이 들어간 새 문장으로 쓴다.
- '꼭 넣을 문장'이 있으면 모든 버전에 글자 그대로 넣는다.
- 구매 권유(가격 확인, 구매해 보세요 등)를 넣는다면 마지막 줄에 둔다. 권유 뒤에 다른 이야기를 붙이지 않는다.

[길이] 매우 중요
- 한 버전은 AI 음성으로 약 ${seconds}초. 이 음성은 1초에 약 ${TTS_CHARS_PER_SEC}글자를 읽으므로, 공백·문장부호를 뺀 글자 수가 버전마다 ${Math.round(chars * 0.9)}~${Math.round(chars * 1.1)}자여야 한다. 넘으면 문장을 줄인다.
- lines 는 문장 하나씩 한 줄로 쓴다.

[사실]
- 사실 목록·소구점·영상에 있는 것만 말한다. 숫자(100만 개, 360도, 4.8점 등)는 바꾸지 않는다. 확인 안 되는 수치나 효능 단정을 새로 만들지 않는다.
- 사실 목록에 적힌 사용 방법(어디에 두는지, 어떻게 설치하는지)과 다르게 말하지 않는다.
- 사실 목록과 소구점이 비어 있으면 '장면(샷) 목록'의 설명과 파일 이름(중국어 제목일 수 있음)에 있는 것만 사실로 쓴다. 보이지 않는 크기·소재·수치는 쓰지 않는다.

[후킹 장면]
- hook_spec 은 "3초 : n번 a~b초" 형식 (n = 영상 번호, a~b = 그 영상 안의 초). 구간은 3초 이상 5초 이하, 첫 문장 내용과 실제로 맞는 장면을 '장면(샷) 목록'에서 골라라.
- 후킹 구간은 장면 하나(샷 하나)의 시작~끝 안에 들어가야 한다. 장면이 바뀌는 순간이 구간 안에 들어가면 다음 장면이 잠깐 비쳐 어색하다. 3초 이상인 장면 중에서 고르고, 없으면 가장 긴 장면 전체를 쓴다.
- 영상이 없으면 "3초 : 1번 0~3초".

[검사]
- 다 쓴 뒤 문장마다 뜻이 맞는지(특히 "안 남는다/남는다" 같은 부정 표현이 뒤집히지 않았는지), 사실과 맞는지, 맡은 소구점을 다 다뤘는지, 글자 수가 맞는지 검사하고 고친다. 고친 점은 self_check 에 적는다.`;
}

const GEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['versions'],
  properties: {
    versions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['hook_type', 'angle', 'hook_spec', 'lines', 'self_check'],
        properties: {
          hook_type: { type: 'string' },
          angle: { type: 'string', description: '이 버전의 이야기 한 줄' },
          hook_spec: { type: 'string', description: '예: 3초 : 2번 4~7초' },
          lines: { type: 'array', items: { type: 'string' }, description: '문장 하나씩' },
          self_check: { type: 'string' },
        },
      },
    },
  },
};

const reviewSystem = (mode: ConcreteMode) => `너는 광고 대본 검수자다. 대본의 문장마다 아래를 검사해 문제 있는 문장만 고쳐라.
1) 뜻이 뒤집히거나 이상한 문장 (예: "흔적이 남는다고 하니 안심"처럼 부정이 빠진 것)
2) 앞뒤가 논리적으로 안 이어지는 문장, 구매 권유 뒤에 이야기가 더 붙은 것
3) 사실 목록·소구점에 없는 주장, 수치, 효능 단정. 원문과 다른 숫자
4) 사실 목록의 사용 방법과 다른 표현
5) ㅋㅋ·ㅎㅎ·이모지·특수문자
6) ${
  mode === 'samebody'
    ? '(본문 같게 방식이라 버전끼리 본문이 같은 것은 정상이다. 고치지 않는다)'
    : mode === 'distribute'
      ? '다른 버전과 거의 같은 문장, 그 버전이 맡지 않은 소구점을 다룬 문장 (마무리 권유 한 줄은 비슷해도 됨)'
      : '다른 버전과 거의 같은 문장 (단, 제품 핵심 한 줄과 마무리 한 줄은 일부러 비슷하게 둔 것이니 고치지 않는다)'
}
7) '꼭 넣을 문장'은 글자 그대로 두고 고치지 않는다.
문제없는 문장은 그대로 둔다. 말투는 바꾸지 않는다. 고칠 게 없으면 fixes 를 빈 배열로.`;

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fixes'],
  properties: {
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['version', 'line_index', 'before', 'after', 'reason'],
        properties: {
          version: { type: 'integer', description: '1부터' },
          line_index: { type: 'integer', description: '0부터' },
          before: { type: 'string' },
          after: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
};

export async function generateScripts(
  ffmpegPath: string,
  p: ScriptGenParams,
  onProgress: (msg: string) => void
): Promise<ScriptGenResult> {
  const usage: UsageTotal = { input: 0, output: 0 };
  const add = (u: UsageTotal) => {
    usage.input += u.input;
    usage.output += u.output;
  };
  const n = Math.max(1, Math.min(MAX_VERSIONS, p.versions.length));
  const specs = p.versions.slice(0, n);
  const hookTypes = resolveHookTypes(specs);
  const mode = concreteMode(p.mode, p.sellingPoints.length);
  const pointsOf = (i: number) =>
    mode === 'samebody' ? p.sellingPoints : (specs[i]?.points || []).map((k) => p.sellingPoints[k - 1]).filter(Boolean);

  // 영상을 보고 쓰는 경우에만: 자동 배치와 같은 장면 분석(저장된 것)을 글로 넘긴다. 사진은 다시 보내지 않는다
  let scenes: { text: string; bounds: ShotBound[] } = { text: '', bounds: [] };
  if (p.media.length) {
    const sc = await sceneList(ffmpegPath, p.media, p.product, onProgress);
    add(sc.usage);
    scenes = sc;
  }

  const ex = readExamples(p.examplePaths);
  const facts = factsBlock(p);
  const hookGuide = (id: string) => {
    const h = HOOK_TYPES.find((x) => x.id === id);
    return h ? `${h.guide} (느낌 참고: "${h.example}" — 이 문장을 그대로 쓰지 말 것)` : '';
  };
  const specLine = (s: (typeof specs)[number], i: number) => {
    const pts = pointsOf(i);
    return `버전 ${i + 1}: 후킹 유형 = ${hookTypes[i]} — ${hookGuide(hookTypes[i])} / 이야기 = ${s.story.trim() || '자동'} / 중심 장점 = ${
      s.focus.trim() || '자동'
    }${mode !== 'samebody' && p.sellingPoints.length ? ` / 맡은 소구점 = ${pts.length ? pts.map((t) => `"${t}"`).join(', ') : '자동 (다른 버전과 겹치지 않게)'}` : ''}`;
  };
  const mediaBlock =
    scenes.text || '(영상 없음 — 후킹 장면은 "3초 : 1번 0~3초"로 둔다)';

  // 버전이 많으면 한 번에 다 쓰다가 답이 잘릴 수 있어 BATCH 개씩 나눠 쓴다. 뒤 묶음은 앞에서 쓴 이야기·첫 문장을 보고 겹치지 않게
  const BATCH = 8;
  const versions: Array<{ hookType: string; angle: string; hookSpec: string; lines: string[] }> = [];
  for (let a = 0; a < n; a += BATCH) {
    const b = Math.min(n, a + BATCH);
    const count = b - a;
    const prev = versions.length
      ? `\n\n## 이미 쓴 버전 (이야기·첫 문장·본문 문장이 겹치지 않게)\n${versions
          .map((v, i) => `버전 ${i + 1}: ${v.angle} / 첫 문장: ${v.lines[0] || ''}`)
          .join('\n')}${
          mode === 'samebody'
            ? `\n\n## 본문 기준 (버전 1 대본)\n${versions[0].lines.join('\n')}\n이 대본의 본문(앞의 후킹·도입 1~3문장 뒤)을 글자 그대로 쓰고, 앞부분만 새로 쓴다.`
            : ''
        }`
      : '';
    const text = `${ex.count ? `## 고객 대본 예시 (말투 참고용)\n${ex.text}\n\n` : ''}## 이번 제품
${facts}

## 버전별 지정 (버전 방식: ${modeLabel(mode)}, 전체 ${n}개 중 버전 ${a + 1}~${b})
${specs
  .slice(a, b)
  .map((s, k) => specLine(s, a + k))
  .join('\n')}

## 영상
${mediaBlock}${prev}

위 지정대로 버전 ${a + 1}~${b}, 대본 ${count}개를 순서대로 써라.`;

    onProgress(n > BATCH ? `AI가 대본을 쓰는 중... (${a + 1}~${b} / ${n}개)` : `AI가 대본 ${n}개를 쓰는 중...`);
    const gen = await claudeJson<{
      versions: Array<{ hook_type: string; angle: string; hook_spec: string; lines: string[]; self_check: string }>;
    }>({ system: buildSystem(p.seconds, mode, count), text, schema: GEN_SCHEMA });
    add(gen.usage);
    gen.data.versions.slice(0, count).forEach((v, k) =>
      versions.push({
        hookType: v.hook_type || hookTypes[a + k],
        angle: v.angle,
        hookSpec: v.hook_spec,
        lines: v.lines.map((l) => l.trim()).filter(Boolean),
      })
    );
  }

  onProgress('AI가 대본을 검수하는 중...');
  const review = await claudeJson<{ fixes: Array<{ version: number; line_index: number; before: string; after: string; reason: string }> }>({
    system: reviewSystem(mode),
    text: `## 사실 목록\n${facts}\n\n## 버전별 맡은 소구점\n${versions
      .map((_, i) => `버전 ${i + 1}: ${pointsOf(i).join(' / ') || '(지정 없음)'}`)
      .join('\n')}\n\n## 검수할 대본\n${JSON.stringify(
      versions.map((v, i) => ({ version: i + 1, hook_type: v.hookType, lines: v.lines })),
      null,
      1
    )}`,
    schema: REVIEW_SCHEMA,
  });
  add(review.usage);
  const fixes: ScriptGenResult['fixes'] = [];
  for (const f of review.data.fixes) {
    const v = versions[f.version - 1];
    if (!v || !f.after.trim()) continue;
    const k = v.lines[f.line_index] === f.before ? f.line_index : v.lines.indexOf(f.before);
    if (k < 0) continue;
    v.lines[k] = f.after.trim();
    fixes.push({ version: f.version, before: f.before, after: f.after.trim(), reason: f.reason });
  }

  const out: ScriptVersion[] = versions.map((v, i) => {
    let removed = false;
    const lines = v.lines
      .map((l) => {
        const c = cleanLine(l);
        removed ||= c.removed;
        return c.line;
      })
      .filter(Boolean);
    const warnings = checkVersion({ hookSpec: v.hookSpec, lines }, p.media, p.seconds, {
      shots: scenes.bounds,
      mustInclude: p.mustInclude,
      points: pointsOf(i),
    });
    if (removed) warnings.unshift('ㅋㅋ·이모지 같은 글자를 자동으로 지웠어요');
    return { ...v, lines, warnings };
  });
  return { versions: out, fixes, usage, exampleCount: ex.count, mode, shots: scenes.bounds };
}
