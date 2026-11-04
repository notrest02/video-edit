/**
 * Typecast API (메인 프로세스 전용) — 키 저장/확인, 목소리 목록, 음성 만들기(단어 시간 정보 포함).
 * 문서: https://typecast.ai/docs/llms.txt (2026-11-04 확인)
 *  - 인증: X-API-KEY 헤더. 키는 화면 쪽으로 보내지 않는다 (safeStorage 암호화 → userData/typecast-key.bin)
 *  - 음성: POST /v1/text-to-speech/with-timestamps?granularity=word → { audio(base64), audio_format, audio_duration, words[{text,start,end}] } (초 단위)
 *  - 목소리: GET /v3/voices?model=… (언어 필드는 없음 → 미리듣기로 확인)
 *  - 크레딧: GET /v1/users/me/subscription → credits.plan_credits - used_credits
 * 웹(Studio) 요금제 키·예전 Starter 키는 API 에서 403. 1글자 = 1크레딧(공백·기호 포함).
 */
import { app, safeStorage } from 'electron';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const BASE = 'https://api.typecast.ai';
export const TYPECAST_MODEL = 'ssfm-v31';
// Typecast 문서가 연동 코드에 붙여 달라고 한 출처 표시
const USER_AGENT = `ShortCut/${app.getVersion()} (source=api-docs; generated_by=claude-code)`;

const keyFile = () => path.join(app.getPath('userData'), 'typecast-key.bin');

export function hasTypecastKey(): boolean {
  return fs.existsSync(keyFile());
}

function readKey(): string | null {
  if (!hasTypecastKey()) return null;
  const buf = fs.readFileSync(keyFile());
  return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
}

export function saveTypecastKey(key: string) {
  const k = key.trim();
  fs.writeFileSync(keyFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(k) : Buffer.from(k, 'utf8'));
}

export function clearTypecastKey() {
  if (hasTypecastKey()) fs.unlinkSync(keyFile());
}

/** 상태 코드 → 쉬운 말 (문서의 403 점검 순서 포함) */
function explain(status: number, body: string): string {
  const tail = body ? ` (${body.slice(0, 200)})` : '';
  switch (status) {
    case 401:
      return 'Typecast API 키가 없거나 올바르지 않습니다.';
    case 402:
      return 'Typecast 크레딧이 부족합니다.';
    case 403:
      return 'Typecast가 요청을 거절했습니다. 웹(Studio) 요금제 키나 예전 Starter 키가 아닌지, 키 앞뒤에 공백이 없는지, 계정이 휴면 상태가 아닌지 확인해 주세요.';
    case 404:
      return `목소리나 모델을 찾지 못했습니다.${tail}`;
    case 422:
    case 400:
      return `요청 값이 올바르지 않습니다.${tail}`;
    case 429:
      return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
    default:
      return `Typecast 오류 ${status}${tail}`;
  }
}

async function call(pathAndQuery: string, init: { method?: string; body?: unknown; key?: string } = {}): Promise<unknown> {
  const key = (init.key ?? readKey() ?? '').trim();
  if (!key) throw new Error('Typecast API 키가 없습니다. 음성 만들기 칸에서 키를 먼저 넣어 주세요.');
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    method: init.method || 'GET',
    headers: {
      'X-API-KEY': key,
      'User-Agent': USER_AGENT,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(explain(res.status, text));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Typecast 응답을 읽지 못했습니다.');
  }
}

export type TypecastSubscription = { plan: string; planCredits: number; usedCredits: number; remaining: number; concurrency: number };

export async function getSubscription(key?: string): Promise<TypecastSubscription> {
  const r = (await call('/v1/users/me/subscription', { key })) as {
    plan: string;
    limits?: { concurrency_limit?: number };
    credits?: { plan_credits?: number; used_credits?: number };
  };
  const planCredits = r.credits?.plan_credits ?? 0;
  const usedCredits = r.credits?.used_credits ?? 0;
  return { plan: r.plan, planCredits, usedCredits, remaining: Math.max(0, planCredits - usedCredits), concurrency: r.limits?.concurrency_limit ?? 1 };
}

