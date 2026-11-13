// AI 자동 배치 규칙 시험 (비용 없음, AI 호출 없음) — 규칙 목록: docs/자동배치_규칙목록.md
// 사용: node tools/auto-edit/rules-test.mjs
// 규칙마다 일부러 어기는 상황을 만들어, 코드(autoEdit.ts)와 검사기(auditPlan)가 막는지 확인한다.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'node_modules/esbuild'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autoedit-rules-'));
const load = (rel) => {
  const out = path.join(tmp, path.basename(rel).replace(/\.ts$/, '.cjs'));
  esbuild.buildSync({ entryPoints: [path.join(ROOT, rel)], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'error' });
  return require(out);
};
const A = load('src/utils/autoEdit.ts');
const SN = load('src/utils/subtitleSnapper.ts');
const SL = load('src/utils/snapLead.ts');
const SG = load('src/utils/scriptGen.ts');

// ---------- 도우미 ----------
const results = [];
const test = (id, name, fn) => {
  try {
    const msg = fn();
    results.push({ id, name, ok: true, msg: msg || '' });
  } catch (e) {
    results.push({ id, name, ok: false, msg: e.message });
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const caps = (arr) => {
  let t = 0;
  return arr.map(([text, d]) => {
    const c = { text, startTime: t, duration: d };
    t += d;
    return c;
  });
};
const totalOf = (cs) => cs[cs.length - 1].startTime + cs[cs.length - 1].duration;
const slot = (k, a, b, hook = false, extra = {}) => ({ slot: k, start: a, end: b, dur: b - a, text: `컷${k}`, hook, captionStart: a, ...extra });
const shot = (id, p, a, b) => ({ id, path: p, file: p, start: a, end: b, dur: b - a });
const issues = (sl, clips, shots, opts = {}) => A.auditPlan(sl, clips, shots, { hi: 2.4, fps: 30, ...opts });
const has = (list, re) => list.some((i) => re.test(i.msg));

// 기본 장면 묶음: 영상 a(장면 6개), b(4개), c(3개)
const SH = [
  shot('1-01', 'a.mp4', 0, 3), shot('1-02', 'a.mp4', 3.1, 6), shot('1-03', 'a.mp4', 6.1, 9), shot('1-04', 'a.mp4', 9.1, 12), shot('1-05', 'a.mp4', 12.1, 15), shot('1-06', 'a.mp4', 15.1, 15.6),
  shot('2-01', 'b.mp4', 0, 3), shot('2-02', 'b.mp4', 3.1, 6), shot('2-03', 'b.mp4', 6.1, 9), shot('2-04', 'b.mp4', 9.1, 12),
  shot('3-01', 'c.mp4', 0, 3), shot('3-02', 'c.mp4', 3.1, 6), shot('3-03', 'c.mp4', 6.1, 9),
];
const SLOTS4 = [slot(0, 0, 2.5), slot(1, 2.5, 5), slot(2, 5, 7.5), slot(3, 7.5, 10)];

// ---------- 규칙 시험 ----------
test('R01', '빈 화면 없음 (AI 답 빠짐·없는 장면)', () => {
  const r = A.fitAssignment(SLOTS4, [{ slot: 0, shot: '1-01', in: 0 }, { slot: 2, shot: '9-99', in: 0 }], SH, null, [], []);
  const is = issues(SLOTS4, r.clips, SH);
  assert(!has(is, /빈 화면/), '빈 화면이 생김: ' + is.map((i) => i.msg).join(' / '));
  assert(r.clips.length === 4, `컷 ${r.clips.length}개 (4개여야 함)`);
});

test('R02', '모든 컷 최저 0.6배 (너무 짧은 장면은 안 씀) + 후킹도', () => {
  const r = A.fitAssignment(SLOTS4, [{ slot: 0, shot: '1-06', in: 15.1 }, { slot: 1, shot: '2-01', in: 0 }, { slot: 2, shot: '3-01', in: 0 }, { slot: 3, shot: '2-03', in: 6.1 }], SH, null, [], []);
  assert(r.clips.every((c) => c.speed >= 0.6 - 1e-9), '0.6배 미만: ' + r.clips.map((c) => c.speed).join(','));
  // 후킹: 지정 구간(2초)이 자리(3초)보다 짧으면 같은 샷 안에서 앞당겨 0.6배 이상 유지
  const long = [shot('1-01', 'a.mp4', 0, 10)];
  const hp = A.hookPieces(slot(0, 0, 3, true), { path: 'a.mp4', from: 5, to: 6.2 }, long, []);
  assert(hp.length && hp.every((p) => p.speed >= 0.6 - 1e-9), '후킹 0.6배 미만: ' + hp.map((p) => p.speed).join(','));
  // AI에게 주는 최소 길이(min_shot)가 코드 계산과 같아야 함: min_shot 길이 샷은 반드시 0.6배 이상으로 쓸 수 있어야
  const src = fs.readFileSync(path.join(ROOT, 'electron/autoEditAssign.ts'), 'utf8');
  const expr = src.match(/min_shot:\s*([^,]+\)\s*\/\s*100)/)?.[1];
  assert(expr, 'autoEditAssign.ts 에서 min_shot 계산식을 찾지 못함');
  const minShot = new Function('dur', `return ${expr}`);
  for (const D of [1.2, 1.37, 1.8, 2.23, 3.1, 4]) {
    const L = minShot(D);
    const r2 = A.fitAssignment([slot(0, 0, D)], [{ slot: 0, shot: 'x-01', in: 0 }], [shot('x-01', 'x.mp4', 0, L)], null, [], []);
    assert(r2.clips[0]?.shot === 'x-01' && r2.clips[0].speed >= 0.6, `자리 ${D}초: AI 최소 길이 ${L}초 샷을 코드가 거부함 (${r2.warnings.join(' / ')})`);
  }
});

test('R03', '컷이 원본 장면 경계를 넘지 않음', () => {
  const r = A.fitAssignment(SLOTS4, [{ slot: 0, shot: '1-01', in: 2.9 }, { slot: 1, shot: '2-02', in: 5.9 }, { slot: 2, shot: '3-02', in: 5 }, { slot: 3, shot: '2-04', in: 11 }], SH, null, [], []);
  const byId = new Map(SH.map((s) => [s.id, s]));
  for (const c of r.clips) {
    const s = byId.get(c.shot);
    assert(c.srcIn >= s.start - 1e-6 && c.srcIn + (c.end - c.start) * c.speed <= s.end + 1e-6, `${c.shot} 경계 넘음`);
  }
});

test('R04', '컷 길이 1.2초 이상 · 최대 길이 이하', () => {
  const cases = [
    caps(Array.from({ length: 12 }, (_, i) => [['네.', '진짜요.', '대박.'][i % 3], 0.7])),
    caps([['처음에', 1.5], ['이걸 보고', 1.5], ['반신반의했는데', 1.5], ['막상 써 보니까', 1.5], ['정말 편하더라고요.', 3], ['추천해요.', 2]]),
    caps(Array.from({ length: 10 }, (_, i) => [['욕실 선반 수건 걸이', '베란다 창문 유리', '양말 속옷 수건'][i % 3], 1.4])),
  ];
  for (const cs of cases) {
    const sl = A.buildSlotsFromCaptions(cs, totalOf(cs), { hi: 2.4, fps: 30 });
    for (const s of sl.slice(1)) {
      assert(s.dur >= 1.2 - 0.12, `${s.dur.toFixed(2)}초 컷 (1.2초 미만)`);
      assert(s.dur <= A.maxCutLen(2.4) + 0.15, `${s.dur.toFixed(2)}초 컷 (너무 김)`);
    }
  }
});

test('R05', '맺음말 꼬리 컷 금지 (문장 끝 1.1초 안에서 새 컷 X)', () => {
  const cs = caps([['양말이 햇빛에', 1.2], ['금방 마른다고', 1.3], ['하더라고요.', 0.67], ['그냥 듣고 넘겼는데', 1.6], ['막상 해 보니까', 1.4], ['진짜 그렇더라고요.', 1.5], ['이건 창문 유리에', 1.4], ['붙이면 돼요.', 1.2]]);
  const sl = A.buildSlotsFromCaptions(cs, totalOf(cs), { hi: 2.4, fps: 30 });
  const is = issues(sl, [], [], { caps: cs }).filter((i) => !/빈 화면/.test(i.msg));
  assert(!has(is, /맺음말/), is.map((i) => i.msg).join(' / '));
});

test('R06', '낱말을 말끝으로 착각하지 않음 + "베란다 |" 컷 금지', () => {
  const expect = { '이 정도면 베란다': 'mid', 거기다: 'mid', 때마다: 'mid', '인형 하나': 'mid', '꼭 필요': 'mid', 사이다: 'mid', 했더니: 'clause', 한다: 'clause', 타일이나: 'break', 좋더라고요: 'sent' };
  for (const [w, k] of Object.entries(expect)) assert(A.endKind(w) === k, `「${w}」 → ${A.endKind(w)} (기대 ${k})`);
  const cs = caps([['빨래 말리는 게 제일 행복해요.', 1.53], ['친구한테 고맙다고 했더니', 1.37], ['이 정도면 베란다', 1.0], ['빨래 고민 덜겠다고 웃더라고요.', 1.77], ['베란다 창가 빨래가 고민이면', 1.43], ['가격 한번 확인해 보고 직접 붙여 보세요.', 2.37]]);
  const sl = A.buildSlotsFromCaptions(cs, totalOf(cs), { hi: 2.4, fps: 30 });
  const cutAfterVeranda = sl.some((s) => Math.abs(s.captionStart - cs[3].startTime) < 0.02);
  assert(!cutAfterVeranda, '「이 정도면 베란다 |」 뒤에서 컷이 남');
});

test('R07', '아주 긴 자막도 컷이 너무 길어지지 않음', () => {
  const cs = caps([['후킹 문장이에요.', 3], ['아주 긴 설명이 계속 이어지는 자막 한 줄입니다', 10], ['끝이에요.', 2]]);
  const sl = A.buildSlotsFromCaptions(cs, totalOf(cs), { hi: 2.4, fps: 30 });
  assert(sl.every((s) => s.dur <= A.maxCutLen(2.4) + 0.15), '긴 컷: ' + sl.map((s) => s.dur.toFixed(2)).join(','));
});

test('R08', '아주 짧은 광고는 한 컷', () => {
  const cs = caps([['이거 하나면 끝나요.', 3.2], ['네.', 0.5]]);
  const sl = A.buildSlotsFromCaptions(cs, totalOf(cs), { hi: 2.4, fps: 30 });
  assert(sl.length === 1, `${sl.length}컷`);
});

test('R09', '후킹은 지정 영상·구간 장면만, 빠르게는 1.5배까지', () => {
  const shots = [shot('1-01', 'a.mp4', 0, 2), shot('1-02', 'a.mp4', 2.1, 9), shot('2-01', 'b.mp4', 0, 9)];
  const hp = A.hookPieces(slot(0, 0, 3, true), { path: 'a.mp4', from: 2.1, to: 9 }, shots, []);
  assert(hp.length && hp.every((p) => p.path === 'a.mp4'), '다른 영상이 섞임');
  assert(hp.every((p) => p.srcIn >= 2.1 - 0.5 && p.speed <= 1.5 + 1e-9), '구간 밖이거나 1.5배 초과: ' + hp.map((p) => `${p.srcIn}/${p.speed}`).join(','));
  // 후킹 길이 = 3초 고정이 아니라 지정 장면이 자연스럽게 담기는 길이 (사용자 2026-11-07, 11-11 재확인)
  const cs = caps([['이거 보세요.', 2.0], ['진짜 신기하죠.', 1.6], ['이렇게 붙이면 끝나요.', 2.4], ['정말 편해요.', 2.0], ['추천해요.', 2.0]]);
  const len = (cap) => A.buildSlotsFromCaptions(cs, totalOf(cs), { hi: 2.4, fps: 30, hookSec: 3, hookCap: cap })[0].end;
  const short = len(2.0), long = len(3.8);
  assert(short < 2.3, `지정 장면이 2초인데 후킹이 ${short.toFixed(2)}초 (장면 길이에 맞아야 함)`);
  assert(long > 3.3, `지정 장면이 3.8초인데 후킹이 ${long.toFixed(2)}초 (3초로 잘림)`);
});

test('R11', '후킹 바로 다음 컷은 후킹 장면 금지', () => {
  const shots = [shot('1-01', 'a.mp4', 0, 7.7), shot('1-02', 'a.mp4', 7.8, 10), shot('2-01', 'b.mp4', 0, 3)];
  const sl = [slot(0, 0, 4.4, true), slot(1, 4.4, 6.9), slot(2, 6.9, 9.4)];
  const r = A.fitAssignment(sl, [{ slot: 1, shot: '1-01', in: 4.5 }, { slot: 2, shot: '2-01', in: 0 }], shots, { path: 'a.mp4', from: 0, to: 4 }, [], []);
  const hookShots = new Set(r.clips.filter((c) => c.hook).map((c) => c.shot));
  const next = r.clips.find((c) => !c.hook);
  assert(next && !hookShots.has(next.shot), `후킹 다음 컷이 ${next?.shot} (후킹 장면)`);
});

test('R12', '한 광고 안 같은 장면 반복 금지', () => {
  const r = A.fitAssignment(SLOTS4, [{ slot: 0, shot: '1-02', in: 3.1 }, { slot: 1, shot: '2-01', in: 0 }, { slot: 2, shot: '1-02', in: 3.1 }, { slot: 3, shot: '3-01', in: 0 }], SH, null, [], []);
  assert(!has(issues(SLOTS4, r.clips, SH), /같은 장면을 다시/), '같은 장면 반복: ' + r.clips.map((c) => c.shot).join(','));
});

test('R13', '바로 앞 컷과 같은 영상의 다른 부분 연달아 금지 (이어 쓰기·다음 장면은 허용)', () => {
  const r = A.fitAssignment(SLOTS4, [{ slot: 0, shot: '1-01', in: 0 }, { slot: 1, shot: '1-04', in: 9.1 }, { slot: 2, shot: '2-01', in: 0 }, { slot: 3, shot: '2-02', in: 3.1 }], SH, null, [], []);
  const [c0, c1, , c3] = r.clips;
  assert(!(c1.path === c0.path && c1.shot !== c0.shot && c1.shot !== '1-02'), `${c0.shot} 다음에 같은 영상 ${c1.shot}`);
  assert(c3.shot === '2-02', `바로 다음 장면(2-02)은 허용돼야 하는데 ${c3.shot} 로 바뀜`);
  const bad = [{ path: 'a.mp4', start: 0, end: 2.5, srcIn: 0, speed: 1, shot: '1-01' }, { path: 'a.mp4', start: 2.5, end: 5, srcIn: 9.1, speed: 1, shot: '1-04' }];
  assert(has(issues(SLOTS4.slice(0, 2), bad, SH), /같은 영상의 다른 부분/), '검사기가 같은 영상 연달아를 못 잡음');
  // 사용자 2026-11-11: '곧바로 같은 컷처럼 보이지만 않으면' 같은 영상도 괜찮음 (창문 유리 문장처럼 같은 장소를 이어 갈 때)
  const d = (id, group, firstFrame, place, desc) => ({ id, desc, place, motion: 'low', parts: [], note: '', group, firstFrame });
  const differ = [d('1-01', '창문에 흡착판 누르기', '창문 유리에 손이 흡착판을 댐', '창문 유리', '흡착판을 창문에 꾹 눌러 붙임'), d('1-04', '창문 거치대에 양말 널기', '거치대에 걸린 양말 여러 켤레', '창문 유리', '거치대에 양말을 하나씩 걸어 널기')];
  const r2 = A.fitAssignment(SLOTS4.slice(0, 2), [{ slot: 0, shot: '1-01', in: 0 }, { slot: 1, shot: '1-04', in: 9.1 }], SH, null, [], [], differ);
  assert(r2.clips[1].shot === '1-04', `달라 보이는 같은 영상 장면(1-04)인데 ${r2.clips[1].shot} 로 바뀜`);
  assert(!has(issues(SLOTS4.slice(0, 2), bad, SH, { descs: differ }), /같은 영상의 다른 부분/), '달라 보이는데 검사기가 경고');
  const same = [d('1-01', '창문에 흡착판 누르기', '창문 유리에 손이 흡착판을 댐', '창문 유리', '흡착판을 창문에 꾹 눌러 붙임'), d('1-04', '창문에 흡착판 누르기', '창문 유리에 손이 흡착판을 댐', '창문 유리', '흡착판을 창문에 다시 꾹 누름')];
  const r3 = A.fitAssignment(SLOTS4.slice(0, 2), [{ slot: 0, shot: '1-01', in: 0 }, { slot: 1, shot: '1-04', in: 9.1 }], SH, null, [], [], same);
  assert(r3.clips[1].shot !== '1-04', '같은 묶음(똑같아 보이는) 장면이 연달아 들어감');
  // 지시문 D 도 같은 기준 (2026-11-11 사용자 확인). AI가 첫 화면을 볼 수 있게 firstFrame 도 넘김
  const src = fs.readFileSync(path.join(ROOT, 'electron/autoEditAssign.ts'), 'utf8');
  assert(src.includes('같은 컷이 두 번 나온 것처럼 보이는 샷은 쓰지 않는다') && src.includes('group·첫 화면·동작이 확실히 다르면 써도 된다'), '지시문 D 가 예전 문장(같은 영상이면 무조건 금지)');
  assert(/firstFrame: d\?\.firstFrame/.test(src), 'AI에게 보내는 장면 목록에 firstFrame 이 없음');
});

test('R14', '비슷한 장면 묶음 연달아 → 검사기 경고', () => {
  const descs = [{ id: '1-01', group: '타일벽에 붙이기' }, { id: '2-01', group: '타일벽에 붙이기' }];
  const clips = [{ path: 'a.mp4', start: 0, end: 2.5, srcIn: 0, speed: 1, shot: '1-01' }, { path: 'b.mp4', start: 2.5, end: 5, srcIn: 0, speed: 1, shot: '2-01' }];
  assert(has(issues(SLOTS4.slice(0, 2), clips, SH, { descs }), /비슷한 장면/), '비슷한 장면 연속을 못 잡음');
  // 후킹 조각끼리는 의뢰자가 정한 구간이라 경고하지 않음 (2026-11-13)
  const hookSlots = [slot(0, 0, 2.5, true), slot(1, 2.5, 5, true)];
  const hookClips = clips.map((c) => ({ ...c, hook: true }));
  assert(!has(issues(hookSlots, hookClips, SH, { descs }), /비슷한 장면/), '후킹 조각끼리 비슷한 장면 경고가 뜸');
});

test('R15', 'AI 1순위를 못 쓸 때도 문장 핵심(주인공)이 맞는 장면', () => {
  const shots = [shot('1-01', 'a.mp4', 0, 3), shot('2-01', 'b.mp4', 0, 3), shot('3-01', 'c.mp4', 0, 3), shot('4-01', 'd.mp4', 0, 3)];
  const descs = [{ id: '1-01', subject: '인형(판다)', desc: '판다 인형 올림' }, { id: '2-01', subject: '빨래(옷)', desc: '옷과 인형을 정리' }, { id: '3-01', subject: '인형(곰)', desc: '곰 인형 올려 보여줌' }, { id: '4-01', subject: '제품', desc: '거치대' }];
  const sl = [slot(0, 0, 2), slot(1, 2, 3.5)];
  // 1순위 1-01 은 앞 컷에서 이미 씀, 2순위는 빨래 장면 → 핵심 '인형' 장면(3-01)이 와야 함
  const r = A.fitAssignment(sl, [{ slot: 0, shot: '1-01', in: 0, focus: '인형 장식' }, { slot: 1, shot: '1-01', in: 0, alt: '2-01', focus: '인형 장식' }], shots, null, [], [], descs);
  assert(r.clips[1].shot === '3-01', `둘째 컷 ${r.clips[1].shot} (인형 장면 3-01 이어야 함)`);
});

test('R16', '대신 고를 때 대사의 장소(창문 유리)가 맞는 장면', () => {
  const shots = [shot('1-01', 'a.mp4', 0, 3), shot('2-01', 'b.mp4', 0, 3), shot('3-01', 'c.mp4', 0, 3)];
  const descs = [{ id: '1-01', subject: '제품(거치대)', place: '창문 유리 앞', desc: '창문 유리에 꾹 눌러 붙임' }, { id: '2-01', subject: '제품(거치대)', place: '욕실 타일벽', desc: '흡착판을 눌러 고정' }, { id: '3-01', subject: '제품(거치대)', place: '창문 유리 발코니', desc: '창문에 거치대 고정' }];
  const sl = [slot(0, 0, 2), slot(1, 2, 3.5)];
  const r = A.fitAssignment(sl, [{ slot: 0, shot: '1-01', in: 0, focus: '창문 유리에 붙이는 거치대' }, { slot: 1, shot: '1-01', in: 0, focus: '창문 유리에 붙이는 거치대' }], shots, null, [], [], descs);
  assert(r.clips[1].shot === '3-01', `둘째 컷 ${r.clips[1].shot} (창문 유리 장면 3-01 이어야 함)`);
});

test('R19', '장면의 핵심 순간(key)이 컷 안에 들어감', () => {
  const shots = [shot('1-01', 'a.mp4', 0, 10)];
  const r = A.fitAssignment([slot(0, 0, 2)], [{ slot: 0, shot: '1-01', in: 0 }], shots, null, [], [], [{ id: '1-01', key: 8 }]);
  const c = r.clips[0];
  assert(c.srcIn <= 8 && 8 <= c.srcIn + 2 * c.speed, `컷 ${c.srcIn}~${c.srcIn + 2}초에 핵심 순간 8초가 없음`);
});

test('R20', '같은 문장에서 같은 장면을 고르면 이어서 재생', () => {
  const shots = [shot('1-01', 'a.mp4', 0, 8)];
  const r = A.fitAssignment([slot(0, 0, 2), slot(1, 2, 4, false, { cont: true })], [{ slot: 0, shot: '1-01', in: 0 }, { slot: 1, shot: '1-01', in: 0 }], shots, null, [], []);
  const [a, b] = r.clips;
  assert(b && b.shot === '1-01' && Math.abs(b.srcIn - (a.srcIn + 2 * a.speed)) < 0.02, `이어 쓰기 안 됨 (${b?.shot} ${b?.srcIn})`);
});

test('R22', '자동 배치를 3번 돌려도 컷·자막이 밀리지 않음', () => {
  let cs = caps([['젖은 양말 대야째 들고', 1.5], ['창가까지 가는 게', 1.3], ['제일 귀찮았어요.', 1.6], ['그래서 벽에', 1.2], ['못 박는 건조대는', 1.3], ['못 쓰겠더라고요.', 1.6], ['그런데 이건', 1.1], ['붙이기만 하면 돼요.', 1.8]]).map((c, i) => ({ ...c, id: `t${i}`, type: 'text', trackId: 'C1', name: 't', startTime: c.startTime + 0.013 }));
  const total = totalOf(cs) + 0.2;
  const first = [];
  for (let run = 0; run < 3; run++) {
    const ref = cs.map(SL.voiceStartCaption).sort((x, y) => x.startTime - y.startTime);
    const sl = A.buildSlotsFromCaptions(ref, total, { hi: 2.4, fps: 30 });
    const vids = sl.map((s, k) => ({ id: `v${k}`, type: 'video', trackId: 'V1', name: 'v', startTime: s.start, duration: s.end - s.start, sourceStart: 0, sourcePath: 'x.mp4' }));
    const all = [...vids, ...cs];
    const { updatedClips } = SN.snapSubtitleClipsToMediaCuts(all, { thresholdFrames: 5, fps: 30, closeMicroGaps: true, alignClipdominantSubtitles: true });
    cs = SL.withSnapLead(all, updatedClips).filter((c) => c.type === 'text');
    const cuts = sl.map((s) => Math.round(s.start * 30));
    if (run === 0) first.push(...cuts);
    else assert(cuts.join() === first.join(), `${run + 1}회차 컷 위치가 달라짐: ${first.join(',')} → ${cuts.join(',')}`);
  }
});

test('R23', '한 문장을 3컷 이상으로 쪼개는 것을 피함', () => {
  const cs = caps([['그런데', 0.6], ['이건 욕실 타일이나', 1.4], ['창문 유리에 손으로', 1.3], ['꾹 눌러 붙이기만 하면', 1.6], ['되더라고요.', 0.6], ['정말 좋아요.', 1.5]]);
  const sl = A.buildSlotsFromCaptions(cs, totalOf(cs), { hi: 2.4, fps: 30 });
  const sentEnd = cs[5].startTime;
  const inner = sl.filter((s) => s.captionStart > 0.02 && s.captionStart < sentEnd - 0.02).length;
  assert(inner <= 1, `첫 문장 안에서 컷 ${inner + 1}개`);
});

test('R25', '대본 근거 장면: 문장을 찾아 지금 미디어의 장면으로 바꾸고, 대신 고를 때 가장 먼저', () => {
  const shots = [shot('1-01', 'D:/영상/a.mp4', 0, 3), shot('1-02', 'D:/영상/a.mp4', 3.1, 6), shot('2-01', 'D:/영상/b.mp4', 0, 4)];
  const entries = [
    { text: '거기다 인형 하나 얹어 두니까 베란다 분위기도 확 살더라고요.', scenes: [{ path: 'D:\\영상\\b.mp4', from: 0.5, to: 3 }] },
    { text: '가격 한번 확인해 보세요.', scenes: [{ path: 'D:/영상/a.mp4', from: 3.2, to: 5 }] },
  ];
  // 대본 AI가 적은 근거 장면 읽기: 장면 목록 형식("2번 영상 4.5~7초")과 짧은 형식 둘 다
  const media = [{ no: 1, path: 'a.mp4' }, { no: 2, path: 'b.mp4' }];
  const refs = SG.parseSceneRefs('2번 영상 4.5~7초; 1번 0~2.84초, 3번 1~2초', media);
  assert(refs.length === 2 && refs[0].path === 'b.mp4' && refs[0].from === 4.5 && refs[1].to === 2.84, '근거 장면 읽기 실패: ' + JSON.stringify(refs));
  const ids = A.basisShotIds({ text: '베란다 분위기도 확 살더라고요.', sentence: '거기다 인형 하나 얹어 두니까 베란다 분위기도 확 살더라고요.' }, entries, shots);
  assert(ids.join() === '2-01', `근거 장면 ${ids.join() || '없음'} (2-01 이어야 함, 경로 구분자가 달라도 같은 영상)`);
  assert(A.basisShotIds({ text: '전혀 다른 문장이에요.', sentence: '전혀 다른 문장이에요.' }, entries, shots).length === 0, '관계없는 문장에 근거 장면이 붙음');
  // AI 1순위를 못 쓸 때(이미 씀) 근거 장면이 다른 후보보다 먼저
  const sl = [slot(0, 0, 2), slot(1, 2, 4, false, { basis: ['2-01'] })];
  const r = A.fitAssignment(sl, [{ slot: 0, shot: '1-01', in: 0 }, { slot: 1, shot: '1-01', in: 0, alt: '1-02' }], shots, null, [], []);
  assert(r.clips[1].shot === '2-01', `둘째 컷 ${r.clips[1].shot} (근거 장면 2-01 이어야 함)`);
});

test('R27', '다른 광고와 겹침은 약하게만 피함: 코드가 겹친다는 이유로 장면을 바꾸지 않고, 지시문에 "금지 아님"이 있음', () => {
  // 다른 광고가 1-01 의 0~3초 전부를 썼어도, AI가 1-01 을 골랐으면 그대로 1-01
  const sl = [slot(0, 0, 2), slot(1, 2, 4)];
  const r = A.fitAssignment(sl, [{ slot: 0, shot: '1-01', in: 0.1 }, { slot: 1, shot: '2-01', in: 0.1 }], SH, null, [['a.mp4', 0, 3]], []);
  assert(r.clips[0].shot === '1-01', `다른 광고에서 쓴 장면이라 바뀜: ${r.clips[0].shot}`);
  // 같은 장면 안에 안 쓴 부분이 있으면 그쪽으로 시작점 옮김 (1-02 의 3.1~4.5 를 다른 광고가 씀 → 4.5 이후)
  const r2 = A.fitAssignment([slot(0, 0, 1.4)], [{ slot: 0, shot: '1-02', in: 3.2 }], SH, null, [['a.mp4', 3.1, 4.5]], []);
  assert(r2.clips[0].shot === '1-02' && r2.clips[0].srcIn >= 4.5 - 0.1, `안 쓴 부분으로 안 옮김 (겹침 0.1초 넘음): in=${r2.clips[0].srcIn}`);
  // 지시문 (다시 쓰다 빠지면 실패)
  const src = fs.readFileSync(path.join(ROOT, 'electron/autoEditAssign.ts'), 'utf8');
  assert(/8\. 다른 광고와 겹침 \(R27\)/.test(src) && src.includes('금지가 아니라 참고다') && src.includes('"대체"로 낮추지 않는다'), '지시문에 R27(다른 광고 겹침은 참고만) 문장이 없음');
  assert(/used_elsewhere \(다른 광고에서 쓴 구간 — 금지 아님/.test(src), 'used_elsewhere 목록 설명이 없음');
});

test('R30', '지시문: 슬롯 항목 설명·맞는 정도(fit) 기준이 있고, 근거 장면을 무조건 "딱 맞음"으로 적게 하지 않음 (2026-11-11 1묶음)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'electron/autoEditAssign.ts'), 'utf8');
  assert(src.includes('나레이션 슬롯의 항목:') && src.includes('sentence 그 대사가 들어 있는 문장 전체') && src.includes('next 는 바로 다음 슬롯의 대사'), '슬롯 항목(text/sentence/cont/next) 설명이 없음');
  assert(src.includes('id 는 "영상 번호-샷 번호"'), '샷 id 설명이 없음');
  assert(src.includes('"대체" = 1(핵심)이나 2(단계)가 안 맞음') && src.includes('"비슷함" = 1·2 는 맞고'), '맞는 정도(fit) 기준이 없음');
  assert(!/fit 은 "딱 맞음"\./.test(src) && src.includes('basis 라고 무조건 "딱 맞음"으로 적지 않는다'), '근거 장면을 무조건 "딱 맞음"으로 적게 함');
});

test('R28', '원본의 약한 화면 전환이 컷 처음·끝 0.15초 안에 걸리지 않음 (다음 화면 1~3프레임 비침 방지)', () => {
  // 1-01(0~3초) 안 1.95초에 약한 전환. AI가 in=1.0 으로 1초짜리 자리에 고르면 1.95~2.0초(끝 2프레임)에 다음 화면이 비침
  const shots = [{ ...shot('1-01', 'a.mp4', 0, 3), soft: [1.95] }, shot('2-01', 'b.mp4', 0, 3)];
  const r = A.fitAssignment([slot(0, 0, 1)], [{ slot: 0, shot: '1-01', in: 1.0 }], shots, null, [], []);
  const c = r.clips[0];
  const a = c.srcIn, b = c.srcIn + (c.end - c.start) * c.speed;
  const bad = c.shot === '1-01' && ((1.95 > a && 1.95 < a + 0.15) || (1.95 > b - 0.15 && 1.95 < b));
  assert(!bad, `약한 전환(1.95초)이 컷 ${a.toFixed(2)}~${b.toFixed(2)} 의 처음·끝에 걸림`);
  // 약한 전환이 없으면 AI가 고른 시작점 그대로 (쓸데없이 옮기지 않음)
  const r2 = A.fitAssignment([slot(0, 0, 1)], [{ slot: 0, shot: '1-01', in: 1.0 }], [shot('1-01', 'a.mp4', 0, 3)], null, [], []);
  assert(Math.abs(r2.clips[0].srcIn - 1.0) < 0.06, `약한 전환이 없는데 시작점이 바뀜: ${r2.clips[0].srcIn}`);
});

test('R13b', '같은 영상 연달아: 실제 화면(작은 그림)이 같아 보이면 금지, 확실히 다르면 허용 — AI 묶음 이름과 상관없이 (운동화 01 12.43초·02 47.95초, 2026-11-13)', () => {
  // a.mp4 를 0.5초마다 작은 그림으로: 0~9초는 같은 배경(한 번에 찍은 장면), 9초부터는 전혀 다른 화면
  const W = 12, H = 20, N = W * H * 3, frames = 32;
  const data = new Uint8Array(frames * N);
  for (let f = 0; f < frames; f++) for (let i = 0; i < N; i++) data[f * N + i] = f * 0.5 < 9 ? 120 + (i % 7) + (f % 3) : 20 + ((i * 13) % 200);
  const look = { step: 0.5, w: W, h: H, data };
  const shots = SH.map((s) => (s.path === 'a.mp4' ? { ...s, look } : s));
  // AI 는 동작마다 다른 묶음 이름을 붙임 (예전 판단 방식이면 '달라 보임'으로 허용됐던 경우)
  const d = (id, group, firstFrame, desc) => ({ id, desc, place: '', motion: 'low', parts: [], note: '', group, firstFrame });
  const descs = [d('1-01', '패치 크기 맞추기', '손에 든 파란 조각', '필름을 손에 들고 크기를 잼'), d('1-03', '패치 붙이기', '흰 운동화 뒤꿈치 안쪽', '뒤꿈치 안쪽에 꾹 눌러 붙임'), d('1-04', '신발 신어 보기', '초록 양말 신은 발', '발을 내밀어 신어 봄')];
  assert(!A.looksSameShot(descs[0], descs[1]), '시험 준비 잘못: 글 설명만으로도 같아 보인다고 판단함 (예전 방식으로도 통과돼 버림)');
  const r = A.fitAssignment(SLOTS4.slice(0, 2), [{ slot: 0, shot: '1-01', in: 0 }, { slot: 1, shot: '1-03', in: 6.1 }], shots, null, [], [], descs);
  assert(r.clips[1].shot !== '1-03', `같은 배경(같아 보임)인데 묶음 이름이 달라 연달아 들어감: ${r.clips[1].shot}`);
  // 같아 보여서 바꾼 자리는 세어서 알려 줌 (너무 많이 바뀌는 프로젝트를 알아채게), 대신 넣는 장면은 다른 영상 파일 먼저 (2026-11-13)
  assert(r.lookSwaps === 1, `같아 보여서 바꾼 자리 수가 ${r.lookSwaps} (1이어야 함)`);
  assert(r.clips[1].path !== 'a.mp4', `같아 보여서 막힌 자리에 또 같은 영상의 장면이 들어감: ${r.clips[1].shot}`);
  // 9초 뒤(1-04)는 화면이 확실히 다름 → 같은 영상이라도 허용 (창문 유리 문장 같은 경우)
  const r2 = A.fitAssignment(SLOTS4.slice(0, 2), [{ slot: 0, shot: '1-01', in: 0 }, { slot: 1, shot: '1-04', in: 9.1 }], shots, null, [], [], descs);
  assert(r2.clips[1].shot === '1-04' && r2.lookSwaps === 0, `화면이 다른데 막힘: ${r2.clips[1].shot}`);
  // 원본의 바로 다음 장면(1-02)이라도 같아 보이면 막음 (운동화 03 68.41초 3-07 → 3-08: 같은 배경에서 5초 건너뜀)
  const r3 = A.fitAssignment(SLOTS4.slice(0, 2), [{ slot: 0, shot: '1-01', in: 0 }, { slot: 1, shot: '1-02', in: 4.5 }], shots, null, [], [], descs);
  assert(r3.clips[1].shot !== '1-02' || Math.abs(r3.clips[1].srcIn - (r3.clips[0].srcIn + 2.5 * r3.clips[0].speed)) < 0.2, `바로 다음 장면이지만 같아 보이는데 건너뛰어 붙음: ${r3.clips[1].shot} ${r3.clips[1].srcIn}`);
  // 검사기도 같은 기준
  const bad = [{ path: 'a.mp4', start: 0, end: 2.5, srcIn: 0.06, speed: 1, shot: '1-01' }, { path: 'a.mp4', start: 2.5, end: 5, srcIn: 6.16, speed: 1, shot: '1-03' }];
  assert(has(issues(SLOTS4.slice(0, 2), bad, shots, { descs }), /같은 영상의 다른 부분/), '같아 보이는데 검사기가 경고 안 함');
  // 후킹: 지정 구간이 같은 배경 두 조각(0~3, 3.1~6)이면 하나로 쳐서 후킹 길이를 정하고, 조각을 이어 붙이지 않음 (운동화 01 후킹 1.70초)
  const cap = A.hookCapacity({ path: 'a.mp4', from: 0, to: 6 }, shots);
  assert(cap < 3.2, `같아 보이는 두 조각을 합쳐 후킹 길이 ${cap.toFixed(2)}초 (한 조각 길이여야 함)`);
  const hp = A.hookPieces(slot(0, 0, 3, true), { path: 'a.mp4', from: 0, to: 6 }, shots, []);
  assert(hp.length === 1, `후킹이 같아 보이는 조각 ${hp.length}개로 나뉨`);
});

test('R20b', '새 문장이 시작되면 앞 컷의 장면을 그대로 이어 쓰지 않음 (사용자 2026-11-13: 다음 문장인데 기존 영상이 쭉 이어지는 것이 가장 걸림)', () => {
  const shots = [shot('1-01', 'a.mp4', 0, 8), shot('2-01', 'b.mp4', 0, 5), shot('3-01', 'c.mp4', 0, 5)];
  const asg = [{ slot: 0, shot: '1-01', in: 0 }, { slot: 1, shot: '1-01', in: 0 }];
  // 새 문장(cont=false): AI가 같은 장면을 골라도 다른 장면으로
  const sl = [slot(0, 0, 2, false, { cont: false }), slot(1, 2, 4, false, { cont: false })];
  const r = A.fitAssignment(sl, asg, shots, null, [], []);
  assert(r.clips[1].shot !== '1-01', '새 문장인데 앞 장면이 그대로 이어짐');
  // 같은 문장(cont=true)은 이어 쓰기 그대로 (R20)
  const r2 = A.fitAssignment([sl[0], slot(1, 2, 4, false, { cont: true })], asg, shots, null, [], []);
  assert(r2.clips[1].shot === '1-01', '같은 문장의 이어 쓰기가 막힘');
  // 검사기도 알림
  const bad = [{ path: 'a.mp4', start: 0, end: 2, srcIn: 0.06, speed: 1, shot: '1-01' }, { path: 'a.mp4', start: 2, end: 4, srcIn: 2.06, speed: 1, shot: '1-01' }];
  assert(has(issues(sl, bad, shots), /새 문장인데/), '새 문장에서 장면이 이어지는데 검사기가 경고 안 함');
  assert(!has(issues([sl[0], slot(1, 2, 4, false, { cont: true })], bad, shots), /새 문장인데/), '같은 문장 이어 쓰기에 경고가 뜸');
  // 서로 다른 영상 파일끼리 화면이 비슷한 것은 경고하지 않음 (사용자 2026-11-13: 문장이 바뀌면서 컷이 바뀌면 괜찮음)
  assert(!/다른 영상이지만 화면이 비슷/.test(fs.readFileSync(path.join(ROOT, 'src/utils/autoEdit.ts'), 'utf8')), '다른 파일 화면 비슷함 경고가 다시 들어감');
});

test('R13d', "'같아 보임' 기준이 사용자가 사진으로 고른 답과 맞음 (eval_data/look-pairs — 고객 자료라 이 PC 에만 있음, 없으면 건너뜀)", () => {
  const f = path.join(ROOT, 'eval_data/look-pairs/pairs.json');
  if (!fs.existsSync(f)) return;
  const dec = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));
  const one = (p, data) => ({ ...shot('9-01', p, 0, 2), look: { step: 0.25, w: 12, h: 20, data: new Uint8Array([...data, ...data, ...data, ...data, ...data, ...data, ...data, ...data, ...data]) } });
  const wrong = [];
  for (const p of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    const sc = A.lookScore(one('x.mp4', dec(p.a)), 1, one('y.mp4', dec(p.b)), 1);
    if (!p.limit && sc < A.LOOK_SAME_SCORE !== p.same) wrong.push(`${p.no}번(${p.what}) 점수 ${sc.toFixed(2)} — 사용자는 ${p.same ? '같아 보임' : '괜찮음'}`);
  }
  assert(!wrong.length, `사용자 답과 다른 쌍: ${wrong.join(' / ')}`);
});

