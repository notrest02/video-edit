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
/** 샷 하나(또는 그 안의 부분)를 화면 기준으로 본 정보 — 대본 만들기와 자동 배치가 같이 쓴다 */
export type ShotView = {
  /** 화면의 주인공: 화면에서 가장 크게·눈에 띄게 보이는 것 (예: 인형, 빨래, 제품, 손 동작, 사람 얼굴) */
  subject?: string;
  /** 인물이 카메라를 보며 말하거나 설명하는 장면 */
  talk?: boolean;
  /** 단계: 문제상황 / 준비 / 실제사용 / 완성모습 / 기타 */
  stage?: string;
};
export type ShotDesc = ShotView & {
  id: string;
  desc: string;
  place: string;
  motion: 'high' | 'low';
  parts: Array<ShotView & { from: number; to: number; desc: string }>;
  note: string;
  /** 분위기: 햇빛, 바깥 풍경 보임, 깔끔/어수선 등 */
  mood?: string;
  /** 구도: 가까이 / 중간 / 넓게 */
  framing?: string;
  /** 핵심 순간 (원본 초): 이 샷에서 가장 중요한 순간 (예: 인형이 놓이는 순간) */
  key?: number;
  /** 비슷한 장면 묶음 이름: 같은 장소·같은 동작이라 비슷해 보이는 샷끼리 같은 이름 (영상이 달라도) */
  group?: string;
  /** 첫 화면 모습 (이 샷이 시작될 때 화면이 어떻게 보이는지) */
  firstFrame?: string;
  /** 쓰기 어려운 점: 큰 자막·워터마크 위치/크기, 흔들림, 흐림, 화면 전환 효과 등. 없으면 "" */
  issues?: string;
};
type FileCache = {
  version: 1;
  path: string;
  duration: number;
  shots: Shot[];
  descs: ShotDesc[] | null;
  sheet: string;
  /** 앞뒤 '표지'를 잘라낸 쓸 수 있는 구간 (예: 더우인 영상 첫 0.1초 제목 카드). 없으면 아직 안 봄 */
  edges?: { intro: number; outro: number };
  /** 샷 경계 정밀 보정 버전 (2: 짧은 조각 병합 금지 + 겹침 전환/연속 컷 구간 통째 제외 + 경계 여유 프레임) */
  cutRefinedVersion?: number;
  /** 장면 설명 항목 버전 (2: 주인공·카메라 보고 말함·단계·분위기·구도·핵심 순간·비슷한 장면 묶음·첫 화면·쓰기 어려운 점) */
  descVersion?: number;
};

/** 장면 설명 항목이 바뀌면 올림 → 예전 설명은 다음에 쓸 때 한 번만 다시 설명 (썸네일 시트·샷 나누기는 그대로 재사용) */
export const DESC_VERSION = 2;

const THRESH = 0.15;
const SOFT_PEAK = 0.11;
const SOFT_SUM = 0.16;
const CLUSTER_FLOOR = 0.04;
const CLUSTER_GAP = 0.05;
const CUT_PAD = 0.02;
const CUT_REFINED_VERSION = 2;
const MERGE = 0.4;
const MIN_SHOT = 0.4;

