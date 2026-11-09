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
});

test('R14', '비슷한 장면 묶음 연달아 → 검사기 경고', () => {
  const descs = [{ id: '1-01', group: '타일벽에 붙이기' }, { id: '2-01', group: '타일벽에 붙이기' }];
  const clips = [{ path: 'a.mp4', start: 0, end: 2.5, srcIn: 0, speed: 1, shot: '1-01' }, { path: 'b.mp4', start: 2.5, end: 5, srcIn: 0, speed: 1, shot: '2-01' }];
  assert(has(issues(SLOTS4.slice(0, 2), clips, SH, { descs }), /비슷한 장면/), '비슷한 장면 연속을 못 잡음');
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

// ---------- 결과 ----------
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.id} ${r.name}${r.ok ? '' : `\n     → ${r.msg}`}`);
console.log(`\n${results.length - failed.length}/${results.length} 통과${failed.length ? ` — 실패 ${failed.map((r) => r.id).join(', ')}` : ''}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
