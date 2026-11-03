/**
 * 자동 배치용 원본 영상 분석 (메인 프로세스) — tools/premiere/shots.py 와 같은 규칙
 *  1) 샷 나누기: ffmpeg 장면 점수 0.15 이상 = 화면 전환 (0.3 은 실제 전환을 놓침), 0.4초 안 전환은 하나로
 *  2) 0.5초 간격 썸네일 시트 (각 칸에 원본 초 표시)
 *  3) Claude(Haiku)로 샷마다 동작/장소/움직임 설명
 * 결과는 파일(경로+크기+수정시각)별로 userData/scene-cache 에 저장 → 같은 영상은 다시 분석하지 않음
 */
import { app } from 'electron';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { claudeJson, type UsageTotal } from './claudeService';

export type Shot = { id: string; file: string; path: string; start: number; end: number; dur: number };
export type ShotDesc = {
  id: string;
  desc: string;
  place: string;
  motion: 'high' | 'low';
  parts: Array<{ from: number; to: number; desc: string }>;
  note: string;
};
type FileCache = { version: 1; path: string; duration: number; shots: Shot[]; descs: ShotDesc[] | null; sheet: string };

const THRESH = 0.15;
const MERGE = 0.4;
const MIN_SHOT = 0.4;

const cacheDir = () => {
  const d = path.join(app.getPath('userData'), 'scene-cache');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

function cacheKey(p: string): string {
  const st = fs.statSync(p);
  return crypto.createHash('sha1').update(`${path.resolve(p).toLowerCase()}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
}

function run(ffmpegPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg 실패(${code}): ${err.slice(-400)}`))));
  });
}

async function detectShots(ffmpegPath: string, file: string, duration: number, prefix: string): Promise<Shot[]> {
  const log = await run(ffmpegPath, ['-hide_banner', '-i', file, '-vf', "scale=160:-2,select='gte(scene,0)',metadata=print", '-an', '-f', 'null', '-']);
  const pts = [...log.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
  const sc = [...log.matchAll(/scene_score=([\d.]+)/g)].map((m) => Number(m[1]));
  const cuts: Array<[number, number]> = [];
  pts.forEach((t, i) => {
    const s = sc[i] ?? 0;
    if (s < THRESH || t < MIN_SHOT || t > duration - MIN_SHOT) return;
    const last = cuts[cuts.length - 1];
    if (last && t - last[0] < MERGE) {
      if (s > last[1]) cuts[cuts.length - 1] = [t, s];
      return;
    }
    cuts.push([t, s]);
  });
  const bounds = [0, ...cuts.map((c) => c[0]), duration];
  const spans: Array<[number, number]> = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const [a, b] = [bounds[i], bounds[i + 1]];
    if (spans.length && b - a < MIN_SHOT) spans[spans.length - 1][1] = b;
    else spans.push([a, b]);
  }
  const r = (x: number) => Math.round(x * 100) / 100;
  return spans.map(([a, b], k) => ({
    id: `${prefix}-${String(k + 1).padStart(2, '0')}`,
    file: path.basename(file),
    path: file,
    start: r(a),
    end: r(b),
    dur: r(b - a),
  }));
}

async function makeSheet(ffmpegPath: string, file: string, duration: number, out: string) {
  const n = Math.max(1, Math.ceil(duration * 2));
  const rows = Math.ceil(n / 10);
  const font = 'C\\:/Windows/Fonts/malgun.ttf';
  const label = "%{eif\\:t\\:d}.%{eif\\:mod(t*10\\,10)\\:d}";
  const vf =
    'fps=2,scale=108:192:force_original_aspect_ratio=decrease,pad=108:192:(ow-iw)/2:(oh-ih)/2,' +
    `drawtext=fontfile='${font}':text='${label}':x=3:y=170:fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.6,` +
    `tile=10x${rows}`;
  await run(ffmpegPath, ['-v', 'error', '-y', '-i', file, '-vf', vf, '-frames:v', '1', '-q:v', '4', out]);
}

/**
 * 썸네일 시트(0.5초 간격, 칸마다 원본 초 표시) 경로. 자동 배치 분석과 같은 캐시를 쓰고, 없으면 새로 만든다.
 * 대본 만들기(STEP 0)가 영상 장면을 AI에게 보여줄 때 쓴다.
 */
export async function ensureSheet(ffmpegPath: string, file: string, duration: number): Promise<string> {
  const key = cacheKey(file);
  const cachePath = path.join(cacheDir(), `${key}.json`);
  if (fs.existsSync(cachePath)) {
    try {
      const c = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as FileCache;
      if (c.sheet && fs.existsSync(c.sheet)) return c.sheet;
    } catch {
      /* 캐시가 깨졌으면 새로 만든다 */
    }
  }
  const sheet = path.join(cacheDir(), `${key}.jpg`);
  if (!fs.existsSync(sheet)) await makeSheet(ffmpegPath, file, duration, sheet);
  return sheet;
}

const DESC_SYSTEM =`당신은 숏폼(세로 9:16) 제품 광고 편집자다. 원본 촬영 영상의 샷(화면 전환 없이 이어지는 구간)마다 화면 내용을 한국어로 적는다.
썸네일 시트는 원본 영상 하나를 0.5초 간격으로 펼친 것이고, 칸 왼쪽 아래 노란 숫자 = 원본 초다. 샷 목록의 시작~끝 초로 칸을 찾아 실제로 보고 적을 것.`;

