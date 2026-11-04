/**
 * ElevenLabs API (메인 프로세스 전용) — 키 저장/확인, 목소리 목록, 음성 만들기(단어 시간 정보 포함).
 *  - 인증: xi-api-key 헤더. 키는 화면 쪽으로 보내지 않는다 (safeStorage 암호화 → userData/elevenlabs-key.bin)
 *  - 구독/크레딧: GET /v1/user/subscription → { tier, character_count, character_limit }
 *  - 목소리: GET /v1/voices → voices[{ voice_id, name, category, labels(gender, age, accent, use_case), preview_url }]
 *  - 음성: POST /v1/text-to-speech/{voice_id}/with-timestamps?output_format=mp3_44100_128
 *          → { audio_base64, alignment: { characters[], character_start_times_seconds[], character_end_times_seconds[] } }
 *  - 쉼 줄이기(removeSilenceMs): 만들어진 음성에서 무음 구간을 찾고 긴 무음만 줄인다 (단어 시간 정보도 함께 당김)
 */
import { app, safeStorage } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const BASE = 'https://api.elevenlabs.io';
export const ELEVEN_DEFAULT_MODEL = 'eleven_multilingual_v2';

const keyFile = () => path.join(app.getPath('userData'), 'elevenlabs-key.bin');

export function hasElevenKey(): boolean {
  return fs.existsSync(keyFile());
}

function readKey(): string | null {
  if (!hasElevenKey()) return null;
  const buf = fs.readFileSync(keyFile());
  return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
}

export function saveElevenKey(key: string) {
  const k = key.trim();
  fs.writeFileSync(keyFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(k) : Buffer.from(k, 'utf8'));
}

export function clearElevenKey() {
  if (hasElevenKey()) fs.unlinkSync(keyFile());
}

function explain(status: number, body: string): string {
  let detail = '';
  try {
    const j = JSON.parse(body);
    detail = j?.detail?.message || (typeof j?.detail === 'string' ? j.detail : '') || '';
  } catch {
    detail = body.slice(0, 200);
  }
  const tail = detail ? ` (${detail})` : '';
  switch (status) {
    case 401:
      return `ElevenLabs API 키가 올바르지 않거나 권한이 없습니다.${tail}`;
    case 402:
    case 403:
      return `ElevenLabs 요청이 거절되었습니다 (크레딧 부족 또는 요금제 제한).${tail}`;
    case 404:
      return `목소리나 모델을 찾지 못했습니다.${tail}`;
    case 422:
    case 400:
      return `요청 값이 올바르지 않습니다.${tail}`;
    case 429:
      return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
    default:
      return `ElevenLabs 오류 ${status}${tail}`;
  }
}

async function call(pathAndQuery: string, init: { method?: string; body?: unknown; key?: string } = {}): Promise<unknown> {
  const key = (init.key ?? readKey() ?? '').trim();
  if (!key) throw new Error('ElevenLabs API 키가 없습니다. 위쪽 ElevenLabs API 키 칸에서 먼저 연결해 주세요.');
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    method: init.method || 'GET',
    headers: {
      'xi-api-key': key,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(explain(res.status, text));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('ElevenLabs 응답을 읽지 못했습니다.');
  }
}

export type ElevenSubscription = { plan: string; planCredits: number; usedCredits: number; remaining: number };

export async function getElevenSubscription(key?: string): Promise<ElevenSubscription> {
  try {
    const r = (await call('/v1/user/subscription', { key })) as {
      tier?: string;
      character_count?: number;
      character_limit?: number;
    };
    const planCredits = r.character_limit ?? 0;
    const usedCredits = r.character_count ?? 0;
    return {
      plan: r.tier || 'basic',
      planCredits,
      usedCredits,
      remaining: Math.max(0, planCredits - usedCredits),
    };
  } catch (e) {
    // 범위 제한 키(Text to Speech 만 허용, user_read 없음)는 /v1/voices 로 연결 확인
    if (key) {
      await call('/v1/voices', { key });
      return { plan: '연결됨', planCredits: 0, usedCredits: 0, remaining: 0 };
    }
    throw e;
  }
}

