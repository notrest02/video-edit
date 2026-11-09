// 지난 자동 배치의 AI 답(userData/auto-edit-logs)을 지금 코드에 다시 넣어 규칙 위반이 다시 나오는지 확인 (비용 없음)
// 사용: node tools/auto-edit/replay-logs.mjs <프로젝트.agproj> <광고1 기록.json> [<광고2 기록.json> ...]
//   기록 파일은 광고 구간 순서대로. 장면 분석은 userData/scene-cache 에서 읽는다 (앱과 같은 번호 매김)
// 고객 자료(프로젝트·영상)는 저장소에 넣지 않는다 — 경로만 인자로 받는다.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'node_modules/esbuild'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autoedit-replay-'));
const out = path.join(tmp, 'autoEdit.cjs');
esbuild.buildSync({ entryPoints: [path.join(ROOT, 'src/utils/autoEdit.ts')], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'error' });
const A = require(out);

const [projPath, ...logFiles] = process.argv.slice(2);
if (!projPath || !logFiles.length) {
  console.log('사용: node tools/auto-edit/replay-logs.mjs <프로젝트.agproj> <광고1 기록.json> [...]');
  process.exit(2);
}
const CACHE = path.join(process.env.APPDATA || '', 'antigravity-video-editor', 'scene-cache');
const contentKey = (p) => {
  const size = fs.statSync(p).size;
  const n = Math.min(size, 1 << 20);
  const fd = fs.openSync(p, 'r');
  const h = Buffer.alloc(n), t = Buffer.alloc(n);
  fs.readSync(fd, h, 0, n, 0);
  fs.readSync(fd, t, 0, n, Math.max(0, size - n));
  fs.closeSync(fd);
  return 'c' + crypto.createHash('sha1').update(String(size)).update(h).update(t).digest('hex').slice(0, 15);
};
const norm = (p) => (p || '').split('\\').join('/').toLowerCase();
const proj = JSON.parse(fs.readFileSync(projPath, 'utf8'));
const seq = proj.sequences[0];
const media = proj.assets.filter((a) => a.type === 'video');
const shots = [], descs = [], seen = new Set();
media.forEach((v, i) => {
  if (!fs.existsSync(v.path)) return;
  const k = contentKey(v.path);
  if (seen.has(k)) return;
  seen.add(k);
  const f = path.join(CACHE, k + '.json');
  if (!fs.existsSync(f)) return;
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const s of c.shots) shots.push({ ...s, id: `${i + 1}-${s.id.split('-')[1]}`, path: v.path });
  for (const d of c.descs || []) descs.push({ ...d, id: `${i + 1}-${d.id.split('-')[1]}` });
});
const hi = A.shotLenCap(shots);
const RULE = [
  [/빈 화면/, 'R01'], [/너무 느림/, 'R02'], [/장면 경계/, 'R03'], [/짧음|김\b/, 'R04'], [/맺음말/, 'R05'], [/말 덩어리 중간/, 'R06'],
  [/후킹 바로 다음/, 'R11'], [/같은 장면을 다시/, 'R12'], [/같은 영상의 다른 부분/, 'R13'], [/비슷한 장면/, 'R14'], [/한 문장 안에서/, 'R23'],
];
let bad = 0;
const prevClips = [];
logFiles.forEach((lf, gi) => {
  const g = seq.adSegments?.[gi];
  const L = JSON.parse(fs.readFileSync(lf, 'utf8'));
  const sl = L.rows.map((r) => ({ slot: r.slot, start: r.start, end: r.end, dur: r.end - r.start, text: r.text, hook: r.hook, captionStart: r.start }));
  const assign = L.rows.filter((r) => !r.hook).map((r) => ({ slot: r.slot, shot: r.shot, in: r.in, alt: r.alt, focus: r.focus }));
  let hook = null;
  if (g?.hook) {
    const v = (g.hook.path && media.find((x) => norm(x.path) === norm(g.hook.path))) || media[g.hook.fileNo - 1];
    if (v) hook = { path: v.path, from: g.hook.from, to: g.hook.to };
  }
  const used = A.usedRangesFromClips(prevClips, shots);
  const r = A.fitAssignment(sl, assign, shots, hook, used.ranges, [], descs);
  prevClips.push(...r.clips.map((c) => ({ type: 'video', sourcePath: c.path, sourceStart: c.srcIn, duration: c.end - c.start, speed: c.speed })));
  const is = A.auditPlan(sl, r.clips, shots, { hi, fps: seq.fps || 30, descs });
  const hardRules = is.filter((i) => /R0[1-3]|R1[1-3]/.test(RULE.find(([re]) => re.test(i.msg))?.[1] || ''));
  bad += hardRules.length;
  console.log(`\n■ ${g?.name || `광고 ${gi + 1}`} — 코드가 바꾼 것 ${r.warnings.length}개, 검사기 ${is.length}개`);
  for (const w of r.warnings) console.log(`   · ${w}`);
  for (const i of is) console.log(`   ${i.level === 'error' ? '❌' : '⚠️'} [${RULE.find(([re]) => re.test(i.msg))?.[1] || '-'}] ${i.msg}`);
});
console.log(`\n코드로 막는 규칙(R01~R03, R11~R13) 위반: ${bad}개`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
