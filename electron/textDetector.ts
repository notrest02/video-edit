/**
 * 자동 마스크: 원본 영상에 박힌 글자(중국어 자막·워터마크) 찾기 — PaddleOCR PP-OCRv4 모바일 (ONNX, 약 15.6MB)
 *  1) 모델이 없으면 userData/models/ppocr 에 한 번 받음
 *  2) 원본을 0.2초 간격으로: 글자 찾기(det) → 가까운 상자 합치기(세로쓰기 조각) → 글자 읽기(rec)
 *  3) 프레임 사이 같은 위치·비슷한 글자를 이어 '글자 덩어리'(시작~끝, 위치 변화)로
 *  4) 원본 파일(경로+크기+수정시각)별로 저장 → 같은 원본은 다시 분석하지 않음
 * 좌표는 원본 화면 기준 0~1
 */
import { app } from 'electron';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type TextBox = [number, number, number, number]; // x0,y0,x1,y1 (0~1)
export type TextTrack = {
  id: string;
  text: string;
  conf: number;
  hasHan: boolean;
  start: number; // 원본 초
  end: number;
  samples: Array<{ t: number; box: TextBox }>;
};

const STEP = 0.2;
const MODEL_BASE = 'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4';
const FILES: Record<string, string> = {
  'det.onnx': `${MODEL_BASE}/ch_PP-OCRv4_det_infer.onnx`,
  'rec.onnx': `${MODEL_BASE}/ch_PP-OCRv4_rec_infer.onnx`,
  'ppocr_keys_v1.txt': 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/release/2.7/ppocr/utils/ppocr_keys_v1.txt',
};

const modelDir = () => path.join(app.getPath('userData'), 'models', 'ppocr');
const cacheDir = () => {
  const d = path.join(app.getPath('userData'), 'text-cache');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

async function ensureModels(onProgress: (m: string) => void) {
  fs.mkdirSync(modelDir(), { recursive: true });
  for (const [name, url] of Object.entries(FILES)) {
    const dst = path.join(modelDir(), name);
    if (fs.existsSync(dst) && fs.statSync(dst).size > 1000) continue;
    onProgress(`글자 찾기 모델 받는 중: ${name}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`모델을 받지 못했습니다 (${res.status}): ${name}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dst + '.part', buf);
    fs.renameSync(dst + '.part', dst);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ort = any;
let sessions: { ort: Ort; det: Ort; rec: Ort; chars: string[] } | null = null;
async function load() {
  if (sessions) return sessions;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ort = require('onnxruntime-node');
  const det = await ort.InferenceSession.create(path.join(modelDir(), 'det.onnx'));
  const rec = await ort.InferenceSession.create(path.join(modelDir(), 'rec.onnx'));
  const keys = fs.readFileSync(path.join(modelDir(), 'ppocr_keys_v1.txt'), 'utf8').split(/\r?\n/);
  if (keys[keys.length - 1] === '') keys.pop();
  sessions = { ort, det, rec, chars: ['', ...keys, ' '] };
  return sessions;
}

const HAN = /[㐀-鿿]/;

type DetBox = [number, number, number, number];
/** 확률 지도 → 글자 상자 (det 좌표 px). parts = 합치기 전 조각들 (합친 상자가 엉터리로 읽히면 조각별로 다시 읽음) */
function boxesFromProb(prob: Float32Array, W: number, H: number): Array<{ box: DetBox; parts: DetBox[] }> {
  const seen = new Uint8Array(W * H);
  const out: Array<{ box: DetBox; parts: DetBox[] }> = [];
  const stack: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (seen[i] || prob[i] < 0.3) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, n = 0, s = 0;
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W, y = (p / W) | 0;
      n++;
      s += prob[p];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && !seen[p - 1] && prob[p - 1] >= 0.3) (seen[p - 1] = 1), stack.push(p - 1);
      if (x < W - 1 && !seen[p + 1] && prob[p + 1] >= 0.3) (seen[p + 1] = 1), stack.push(p + 1);
      if (y > 0 && !seen[p - W] && prob[p - W] >= 0.3) (seen[p - W] = 1), stack.push(p - W);
      if (y < H - 1 && !seen[p + W] && prob[p + W] >= 0.3) (seen[p + W] = 1), stack.push(p + W);
    }
    if (n < 12 || s / n < 0.6) continue;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const pad = (bw * bh * 1.5) / (2 * (bw + bh)); // PaddleOCR unclip 과 비슷하게 조금 넓힘
    const box: DetBox = [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(W, x1 + pad), Math.min(H, y1 + pad)];
    out.push({ box, parts: [box] });
  }
  // 가까운 상자 합치기 (세로쓰기가 글자마다 따로 잡히는 경우 등)
  let merged = true;
  while (merged) {
    merged = false;
    for (let a = 0; a < out.length && !merged; a++)
      for (let b = a + 1; b < out.length && !merged; b++) {
        const [A, B] = [out[a].box, out[b].box];
        const g = 0.5 * Math.min(A[3] - A[1], A[2] - A[0], B[3] - B[1], B[2] - B[0]);
        const touch = A[0] - g <= B[2] && B[0] - g <= A[2] && A[1] - g <= B[3] && B[1] - g <= A[3];
        const sameLine =
          Math.abs((A[1] + A[3]) / 2 - (B[1] + B[3]) / 2) < 0.6 * Math.max(A[3] - A[1], B[3] - B[1]) ||
          Math.abs((A[0] + A[2]) / 2 - (B[0] + B[2]) / 2) < 0.6 * Math.max(A[2] - A[0], B[2] - B[0]);
        if (touch && sameLine) {
          out[a] = { box: [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[2], B[2]), Math.max(A[3], B[3])], parts: [...out[a].parts, ...out[b].parts] };
          out.splice(b, 1);
          merged = true;
        }
      }
  }
  return out;
}

