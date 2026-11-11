// 컷 검사기 시험 (비용 없음): 일부러 망가뜨린 영상을 만들어, 검사기가 심은 문제를 정확한 자리에서 찾고
// 멀쩡한 영상에서는 아무것도 안 잡는지 확인한다. 고객 자료 없이 ffmpeg 가 만든 화면(lavfi)만 쓴다.
// 사용: npm run test:checker
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const FFMPEG = path.join(ROOT, 'node_modules/ffmpeg-static/ffmpeg.exe');
const esbuild = require(path.join(ROOT, 'node_modules/esbuild'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-test-'));
const cjs = path.join(tmp, 'exportChecker.cjs');
esbuild.buildSync({ entryPoints: [path.join(ROOT, 'electron/exportChecker.ts')], bundle: true, format: 'cjs', platform: 'node', outfile: cjs, logLevel: 'error' });
const { checkExportedVideo } = require(cjs);

const W = 540, H = 960, FPS = 30, N = 45; // 장면 하나 45프레임(1.5초)
const SRC = {
  a: `testsrc2=s=${W}x${H}:r=${FPS}`,
  b: `mandelbrot=s=${W}x${H}:r=${FPS}`,
  c: `cellauto=s=${W}x${H}:r=${FPS}:rule=110`,
  d: `life=s=${W}x${H}:r=${FPS}:ratio=0.5:mold=10:life_color=#e0c080:death_color=#203040`,
  e: `testsrc=s=${W}x${H}:r=${FPS}`,
  leak: `color=c=#d02020:s=${W}x${H}:r=${FPS}`,
};
// 블러 마스크 자리: 화면 세로 65~80% (원본 자막이 있는 자리처럼)
const MY = Math.round(H * 0.65), MH = Math.round(H * 0.15);
const blur = (from, to) => `split[o][m];[m]crop=${W}:${MH}:0:${MY},gblur=sigma=25[bl];[o][bl]overlay=0:${MY}:enable='between(n,${from},${to})'`;

/** 장면 하나 = 원본 + (선택) 마스크 구간 + (선택) 1프레임 번쩍임 → 파일 */
function segment(name, src, frames, { mask, flashAt } = {}) {
  // life 는 처음 몇 프레임이 무작위라 서로 완전히 달라 '1프레임 장면'이 됨 → 앞 15프레임 버림
  let vf = src.startsWith('life') ? 'trim=start_frame=15,setpts=PTS-STARTPTS,format=yuv420p' : 'format=yuv420p';
  if (mask) vf = `${vf},${blur(mask[0], mask[1])},format=yuv420p`;
  if (flashAt !== undefined) vf += `,drawbox=x=${W * 0.3}:y=${H * 0.3}:w=${W * 0.4}:h=${H * 0.12}:color=white@1:t=fill:enable='eq(n,${flashAt})'`;
  const out = path.join(tmp, `${name}.mp4`);
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-frames:v', String(frames), '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', '1', out]);
  if (r.status !== 0) throw new Error(`${name} 만들기 실패: ${r.stderr}`);
  return out;
}
function join(name, parts) {
  const list = path.join(tmp, `${name}.txt`);
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const out = path.join(tmp, `${name}.mp4`);
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', String(FPS), out]);
  if (r.status !== 0) throw new Error(`${name} 잇기 실패: ${r.stderr}`);
  return out;
}

const results = [];
const test = async (id, name, fn) => {
  try {
    const msg = await fn();
    results.push({ id, name, ok: true, msg: msg || '' });
  } catch (e) {
    results.push({ id, name, ok: false, msg: e.message });
  }
};
const fmt = (ps) => ps.map((p) => `${p.kind}@${p.frame}`).join(', ') || '없음';

// 멀쩡한 영상: 장면 5개, b·d 는 마스크가 장면 전체를 덮음
const clean = join('clean', [
  segment('a', SRC.a, N),
  segment('b', SRC.b, N, { mask: [0, N - 1] }),
  segment('c', SRC.c, N),
  segment('d', SRC.d, N, { mask: [0, N - 1] }),
  segment('e', SRC.e, N),
]);
// 망가뜨린 영상: 같은 구성 + 문제 4개 심기
//  ① a 와 b 사이에 다른 장면 2프레임 (원본 다음 장면 비침) → 프레임 45
//  ② b 의 마지막 1프레임만 마스크 꺼짐 → 프레임 47+44 = 91
//  ③ d 의 처음 2프레임 마스크 꺼짐 (늦게 켜짐) → 프레임 47+45+45 = 137
//  ④ e 의 가운데(20번째) 1프레임 번쩍임 → 프레임 137+45+20 = 202
const broken = join('broken', [
  segment('a2', SRC.a, N),
  segment('leak', SRC.leak, 2),
  segment('b2', SRC.b, N, { mask: [0, N - 2] }),
  segment('c2', SRC.c, N),
  segment('d2', SRC.d, N, { mask: [2, N - 1] }),
  segment('e2', SRC.e, N, { flashAt: 20 }),
]);
const EXPECT = [
  { kind: '짧은 장면', frame: 45 },
  { kind: '마스크 풀림', frame: 91 },
  { kind: '마스크 풀림', frame: 137 },
  { kind: '번쩍임', frame: 202 },
];

await test('C1', '멀쩡한 영상에서는 아무것도 안 잡음', async () => {
  const r = await checkExportedVideo(FFMPEG, clean, path.join(tmp, 'img-clean'), FPS);
  if (r.cuts !== 4) throw new Error(`컷 ${r.cuts}개 (4개여야 함)`);
  if (r.problems.length) throw new Error(`잘못 잡음: ${fmt(r.problems)}`);
});
const got = await checkExportedVideo(FFMPEG, broken, path.join(tmp, 'img-broken'), FPS);
for (const [i, e] of EXPECT.entries()) {
  await test(`C${i + 2}`, `${e.kind} 찾기 (${e.frame}번 프레임 ±1)`, async () => {
    const hit = got.problems.find((p) => p.kind === e.kind && Math.abs(p.frame - e.frame) <= 1);
    if (!hit) throw new Error(`못 찾음. 찾은 것: ${fmt(got.problems)}`);
    if (!hit.image || !fs.existsSync(hit.image)) throw new Error('확인용 사진이 없음');
  });
}
await test('C6', '망가뜨린 영상에서 심지 않은 문제는 안 잡음', async () => {
  const extra = got.problems.filter((p) => !EXPECT.some((e) => e.kind === p.kind && Math.abs(p.frame - e.frame) <= 1));
  if (extra.length) throw new Error(`잘못 잡음: ${fmt(extra)}`);
});

// 두 번째 망가뜨린 영상 (더 어려운 경우)
//  ⑤ b 의 처음 3프레임 마스크 꺼짐 (운동화키트_01 5.71초와 같은 경우) → 프레임 45
//  ⑥ c 와 d 사이에 다른 장면 1프레임만 → 프레임 135
const broken2 = join('broken2', [
  segment('a3', SRC.a, N),
  segment('b3', SRC.b, N, { mask: [3, N - 1] }),
  segment('c3', SRC.c, N),
  segment('leak1', SRC.leak, 1),
  segment('d3', SRC.d, N, { mask: [0, N - 1] }),
]);
const EXPECT2 = [
  { kind: '마스크 풀림', frame: 45 },
  { kind: '짧은 장면', frame: 135 },
];
// 세 번째: 영상 맨 끝 2프레임에 다른 장면 (광고 마지막 클립이 원본 다음 장면을 보여 주고 끝남, 운동화키트 02)
//  + 맨 앞 2프레임 다른 장면 (원본 제목 카드) → 프레임 0, 2+45+45 = 92
const broken3 = join('broken3', [
  segment('lead2', SRC.leak, 2),
  segment('a4', SRC.a, N),
  segment('e4', SRC.e, N),
  segment('tail2', SRC.c, 2),
]);
const EXPECT3 = [
  { kind: '짧은 장면', frame: 0 },
  { kind: '짧은 장면', frame: 92 },
];
const got2 = await checkExportedVideo(FFMPEG, broken2, path.join(tmp, 'img-broken2'), FPS);
await test('C7', '마스크 3프레임 늦게 켜짐 + 다른 장면 1프레임 찾기, 그 밖엔 안 잡음', async () => {
  for (const e of EXPECT2) if (!got2.problems.some((p) => p.kind === e.kind && Math.abs(p.frame - e.frame) <= 1)) throw new Error(`${e.kind}@${e.frame} 못 찾음. 찾은 것: ${fmt(got2.problems)}`);
  const extra = got2.problems.filter((p) => !EXPECT2.some((e) => e.kind === p.kind && Math.abs(p.frame - e.frame) <= 1));
  if (extra.length) throw new Error(`잘못 잡음: ${fmt(extra)}`);
});
const got3 = await checkExportedVideo(FFMPEG, broken3, path.join(tmp, 'img-broken3'), FPS);
await test('C8', '영상 맨 앞·맨 끝 2프레임 다른 장면 찾기, 그 밖엔 안 잡음', async () => {
  for (const e of EXPECT3) if (!got3.problems.some((p) => p.kind === e.kind && Math.abs(p.frame - e.frame) <= 1)) throw new Error(`${e.kind}@${e.frame} 못 찾음. 찾은 것: ${fmt(got3.problems)}`);
  const extra = got3.problems.filter((p) => !EXPECT3.some((e) => e.kind === p.kind && Math.abs(p.frame - e.frame) <= 1));
  if (extra.length) throw new Error(`잘못 잡음: ${fmt(extra)}`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.id} ${r.name}${r.ok ? '' : `\n     → ${r.msg}`}`);
console.log(`\n${results.length - failed.length}/${results.length} 통과${failed.length ? ` — 실패 ${failed.map((r) => r.id).join(', ')}` : ''}`);
if (process.env.KEEP) console.log('시험 영상:', tmp);
else fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