const DESC_TEXT = (product: string, shots: Shot[]) => `제품: ${product || '(미지정)'}
샷 목록 (id, 파일, 시작~끝 초):
${shots.map((s) => `${s.id}\t${s.file}\t${s.start}~${s.end}`).join('\n')}

모든 샷에 대해 적는다:
- desc: 화면에 보이는 것과 **동작** (예: "흡착판 헤드를 벽에 대고 손으로 꾹 눌러 붙임", "걸린 슬리퍼에 샤워기로 물을 뿌려 물이 아래로 떨어짐")
- place: 장소/상황
- motion: high(동작이 뚜렷함) / low(거의 정지, 같은 구도)
- parts: 샷 안에서 동작이 바뀌면 [{from, to, desc}] (원본 초). 없으면 []
- note: 화면에 박힌 자막/글자, 흔들림 등 참고할 점. 없으면 ""`;

const DESC_SCHEMA = {
  type: 'object',
  properties: {
    shots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          desc: { type: 'string' },
          place: { type: 'string' },
          motion: { type: 'string', enum: ['high', 'low'] },
          parts: {
            type: 'array',
            items: {
              type: 'object',
              properties: { from: { type: 'number' }, to: { type: 'number' }, desc: { type: 'string' } },
              required: ['from', 'to', 'desc'],
              additionalProperties: false,
            },
          },
          note: { type: 'string' },
        },
        required: ['id', 'desc', 'place', 'motion', 'parts', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['shots'],
  additionalProperties: false,
};

/**
 * 미디어 영상들 분석. 이미 분석한 파일은 캐시 사용, 새 파일만 샷 나누기 + 한 번의 Claude 호출로 설명.
 * 샷 id 는 파일 순서 번호 기준 (예: 3번째 파일 → "3-07") — 같은 미디어 목록이면 항상 같음
 */
export async function analyzeMedia(
  ffmpegPath: string,
  media: Array<{ path: string; duration: number }>,
  product: string,
  onProgress: (msg: string) => void
): Promise<{ shots: Shot[]; descs: ShotDesc[]; usage: UsageTotal; analyzedFiles: number }> {
  const usage: UsageTotal = { input: 0, output: 0 };
  const entries: Array<{ cachePath: string; cache: FileCache }> = [];
  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    const prefix = String(i + 1);
    const key = cacheKey(m.path);
    const cachePath = path.join(cacheDir(), `${key}.json`);
    let cache: FileCache | null = null;
    if (fs.existsSync(cachePath)) {
      try {
        cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      } catch {
        cache = null;
      }
    }
    if (!cache || !fs.existsSync(cache.sheet)) {
      onProgress(`장면 나누는 중 (${i + 1}/${media.length}): ${path.basename(m.path)}`);
      const shots = await detectShots(ffmpegPath, m.path, m.duration, 'x');
      const sheet = path.join(cacheDir(), `${key}.jpg`);
      await makeSheet(ffmpegPath, m.path, m.duration, sheet);
      cache = { version: 1, path: m.path, duration: m.duration, shots, descs: null, sheet };
      fs.writeFileSync(cachePath, JSON.stringify(cache));
    }
    // 이번 미디어 목록 순서로 id 다시 매김 (캐시엔 'x-NN' 형태로 저장)
    const renum = (id: string) => id.replace(/^[^-]+-/, `${prefix}-`);
    cache.shots = cache.shots.map((s) => ({ ...s, id: renum(s.id), path: m.path }));
    if (cache.descs) cache.descs = cache.descs.map((d) => ({ ...d, id: renum(d.id) }));
    entries.push({ cachePath, cache });
  }

  const todo = entries.filter((e) => !e.cache.descs);
  if (todo.length > 0) {
    onProgress(`AI가 장면 ${todo.reduce((n, e) => n + e.cache.shots.length, 0)}개를 보는 중 (영상 ${todo.length}개)...`);
    const shots = todo.flatMap((e) => e.cache.shots);
    const res = await claudeJson<{ shots: ShotDesc[] }>({
      system: DESC_SYSTEM,
      text: DESC_TEXT(product, shots),
      images: todo.map((e) => ({ label: `썸네일 시트: ${e.cache.shots[0]?.id.split('-')[0]}번 파일 ${path.basename(e.cache.path)}`, path: e.cache.sheet })),
      schema: DESC_SCHEMA,
    });
    usage.input += res.usage.input;
    usage.output += res.usage.output;
    const byId = new Map(res.data.shots.map((d) => [d.id, d]));
    for (const e of todo) {
      e.cache.descs = e.cache.shots.map(
        (s) => byId.get(s.id) || { id: s.id, desc: '(설명 없음)', place: '', motion: 'low', parts: [], note: '' }
      );
      const stored = { ...e.cache, shots: e.cache.shots.map((s) => ({ ...s, id: s.id.replace(/^[^-]+-/, 'x-') })), descs: e.cache.descs.map((d) => ({ ...d, id: d.id.replace(/^[^-]+-/, 'x-') })) };
      fs.writeFileSync(e.cachePath, JSON.stringify(stored));
    }
  }
  return {
    shots: entries.flatMap((e) => e.cache.shots),
    descs: entries.flatMap((e) => e.cache.descs || []),
    usage,
    analyzedFiles: todo.length,
  };
}
