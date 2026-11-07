/**
 * 자동 배치 2단계: 컷 자리(슬롯)마다 샷 고르기 (메인 프로세스에서 Claude 호출)
 * 규칙 = tools/premiere/planner_prompt.md 2단계 (편집자 본인이 정한 규칙). 바꿀 때 함께 바꿀 것.
 */
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { claudeJson, type UsageTotal } from './claudeService';
import type { Shot, ShotDesc } from './sceneAnalyzer';

export type AssignSlot = { slot: number; start: number; end: number; dur: number; text: string; hook: boolean; sentence?: string; cont?: boolean; next?: string };
export type UsedRange = { shot: string; from: number; to: number };
export type Assignment = { slot: number; focus: string; shot: string; in: number; alt: string; why: string };

const SYSTEM = `당신은 숏폼(세로 9:16, 30~40초) 제품 광고 편집자다. AI 음성 나레이션이 이미 깔려 있고,
나레이션의 각 구간(슬롯)마다 제품 원본 촬영 영상에서 장면(샷) 하나를 골라 붙인다.

규칙 (편집자 본인이 정한 것 — 중요한 순서):
1. 대사의 핵심 동작/상황과 화면이 맞아야 한다. 대사가 "꾹 눌러 붙여서"면 벽에 붙이는 장면, "물기가 쫙 빠져서"면 물이 빠지는 장면,
   "쓱 쓸어버리면"이면 바닥을 쓸어내는 장면. 같은 제품이 나온다는 이유만으로 고르지 않는다. 대사와 상관없는 동작은 금지.
   문제 상황을 말하는 대사는 그 문제가 보이는 장면, 감탄/결론 대사는 제품이 정돈되어 깔끔하게 쓰이는 장면.
2. 슬롯 길이만큼 볼거리가 있어야 한다. 긴 슬롯(3.5초 이상)에 거의 정지된(motion low) 같은 구도를 길게 늘이면 루즈하다 → 동작이 있는 샷.
   샷 길이가 슬롯보다 짧으면 느리게 늘어나는데, 0.8배보다 느려지면 어색하다. 슬롯 길이 이상인 샷을 우선한다.
3. 한 광고 안에서 같은 장면(같은 샷의 같은 부분)을 다시 쓰지 않는다. 더 맞는 장면이 정말 없을 때만 재사용.
   - hook_used: 이 광고의 후킹에 이미 쓴 샷 구간. 다시 쓰지 않는다.
     특히 after_hook=true 인 슬롯(후킹 바로 다음)은 후킹에 쓴 샷을 그 샷의 다른 부분이라도 절대 쓰지 않는다
     (후킹 장면이 그대로 이어지는 것처럼 보여서 컷이 바뀐 느낌이 없다). 반드시 다른 샷.
   - used_elsewhere: 같은 원본으로 만든 다른 광고에서 쓴 구간. 되도록 다른 샷. 대사와 확실히 더 잘 맞으면 써도 되지만
     그때는 그 샷 안에서 from~to 와 겹치지 않는 부분을 in 으로 고른다. 규칙 1보다 우선하지 않는다.
4. 문장의 핵심 (가장 중요): 문장마다 먼저 '이 문장이 시청자를 설득하려는 핵심 대상·동작'을 정해 focus 에 적는다.
   문장이 여러 슬롯으로 나뉘면 그 문장의 모든 슬롯이 핵심을 보여 줘야 한다. 컷마다 그 컷의 대사만 보고 고르지 않는다.
   예: "거기다 인형 하나 얹어 두니까 / 베란다 분위기도 확 살더라고요" → 핵심 = 인형. 분위기가 산 이유가 인형이므로
   두 컷 모두 인형을 올리는/인형이 올라간 장면이어야 한다. 뒤 컷에 빨래만 보이면 문장의 설득력이 떨어진다.
   핵심을 보여 주는 샷이 여러 개 있으면 그 안에서만 아래 흐름·장소 규칙으로 고른다. 장면 설명(desc)에 핵심이 지나가듯 언급만 된 샷보다
   핵심이 화면의 주인공인 샷을 고른다.
4-1. 한 문장 = 한 흐름 (핵심을 보여 주는 샷들 안에서):
   - 슬롯의 sentence 는 그 슬롯이 속한 문장 전체다. 낱말 하나(타일, 유리…)가 아니라 문장 전체의 뜻으로 고른다.
   - cont=true 인 슬롯은 앞 슬롯과 같은 문장이 이어지는 자리다. 핵심을 보여 주는 샷 중에서, 앞 슬롯과 같은 영상의 바로 이어지는 샷,
     같은 장소(place)를 우선한다. 같은 영상의 다음 샷이라도 핵심이 안 보이면 고르지 않는다. 한 문장 안에서 구도·장소가 전혀 다른 영상으로 계속 바꾸면 템포가 너무 빨라 보인다.
     문장 안에서 낱말마다 그 낱말에 맞는 장면을 따로 찾아 붙이지 않는다 (예: "욕실 타일이나 창문 유리에 손으로 꾹 눌러 붙이면" → 붙이는 장면 하나의 흐름).
   - 같은 영상·같은 장소에서 시간을 건너뛰어 비슷한 동작을 연달아 붙이지 않는다 (두 컷 첫 화면이 똑같아 보인다).
     같은 영상을 이어 쓸 때는 바로 다음 샷으로 이어 가거나, 다른 영상으로 바꾼다.
   - 앞 컷과 거의 같은 구도로 바꾸면 바꾼 의미가 없다.
5. 장소를 맞춘다: 대사(sentence, next 포함)에 장소 말(베란다·발코니·창밖·창가·욕실·화장실·주방·현관·거실 등)이 나오면
   place 가 그 장소인 샷을 우선한다. 단 문장의 핵심을 보여 주는 샷 중에서만 (핵심 장면이 다른 장소뿐이면 핵심이 먼저).
   우선순위: 문장의 핵심 > 장소 > 같은 영상으로 이어 가기 > 낱말 하나하나.
6. 실제로 하는 부분: "해 보니까 / 써 보니까 / 걸어 보니까 / 붙여 보니까"처럼 직접 써 본 대사는 준비하거나 설명하는 부분이 아니라
   실제로 쓰는 동작이 보이는 부분이어야 한다. 샷에 parts 가 있으면 in 은 대사와 맞는 part 의 from 으로 정한다.
7. 원본 영상의 효과/자막 여부는 참고만 한다.

각 슬롯마다 샷 id 하나와, 그 샷 안에서 시작할 원본 초 in(샷 시작~끝 사이, 대사에 맞는 동작이 시작되는 순간)을 정한다.
in + 슬롯 길이가 샷 끝을 넘지 않게 고르는 게 좋다 (넘으면 자동으로 앞당기거나 느리게 맞춘다).
샷 길이(dur)가 슬롯 길이(dur)의 0.6배보다 짧은 샷은 절대 고르지 않는다 (너무 느려져서 쓸 수 없다).
alt 에는 두 번째로 맞는 샷 id 를 적는다 (shot 이 쓸 수 없을 때 대신 쓴다. shot 과 다른 샷, 같은 규칙).
focus 에는 그 슬롯이 속한 문장의 핵심 대상·동작을 짧게 적는다 (같은 문장의 슬롯은 같은 focus).
why 에는 대사의 어떤 부분과 화면의 어떤 동작이 맞는지 한 줄로 적는다.`;

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
          alt: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['slot', 'focus', 'shot', 'in', 'alt', 'why'],
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
      parts: d?.parts ?? [],
      note: d?.note ?? '',
    };
  });
  const text = `제품: ${params.product || '(미지정)'}

샷 목록 (JSON):
${JSON.stringify(shotTable)}

나레이션 슬롯 (후킹이 정해진 슬롯은 목록에서 뺐다. min_shot = 고를 수 있는 샷의 최소 길이):
${JSON.stringify(params.slots.filter((s) => !s.hook).map(({ slot, start, end, dur, text: t, sentence, cont, next }) => ({ slot, start, end, dur, min_shot: +(dur * 0.6).toFixed(2), text: t, sentence, cont: !!cont, next: next ?? '', after_hook: params.slots.some((h) => h.hook && h.slot === slot - 1) })))}

hook_used: ${JSON.stringify(params.hookUsed)}
used_elsewhere: ${JSON.stringify(params.usedElsewhere)}

위 목록에 있는 모든 슬롯에 빠짐없이 샷을 배정해 assign 으로 답한다. (후킹 지정이 없는 광고는 슬롯 0도 목록에 있다)`;
  const res = await claudeJson<{ assign: Assignment[] }>({ system: SYSTEM, text, schema: SCHEMA, maxTokens: 16000 });
  // AI가 자리마다 무엇을 핵심으로 보고(focus) 왜 그 장면을 골랐는지(why) 기록 → userData/auto-edit-logs (추가 비용 없음)
  try {
    const dir = path.join(app.getPath('userData'), 'auto-edit-logs');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const descById = new Map(params.descs.map((d) => [d.id, d]));
    const rows = params.slots.map((s) => {
      const a = res.data.assign.find((x) => x.slot === s.slot);
      const d = a ? descById.get(a.shot) : undefined;
      return { slot: s.slot, start: +s.start.toFixed(2), end: +s.end.toFixed(2), hook: s.hook, text: s.text, sentence: s.sentence, focus: a?.focus, shot: a?.shot, in: a?.in, shotDesc: d?.desc, shotPlace: d?.place, alt: a?.alt, why: a?.why };
    });
    fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify({ product: params.product, rows }, null, 1));
  } catch {
    /* 기록 실패는 배치에 영향 없음 */
  }
  return { assign: res.data.assign, usage: res.usage };
}