test('R04b', '이어 쓰기로 한 장면이 너무 오래 계속되지 않음: 코드가 대신 고를 땐 안 잇고, AI가 고른 건 검사기가 알림 (운동화 01 8.63~16.30초, 2026-11-13)', () => {
  const shots = [shot('1-01', 'a.mp4', 0, 20), shot('2-01', 'b.mp4', 0, 5), shot('3-01', 'c.mp4', 0, 5), shot('4-01', 'd.mp4', 0, 5)];
  const sl = [slot(0, 0, 3.5), slot(1, 3.5, 7, false, { cont: true })];
  const max = A.maxCutLen(A.shotLenCap(shots));
  assert(7 > max + 0.15, '시험 준비 잘못: 두 컷을 이어도 상한 안쪽');
  // AI 답이 틀려서(없는 장면) 코드가 대신 고름 → 앞 장면을 이어 붙여 7초짜리 한 장면을 만들면 안 됨
  const r = A.fitAssignment(sl, [{ slot: 0, shot: '1-01', in: 0 }, { slot: 1, shot: '9-99', in: 0 }], shots, null, [], []);
  assert(r.clips.length === 2 && r.clips[1].shot !== '1-01', `대신 고르면서 앞 장면을 이어 붙여 한 장면이 7초 계속됨 (${r.clips[1]?.shot})`);
  // AI가 직접 이어 쓰기를 고르면 그대로 두되(R20) 검사기가 알림
  const r2 = A.fitAssignment(sl, [{ slot: 0, shot: '1-01', in: 0 }, { slot: 1, shot: '1-01', in: 0 }], shots, null, [], []);
  assert(r2.clips[1].shot === '1-01', 'AI가 고른 이어 쓰기가 바뀜');
  assert(has(A.auditPlan(sl, r2.clips, shots, { hi: A.shotLenCap(shots), fps: 30 }), /한 장면이 .*계속됨/), '한 장면이 오래 계속되는데 검사기가 경고 안 함');
  // 상한 안쪽 이어 쓰기는 경고 없음
  const sl2 = [slot(0, 0, 2), slot(1, 2, 4, false, { cont: true })];
  const r3 = A.fitAssignment(sl2, [{ slot: 0, shot: '1-01', in: 0 }, { slot: 1, shot: '1-01', in: 0 }], shots, null, [], []);
  assert(!has(A.auditPlan(sl2, r3.clips, shots, { hi: A.shotLenCap(shots), fps: 30 }), /계속됨/), '짧은 이어 쓰기에 경고가 뜸');
});

