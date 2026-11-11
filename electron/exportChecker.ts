/**
 * 내보낸 mp4 컷 검사기 (비용 없음, AI 호출 없음) — 앱(내보내기 직후)과 tools/check-export/check-cuts.mjs 가 같이 쓴다.
 *
 * 영상을 작은 회색 사진 묶음으로 읽어, 칸(가로 6 × 세로 12)마다 숫자 두 개를 잰다.
 *  - 밝기 차이(앞 프레임과 얼마나 다른가) → 컷 위치, 짧은 장면, 1프레임 번쩍임
 *  - 선명도(이웃 점끼리 차이) → 블러 칸은 아주 낮음 → 마스크 풀림
 * 찾는 것:
 *  1) 짧은 장면: 컷과 컷 사이가 3프레임 이하 → 원본의 다음 장면이 잠깐 비침, 컷이 두 번 바뀜
 *  2) 마스크 풀림: 장면 안에서 늘 흐린 칸이 장면 첫·끝 2프레임에서만 선명해짐 → 원본 글자가 보임
 *  3) 1프레임 번쩍임: 앞뒤 프레임은 같은데 가운데 한 프레임만 한 부분이 다름
 * 2026-11-11 운동화키트_01 로 확인: 5.71초(마스크 3프레임 늦게 켜짐)·6.57초(마지막 1프레임 중국어 자막)를 잡고, 멀쩡한 컷 13개는 안 잡음.
 * 못 잡는 것: 한국어 자막 아래로 살짝 비치는 원본 글자(자막이 원래 선명해서 구분 안 됨).
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

export type CheckProblem = { kind: '짧은 장면' | '마스크 풀림' | '번쩍임'; frame: number; time: number; msg: string; image?: string };
export type CheckResult = { frames: number; fps: number; cuts: number; problems: CheckProblem[] };

const W = 216;
const H = 384;
const GX = 6;
const GY = 12;

/** 회색 프레임 묶음(W×H 바이트씩)을 분석 — 파일·ffmpeg 없이 계산만 (시험하기 쉽게) */
export function analyzeFrames(buf: Uint8Array, fps: number): CheckResult {
  const N = W * H;
  const F = Math.floor(buf.length / N);
  const fr = (i: number) => buf.subarray(i * N, (i + 1) * N);
  const CW = W / GX;
  const CH = H / GY;
  const C = GX * GY;
  const cellOf = (x: number, y: number) => Math.floor(y / CH) * GX + Math.floor(x / CW);
  const diff = (a: number, b: number) => {
    const A = fr(a);
    const B = fr(b);
    const out = new Float64Array(C);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[cellOf(x, y)] += Math.abs(A[y * W + x] - B[y * W + x]);
    for (let i = 0; i < C; i++) out[i] /= CW * CH;
    return out;
  };
  const sharpCache = new Map<number, Float64Array>();
  const sharp = (i: number) => {
    const hit = sharpCache.get(i);
    if (hit) return hit;
    const A = fr(i);
    const out = new Float64Array(C);
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const k = y * W + x;
        out[cellOf(x, y)] += Math.abs(4 * A[k] - A[k - 1] - A[k + 1] - A[k - W] - A[k + W]);
      }
    for (let c = 0; c < C; c++) out[c] /= CW * CH;
    sharpCache.set(i, out);
    return out;
  };
  const mean = (a: ArrayLike<number>) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i];
    return s / Math.max(1, a.length);
  };
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
  const problems: CheckProblem[] = [];
  const add = (kind: CheckProblem['kind'], frame: number, msg: string) => problems.push({ kind, frame, time: +(frame / fps).toFixed(3), msg });
  const rowsText = (cells: number[]) => {
    const rows = [...new Set(cells.map((c) => Math.floor(c / GX)))];
    return `화면 세로 ${Math.round((Math.min(...rows) / GY) * 100)}~${Math.round(((Math.max(...rows) + 1) / GY) * 100)}% 높이`;
  };

  // 1) 컷 찾기: 화면 전체가 앞 프레임과 크게 다르고, 앞쪽·뒤쪽 장면 각각의 평소 움직임보다 2.5배 넘게 큼
  //    (예전: 앞뒤를 섞은 중간값의 3배 → 계속 크게 움직이는 장면 옆의 컷을 놓쳤음, 검사기 시험 C1)
  const d = [0];
  for (let i = 1; i < F; i++) d.push(mean(diff(i - 1, i)));
  const cuts = [0];
  for (let i = 1; i < F; i++) {
    const before = median(d.slice(Math.max(1, i - 6), i));
    const after = median(d.slice(i + 1, Math.min(F, i + 7)));
    if (d[i] > 22 && d[i] > Math.max(before, after) * 2.5) cuts.push(i);
  }
  // 확실한 컷 바로 옆(3프레임 안)의 두 번째 경계는 기준을 낮춰 다시 봄: 다른 장면이 1~3프레임 끼어든 경우
  //  끼어든 장면과 다음 장면의 밝기가 비슷하면 두 번째 경계가 약해서 놓쳤음 (검사기 시험 C7)
  for (const k of [...cuts]) {
    for (let i = k - 3; i <= k + 3; i++) {
      if (i <= 0 || i >= F || i === k || cuts.includes(i)) continue;
      const side = i > k ? median(d.slice(i + 1, Math.min(F, i + 7))) : median(d.slice(Math.max(1, i - 6), i));
      if (d[i] > 22 && d[i] > side * 1.8) cuts.push(i);
    }
  }
  cuts.sort((x, y) => x - y);
  cuts.push(F);

  // 흐리게 만든 프레임 (마스크 풀림 확인용): 가로·세로 상자 흐림 두 번
  const blurCache = new Map<number, Float32Array>();
  const blurred = (i: number) => {
    const hit = blurCache.get(i);
    if (hit) return hit;
    const R = 5;
    let src = Float32Array.from(fr(i));
    const tmp = new Float32Array(N);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          let s = 0;
          let n = 0;
          for (let k = Math.max(0, x - R); k <= Math.min(W - 1, x + R); k++, n++) s += src[y * W + k];
          tmp[y * W + x] = s / n;
        }
      const out = new Float32Array(N);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          let s = 0;
          let n = 0;
          for (let k = Math.max(0, y - R); k <= Math.min(H - 1, y + R); k++, n++) s += tmp[k * W + x];
          out[y * W + x] = s / n;
        }
      src = out;
    }
    blurCache.set(i, src);
    return src;
  };
  /** 칸 c 에서 프레임 a(그대로 또는 흐리게) 와 프레임 b 의 평균 차이 */
  const cellDiff = (a: ArrayLike<number>, b: ArrayLike<number>, c: number) => {
    const x0 = (c % GX) * CW;
    const y0 = Math.floor(c / GX) * CH;
    let s = 0;
    for (let y = y0; y < y0 + CH; y++) for (let x = x0; x < x0 + CW; x++) s += Math.abs(a[y * W + x] - b[y * W + x]);
    return s / (CW * CH);
  };

  // 짧은 장면
  //  영상 맨 앞·맨 끝의 1~3프레임 장면도 포함 (광고 끝 클립이 원본 다음 장면을 2프레임 보여 주고 끝나는 경우 —
  //  운동화키트 02 마지막 클립, 2026-11-12. 예전엔 맨 끝이라 안 봤음)
  for (let k = 0; k < cuts.length - 1; k++) {
    const len = cuts[k + 1] - cuts[k];
    if (len > 3 || cuts.length < 3) continue;
    if (k === 0) add('짧은 장면', 0, `영상 맨 앞 ${len}프레임만 다른 장면 (원본 앞 장면·제목 카드가 비침)`);
    else if (cuts[k + 1] >= F) add('짧은 장면', cuts[k], `영상 맨 끝 ${len}프레임이 다른 장면 (원본 다음 장면이 비친 채 끝남)`);
    else add('짧은 장면', cuts[k], `${len}프레임짜리 장면 (원본 다음 장면이 비치거나 컷이 두 번 바뀜)`);
  }

  // 2) 마스크 풀림
  for (let k = 0; k < cuts.length - 1; k++) {
    const a = cuts[k];
    const b = cuts[k + 1];
    if (b - a < 10) continue;
    const inner: Float64Array[] = [];
    for (let i = a + 3; i < b - 3; i += Math.max(1, Math.floor((b - a - 6) / 12))) inner.push(sharp(i));
    const innerMed = Array.from({ length: C }, (_, c) => median(inner.map((s) => s[c])));
    const innerMax = Array.from({ length: C }, (_, c) => Math.max(...inner.map((s) => s[c])));
    for (const i of [a, a + 1, b - 2, b - 1]) {
      const s = sharp(i);
      // 안쪽 프레임 (마스크가 켜져 있을 프레임). 마스크가 3프레임까지 늦게 켜질 수 있어 4프레임 안쪽 (운동화키트 5.71초)
      const nb = i < a + 2 ? a + 4 : b - 5;
      const cells: number[] = [];
      for (let c = 0; c < C; c++) {
        // 늘 흐린 칸(장면 안 최대 선명도도 낮음)이 이 프레임에서만 확 선명해짐
        if (!(innerMax[c] < 6 && s[c] > Math.max(8, innerMed[c] * 2.5, innerMax[c] * 1.8))) continue;
        // 그리고 이 프레임을 흐리게 하면 옆 프레임과 비슷해짐 = 같은 화면인데 블러만 빠짐 (마스크 풀림).
        // 물체가 새로 들어온 경우는 흐리게 해도 옆 프레임과 다름 → 제외 (검사기 시험 C6)
        const raw = cellDiff(fr(i), fr(nb), c);
        const blr = cellDiff(blurred(i), fr(nb), c);
        if (raw > 3 && blr < raw * 0.6) cells.push(c);
      }
      if (cells.length) add('마스크 풀림', i, `${i < a + 2 ? '장면 첫' : '장면 끝'} 프레임에서 흐리던 자리가 선명해짐 (${rowsText(cells)})`);
    }
  }

  // 3) 1프레임 번쩍임 (컷 아닌 자리)
  const cutSet = new Set(cuts);
  for (let n = 1; n < F - 1; n++) {
    if (cutSet.has(n) || cutSet.has(n + 1)) continue;
    const p = diff(n - 1, n);
    const q = diff(n, n + 1);
    const r = diff(n - 1, n + 1);
    const cells: number[] = [];
    for (let c = 0; c < C; c++) if (p[c] > 14 && q[c] > 14 && r[c] < Math.min(p[c], q[c]) * 0.3) cells.push(c);
    if (cells.length < 2) continue;
    // 빠르게 지나가는 손도 '한 프레임만 다름'으로 보인다 (원본 9개에서 7번 잘못 잡음, 변화량 최대 81).
    // 우리 쪽 문제(자막·마스크가 1프레임 어긋남)는 컷 옆에서 생기므로 컷 옆은 50 이상, 컷에서 먼 곳은 아주 뚜렷할 때(120 이상)만
    // (컷 옆에서 손이 지나간 경우 16~44 — 편집자 완성본 캐릭터 선반)
    const strong = Math.max(...cells.map((c) => Math.min(p[c], q[c])));
    const nearCut = cuts.some((k) => Math.abs(k - n) <= 3);
    if (strong >= (nearCut ? 50 : 120)) add('번쩍임', n, `한 프레임만 앞뒤와 다름 (${rowsText(cells)})`);
  }

  problems.sort((x, y) => x.frame - y.frame);
  const merged: CheckProblem[] = [];
  for (const p of problems) {
    const last = merged[merged.length - 1];
    if (last && last.kind === p.kind && p.frame - last.frame <= 3) continue;
    merged.push(p);
  }
  return { frames: F, fps, cuts: cuts.length - 2, problems: merged };
}

