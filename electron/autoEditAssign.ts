/**
 * 자동 배치 2단계: 컷 자리(슬롯)마다 샷 고르기 (메인 프로세스에서 Claude 호출)
 * 규칙 = tools/premiere/planner_prompt.md 2단계 (편집자 본인이 정한 규칙). 바꿀 때 함께 바꿀 것.
 */
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { claudeJson, TruncatedError, type UsageTotal } from './claudeService';
import type { Shot, ShotDesc } from './sceneAnalyzer';

export type AssignSlot = { slot: number; start: number; end: number; dur: number; text: string; hook: boolean; sentence?: string; cont?: boolean; next?: string; basis?: string[] };
export type UsedRange = { shot: string; from: number; to: number };
export type Assignment = { slot: number; focus: string; shot: string; in: number; fit: string; alt: string; why: string };

const SYSTEM = `당신은 숏폼(세로 9:16, 30~40초) 제품 광고 편집자다. AI 음성 나레이션이 이미 깔려 있고,
나레이션의 각 구간(슬롯)마다 제품 원본 촬영 영상에서 장면(샷) 하나를 골라 붙인다.

샷 목록의 항목 (원본을 미리 본 분석 결과):
- desc 설명, place 장소, motion 움직임, subject 화면의 주인공(가장 크게 보이는 것), talk 카메라 보고 말하는 장면,
  stage 단계(문제상황/준비/실제사용/완성모습/기타), mood 분위기, framing 구도, key 핵심 순간(원본 초),
  group 비슷한 장면 묶음, issues 쓰기 어려운 점(큰 자막 등), parts 샷 안 부분별(from~to 원본 초, 부분마다 subject/talk/stage)
- 항목이 비어 있으면(예전 분석) desc 로 판단한다.
- id 는 "영상 번호-샷 번호"다 (1-02 = 1번 영상의 2번째 샷). 같은 영상에서 번호가 1 큰 샷이 시간상 바로 다음 샷이다.

나레이션 슬롯의 항목:
- text 이 슬롯에서 나오는 대사, sentence 그 대사가 들어 있는 문장 전체.
  문장의 핵심(focus)은 sentence 로 정하고, 샷은 그 핵심을 보여 주면서 text 와도 어긋나지 않는 것을 고른다.
- cont=true 면 바로 앞 슬롯과 같은 문장이 이어지는 슬롯이다. next 는 바로 다음 슬롯의 대사다 (흐름 참고용).
- dur 슬롯 길이(초), min_shot 고를 수 있는 샷의 최소 길이(초), after_hook=true 면 후킹 바로 다음 슬롯.
- basis 는 [대본 근거 장면] 참고.
hook_used 는 이 광고에서 이미 쓴 샷 구간(후킹 등)이다.

[반드시 지킬 것 — 어기면 코드가 다른 장면으로 바꾼다]
A. 샷 길이(dur)가 슬롯의 min_shot 보다 짧은 샷은 고르지 않는다 (너무 느려진다).
B. after_hook=true 슬롯(후킹 바로 다음)은 hook_used 에 있는 샷을 그 샷의 다른 부분이라도 쓰지 않는다.
C. 한 광고 안에서 같은 샷의 같은 부분을 두 번 쓰지 않는다 (hook_used 포함).
   단 '이어 쓰기'는 된다: 같은 문장(cont=true)에서 바로 앞 슬롯과 같은 샷을 고르면 앞 컷이 끝난 곳부터 이어서 재생된다(화면이 안 바뀜).
D. 바로 앞 슬롯(후킹 포함)과 같은 영상 파일의 '다른' 샷은 쓰지 않는다. 같은 영상은 장소·사람·빨래가 같아서
   시간을 건너뛰어 붙이면 같은 컷이 두 번 나온 것처럼 보인다. 예외: 앞 샷 이어 쓰기, 또는 시간상 바로 다음 샷(id 번호 +1).

[대본 근거 장면] 슬롯에 basis 가 있으면 대본을 쓸 때 그 문장의 근거로 본 장면들이다.
   위 A~D 를 지키는 한 basis 장면을 가장 먼저 고른다 (basis 가 여러 개면 그중 아래 순서에 가장 맞는 것).
   basis 는 문장 전체의 근거다. fit 은 이 슬롯의 대사에 실제로 맞는 정도대로 적는다 (basis 라고 무조건 "딱 맞음"으로 적지 않는다).
   basis 장면이 모두 A~D 에 걸리면 basis 와 같은 주인공·장소의 다른 샷을 고른다.

[고르는 순서 — 위에 있을수록 중요]
1. 문장의 핵심 = 화면의 주인공. 문장마다 먼저 '이 문장이 시청자를 설득하려는 핵심 대상·동작'을 정해 focus 에 적는다.
   그 문장의 모든 슬롯은 subject(주인공)가 핵심인 샷에서 고른다. 설명에 핵심이 스치듯 나오기만 하는 샷은 고르지 않는다.
   같은 문장의 슬롯은 focus 를 글자 그대로 똑같이 적는다 (슬롯마다 그 슬롯 대사만 보고 바꾸지 않는다).
   대사에 장소 말(창문 유리·베란다·욕실 타일…)이 있으면 focus 에 장소를 넣고(예: "창문 유리에 붙이는 거치대"),
   그 문장의 모든 슬롯을 그 장소(place) 샷으로 고른다.
   예: "이건 창문 유리에 손으로 꾹 눌러 붙이면 / 바로 고정되는 거치대예요" → 두 슬롯 모두 창문 유리에 붙이는 샷 (욕실 벽 샷 X).
   예: "거기다 인형 하나 얹어 두니까 / 베란다 분위기도 확 살더라고요" → 핵심 = 인형 → 두 슬롯 모두 subject 가 인형인 샷.
2. 대사의 성격에 맞는 단계:
   - 문제·불편을 말하는 대사 → stage 문제상황 (없으면 준비)
   - "해 보니까 / 써 보니까 / 붙이기만 하면" 같은 사용 대사 → stage 실제사용. 샷에 parts 가 있으면 실제사용 부분의 from 을 in 으로
   - 장점·결론·감정 대사("행복해요", "편해요", "분위기가 살았다", "깔끔해졌어요") → stage 완성모습 또는 실제사용
   - 감정·결과·사용 대사에는 stage 준비, talk=true, subject 가 사람(얼굴)인 샷(부분)을 쓰지 않는다 (들고 걸어오며 말하는 소개 장면 등).
     talk=true 장면은 처음 소개·설명 대사에만.
   - 가격·구매 권유 대사 → 제품(거치대 등)이 잘 보이는 완성모습
3. 장소·분위기: 대사에 장소(베란다·창밖·욕실…)나 분위기(햇빛, 깔끔…) 말이 있으면 place/mood 가 맞는 샷. 단 1·2 를 지키는 샷 중에서.
4. 비슷한 장면 연달아 피하기: 바로 앞 컷과 group 이 같은 '다른' 샷은 피한다 (첫 화면이 같아 보인다). 이어 쓰기(같은 샷 이어서)는 괜찮다.
5. 흐름: 같은 문장(cont=true) 안에서는 1~4 를 지키는 샷 중 앞 슬롯과 같은 영상·같은 장소를 우선하고,
   앞 장면이 여전히 문장에 맞으면 같은 샷을 이어 쓴다 (화면이 덜 자주 바뀐다).
6. 깨끗한 장면: 같은 조건이면 issues 가 없는(큰 자막·흔들림 없는) 샷.
7. 구도: 같은 조건이면 바로 앞 컷과 framing 이 다른 샷.
8. 다른 광고와 겹침 (R27): used_elsewhere 는 같은 원본으로 만든 '다른 광고'에서 쓴 샷 구간이다. 금지가 아니라 참고다.
   1~7 기준으로 똑같이 잘 맞는 후보가 둘 이상일 때만 used_elsewhere 에 없는 쪽을 고른다.
   대사에 더 잘 맞는 샷이 used_elsewhere 에 있으면 그대로 고르고, 그 샷 안에서 from~to 와 겹치지 않는 부분을 in 으로 고른다
   (겹치지 않는 부분이 없거나 key 가 겹친 부분에 있으면 겹쳐도 된다).
   겹침을 피하려고 핵심·단계·장소가 덜 맞는 샷을 고르거나 fit 을 "대체"로 낮추지 않는다. (hook_used 와 다르다: hook_used 는 C 규칙)

[맞는 정도] fit 에 적는다:
   "딱 맞음" = 1(핵심)·2(단계)·3(장소·분위기)이 모두 맞음 / "비슷함" = 1·2 는 맞고 3(장소·분위기)이 어긋남 / "대체" = 1(핵심)이나 2(단계)가 안 맞음.
[맞는 장면이 없을 때] 1~2 를 지키는 샷이 없으면 "대체"로 하고 이 순서로 고른다:
   ① 같은 문장이면 앞 슬롯 샷 이어 쓰기 ② 대사 성격에 맞는 단계의 샷(감정·결론→완성모습, 사용→실제사용, 문제→문제상황)
   ③ 제품이 잘 보이는 깨끗한 완성모습. 글자만 비슷하고 뜻이 다른 장면은 대체로도 쓰지 않는다.

in 은 샷 시작~끝 사이 원본 초. 샷에 key(핵심 순간)가 있으면 in ~ in+슬롯 길이 안에 key 가 들어가게 고른다.
alt 에는 두 번째로 맞는 샷 id 를 적는다 (같은 focus 를 보여 주는 샷, 같은 규칙. shot 과 다른 샷).
focus 는 15자 이내, why 는 대사의 어떤 부분과 화면의 무엇(주인공·단계)이 맞는지 30자 이내 한 줄로 적는다 (길게 쓰지 않는다).`;

