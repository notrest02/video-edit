// 내보낸 mp4 컷 검사기 (비용 없음, AI 호출 없음) — 계산은 electron/exportChecker.ts (앱이 내보내기 직후 쓰는 것과 같음)
// 사용: npm run check:export -- <결과.mp4> [사진 저장 폴더]
//  1) 짧은 장면(원본 다음 장면이 잠깐 비침) 2) 마스크 풀림(컷 앞뒤 1~2프레임) 3) 1프레임 번쩍임
// 의심 자리마다 앞뒤 프레임을 이어 붙인 사진을 저장 (가운데가 문제 프레임)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const FFMPEG = path.join(ROOT, 'node_modules/ffmpeg-static/ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe');
const [, , input, outDirArg] = process.argv;
if (!input || !fs.existsSync(input)) {
  console.log('사용: npm run check:export -- <결과.mp4> [사진 저장 폴더]');
  process.exit(2);
}
const outDir = outDirArg || path.join(path.dirname(input), path.basename(input, path.extname(input)) + '_컷검사');

const esbuild = require(path.join(ROOT, 'node_modules/esbuild'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-export-'));
const out = path.join(tmp, 'exportChecker.cjs');
esbuild.buildSync({ entryPoints: [path.join(ROOT, 'electron/exportChecker.ts')], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'error' });
const { checkExportedVideo } = require(out);

const probe = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', input], { encoding: 'utf8' });
const [fn, fd] = (probe.stdout.trim() || '30/1').split('/').map(Number);
const fps = fn / (fd || 1);

const res = await checkExportedVideo(FFMPEG, input, outDir, fps);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`검사: ${path.basename(input)} — ${res.frames}프레임, ${fps.toFixed(2)}fps, 컷 ${res.cuts}개`);
if (!res.problems.length) {
  console.log('✅ 문제 없음');
  process.exit(0);
}
for (const p of res.problems) console.log(`⚠️ ${p.time.toFixed(2)}초 (${p.frame}번 프레임) ${p.kind}: ${p.msg}  → ${p.image ? path.basename(p.image) : '(사진 없음)'}`);
console.log(`\n의심 ${res.problems.length}곳. 사진: ${outDir} (가운데 사진이 문제 프레임)`);
process.exit(1);
