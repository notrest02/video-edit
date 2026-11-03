/**
 * STEP 0 '대본 만들기' (메인 프로세스): 제품 정보 + 영상 장면 + 고객 대본 말투 예시 → Claude(Haiku)로 광고 대본 여러 버전
 *  1단계 생성: 버전마다 후킹 유형·이야기·중심 장점을 지정해 서로 다른 이야기로 쓴다
 *  2단계 검수: 뜻 뒤집힘·논리·사실 밖 주장·금지 글자·버전끼리 겹치는 문장을 고친다
 *  3단계 코드 검사: 금지 글자 지우기, 후킹 줄 모양·길이, 예상 길이 (src/utils/scriptGen.ts)
 * 규칙은 사용자와 맞춘 것 (메모리 script-generation-rules). 바꿀 때 src/utils/scriptGen.ts 와 함께 볼 것.
 */
import fs from 'fs';
import path from 'path';
import { claudeJson, type UsageTotal } from './claudeService';
import { ensureSheet } from './sceneAnalyzer';
import {
  HOOK_AUTO,
  HOOK_TYPES,
  TTS_CHARS_PER_SEC,
  checkVersion,
  cleanLine,
  targetChars,
  type ScriptVersion,
} from '../src/utils/scriptGen';

export type ScriptGenParams = {
  product: string;
  facts: string;
  space: string;
  target: string;
  seconds: number;
  versions: Array<{ hookType: string; story: string; focus: string }>;
  /** no = 대본의 "n번" (AI 자동 배치가 찾는 번호와 같게 화면에서 정해 보냄) */
  media: Array<{ no: number; path: string; duration: number; name: string }>;
  examplePaths: string[];
};