function recognize(buf: Buffer, W: number, H: number, b: [number, number, number, number], s: NonNullable<typeof sessions>) {
  const [x0, y0, x1, y1] = b;
  const bw = x1 - x0, bh = y1 - y0;
  const vertical = bh > bw * 1.5; // 세로쓰기는 돌려서 읽음
  const RH = 48;
  const srcW = vertical ? bh : bw, srcH = vertical ? bw : bh;
  const RW = Math.max(16, Math.min(640, Math.round((RH * srcW) / Math.max(1, srcH))));
  const d = new Float32Array(3 * RH * RW);
  for (let y = 0; y < RH; y++)
    for (let x = 0; x < RW; x++) {
      const u = x / RW, v = y / RH;
      const sx = vertical ? x0 + (1 - v) * bw : x0 + u * bw;
      const sy = vertical ? y0 + u * bh : y0 + v * bh;
      const p = (Math.min(H - 1, sy | 0) * W + Math.min(W - 1, sx | 0)) * 3;
      for (let c = 0; c < 3; c++) d[c * RH * RW + y * RW + x] = (buf[p + c] / 255 - 0.5) / 0.5;
    }
  return new s.ort.Tensor('float32', d, [1, 3, RH, RW]);
}

function ctcDecode(out: { dims: number[]; data: Float32Array }, chars: string[]): [string, number] {
  const [, T, C] = out.dims;
  let str = '', prev = -1, conf = 0, n = 0;
  for (let t = 0; t < T; t++) {
    let bi = 0, bv = -1;
    for (let c = 0; c < C; c++) {
      const v = out.data[t * C + c];
      if (v > bv) [bv, bi] = [v, c];
    }
    if (bi !== 0 && bi !== prev) {
      str += chars[bi] ?? '';
      conf += bv;
      n++;
    }
    prev = bi;
  }
  return [str.trim(), n ? conf / n : 0];
}

const iou = (a: TextBox, b: TextBox) => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return u > 0 ? inter / u : 0;
};
const textSim = (a: string, b: string) => {
  if (!a || !b) return 0;
  const sa = new Set(a);
  let hit = 0;
  for (const ch of b) if (sa.has(ch)) hit++;
  return hit / Math.max(a.length, b.length);
};

// 분석 취소 (시퀀스 전체 자동 마스크 중 [취소])
let currentProc: ReturnType<typeof spawn> | null = null;
let cancelled = false;
export function cancelTextAnalyze() {
  cancelled = true;
  try {
    currentProc?.kill();
  } catch {
    /* 이미 끝남 */
  }
}