/** 키 확인 = 구독 정보 조회가 되면 저장 */
export async function testAndSaveKey(key: string): Promise<{ ok: boolean; message: string; sub?: TypecastSubscription }> {
  try {
    const sub = await getSubscription(key.trim());
    saveTypecastKey(key);
    return { ok: true, message: `연결 확인됨 (${sub.plan} 요금제, 남은 크레딧 ${sub.remaining.toLocaleString()})`, sub };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export type TypecastVoice = {
  id: string;
  name: string; // 한국어 이름
  nameEng: string;
  gender: string | null;
  age: string | null;
  useCases: string[];
  emotions: string[]; // 권장 모델(ssfm-v31)에서 쓸 수 있는 감정
  previewUrl: string | null;
  isKorean: boolean; // 한국어 성우/캐릭터 여부 (영어·일본어·중국어 성우와 구분)
};

const JP_CN_NAMES =
  /^(고바야시|사토|요시다|스즈키|타카하시|시미즈|무라카미|이노우에|야마모토|노무라|카토|무라타|코지마|와타나베|다나카|이치카와|이시다|토나카이|칸노|하오란|다이다이|리리|티안|미오)/;

const FOREIGN_ENG_NAMES = new Set(
  [
    'Alder','Brandon','Shane','Griffin','Felicity','Serena','Ares','Hephaestus','Krista','Amara','Poseidon','Hades','Demeter','Hera','Artemis',
    'Zeus','Aphrodite','Apollo','Hestia','Hermes','Silas','Ray','Callum','Lorenzo','Donatella','Antonio','Franz','Carmen','Lena','Diego','Mateo',
    'Pierre','Manon','Fabio','Alessandra','Alena','Anja','Elise','Wade','Nia','Walter','Tessa','Doug','Janet','Echo','Nova','Audrey','Verna',
    'Riley','Elias','Sylvia','Zoey','Valerie','Chad','Rusty','Gus','Aaron','Damian','Margot','Logan','Jackson','Viktor','Benny','Hugh','Hailey',
    'Carl','Victoria','Kelsey','Oliver','Jeff','Lucille','Dean','Babilon','Dylan','Bruce','Robert','Starling','Chloe','Ron','Carol','Chester',
    'Larry','Royce','Callan','Simon','Lloyd','Rita','Billie','Maisie','River','Jake','Amber','Catherine','Lydia','Neel','Cherry','Maddie','Cole',
    'Cox','Liz','Bell','Noel','Buddy','Patrick','Jodie','Jerome','Millie','Henry','Justin','Ben','West','Rex','Rebecca','Sean','Ella','Owen',
    'Mia','Tim','Joshua','Tyson','Sophia','Ruby','Claire','P-0150N','Kelly','Alex','Angela','Matthew','Oscar','Helena','Vincent','Teal','Noa',
    'Aiden','Katie','Betty','Emma','Ryan','Peter','Michael','Carlos','Dollar Jr.','Santa','Slushy','Rudolph','Dan','Vivien','Vanessa','Sindarin',
    'Kevin','Cameron','Jolly','Furnando','Hellen','David','Jack','Annie','George','Liam','Margaret','Dana','Xavier','Tommy','Nana','Duke',
    'Doughnut','Newscaster John','Reporter Catalina','Jimmy','Icarus','Shotgun','Uncle Hank','Ian','Glenda','Jennifer','Camila','Morgan','Sammy',
    'Spice','Lala','Luna','Toby','Valkyrie','Old radio','Smoke','Bono','Captain Bill','Mrs. Claus','Annabelle the Ghost','Sabrina the Witch',
  ].map((s) => s.toLowerCase())
);

/** Typecast 목소리 목록에 언어 필드가 없어서 이름·영문 표기로 한국어 성우/캐릭터인지 판별 */
function detectKoreanTypecastVoice(kor: string, eng: string): boolean {
  const k = kor.trim();
  const e = eng.trim();
  if (!k) return false;
  if (JP_CN_NAMES.test(k) || /-san$/i.test(e)) return false;
  if (FOREIGN_ENG_NAMES.has(e.toLowerCase())) return false;
  if (/(캐스터|기자|앵커|교관|스토리텔러|할아버지|반장|기장|변사|홈쇼핑|쇼린이|단희빈|타캐|MBTI|김|박|이|최|정|강|조|윤|장|임|한|오|서|신|권|황|안|송|홍|유|고|문|양|손|배|백|허|남|심|노|하|곽|성|차|주)/.test(k)) {
    return true;
  }
  if (
    /(eo|eu|oo|hy|ky|gy|yeong|young|jung|jeong|seong|sung|hyun|hyeon|jin|min|jun|joon|hoon|hun|woo|wu|soo|su|hee|hui|ji|eun|bin|won|yeon|yun|yoon|ho|ha|do|da|na|ra|ae|ok|suk|sook|shik|sik|chul|cheol|pil|mok|seok|gwang|kwang|chan|chang|sang|seung|kyung|gyeong|myung|myeong|tae|jae|chae|hae|hye|gyu|kyu|gg|bb)/i.test(
      e
    )
  ) {
    return true;
  }
  return k.length <= 3 && !/\s/.test(e);
}

export async function listVoices(filter: { gender?: string; age?: string } = {}): Promise<TypecastVoice[]> {
  const q = new URLSearchParams({ model: TYPECAST_MODEL });
  if (filter.gender) q.set('gender', filter.gender);
  if (filter.age) q.set('age', filter.age);
  const r = (await call(`/v3/voices?${q}`)) as Array<{
    voice_id: string;
    voice_name: { kor?: string; eng?: string } | string;
    gender: string | null;
    age: string | null;
    models?: Array<{ version: string; emotions?: string[] }>;
    use_cases?: string[];
    preview_url?: string | null;
  }>;
  const list = (Array.isArray(r) ? r : []).map((v) => {
    const nm = typeof v.voice_name === 'string' ? { kor: v.voice_name, eng: v.voice_name } : v.voice_name || {};
    const kor = nm.kor || nm.eng || v.voice_id;
    const eng = nm.eng || '';
    return {
      id: v.voice_id,
      name: kor,
      nameEng: eng,
      gender: v.gender,
      age: v.age,
      useCases: v.use_cases || [],
      emotions: v.models?.find((m) => m.version === TYPECAST_MODEL)?.emotions || [],
      previewUrl: v.preview_url ?? null,
      isKorean: detectKoreanTypecastVoice(kor, eng),
    };
  });
  // 한국어 성우를 앞쪽에 정렬
  return list.sort((a, b) => Number(b.isKorean) - Number(a.isKorean));
}

/**
 * 바로 듣기 (무료, 대략): 목소리 미리듣기 샘플을 내려받아(한 번만, userData/voice-previews) ffmpeg 로 속도·음높이를 바꿔 들려준다.
 * Typecast 가 실제로 바꾸는 방식과는 조금 다르다 — 느낌 확인용. 감정은 반영되지 않는다.
 *  음높이: asetrate 로 반음만큼 올리고/내린 뒤 atempo 로 길이를 되돌리고, 속도는 atempo 에 곱한다
 */
export async function adjustedPreview(ffmpegPath: string, p: { url: string; tempo: number; pitch: number }): Promise<string> {
  const dir = path.join(app.getPath('userData'), 'voice-previews');
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.createHash('sha1').update(p.url).digest('hex').slice(0, 16);
  const src = path.join(dir, `${id}.src`);
  if (!fs.existsSync(src)) {
    const res = await fetch(p.url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`미리듣기 샘플을 받지 못했습니다 (${res.status})`);
    fs.writeFileSync(src, Buffer.from(await res.arrayBuffer()));
  }
  const ratio = Math.pow(2, Math.max(-12, Math.min(12, p.pitch)) / 12);
  const tempo = Math.max(0.5, Math.min(2, p.tempo));
  const out = path.join(dir, `${id}_${tempo.toFixed(2)}_${p.pitch}.wav`);
  if (!fs.existsSync(out)) {
    const filter =
      p.pitch === 0
        ? `atempo=${tempo.toFixed(4)}`
        : `aresample=44100,asetrate=${Math.round(44100 * ratio)},aresample=44100,atempo=${(tempo / ratio).toFixed(4)}`;
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath, ['-v', 'error', '-y', '-i', src, '-af', filter, '-ac', '1', '-c:a', 'pcm_s16le', out], { windowsHide: true });
      let err = '';
      proc.stderr.on('data', (d) => (err += d.toString()));
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`소리 변환 실패: ${err.slice(-200)}`))));
    });
  }
  return `data:audio/wav;base64,${fs.readFileSync(out).toString('base64')}`;
}