const SCHEMA = {
  type: 'object',
  properties: {
    assign: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slot: { type: 'integer' },
          focus: { type: 'string' },
          shot: { type: 'string' },
          in: { type: 'number' },
          fit: { type: 'string', enum: ['딱 맞음', '비슷함', '대체'] },
          alt: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['slot', 'focus', 'shot', 'in', 'fit', 'alt', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['assign'],
  additionalProperties: false,
};

export async function assignShots(params: {
  product: string;
  shots: Shot[];
  descs: ShotDesc[];
  slots: AssignSlot[];
  hookUsed: UsedRange[];
  usedElsewhere: UsedRange[];
}): Promise<{ assign: Assignment[]; usage: UsageTotal }> {
  const descById = new Map(params.descs.map((d) => [d.id, d]));
  const shotTable = params.shots.map((s) => {
    const d = descById.get(s.id);
    return {
      id: s.id,
      file: s.file,
      start: s.start,
      end: s.end,
      dur: s.dur,
      desc: d?.desc ?? '',
      place: d?.place ?? '',
      motion: d?.motion ?? 'low',
      subject: d?.subject ?? '',
      talk: d?.talk ?? false,
      stage: d?.stage ?? '',
      mood: d?.mood ?? '',
      framing: d?.framing ?? '',
      key: d?.key ?? null,
      group: d?.group ?? '',
      issues: d?.issues ?? '',
      parts: d?.parts ?? [],
      note: d?.note ?? '',
    };
  });
  const slotJson = (list: AssignSlot[]) =>
    JSON.stringify(
      list.map(({ slot, start, end, dur, text: t, sentence, cont, next, basis }) => ({
        slot,
        start,
        end,
        dur,
        ...(basis?.length ? { basis } : {}),
        min_shot: Math.ceil((dur * 0.6 + 0.12 + 0.04) * 100) / 100,
        text: t,
        sentence,
        cont: !!cont,
        next: next ?? '',
        after_hook: params.slots.some((h) => h.hook && h.slot === slot - 1),
      }))
    );
  const usage: UsageTotal = { input: 0, output: 0 };
  // 잘리면 반으로 나눠 다시 묻기는 1번까지만. 2번째로 잘리면 AI가 멈추지 못하는 상황으로 보고 멈춤
  //  (잘린 시도 1번 ≈ 45원 → 광고 하나당 최악 약 90원)
  const MAX_TRUNCATIONS = 1;
  let truncations = 0;
  // 슬롯 묶음 하나를 물어봄. 답이 최대 길이에 걸려 잘리면 슬롯을 반으로 나눠 다시 물어봄 (뒤쪽은 앞쪽에서 고른 장면을 '이미 씀'으로 알려 줌)
  const ask = async (list: AssignSlot[], usedHere: UsedRange[], prevNote: string): Promise<Assignment[]> => {
    const text = `제품: ${params.product || '(미지정)'}

샷 목록 (JSON):
${JSON.stringify(shotTable)}

나레이션 슬롯 (후킹이 정해진 슬롯은 목록에서 뺐다. min_shot = 고를 수 있는 샷의 최소 길이):
${slotJson(list)}

hook_used: ${JSON.stringify([...params.hookUsed, ...usedHere])}
used_elsewhere (다른 광고에서 쓴 구간 — 금지 아님, 고르는 순서 8 참고): ${JSON.stringify(params.usedElsewhere)}
${prevNote}
위 목록에 있는 모든 슬롯에 빠짐없이 샷을 배정해 assign 으로 답한다. (후킹 지정이 없는 광고는 슬롯 0도 목록에 있다)`;
    try {
      const res = await claudeJson<{ assign: Assignment[] }>({ system: SYSTEM, text, schema: SCHEMA, maxTokens: 64000 });
      usage.input += res.usage.input;
      usage.output += res.usage.output;
      return res.data.assign;
    } catch (e) {
      if (!(e instanceof TruncatedError) || list.length < 2) throw e;
      usage.input += e.usage.input; // 잘린 답에 든 비용도 합계에 넣음
      usage.output += e.usage.output;
      truncations++;
      if (truncations > MAX_TRUNCATIONS) {
        throw new Error(`AI 답이 너무 길어 ${truncations}번 잘려서 이 광고의 자동 배치를 멈췄습니다 (그동안 사용량 입력 ${usage.input} / 출력 ${usage.output} 토큰). 다시 시도해 주세요.`);
      }
      const half = Math.ceil(list.length / 2);
      const first = await ask(list.slice(0, half), usedHere, prevNote);
      const used = first.map((a) => {
        const s = list.find((x) => x.slot === a.slot);
        return { shot: a.shot, from: +Number(a.in).toFixed(2), to: +(Number(a.in) + (s?.dur ?? 0)).toFixed(2) };
      });
      const last = first.find((a) => a.slot === list[half - 1].slot);
      const note = last ? `(이 광고의 앞 슬롯은 이미 정했다. 바로 앞 슬롯 ${last.slot} = 샷 ${last.shot}. 이어 쓰기가 아니면 같은 영상의 다른 샷은 쓰지 않는다)\n` : '';
      const second = await ask(list.slice(half), [...usedHere, ...used], note);
      return [...first, ...second];
    }
  };
  const assign = await ask(params.slots.filter((s) => !s.hook), [], '');
  const res = { data: { assign } };
  // AI가 자리마다 무엇을 핵심으로 보고(focus) 왜 그 장면을 골랐는지(why) 기록 → userData/auto-edit-logs (추가 비용 없음)
  try {
    const dir = path.join(app.getPath('userData'), 'auto-edit-logs');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const descById = new Map(params.descs.map((d) => [d.id, d]));
    const rows = params.slots.map((s) => {
      const a = res.data.assign.find((x) => x.slot === s.slot);
      const d = a ? descById.get(a.shot) : undefined;
      return { slot: s.slot, start: +s.start.toFixed(2), end: +s.end.toFixed(2), hook: s.hook, text: s.text, sentence: s.sentence, focus: a?.focus, fit: a?.fit, shot: a?.shot, in: a?.in, shotDesc: d?.desc, shotSubject: d?.subject, shotStage: d?.stage, shotPlace: d?.place, alt: a?.alt, why: a?.why };
    });
    // 실제 사용량(생각 포함 출력 토큰)도 남김 → 답 길이 한도(64000)가 적당한지 숫자로 판단 (사용자 2026-11-11)
    const won = Math.round(((usage.input * 0.1 + usage.output * 0.5) / 1e6) * 1400);
    fs.writeFileSync(
      path.join(dir, `${stamp}.json`),
      JSON.stringify({ product: params.product, usage: { input: usage.input, output: usage.output, truncations, maxTokens: 64000, approxWon: won }, rows }, null, 1)
    );
  } catch {
    /* 기록 실패는 배치에 영향 없음 */
  }
  return { assign: res.data.assign, usage };
}