test('R29', '컷은 자막이 바뀌기 3프레임 앞에서 (컷 자리 = 자막 시작 - 3프레임)', () => {
  const cs = caps([['이거 보세요.', 2.0], ['진짜 신기하죠.', 1.6], ['이렇게 붙이면 끝나요.', 2.4], ['정말 편해요.', 2.0], ['추천해요.', 2.0]]);
  const sl = A.buildSlotsFromCaptions(cs, totalOf(cs), { hi: 2.4, fps: 30 });
  for (const s of sl.slice(1)) {
    const lead = Math.round((s.captionStart - s.start) * 30);
    assert(lead === 3, `${s.captionStart.toFixed(2)}초 자막의 컷이 ${lead}프레임 앞 (3프레임이어야 함)`);
  }
});

test('R36', '손으로 클립을 늘릴 때 원본 장면이 바뀌는 곳에서 멈춤 + 미디어에서 넣을 때 제목 카드 건너뜀', () => {
  const SC = load('src/utils/sceneCuts.ts');
  // 운동화키트 02 마지막 클립: 원본 21.56초부터, 장면은 25.13초에 바뀜 → 끝을 늘려도 25.07초(경계 0.06초 안쪽)까지만
  const cuts = { shots: [[0.11, 4.03], [4.13, 25.09], [25.17, 36.6]], intro: 0.11, outro: 36.6 };
  const maxDur = SC.maxDurationInShot(cuts, 21.56, 1, 2.0);
  assert(Math.abs(21.56 + maxDur - (25.09 - SC.CUT_EDGE)) < 1e-6, `늘릴 수 있는 끝 ${(21.56 + maxDur).toFixed(2)}초 (25.03초여야 함)`);
  // 이미 경계를 넘은 클립은 줄이기는 자유 (지금 길이보다 작게 제한하지 않음)
  assert(SC.maxDurationInShot(cuts, 21.56, 1, 3.64) === 3.64, '이미 넘은 클립의 길이를 강제로 줄임');
  // 느리게 재생하는 클립은 속도만큼 길게 늘릴 수 있음
  assert(Math.abs(SC.maxDurationInShot(cuts, 21.56, 0.5, 1) - (25.03 - 21.56) / 0.5) < 1e-6, '속도를 반영하지 않음');
  // 앞을 늘릴 때: 장면 시작(4.13) 안쪽까지만
  assert(Math.abs(SC.minSourceStartInShot(cuts, 5, 7) - (4.13 + SC.CUT_EDGE)) < 1e-6, '앞 늘리기 한계가 장면 시작이 아님');
  // 미디어에서 넣을 때 앞 표지 0.11초 건너뜀 / 장면 구간을 아직 모르면 통째로
  const [a, b] = SC.usableRange(cuts, 36.6);
  assert(a === 0.11 && b === 36.6, `넣는 구간 ${a}~${b}`);
  const [a2] = SC.usableRange(undefined, 36.6);
  assert(a2 === 0, '장면 구간이 없는데 앞을 자름');
  // 타임라인이 실제로 이 계산을 씀 (빠지면 실패)
  const tl = fs.readFileSync(path.join(ROOT, 'src/components/TimelinePanel.tsx'), 'utf8');
  assert(tl.includes('maxDurationInShot(cutsForClip') && tl.includes('minSourceStartInShot(cutsForClip') && tl.includes('altHeld'), '타임라인 끌기에 장면 경계 멈춤이 빠짐');
  const st = fs.readFileSync(path.join(ROOT, 'src/store/useEditorStore.ts'), 'utf8');
  assert(st.includes('usableRange(getSceneCuts(asset.path)'), '미디어에서 넣을 때 제목 카드 건너뛰기가 빠짐');
});