const cacheDir = () => {
  const d = path.join(app.getPath('userData'), 'scene-cache');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

/** 예전 방식(경로+크기+수정시각) — 이름만 다른 복사본(예: "영상 (1).mp4")을 다른 영상으로 봐서 다시 분석했다 */
function legacyKey(p: string): string {
  const st = fs.statSync(p);
  return crypto.createHash('sha1').update(`${path.resolve(p).toLowerCase()}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
}

/** 영상 내용 기준 (크기 + 앞·뒤 1MB) — 이름이나 위치가 달라도 같은 영상이면 같은 분석을 쓴다 (2026-11-04) */
function contentKey(p: string): string {
  const size = fs.statSync(p).size;
  const n = Math.min(size, 1 << 20);
  const fd = fs.openSync(p, 'r');
  try {
    const head = Buffer.alloc(n);
    const tail = Buffer.alloc(n);
    fs.readSync(fd, head, 0, n, 0);
    fs.readSync(fd, tail, 0, n, Math.max(0, size - n));
    return 'c' + crypto.createHash('sha1').update(String(size)).update(head).update(tail).digest('hex').slice(0, 15);
  } finally {
    fs.closeSync(fd);
  }
}

/** 저장 위치. 예전 방식으로 저장된 분석이 있으면 새 이름으로 옮겨 온다 (다시 분석하지 않게) */
function cacheKey(p: string): string {
  const key = contentKey(p);
  const dir = cacheDir();
  const json = path.join(dir, `${key}.json`);
  if (!fs.existsSync(json)) {
    const old = legacyKey(p);
    const oldJson = path.join(dir, `${old}.json`);
    const oldJpg = path.join(dir, `${old}.jpg`);
    try {
      if (fs.existsSync(oldJpg)) fs.copyFileSync(oldJpg, path.join(dir, `${key}.jpg`));
      if (fs.existsSync(oldJson)) {
        const c = JSON.parse(fs.readFileSync(oldJson, 'utf8')) as FileCache;
        c.sheet = path.join(dir, `${key}.jpg`);
        fs.writeFileSync(json, JSON.stringify(c));
      }
    } catch {
      /* 옮기기 실패하면 새로 분석한다 */
    }
  }
  return key;
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
  // 1) 인접 프레임(<=0.05초) 중 변화량이 있는 프레임을 전환 구간(클러스터)으로 묶는다.
  //    단일 프레임 확 바뀌는 컷(max>=0.15)뿐 아니라 2~5프레임에 걸쳐 겹치며 바뀌는 디졸브/점프컷(max>=0.11, 합>=0.16)도 잡는다.
  const raw: Array<{ start: number; end: number; max: number; sum: number }> = [];
  pts.forEach((t, i) => {
    const s = sc[i] ?? 0;
    if (s < CLUSTER_FLOOR) return;
    const last = raw[raw.length - 1];
    if (last && t - last.end <= CLUSTER_GAP) {
      last.end = t;
      last.max = Math.max(last.max, s);
      last.sum += s;
    } else {
      raw.push({ start: t, end: t, max: s, sum: s });
    }
  });
  const cuts = raw.filter((c) => c.max >= THRESH || (c.max >= SOFT_PEAK && c.sum >= SOFT_SUM));
  // 2) 0.4초(MERGE) 안에 전환이 연달아 나오면 그 사이 짧은 조각을 앞/뒤 샷에 붙이지 않고 전환 구간 전체([첫 시작, 끝])를 통째로 뺀다.
  const merged: Array<{ start: number; end: number }> = [];
  for (const c of cuts) {
    const last = merged[merged.length - 1];
    if (last && c.start - last.end < MERGE) {
      last.end = c.end;
    } else {
      merged.push({ start: c.start, end: c.end });
    }
  }
  // 3) 전환 구간 바깥만 깨끗한 샷으로 취하고, 0.4초(MIN_SHOT) 미만 조각(앞/뒤 표지나 중간 번쩍임)은 옆 샷에 절대 합치지 않고 버린다.
  //    반올림으로 전환 프레임이 걸치지 않도록 시작은 올림(+여유), 끝은 내림(-여유) 처리한다.
  const spans: Array<[number, number]> = [];
  for (let i = 0; i <= merged.length; i++) {
    const prevCut = i > 0 ? merged[i - 1] : null;
    const nextCut = i < merged.length ? merged[i] : null;
    const rawA = prevCut ? prevCut.end : 0;
    const rawB = nextCut ? nextCut.start : duration;
    if (rawB - rawA < MIN_SHOT) continue;
    const a = prevCut ? Math.ceil((rawA + CUT_PAD) * 100) / 100 : 0;
    const b = nextCut ? Math.floor((rawB - CUT_PAD) * 100) / 100 : Math.floor(duration * 100) / 100;
    if (b - a >= MIN_SHOT - 0.05) spans.push([a, b]);
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

/** 기존 AI 설명(descs)을 새로 정밀 분할된 샷 목록에 시간 겹침 기준으로 매핑 (AI 재호출 방지) */
function remapDescsToShots(oldShots: Shot[], oldDescs: ShotDesc[] | null, newShots: Shot[]): ShotDesc[] | null {
  if (!oldDescs || !oldDescs.length) return null;
  const byOldId = new Map(oldDescs.map((d) => [d.id, d]));
  return newShots.map((ns) => {
    let bestOld: Shot | null = null;
    let bestOv = -1;
    for (const os of oldShots) {
      const ov = Math.min(ns.end, os.end) - Math.max(ns.start, os.start);
      if (ov > bestOv) {
        bestOv = ov;
        bestOld = os;
      }
    }
    const od = bestOld ? byOldId.get(bestOld.id) : undefined;
    if (!od) return { id: ns.id, desc: '(설명 없음)', place: '', motion: 'low', parts: [], note: '' };
    const parts = (od.parts || []).filter((p) => p.to > ns.start + 0.05 && p.from < ns.end - 0.05);
    const partDesc = parts.length === 1 && oldShots.some((os) => os.id === bestOld?.id && os.dur > ns.dur + 0.5) ? parts[0].desc : od.desc;
    return { ...od, id: ns.id, desc: partDesc, parts };
  });
}

/**
 * 영상 맨 앞·맨 뒤의 아주 짧은 '표지' 찾기. 샷 나누기는 0.4초보다 짧은 조각을 앞 샷에 붙여 버려서
 * 더우인 영상의 첫 0.1초 제목 카드(예: '浴室台面救星')가 첫 샷에 섞였고, 자동 배치가 그 샷을 0.05초부터 쓰면
 * 제목 카드가 1~2프레임 번쩍였다 (2026-11-04). → 첫 1초 안 / 끝 1초 안의 뚜렷한 화면 전환은 표지 경계로 보고 그 바깥만 쓴다.
 * 1프레임(1/30초) 여유를 더 둔다.
 */
const EDGE_WINDOW = 1.0;
const EDGE_THRESH = 0.3;
const EDGE_MARGIN = 0.04;
async function detectEdges(ffmpegPath: string, file: string, duration: number): Promise<{ intro: number; outro: number }> {
  const scan = async (args: string[]) => {
    const log = await run(ffmpegPath, ['-hide_banner', ...args, '-vf', "scale=160:-2,select='gte(scene,0)',metadata=print", '-an', '-f', 'null', '-']);
    const pts = [...log.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
    const sc = [...log.matchAll(/scene_score=([\d.]+)/g)].map((m) => Number(m[1]));
    return pts.map((t, i) => ({ t, s: sc[i] ?? 0 })).filter((x) => x.s >= EDGE_THRESH);
  };
  let intro = 0;
  let outro = duration;
  if (duration > EDGE_WINDOW * 3) {
    // 앞: 첫 1초 안 마지막 뚜렷한 전환 (0.4초보다 앞이면 표지로 봄)
    const head = (await scan(['-t', String(EDGE_WINDOW), '-i', file])).filter((x) => x.t > 0.01 && x.t < MIN_SHOT);
    if (head.length) intro = head[head.length - 1].t + EDGE_MARGIN;
    // 뒤: 끝 1초 안 전환 뒤 남은 길이가 0.4초보다 짧으면 끝 카드로 봄
    const from = Math.max(0, duration - EDGE_WINDOW);
    const tail = (await scan(['-ss', from.toFixed(3), '-i', file])).filter((x) => duration - (from + x.t) < MIN_SHOT && from + x.t < duration - 0.01);
    if (tail.length) outro = from + tail[0].t - EDGE_MARGIN;
  }
  return { intro: +intro.toFixed(3), outro: +outro.toFixed(3) };
}

/** 표지 밖으로 샷 범위 좁히기 (첫 샷 시작·마지막 샷 끝만 바뀜 → 샷 id·AI 설명은 그대로) */
function applyEdges(shots: Shot[], edges: { intro: number; outro: number }): Shot[] {
  const r = (x: number) => Math.round(x * 100) / 100;
  return shots
    .map((s) => {
      const start = Math.max(s.start, edges.intro);
      const end = Math.min(s.end, edges.outro);
      return { ...s, start: r(start), end: r(end), dur: r(end - start) };
    })
    .filter((s) => s.dur > 0.05);
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

const DESC_SYSTEM = `당신은 숏폼(세로 9:16) 제품 광고 편집자다. 원본 촬영 영상의 샷(화면 전환 없이 이어지는 구간)마다 화면 내용을 한국어로 적는다.
썸네일 시트는 원본 영상 하나를 0.5초 간격으로 펼친 것이고, 칸 왼쪽 아래 노란 숫자 = 원본 초다. 샷 목록의 시작~끝 초로 칸을 찾아 실제로 보고 적을 것.
이 정보는 나중에 대본 문장마다 맞는 장면을 고를 때 쓰인다. 설명에 잠깐 스치는 물건을 넣지 말고, 화면에 실제로 크게 보이는 것을 기준으로 적는다.`;

const DESC_TEXT = (product: string, shots: Shot[]) => `제품: ${product || '(미지정)'}
샷 목록 (id, 파일, 시작~끝 초):
${shots.map((s) => `${s.id}\t${s.file}\t${s.start}~${s.end}`).join('\n')}

모든 샷에 대해 적는다:
- desc: 화면에 보이는 것과 **동작** (예: "흡착판 헤드를 벽에 대고 손으로 꾹 눌러 붙임", "걸린 슬리퍼에 샤워기로 물을 뿌려 물이 아래로 떨어짐")
- place: 장소/상황
- motion: high(동작이 뚜렷함) / low(거의 정지, 같은 구도)
- subject: 화면의 주인공 = 화면에서 가장 크게, 가장 오래 보이는 것 하나 (예: "인형", "빨래(옷·양말)", "제품(거치대)", "손 동작", "사람(얼굴)").
  잠깐 스치거나 구석에 작게 보이는 것은 주인공이 아니다. 인형이 거치대 위에 작게 있고 화면 대부분이 빨래면 주인공은 "빨래".
- talk: 인물이 카메라를 보며 말하거나 설명하는 장면이면 true (브이로그식으로 카메라에 대고 이야기하며 걷는 장면 포함). 아니면 false
- stage: 문제상황(불편·지저분함 등 문제가 보임) / 준비(꺼내기·들고 가기·설치 전) / 실제사용(제품을 실제로 쓰는 동작) / 완성모습(설치·사용이 끝나 정돈된 모습) / 기타 중 하나
- mood: 분위기 (예: "햇빛 들어옴, 바깥 풍경 보임", "실내 조명, 깔끔", "어수선") 짧게
- framing: 가까이(손·제품 확대) / 중간 / 넓게(공간 전체) 중 하나
- key: 이 샷에서 가장 중요한 순간의 원본 초 (예: 인형이 거치대에 놓이는 순간, 흡착판을 꾹 누르는 순간). 샷 시작~끝 사이 숫자
- group: 비슷한 장면 묶음 이름. 같은 장소·같은 동작이라 연달아 붙이면 같은 장면처럼 보이는 샷끼리 같은 이름을 쓴다 (영상이 달라도).
  예: "타일벽에 거치대 눌러 붙이기", "발코니 창밖 빨래 걸기". 비슷한 샷이 없으면 그 샷만의 이름
- firstFrame: 샷이 시작될 때 첫 화면 모습 한 줄 (예: "흰 타일벽에 검은 거치대, 손이 왼쪽에서 들어옴")
- issues: 쓰기 어려운 점 (화면에 박힌 큰 자막·워터마크의 위치와 크기, 흔들림, 흐림, 화면 전환 효과·제목 카드). 없으면 ""
- parts: 샷 안에서 동작이 바뀌면 [{from, to, desc, subject, talk, stage}] (원본 초). 부분마다 주인공·말함·단계가 다를 수 있으니 따로 적는다.
  예: 0~4초 카메라 보며 말하며 대야 들고 걸어감(talk true, stage 준비) / 4~7.7초 양말을 거치대에 거는 손(talk false, stage 실제사용). 바뀌지 않으면 []
- note: 그 밖에 참고할 점. 없으면 ""`;

const VIEW_PROPS = {
  subject: { type: 'string' },
  talk: { type: 'boolean' },
  stage: { type: 'string', enum: ['문제상황', '준비', '실제사용', '완성모습', '기타'] },
};

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
          ...VIEW_PROPS,
          mood: { type: 'string' },
          framing: { type: 'string', enum: ['가까이', '중간', '넓게'] },
          key: { type: 'number' },
          group: { type: 'string' },
          firstFrame: { type: 'string' },
          issues: { type: 'string' },
          parts: {
            type: 'array',
            items: {
              type: 'object',
              properties: { from: { type: 'number' }, to: { type: 'number' }, desc: { type: 'string' }, ...VIEW_PROPS },
              required: ['from', 'to', 'desc', 'subject', 'talk', 'stage'],
              additionalProperties: false,
            },
          },
          note: { type: 'string' },
        },
        required: ['id', 'desc', 'place', 'motion', 'subject', 'talk', 'stage', 'mood', 'framing', 'key', 'group', 'firstFrame', 'issues', 'parts', 'note'],
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
  const seen = new Set<string>();
  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    const prefix = String(i + 1);
    const key = cacheKey(m.path);
    // 같은 영상이 이름만 다르게 두 번 있으면 (예: "영상 (1).mp4") 한 번만 쓴다 — 같은 장면이 두 번 나와 중복 배치되지 않게
    if (seen.has(key)) {
      onProgress(`같은 영상이 두 번 있어 하나만 씁니다: ${path.basename(m.path)}`);
      continue;
    }
    seen.add(key);
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
      const edges = await detectEdges(ffmpegPath, m.path, m.duration).catch(() => ({ intro: 0, outro: m.duration }));
      cache = {
        version: 1,
        path: m.path,
        duration: m.duration,
        shots: applyEdges(shots, edges),
        descs: null,
        sheet,
        edges,
        cutRefinedVersion: CUT_REFINED_VERSION,
      };
      fs.writeFileSync(cachePath, JSON.stringify(cache));
    }
    // 예전 캐시도 새 정밀 샷 분할(디졸브/연속컷 제외 + 짧은 조각 병합 금지 + 앞뒤 표지 제거)로 한 번 보정 (ffmpeg 만, AI 재호출 없음)
    if (cache.cutRefinedVersion !== CUT_REFINED_VERSION || !cache.edges) {
      try {
        onProgress(`장면 경계 정밀 보정 중 (${i + 1}/${media.length}): ${path.basename(m.path)}`);
        const edges = cache.edges || (await detectEdges(ffmpegPath, m.path, m.duration).catch(() => ({ intro: 0, outro: m.duration })));
        const refined = applyEdges(await detectShots(ffmpegPath, m.path, m.duration, 'x'), edges);
        if (refined.length > 0) {
          cache.descs = remapDescsToShots(cache.shots, cache.descs, refined);
          cache.shots = refined;
        }
        cache.edges = edges;
        cache.cutRefinedVersion = CUT_REFINED_VERSION;
        fs.writeFileSync(cachePath, JSON.stringify(cache));
      } catch {
        /* 보정 실패 시 기존 캐시 유지 */
      }
    }
    // 이번 미디어 목록 순서로 id 다시 매김 (캐시엔 'x-NN' 형태로 저장)
    const renum = (id: string) => id.replace(/^[^-]+-/, `${prefix}-`);
    cache.shots = cache.shots.map((s) => ({ ...s, id: renum(s.id), path: m.path }));
    if (cache.descs) cache.descs = cache.descs.map((d) => ({ ...d, id: renum(d.id) }));
    entries.push({ cachePath, cache });
  }

  // 설명이 없거나 예전 항목으로 적힌 영상만 다시 설명 (샷 나누기·썸네일은 재사용)
  const todo = entries.filter((e) => !e.cache.descs || (e.cache.descVersion ?? 1) < DESC_VERSION);
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
      e.cache.descVersion = DESC_VERSION;
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