export async function testAndSaveElevenKey(key: string): Promise<{ ok: boolean; message: string; sub?: ElevenSubscription }> {
  try {
    const sub = await getElevenSubscription(key.trim());
    saveElevenKey(key);
    const creditTxt = sub.planCredits > 0 ? `, 남은 ${sub.remaining.toLocaleString()}자` : '';
    return { ok: true, message: `연결 확인됨 (${sub.plan}${creditTxt})`, sub };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export type ElevenVoice = {
  id: string;
  name: string;
  category: string; // premade, cloned, generated, professional, shared_ko
  gender: string | null;
  age: string | null;
  useCase: string | null;
  accent: string | null;
  previewUrl: string | null;
  isKorean: boolean;
  requiresPaid?: boolean;
};

export async function listElevenVoices(filter: { gender?: string; age?: string; koreanOnly?: boolean } = {}): Promise<ElevenVoice[]> {
  const sub = await getElevenSubscription().catch(() => ({ plan: 'free', planCredits: 0, usedCredits: 0, remaining: 0 }));
  const isFree = sub.plan.toLowerCase() === 'free';

  // 1) 내 보관함 + 기본(Premade) 목소리
  const r = (await call('/v1/voices')) as {
    voices?: Array<{
      voice_id: string;
      name: string;
      category?: string;
      labels?: Record<string, string>;
      preview_url?: string | null;
      verified_languages?: Array<{ language?: string; locale?: string; preview_url?: string }>;
    }>;
  };
  const myVoices: ElevenVoice[] = (r.voices || []).map((v) => {
    const lb = v.labels || {};
    const koVer = (v.verified_languages || []).find((l) => l.language === 'ko' || l.locale?.startsWith('ko'));
    const isKo =
      Boolean(koVer) ||
      lb.language === 'ko' ||
      /korean|한국/i.test(`${v.name} ${lb.accent || ''} ${lb.description || ''}`);
    return {
      id: v.voice_id,
      name: v.name || v.voice_id,
      category: v.category || 'premade',
      gender: lb.gender || null,
      age: lb.age || null,
      useCase: lb.use_case || lb['use case'] || lb.description || null,
      accent: lb.accent || null,
      previewUrl: koVer?.preview_url || v.preview_url || null,
      isKorean: isKo,
      requiresPaid: isFree && v.category === 'professional',
    };
  });

  // 2) ElevenLabs Voice Library 의 한국어(language=ko) 성우 목록도 함께 가져옴
  let sharedKo: ElevenVoice[] = [];
  try {
    const q = new URLSearchParams({ language: 'ko', page_size: '30' });
    if (filter.gender) q.set('gender', filter.gender);
    if (filter.age) q.set('age', filter.age);
    const sr = (await call(`/v1/shared-voices?${q}`)) as {
      voices?: Array<{
        voice_id: string;
        name: string;
        category?: string;
        gender?: string | null;
        age?: string | null;
        use_case?: string | null;
        accent?: string | null;
        preview_url?: string | null;
      }>;
    };
    const existingIds = new Set(myVoices.map((v) => v.id));
    sharedKo = (sr.voices || [])
      .filter((v) => !existingIds.has(v.voice_id))
      .map((v) => ({
        id: v.voice_id,
        name: v.name || v.voice_id,
        category: 'shared_ko',
        gender: v.gender || null,
        age: v.age || null,
        useCase: v.use_case || null,
        accent: v.accent || 'ko',
        previewUrl: v.preview_url ?? null,
        isKorean: true,
        requiresPaid: isFree, // ElevenLabs 정책상 무료 요금제는 API 에서 라이브러리 성우 생성을 막음(402)
      }));
  } catch {
    sharedKo = [];
  }

  const combined = [...myVoices, ...sharedKo].filter((v) => {
    if (filter.gender && v.gender && v.gender.toLowerCase() !== filter.gender.toLowerCase()) return false;
    if (filter.age && v.age && v.age.toLowerCase() !== filter.age.toLowerCase()) return false;
    if (filter.koreanOnly && !v.isKorean) return false;
    return true;
  });

  // 무료 요금제면 바로 쓸 수 있는 목소리(requiresPaid=false) 중 한국어 → 기본 목소리 → 유료 전용 한국어 성우 순으로 정렬
  return combined.sort((a, b) => {
    if (Boolean(a.requiresPaid) !== Boolean(b.requiresPaid)) return Number(Boolean(a.requiresPaid)) - Number(Boolean(b.requiresPaid));
    return Number(b.isKorean) - Number(a.isKorean);
  });
}

/** 글자 단위 정렬(alignment) → 단어 배열 [{ text, start, end }] 변환 */
function charsToWords(align?: {
  characters?: string[];
  character_start_times_seconds?: number[];
  character_end_times_seconds?: number[];
}): { words: Array<{ text: string; start: number; end: number }>; duration: number } {
  const chars = align?.characters || [];
  const starts = align?.character_start_times_seconds || [];
  const ends = align?.character_end_times_seconds || [];
  const words: Array<{ text: string; start: number; end: number }> = [];
  let cur = '';
  let wStart = 0;
  let wEnd = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const st = starts[i] ?? wEnd;
    const ed = ends[i] ?? st;
    if (/\s/.test(ch)) {
      if (cur) {
        words.push({ text: cur, start: Number(wStart.toFixed(3)), end: Number(wEnd.toFixed(3)) });
        cur = '';
      }
    } else {
      if (!cur) wStart = st;
      cur += ch;
      wEnd = ed;
    }
  }
  if (cur) {
    words.push({ text: cur, start: Number(wStart.toFixed(3)), end: Number(wEnd.toFixed(3)) });
  }
  const duration = ends.length ? ends[ends.length - 1] : 0;
  return { words, duration };
}

/**
 * 쉼 줄이기(선택): ffmpeg silencedetect 로 무음 구간을 찾아 maxSilenceSec 보다 긴 무음을 maxSilenceSec 로 줄이고,
 * 단어 시간표(words)도 똑같이 앞당긴다.
 */
async function tightenSilences(
  ffmpegPath: string,
  audioPath: string,
  maxSilenceMs: number,
  words: Array<{ text: string; start: number; end: number }>,
  totalDuration: number
): Promise<{ words: Array<{ text: string; start: number; end: number }>; duration: number }> {
  const maxSec = Math.max(0.05, maxSilenceMs / 1000);
  // 1) 무음 구간 찾기
  const detectMin = Math.max(0.08, maxSec + 0.02);
  const log = await new Promise<string>((resolve) => {
    const proc = spawn(
      ffmpegPath,
      ['-hide_banner', '-nostats', '-i', audioPath, '-af', `silencedetect=noise=-38dB:d=${detectMin.toFixed(3)}`, '-f', 'null', '-'],
      { windowsHide: true }
    );
    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', () => resolve(''));
    proc.on('close', () => resolve(err));
  });
  const silences: Array<{ start: number; end: number }> = [];
  let curStart: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const m1 = line.match(/silence_start:\s*([0-9.]+)/);
    if (m1) curStart = parseFloat(m1[1]);
    const m2 = line.match(/silence_end:\s*([0-9.]+)/);
    if (m2 && curStart !== null) {
      const end = parseFloat(m2[1]);
      if (end - curStart > maxSec + 0.01) silences.push({ start: curStart, end });
      curStart = null;
    }
  }
  if (!silences.length) return { words, duration: totalDuration };

  // 2) 유지할 구간(keep) 계산: 각 긴 무음의 앞쪽 maxSec/2 와 뒤쪽 maxSec/2 만 남기고 가운데를 잘라냄
  const keep: Array<{ start: number; end: number }> = [];
  const cuts: Array<{ cutStart: number; cutEnd: number; removed: number }> = [];
  let cursor = 0;
  const half = maxSec / 2;
  for (const s of silences) {
    const cutStart = s.start + half;
    const cutEnd = s.end - half;
    if (cutEnd <= cutStart + 0.01) continue;
    if (cutStart > cursor) keep.push({ start: cursor, end: cutStart });
    cuts.push({ cutStart, cutEnd, removed: cutEnd - cutStart });
    cursor = cutEnd;
  }
  if (!cuts.length) return { words, duration: totalDuration };
  const endLimit = Math.max(totalDuration, cursor + 0.05);
  if (cursor < endLimit) keep.push({ start: cursor, end: endLimit + 10 });

  const filterParts = keep.map((k, idx) => `[0:a]atrim=start=${k.start.toFixed(4)}:end=${k.end.toFixed(4)},asetpts=PTS-STARTPTS[a${idx}]`);
  const concatIn = keep.map((_, idx) => `[a${idx}]`).join('');
  const filter = `${filterParts.join(';')};${concatIn}concat=n=${keep.length}:v=0:a=1[outa]`;
  const tmpPath = `${audioPath}.tmp${path.extname(audioPath)}`;

  const ok = await new Promise<boolean>((resolve) => {
    const codecArgs = audioPath.endsWith('.wav') ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'libmp3lame', '-b:a', '128k'];
    const proc = spawn(ffmpegPath, ['-v', 'error', '-y', '-i', audioPath, '-filter_complex', filter, '-map', '[outa]', ...codecArgs, tmpPath], {
      windowsHide: true,
    });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
  if (!ok || !fs.existsSync(tmpPath)) {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    return { words, duration: totalDuration };
  }
  fs.renameSync(tmpPath, audioPath);

  const shiftTime = (t: number) => {
    let shift = 0;
    for (const c of cuts) {
      if (t >= c.cutEnd) shift += c.removed;
      else if (t > c.cutStart) shift += t - c.cutStart;
    }
    return Math.max(0, Number((t - shift).toFixed(3)));
  };
  const newWords = words.map((w) => ({
    text: w.text,
    start: shiftTime(w.start),
    end: Math.max(shiftTime(w.start) + 0.02, shiftTime(w.end)),
  }));
  const totalRemoved = cuts.reduce((n, c) => n + c.removed, 0);
  return { words: newWords, duration: Math.max(0.1, Number((totalDuration - totalRemoved).toFixed(3))) };
}

export type ElevenSynthItem = {
  name: string;
  text: string;
  voiceId: string;
  modelId: string;
  stability: number;
  similarityBoost: number;
  style: number;
  speed: number;
  pitch: number;
};

export type ElevenSynthResult = {
  name: string;
  ok: boolean;
  error?: string;
  audioPath?: string;
  timestampsPath?: string;
  duration?: number;
  credits?: number;
};

/**
 * 버전마다 ElevenLabs 음성 만들기 (차례대로 하나씩)
 */
export async function synthesizeEleven(
  ffmpegPath: string,
  params: { folder: string; items: ElevenSynthItem[]; removeSilenceMs: number | null; format: 'mp3' | 'wav' },
  onProgress: (msg: string) => void
): Promise<ElevenSynthResult[]> {
  fs.mkdirSync(params.folder, { recursive: true });
  const out: ElevenSynthResult[] = [];
  const outFmt = params.format === 'wav' ? 'pcm_44100' : 'mp3_44100_128';

  for (let i = 0; i < params.items.length; i++) {
    const it = params.items[i];
    onProgress(`ElevenLabs 음성 만드는 중 (${i + 1}/${params.items.length}): ${it.name}`);
    const body = {
      text: it.text,
      model_id: it.modelId || ELEVEN_DEFAULT_MODEL,
      language_code: 'ko',
      voice_settings: {
        stability: it.stability,
        similarity_boost: it.similarityBoost,
        style: it.style,
        use_speaker_boost: true,
        speed: Math.max(0.7, Math.min(1.2, it.speed)),
      },
    };
    try {
      const r = (await call(`/v1/text-to-speech/${encodeURIComponent(it.voiceId)}/with-timestamps?output_format=${outFmt}`, {
        method: 'POST',
        body,
      })) as {
        audio_base64: string;
        alignment?: {
          characters?: string[];
          character_start_times_seconds?: number[];
          character_end_times_seconds?: number[];
        };
        normalized_alignment?: {
          characters?: string[];
          character_start_times_seconds?: number[];
          character_end_times_seconds?: number[];
        };
      };
      const ext = params.format === 'wav' ? 'wav' : 'mp3';
      const audioPath = path.join(params.folder, `${it.name}.${ext}`);
      const rawBuf = Buffer.from(r.audio_base64, 'base64');
      fs.writeFileSync(audioPath, rawBuf);

      // 음높이(pitch) 조절 또는 속도가 1.2 초과일 때 ffmpeg 후처리
      const extraTempo = it.speed > 1.2 ? it.speed / 1.2 : it.speed < 0.7 ? it.speed / 0.7 : 1;
      if (it.pitch !== 0 || Math.abs(extraTempo - 1) > 0.01) {
        const ratio = Math.pow(2, Math.max(-12, Math.min(12, it.pitch)) / 12);
        const filter =
          it.pitch === 0
            ? `atempo=${extraTempo.toFixed(4)}`
            : `aresample=44100,asetrate=${Math.round(44100 * ratio)},aresample=44100,atempo=${(extraTempo / ratio).toFixed(4)}`;
        const tmp = `${audioPath}.pitch.${ext}`;
        await new Promise<void>((resolve, reject) => {
          const codec = ext === 'wav' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'libmp3lame', '-b:a', '128k'];
          const proc = spawn(ffmpegPath, ['-v', 'error', '-y', '-i', audioPath, '-af', filter, ...codec, tmp], { windowsHide: true });
          proc.on('error', reject);
          proc.on('close', (c) => (c === 0 ? resolve() : reject(new Error('음높이 변환 실패'))));
        });
        if (fs.existsSync(tmp)) fs.renameSync(tmp, audioPath);
      }

      let { words, duration } = charsToWords(r.alignment || r.normalized_alignment);
      if (Math.abs(extraTempo - 1) > 0.01 && words.length) {
        words = words.map((w) => ({
          text: w.text,
          start: Number((w.start / extraTempo).toFixed(3)),
          end: Number((w.end / extraTempo).toFixed(3)),
        }));
        duration = Number((duration / extraTempo).toFixed(3));
      }

      if (params.removeSilenceMs !== null && params.removeSilenceMs >= 0) {
        const tightened = await tightenSilences(ffmpegPath, audioPath, params.removeSilenceMs, words, duration);
        words = tightened.words;
        duration = tightened.duration;
      }

      const timestampsPath = path.join(params.folder, `${it.name}.timestamps.json`);
      fs.writeFileSync(
        timestampsPath,
        JSON.stringify({ text: it.text, voiceId: it.voiceId, model: it.modelId || ELEVEN_DEFAULT_MODEL, duration, words }, null, 1)
      );
      out.push({ name: it.name, ok: true, audioPath, timestampsPath, duration, credits: it.text.length });
    } catch (e) {
      out.push({ name: it.name, ok: false, error: (e as Error).message });
      if (/키|크레딧|거절|권한/.test((e as Error).message)) break;
    }
  }
  return out;
}
