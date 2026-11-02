/**
 * 자동 배치 2단계: 컷 자리(슬롯)마다 샷 고르기 (메인 프로세스에서 Claude 호출)
 * 규칙 = tools/premiere/planner_prompt.md 2단계 (편집자 본인이 정한 규칙). 바꿀 때 함께 바꿀 것.
 */
import { claudeJson, type UsageTotal } from './claudeService';
import type { Shot, ShotDesc } from './sceneAnalyzer';

export type AssignSlot = { slot: number; start: number; end: number; dur: number; text: string; hook: boolean };
export type UsedRange = { shot: string; from: number; to: number };
export type Assignment = { slot: number; shot: string; in: number; why: string };

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
   - used_elsewhere: 같은 원본으로 만든 다른 광고에서 쓴 구간. 되도록 다른 샷. 대사와 확실히 더 잘 맞으면 써도 되지만
     그때는 그 샷 안에서 from~to 와 겹치지 않는 부분을 in 으로 고른다. 규칙 1보다 우선하지 않는다.
4. 흐름: 앞 슬롯과 이어지는 상황이면 같은 영상의 다음 샷이 자연스럽다. 앞 컷과 거의 같은 구도로 바꾸면 바꾼 의미가 없다.
5. 원본 영상의 효과/자막 여부는 참고만 한다.

각 슬롯마다 샷 id 하나와, 그 샷 안에서 시작할 원본 초 in(샷 시작~끝 사이, 대사에 맞는 동작이 시작되는 순간)을 정한다.
in + 슬롯 길이가 샷 끝을 넘지 않게 고르는 게 좋다 (넘으면 자동으로 앞당기거나 느리게 맞춘다).
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
          shot: { type: 'string' },
          in: { type: 'number' },
          why: { type: 'string' },
        },
        required: ['slot', 'shot', 'in', 'why'],
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

나레이션 슬롯 (슬롯 0 = 후킹은 이미 정해져 있으니 고르지 않는다):
${JSON.stringify(params.slots.filter((s) => !s.hook).map(({ slot, start, end, dur, text: t }) => ({ slot, start, end, dur, text: t })))}

hook_used: ${JSON.stringify(params.hookUsed)}
used_elsewhere: ${JSON.stringify(params.usedElsewhere)}

슬롯 0을 뺀 모든 슬롯에 샷을 배정해 assign 으로 답한다.`;
  const res = await claudeJson<{ assign: Assignment[] }>({ system: SYSTEM, text, schema: SCHEMA, maxTokens: 16000 });
  return { assign: res.data.assign, usage: res.usage };
}