export type SynthItem = {
  /** 파일 이름 (확장자 없이), 예: 캐릭터흡착수납함_01 */
  name: string;
  text: string;
  voiceId: string;
  /** 'smart' = 문맥 보고 자동, 그 밖에는 프리셋 감정 이름 */
  emotion: string;
  intensity: number;
  tempo: number;
  pitch: number;
};

export type SynthResult = {
  name: string;
  ok: boolean;
  error?: string;
  audioPath?: string;
  timestampsPath?: string;
  duration?: number;
  credits?: number;
};

/**
 * 버전마다 음성 만들기 (차례대로 하나씩 — 동시 요청 한도가 작은 요금제도 있어서)
 * 결과 파일: <폴더>/<name>.mp3 + <name>.timestamps.json (단어별 시작·끝 초, 쉼 줄인 음성 기준)
 */
export async function synthesize(
  params: { folder: string; items: SynthItem[]; removeSilenceMs: number | null; format: 'mp3' | 'wav' },
  onProgress: (msg: string) => void
): Promise<SynthResult[]> {
  fs.mkdirSync(params.folder, { recursive: true });
  const out: SynthResult[] = [];
  for (let i = 0; i < params.items.length; i++) {
    const it = params.items[i];
    onProgress(`음성 만드는 중 (${i + 1}/${params.items.length}): ${it.name}`);
    const body: Record<string, unknown> = {
      voice_id: it.voiceId,
      text: it.text,
      model: TYPECAST_MODEL,
      language: 'kor',
      prompt:
        it.emotion === 'smart'
          ? { emotion_type: 'smart' }
          : { emotion_type: 'preset', emotion_preset: it.emotion, emotion_intensity: it.intensity },
      output: {
        audio_format: params.format,
        audio_tempo: it.tempo,
        audio_pitch: it.pitch,
        ...(params.removeSilenceMs === null ? {} : { remove_silence_ms: params.removeSilenceMs }),
      },
    };
    try {
      const r = (await call('/v1/text-to-speech/with-timestamps?granularity=word', { method: 'POST', body })) as {
        audio: string;
        audio_format: string;
        audio_duration: number;
        words: Array<{ text: string; start: number; end: number }> | null;
      };
      const ext = r.audio_format === 'wav' ? 'wav' : 'mp3';
      const audioPath = path.join(params.folder, `${it.name}.${ext}`);
      fs.writeFileSync(audioPath, Buffer.from(r.audio, 'base64'));
      const timestampsPath = path.join(params.folder, `${it.name}.timestamps.json`);
      fs.writeFileSync(
        timestampsPath,
        JSON.stringify({ text: it.text, voiceId: it.voiceId, model: TYPECAST_MODEL, duration: r.audio_duration, words: r.words || [] }, null, 1)
      );
      out.push({ name: it.name, ok: true, audioPath, timestampsPath, duration: r.audio_duration, credits: it.text.length });
    } catch (e) {
      out.push({ name: it.name, ok: false, error: (e as Error).message });
      // 키·크레딧 문제는 다음 것도 실패하니 멈춘다
      if (/키|크레딧|거절/.test((e as Error).message)) break;
    }
  }
  return out;
}