export type ScriptGenResult = {
  versions: ScriptVersion[];
  fixes: Array<{ version: number; before: string; after: string; reason: string }>;
  usage: UsageTotal;
  exampleCount: number;
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
function resolveHookTypes(specs: ScriptGenParams['versions']): string[] {
  const chosen = specs.map((s) => (s.hookType && s.hookType !== HOOK_AUTO ? s.hookType : ''));
  const pool = HOOK_TYPES.map((h) => h.id).filter((id) => !chosen.includes(id));
  return chosen.map((c) => c || pool.shift() || HOOK_TYPES[0].id);
}

function buildSystem(seconds: number) {
  const chars = targetChars(seconds);
  return `너는 한국 숏폼 제품 광고(메타 광고, 세로 영상, AI 음성 내레이션) 대본 작가다.
'고객 대본 예시'가 있으면 그 말투와 호흡을 따라 쓴다. 예시는 말투 참고용이며 문장·표현을 가져오지 않는다.

[말투]
- 실제 사용자가 신나서 경험담을 말하는 구어체. "~더라고요", "~잖아요", "진짜", "대박", "완전" 같은 생생한 말투.
- 제품 설명서처럼 생김새나 기능을 나열하지 않는다. 사실 목록을 그대로 읽지 말고 경험 속에 녹인다.
- AI 음성(TTS)이 읽는다. "ㅋㅋ", "ㅎㅎ", "ㅠㅠ" 같은 자음·모음만 있는 글자, 이모지, 특수문자(~, ♥, ! 반복)는 절대 쓰지 않는다. 예시에 있어도 쓰지 않는다.

[버전]
- 아래 '버전별 지정'의 후킹 유형, 이야기, 중심 장점을 반드시 따른다. '자동'이라고 된 칸은 다른 버전과 겹치지 않게 네가 정한다.
- 버전이 3개 이상이면 그중 1개는 반드시 이 제품의 가장 큰 매력(사실 목록에서 '매력'으로 표시한 것, 없으면 영상에서 가장 눈에 띄는 점)을 중심으로 한 이야기여야 한다. 이미 지정된 이야기가 있으면 지정을 우선한다.
- 버전들은 같은 제품의 광고 시리즈다. 다양하되 일관성을 지킨다.
  · 다르게: 첫 문장(후킹 유형), 이야기, 본문에서 깊게 다루는 중심 장점.
  · 공통으로 유지: 같은 말투와 화자 느낌, 제품의 가장 핵심 장점 한 줄을 버전마다 한 번씩 꼭 넣기(표현은 조금씩 달라도 됨), 마지막은 비슷한 권유형 마무리 한 줄.
- 핵심 한 줄과 마무리 외의 본문 문장은 다른 버전과 겹치지 않게 쓴다.
- 각 버전은 자기 중심 장점을 깊게 다루고, 다른 버전의 중심 장점은 많아야 한 줄만 짧게 언급한다.
- 첫 문장은 지정된 후킹 유형으로, 3초 안에 멈춰 보게 만든다.

[길이] 매우 중요
- 한 버전은 AI 음성으로 약 ${seconds}초. 이 음성은 1초에 약 ${TTS_CHARS_PER_SEC}글자를 읽으므로, 공백·문장부호를 뺀 글자 수가 버전마다 ${Math.round(chars * 0.9)}~${Math.round(chars * 1.1)}자여야 한다. 넘으면 문장을 줄인다.
- lines 는 문장 하나씩 한 줄로 쓴다.

[사실]
- 사실 목록과 영상에 보이는 것만 말한다. 확인 안 되는 수치(하중 kg, 100%, 몇 초 만에 설치)나 효능 단정은 쓰지 않는다.
- 사실 목록에 적힌 사용 방법(어디에 두는지, 어떻게 설치하는지)과 다르게 말하지 않는다.

[후킹 장면]
- hook_spec 은 "3초 : n번 a~b초" 형식 (n = 영상 번호, a~b = 그 영상 안의 초). 구간은 3초 이상 5초 이하, 첫 문장 내용과 실제로 맞는 장면을 장면표에서 골라라.

[검사]
- 다 쓴 뒤 문장마다 뜻이 맞는지(특히 "안 남는다/남는다" 같은 부정 표현이 뒤집히지 않았는지), 영상·사실과 맞는지, 글자 수가 맞는지 검사하고 고친다. 고친 점은 self_check 에 적는다.`;
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

const REVIEW_SYSTEM = `너는 광고 대본 검수자다. 대본의 문장마다 아래를 검사해 문제 있는 문장만 고쳐라.
1) 뜻이 뒤집히거나 이상한 문장 (예: "흔적이 남는다고 하니 안심"처럼 부정이 빠진 것)
2) 앞뒤가 논리적으로 안 이어지는 문장
3) 사실 목록에 없는 주장, 수치, 효능 단정
4) 사실 목록의 사용 방법과 다른 표현 (예: 벽에 붙이는 제품을 바닥이나 선반 위에 둔다고 말함)
5) ㅋㅋ·ㅎㅎ·이모지·특수문자
6) 다른 버전과 거의 같은 문장 (단, 제품 핵심 한 줄과 마무리 한 줄은 일부러 비슷하게 둔 것이니 고치지 않는다)
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
  const n = Math.max(1, Math.min(5, p.versions.length));
  const specs = p.versions.slice(0, n);
  const hookTypes = resolveHookTypes(specs);

  // 영상 장면표 (자동 배치와 같은 캐시)
  const images: Array<{ label: string; path: string }> = [];
  for (let i = 0; i < p.media.length; i++) {
    const m = p.media[i];
    onProgress(`영상 장면 준비 중 (${i + 1}/${p.media.length}): ${m.name}`);
    const sheet = await ensureSheet(ffmpegPath, m.path, m.duration);
    images.push({ label: `${m.no}번 영상 장면표 (${m.name}, ${m.duration.toFixed(1)}초) — 0.5초마다 한 칸, 칸 왼쪽 아래 노란 숫자 = 원본 초`, path: sheet });
  }

  const ex = readExamples(p.examplePaths);
  const factsBlock = `제품: ${p.product || '(이름 없음)'}
공간: ${p.space || '(미지정)'}
타겟: ${p.target || '(미지정)'}
사실 목록 (그대로 읽지 말 것):
${p.facts.trim() || '(없음 — 영상 장면표에서 보이는 것만 사실로 쓴다)'}`;
  const hookGuide = (id: string) => {
    const h = HOOK_TYPES.find((x) => x.id === id);
    return h ? `${h.guide} (예: "${h.example}")` : '';
  };
  const text = `${ex.count ? `## 고객 대본 예시 (말투 참고용)\n${ex.text}\n\n` : ''}## 이번 제품
${factsBlock}

## 버전별 지정
${specs
  .map(
    (s, i) =>
      `버전 ${i + 1}: 후킹 유형 = ${hookTypes[i]} — ${hookGuide(hookTypes[i])} / 이야기 = ${s.story.trim() || '자동'} / 중심 장점 = ${s.focus.trim() || '자동'}`
  )
  .join('\n')}

## 영상
${p.media.map((m) => `${m.no}번: ${m.name} (${m.duration.toFixed(1)}초)`).join('\n') || '(영상 없음 — 후킹 장면은 "3초 : 1번 0~3초"로 둔다)'}

위 지정대로 대본 ${n}개를 써라.`;

  onProgress(`AI가 대본 ${n}개를 쓰는 중...`);
  const gen = await claudeJson<{
    versions: Array<{ hook_type: string; angle: string; hook_spec: string; lines: string[]; self_check: string }>;
  }>({ system: buildSystem(p.seconds), text, images, schema: GEN_SCHEMA });
  add(gen.usage);
  const versions = gen.data.versions.slice(0, n).map((v, i) => ({
    hookType: v.hook_type || hookTypes[i],
    angle: v.angle,
    hookSpec: v.hook_spec,
    lines: v.lines.map((l) => l.trim()).filter(Boolean),
  }));

  onProgress('AI가 대본을 검수하는 중...');
  const review = await claudeJson<{ fixes: Array<{ version: number; line_index: number; before: string; after: string; reason: string }> }>({
    system: REVIEW_SYSTEM,
    text: `## 사실 목록\n${factsBlock}\n\n## 검수할 대본\n${JSON.stringify(
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

  const out: ScriptVersion[] = versions.map((v) => {
    let removed = false;
    const lines = v.lines
      .map((l) => {
        const c = cleanLine(l);
        removed ||= c.removed;
        return c.line;
      })
      .filter(Boolean);
    const warnings = checkVersion({ hookSpec: v.hookSpec, lines }, p.media, p.seconds);
    if (removed) warnings.unshift('ㅋㅋ·이모지 같은 글자를 자동으로 지웠어요');
    return { ...v, lines, warnings };
  });
  return { versions: out, fixes, usage, exampleCount: ex.count };
}