function runCollect(cmd: string, args: string[]): Promise<{ code: number; out: Buffer; err: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let err = '';
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code: code ?? 1, out: Buffer.concat(chunks), err }));
  });
}

/** 영상 파일 검사 + 의심 자리마다 앞뒤 2프레임 사진(가운데가 문제 프레임)을 imageDir 에 저장 */
export async function checkExportedVideo(ffmpegPath: string, input: string, imageDir: string, fps: number): Promise<CheckResult> {
  const raw = await runCollect(ffmpegPath, ['-v', 'error', '-i', input, '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-']);
  if (raw.code !== 0) throw new Error(`검사용으로 영상을 읽지 못함: ${raw.err.slice(-300)}`);
  const res = analyzeFrames(raw.out, fps);
  if (res.problems.length) {
    fs.mkdirSync(imageDir, { recursive: true });
    for (const p of res.problems) {
      const file = path.join(imageDir, `${String(p.frame).padStart(5, '0')}_${p.kind.replace(/\s/g, '')}.png`);
      await runCollect(ffmpegPath, ['-v', 'error', '-y', '-i', input, '-vf', `select='between(n,${Math.max(0, p.frame - 2)},${p.frame + 2})',scale=240:-2,tile=5x1`, '-frames:v', '1', file]);
      if (fs.existsSync(file)) p.image = file;
    }
  }
  return res;
}