// ---------- 자동 마스크 (컷 앞뒤 프레임) ----------
const M = load('src/utils/autoMask.ts');
const vclip = (sourceStart, duration, speed = 1) => ({ id: 'v', type: 'video', startTime: 10, duration, sourceStart, speed });
const track = (id, text, a, b, box = [0.2, 0.7, 0.8, 0.75]) => {
  const samples = [];
  for (let t = a; t < b - 1e-6; t += 0.2) samples.push({ t: +t.toFixed(3), box });
  return { id, text, conf: 0.9, hasHan: true, start: a, end: b, samples };
};
const SZ = { w: 1080, h: 1920 };

test('R26', '자동 마스크: 컷 직전·직후 1~2프레임에도 원본 글자가 안 보인다', () => {
  // 1) 클립(원본 2~4초) 끝 직후에 처음 잡힌 글자 → 실제론 마지막 프레임에 이미 나와 있을 수 있음 (운동화키트_01 6.57초)
  let ms = M.tracksToMasks([track('a', '鞋子刮破了', 4.1, 6)], vclip(2, 2), SZ, SZ);
  assert(ms.length === 1 && (ms[0].to ?? 2) >= 2 - 1e-6, `클립 끝 직후 글자를 버림/끝까지 안 가림: ${JSON.stringify(ms.map((m) => [m.from, m.to]))}`);
  // 2) 클립 시작 0.15초 뒤에 처음 잡힌 글자 → 처음부터 가림 (23.72초)
  ms = M.tracksToMasks([track('b', '不要扔', 2.15, 6)], vclip(2, 2), SZ, SZ);
  assert(ms.length === 1 && (ms[0].from ?? 0) === 0, `시작 직후 글자가 처음부터 안 가려짐: from=${ms[0]?.from}`);
  // 3) 같은 자리에서 문장만 바뀜(A → 0.4초 빈틈 → B) → 빈틈 없이 이어서
  ms = M.tracksToMasks([track('c', '第一句话', 0, 1.0), track('d', '另外内容', 1.4, 4)], vclip(0, 4), SZ, SZ);
  const [x, y] = [...ms].sort((p, q) => (p.from ?? 0) - (q.from ?? 0));
  assert(ms.length === 2 && x.to >= (y.from ?? 0) - 1e-6, `같은 자리 문장 사이 빈틈: ${x?.to} ~ ${y?.from}`);
  // 4) 예전에 만든 마스크(끝 0.05초 전에 꺼짐)도 미리보기·내보내기에선 클립 끝까지
  const old = [{ id: 'o', points: [[0, 0], [1, 0], [1, 1], [0, 1]], blur: 30, feather: 6, from: 0.1, to: 1.95, auto: 'x' }];
  const eff = M.effectiveMasks(old, 2)[0];
  assert(eff.from === undefined && eff.to === undefined, `예전 마스크 끝 처리 안 됨: ${eff.from} ~ ${eff.to}`);
  // 손으로 만든 마스크는 그대로
  const hand = M.effectiveMasks([{ ...old[0], auto: undefined }], 2)[0];
  assert(hand.from === 0.1 && hand.to === 1.95, '손으로 만든 마스크 구간을 바꿈');
});

// ---------- 결과 ----------
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.id} ${r.name}${r.ok ? '' : `\n     → ${r.msg}`}`);
console.log(`\n${results.length - failed.length}/${results.length} 통과${failed.length ? ` — 실패 ${failed.map((r) => r.id).join(', ')}` : ''}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