export async function analyzeText(
  ffmpegPath: string,
  file: string,
  srcW: number,
  srcH: number,
  onProgress: (m: string) => void
): Promise<{ tracks: TextTrack[]; cached: boolean }> {
  const st = fs.statSync(file);
  const key = crypto.createHash('sha1').update(`v4|${path.resolve(file).toLowerCase()}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
  const cachePath = path.join(cacheDir(), `${key}.json`);
  if (fs.existsSync(cachePath)) return { tracks: JSON.parse(fs.readFileSync(cachePath, 'utf8')), cached: true };

  cancelled = false;
  await ensureModels(onProgress);
  const s = await load();
  // 분석 크기: 긴 쪽 960, 32의 배수
  const r = 960 / Math.max(srcW, srcH);
  const W = Math.max(32, Math.round((srcW * r) / 32) * 32);
  const H = Math.max(32, Math.round((srcH * r) / 32) * 32);
  const frameBytes = W * H * 3;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];

  type Open = TextTrack & { last: number; texts: Map<string, number> };
  const open: Open[] = [];
  const done: TextTrack[] = [];
  let seq = 0;
  const close = (o: Open) => {
    const best = [...o.texts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? o.text;
    done.push({ id: o.id, text: best, conf: o.conf, hasHan: HAN.test(best), start: o.start, end: o.end, samples: o.samples });
  };

  const proc = spawn(ffmpegPath, ['-v', 'error', '-i', file, '-vf', `fps=${1 / STEP},scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'], {
    windowsHide: true,
  });
  currentProc = proc;
  let pending = Buffer.alloc(0);
  let frameIdx = 0;
  const handle = async (buf: Buffer) => {
    if (cancelled) return;
    const t = frameIdx * STEP;
    frameIdx++;
    if (frameIdx % 10 === 0) onProgress(`글자 찾는 중: ${path.basename(file)} ${t.toFixed(1)}초`);
    const d = new Float32Array(3 * W * H);
    for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) d[c * W * H + i] = (buf[i * 3 + c] / 255 - mean[c]) / std[c];
    const prob = (await s.det.run({ [s.det.inputNames[0]]: new s.ort.Tensor('float32', d, [1, 3, H, W]) }))[s.det.outputNames[0]].data as Float32Array;
    const found: Array<{ box: TextBox; text: string; conf: number }> = [];
    const read = async (b: DetBox) => {
      const out = (await s.rec.run({ [s.rec.inputNames[0]]: recognize(buf, W, H, b, s) }))[s.rec.outputNames[0]];
      const [text, conf] = ctcDecode(out, s.chars);
      // ok 가 아니면 엉터리로 읽힌 상자(화면 속 물건 등) → 버림
      return { box: [b[0] / W, b[1] / H, b[2] / W, b[3] / H] as TextBox, text, conf, ok: !!text && conf >= 0.5 };
    };
    for (const g of boxesFromProb(prob, W, H)) {
      const whole = await read(g.box);
      // 여러 조각을 합친 상자가 엉터리로 읽히거나 한자가 안 나오면 조각별로 다시 읽음.
      //  (운동화 2.mp4 14.4초~: 자막 "拿回去试试"가 바로 아래 달력 글자 "NOV"와 한 상자로 합쳐져 "die" 0.35 로 읽혀 통째로 버려짐 → 자막이 안 가려짐, 2026-11-13)
      if (g.parts.length > 1 && !(whole.ok && HAN.test(whole.text))) {
        const parts = [];
        for (const p of g.parts) parts.push(await read(p));
        // 조각에서 나온 한자 1~3자는 쓰지 않음: 배경 소품(그림 속 "發財"·"主發财" 등)이 잠깐씩 잡혀 블러가 생겼다 없어졌다 함. 따로 잡힌 짧은 자막은 그대로 가림
        const good = parts.filter((p) => p.ok && !(HAN.test(p.text) && [...p.text].length < 4));
        if (good.length && (!whole.ok || good.some((p) => HAN.test(p.text)))) {
          for (const p of good) found.push({ box: p.box, text: p.text, conf: p.conf });
          continue;
        }
      }
      if (whole.ok) found.push({ box: whole.box, text: whole.text, conf: whole.conf });
    }
    // 열린 덩어리와 이어 붙이기: 위치가 겹치고 글자가 비슷하면 같은 덩어리
    const used = new Set<Open>();
    for (const f of found) {
      let best: Open | null = null;
      let bestScore = 0;
      for (const o of open) {
        if (used.has(o)) continue;
        const last = o.samples[o.samples.length - 1].box;
        const ov = iou(last, f.box);
        const sim = textSim(o.text, f.text);
        const score = ov > 0.3 && (sim > 0.4 || ov > 0.85) ? ov + sim : 0;
        if (score > bestScore) [best, bestScore] = [o, score];
      }
      if (best) {
        used.add(best);
        best.samples.push({ t, box: f.box });
        best.end = t + STEP;
        best.last = t;
        best.conf = Math.max(best.conf, f.conf);
        best.texts.set(f.text, (best.texts.get(f.text) || 0) + f.conf);
        if (f.conf >= best.conf) best.text = f.text;
      } else {
        const o: Open = { id: `txt_${++seq}`, text: f.text, conf: f.conf, hasHan: HAN.test(f.text), start: t, end: t + STEP, samples: [{ t, box: f.box }], last: t, texts: new Map([[f.text, f.conf]]) };
        open.push(o);
        used.add(o);
      }
    }
    // 0.4초 넘게 안 보인 덩어리는 닫음
    for (let i = open.length - 1; i >= 0; i--) if (t - open[i].last > 0.4 + 1e-6) close(open.splice(i, 1)[0]);
  };

  await new Promise<void>((resolve, reject) => {
    let chain = Promise.resolve();
    proc.stdout.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        const frame = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
        proc.stdout.pause();
        chain = chain.then(() => handle(Buffer.from(frame))).then(() => {
          proc.stdout.resume();
        });
      }
    });
    proc.on('error', reject);
    proc.on('close', () => chain.then(() => resolve(), reject));
  });
  currentProc = null;
  if (cancelled) throw new Error('취소됨');
  open.splice(0).forEach(close);
  // 너무 짧게(0.4초 미만) 스친 글자는 버림
  const tracks = done.filter((d) => d.end - d.start >= 0.4).sort((a, b) => a.start - b.start);
  fs.writeFileSync(cachePath, JSON.stringify(tracks));
  return { tracks, cached: false };
}
