"""
말하는 시간 기준으로 컷 자리(슬롯)를 나누고, 모델이 고른 샷을 붙여 컷 계획/검토 자료를 만든다.

사용 (torch 있는 파이썬 — flow_plan 의 검토 이미지/미리보기 재사용):
    python -X utf8 tools/premiere/slot_plan.py slots --project 길이조절거치대
    python -X utf8 tools/premiere/slot_plan.py apply --project 길이조절거치대 --seq 길이조절거치대01 --assign <배정.json> --tag haiku [--preview]

슬롯 규칙 (사용자 피드백 2026-11-02 + 편집자 실제 컷: 30초에 ~10컷, 1.5~5초):
  - 화면은 '말하는 시간'으로 나눈다. 대본 글자 수가 아님
  - 경계 후보 = 문장 끝, 또는 문장 안에서 0.15초 이상 쉬는 곳. 문장 끝을 가장 선호
  - 한 컷 1.3초 미만은 사실상 금지, 2.2~4.0초가 자연스러움, 4초를 넘으면 점점 감점
  - 후킹 = 지정 길이(보통 3초)에 가장 가까운 문장 끝까지
배정 파일 형식: [{"slot": 1, "shot": "5-03", "in": 16.0(선택, 원본 초)}, ...]  (슬롯 0 = 후킹은 대본 지정)
"""
import argparse
import json
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PUNCT_END = re.compile(r'[.?!…]+$')
CLAUSE_END = ('서', '고', '데', '니', '까', '면', '도', '며', '만', '라', '요', '다', '지', ',')
# 문장 안에서 끊어도 되는 말끝: 어미 + 조사 ('햇빛이랑 | 전조등', '바닥에 | 계속'). 그 밖(예: '눈 | 피로가')은 0.3초 이상 쉴 때만
BREAK_END = CLAUSE_END + ('랑', '은', '는', '을', '를', '에', '로', '게', '와', '과', '나')
MIN_SPEED, MIN_SPEED_HARD = 0.8, 0.6


def len_cost(L, hi=4.0):
    lo = min(2.2, hi - 0.6)
    if L < 1.3:
        return 8 + (1.3 - L) * 10
    if L < lo:
        return (lo - L) * 2.0
    if L <= hi:
        return 0.0
    return (L - hi) * 1.2


def shot_len_cap(project):
    """원본 샷이 짧은 프로젝트(햇빛가리개: 대부분 1~2초)는 컷도 짧게 — 편집자도 그렇게 함.
    상한 = 샷 길이 상위 25% + 0.5초, 2.4~4.0초 사이"""
    p = os.path.join('eval_data/shots', project, 'shots.json')
    if not os.path.exists(p):
        return 4.0
    d = sorted(s['dur'] for s in json.load(open(p, encoding='utf8'))['shots'])
    return float(min(4.0, max(2.4, d[int(len(d) * 0.75)] + 0.5)))


FPS = 30
CUT_LEAD_FRAMES = 3  # 컷을 말 시작보다 앞당기는 프레임 수
CAPTION_MAX_CHARS = 13  # 사용자 작업 기준 (편집자 자막: 띄어쓰기 빼고 최대 13자)


def app_captions(truth_path, seq_name, max_chars=CAPTION_MAX_CHARS):
    """앱의 자막 나누기 코드(caption_check.cjs)로 자막 조각과 화면에 나타나는 시점"""
    import subprocess
    here = os.path.dirname(os.path.abspath(__file__))
    r = subprocess.run(['node', os.path.join(here, 'caption_check.cjs'), truth_path, seq_name, str(max_chars)],
                       capture_output=True, stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode('utf8', 'replace'))
    return json.loads(r.stdout.decode('utf8'))['captions']


def boundaries(seq, caps):
    """(시간, 보너스, 설명) 후보 = 자막이 바뀌는 시점만 (사용자 2026-11-02: 영상 컷과 자막 전환이 같은 프레임이어야 함).
    시간 = 그 자막 조각 첫 단어가 발음되기 시작하는 프레임 (앱과 같은 계산)"""
    ws = seq['words']
    sent_first = set()
    k = 0
    for x in seq['sentences']:
        sent_first.add(k)
        k += len(x['text'].split())
    out = []
    for c in caps[1:]:
        i = c['firstWord']
        w1, w2 = ws[i - 1], ws[i]
        gap = (w2['start'] - w1['end']) if (w1['end'] is not None and w2['start'] is not None) else 0.2
        if i in sent_first:
            out.append((c['start'], 2.5 + min(gap, 0.6), '문장끝'))
        elif w1['text'].rstrip().endswith(BREAK_END) and gap >= 0.12:
            out.append((c['start'], min(gap, 0.5) * 3 + (0.6 if w1['text'].rstrip().endswith(CLAUSE_END) else 0), '쉼'))
        else:
            # 자막은 바뀌지만 말 덩어리 중간('막힘없이 쓱 | 쓸어버리면', '샤워기 | 바로 밑에') → 영상은 되도록 안 바꿈
            out.append((c['start'], -2.5, '약한경계'))
    return out


def make_slots(seq, caps, hi=4.0):
    total = seq['duration']
    cands = boundaries(seq, caps)
    hs = seq.get('hookSpec')
    hook_sec = (hs or {}).get('sec', 3.0)
    # 후킹: 지정 길이에 가장 가까운 문장 끝
    ends = [c for c in cands if c[2] == '문장끝' and 1.0 <= c[0] <= hook_sec + 0.6]
    hook_end = min(ends, key=lambda c: abs(c[0] - hook_sec))[0] if ends else min(cands, key=lambda c: abs(c[0] - hook_sec))[0]
    pts = [(hook_end, 0, '후킹')] + [c for c in cands if c[0] > hook_end + 0.5] + [(total, 0, '끝')]
    # DP: 슬롯 비용 합 - 경계 보너스 + 컷마다 1.0 (적은 컷 선호)
    send = [c[0] for c in cands if c[2] == '문장끝']
    n = len(pts)
    best = [1e9] * n
    prev = [-1] * n
    best[0] = 0.0
    for j in range(1, n):
        for i in range(j):
            L = pts[j][0] - pts[i][0]
            if L > 9:
                continue
            c = best[i] + len_cost(L, hi) + 1.0 - (pts[j][1] if j < n - 1 else 0)
            if any(pts[i][0] + 0.8 < e < pts[j][0] - 0.8 for e in send):
                c += 3.0  # 한 컷이 문장 끝을 걸치지 않게
            if c < best[j]:
                best[j], prev[j] = c, i
    idx, j = [], n - 1
    while j > 0:
        idx.append(j)
        j = prev[j]
    times = [0.0] + [pts[0][0]] + [pts[k][0] for k in reversed(idx)]
    ws = [w for w in seq['words'] if w['start'] is not None]
    # 컷은 말(=자막 전환)보다 3프레임 앞 (편집자 완성본: 컷·자막 모두 말보다 0.04~0.16초 앞).
    # 앱의 '클립에 자막 맞추기'가 근처 자막 경계를 이 컷으로 당겨 붙임
    lead = lambda t: t if t <= 0 or t >= total - 1e-6 else max(0.0, round((round(t * FPS) - CUT_LEAD_FRAMES) / FPS, 4))
    slots = []
    for k, (a, b) in enumerate(zip(times, times[1:])):
        text = ' '.join(w['text'] for w in ws if a - 0.02 <= w['start'] < b - 0.02)
        la, lb = lead(a), lead(b)
        slots.append({'slot': k, 'start': round(la, 3), 'end': round(lb, 3), 'dur': round(lb - la, 3), 'text': text,
                      'hook': k == 0, 'captionStart': round(a, 3)})
    return slots


def cmd_slots(a):
    truth = json.load(open(os.path.join('eval_data/truth', a.project + '.json'), encoding='utf8'))
    out_dir = os.path.join('eval_data/shots', a.project)
    os.makedirs(out_dir, exist_ok=True)
    hi = shot_len_cap(a.project)
    print(f'컷 길이 상한 {hi:.1f}초')
    for seq in truth['sequences']:
        caps = app_captions(os.path.join('eval_data/truth', a.project + '.json'), seq['sequence'])
        slots = make_slots(seq, caps, hi)
        hs = seq.get('hookSpec')
        json.dump({'sequence': seq['sequence'], 'duration': seq['duration'], 'hookSpec': hs, 'slots': slots,
                   'captions': [{'start': c['start'], 'text': c['text']} for c in caps]},
                  open(os.path.join(out_dir, f"slots_{seq['sequence']}.json"), 'w', encoding='utf8'), ensure_ascii=False, indent=1)
        ed = [round(c['start'], 2) for c in seq['allCuts']][1:]
        mine = [s['start'] for s in slots][1:]
        hit = sum(any(abs(m - e) < 0.35 for e in ed) for m in mine)
        print(f"== {seq['sequence']}: 슬롯 {len(slots)}개 (편집자 {len(seq['allCuts'])}컷), 경계 일치 {hit}/{len(mine)}")
        for s in slots:
            print(f"  {s['start']:5.2f}-{s['end']:5.2f} ({s['dur']:.2f}) {s['text']}")
        print('  편집자 컷:', ed)


# ---------- 배정 → 컷 계획 ----------

def load_shots(project):
    d = json.load(open(os.path.join('eval_data/shots', project, 'shots.json'), encoding='utf8'))
    return {s['id']: s for s in d['shots']}


def hook_pieces(s, hs, shots, caps=()):
    """후킹: 광고주 지정 구간(from~to) 안의 샷만 순서대로. 한 샷으로 모자라면 나눈다.
    후킹 안에서는 자막과 상관없이 나눌 수 있음 (사용자 2026-11-02 '(가)': 편집자도 햇빛가리개02 후킹을 자막 전환이
    아닌 1.1초에서 나눔). 자막이 바뀌는 시점이면 조금 더 선호. 조각은 1초 이상.
    느려지는 정도(길이 가중), 조각 수, 지정 시작 샷을 건너뛰는 것(광고주 의도와 어긋남)에 감점"""
    from itertools import combinations
    f, t0, to = hs['file'], hs['from'], hs.get('to', hs['from'] + 30)
    seg = sorted((x for x in shots.values() if x['file'] == f and x['end'] > t0 and x['start'] < to), key=lambda x: x['start'])
    src = []  # (샷, 쓸 수 있는 시작, 끝)
    for x in seg:
        a0 = max(x['start'], t0) + (0 if x['start'] >= t0 else 0)
        a1 = min(x['end'], to + 0.5)
        if a1 - a0 >= 0.3:
            src.append((x, a0, a1))
    if src and src[0][2] - src[0][1] < 0.5 and len(src) > 1:  # 지정 시각이 샷 끝자락이면 다음 샷부터
        src = src[1:]
    S, E = s['start'], s['end']
    capset = [c for c in caps if S + 1.0 <= c <= E - 1.0]
    grid = sorted(set([round(x, 3) for x in np.arange(S + 1.0, E - 1.0 + 1e-6, 0.1)] + capset))
    best = None
    for m in range(1, min(3, len(src)) + 1):
        for cut in combinations(grid, m - 1):
            edges = [S, *cut, E]
            if any(b - a < 1.0 - 1e-6 for a, b in zip(edges, edges[1:])):
                continue
            for pick in combinations(range(len(src)), m):
                sps, pen = [], 0.0
                for k, j in enumerate(pick):
                    dur = edges[k + 1] - edges[k]
                    sp = min(2.0, (src[j][2] - src[j][1] - 0.1) / dur)
                    sps.append(sp)
                    pen += dur * (max(0.0, 0.6 - sp) * 10 + max(0.0, 0.8 - sp) * 2)
                pen += 0.5 * (m - 1) + 1.0 * pick[0]
                pen -= 0.2 * sum(1 for c in cut if any(abs(c - x) < 0.02 for x in capset))
                if best is None or pen < best[0]:
                    best = (pen, edges, pick, sps)
    if best is None:
        return []
    _pen, edges, pick, sps = best
    out = []
    for k, j in enumerate(pick):
        x, a0, _a1 = src[j]
        sp = max(0.3, np.floor(sps[k] * 100) / 100)
        dur = edges[k + 1] - edges[k]
        out.append(dict(s, start=round(edges[k], 3), end=round(edges[k + 1], 3), dur=round(dur, 2), file=f, shot=x['id'],
                        srcIn=round(a0 + (0.05 if a0 <= x['start'] + 0.01 else 0), 3),
                        srcOut=round(a0 + dur * sp, 3), speed=round(float(sp), 2), kind='hook'))
    return out


def overlap(f, t0, t1, avoid):
    return sum(max(0.0, min(t1, b) - max(t0, a)) for ff, a, b in avoid if ff == f)


EDGE = 0.05  # 샷 경계에서 띄우는 여유 (30fps 1.5프레임). 경계 시각은 0.01초로 반올림돼 있음


def guard_shot_edges(plan, shots, warns):
    """최종 안전장치: 어떤 컷도 원본 샷 경계를 넘지 않게 (넘으면 다음 장면이 1~2프레임 비침 — 사용자: 절대 안 나오게).
    속도 하한(0.6배)에 걸려 원본이 모자라도 경계를 넘기는 대신 더 느리게 맞춘다"""
    for p in plan:
        sh = shots.get(p.get('shot'))
        if not sh:
            continue
        lo, hi = sh['start'] + EDGE, sh['end'] - EDGE
        if p['srcIn'] < lo:
            p['srcIn'] = round(lo, 3)
        dur = p['end'] - p['start']
        if p['srcIn'] + dur * p['speed'] > hi:
            sp = np.floor((hi - p['srcIn']) / dur * 100) / 100
            warns.append(f"{p['start']:.2f}초 컷: 샷 {sh['id']} 끝을 넘어 {p['speed']}→{sp}배속으로 조정")
            p['speed'] = float(sp)
        p['srcOut'] = round(p['srcIn'] + dur * p['speed'], 3)
    return plan


def fit(slots, assign, shots, hs, avoid=(), caps=()):
    """배정을 원본 구간/속도로. 샷 경계를 넘지 않음. 같은 샷이 이어지면 이어서 재생.
    avoid = 다른 광고에서 쓴 원본 구간 [(파일, 시작, 끝)]. 같은 샷을 다시 쓰면 그 샷 안에서 안 쓴 부분을 고름
    (사용자 2026-11-02: 같은 원본으로 만든 광고들끼리 겹침 줄이기). 이 광고의 후킹/앞 컷도 자동으로 피함"""
    amap = {x['slot']: x for x in assign}
    plan, warns = [], []
    avoid = list(avoid)
    prev = None
    for s in slots:
        D = s['end'] - s['start']
        if s['hook']:
            for piece in hook_pieces(s, hs, shots, caps):
                plan.append(piece)
                avoid.append((piece['file'], piece['srcIn'], piece['srcOut']))
            prev = None
            continue
        x = amap.get(s['slot'])
        if not x or x.get('shot') not in shots:
            warns.append(f"슬롯 {s['slot']}: 배정 없음/잘못된 샷 {x}")
            continue
        sh = shots[x['shot']]
        s0, s1 = sh['start'] + 0.05, sh['end'] - 0.05
        want = min(max(float(x.get('in', s0)), s0), s1 - 0.3)
        if prev and prev['shot'] == sh['id'] and prev['srcOut'] < s1 - 0.3 and x.get('in') is None:
            t0, kind, sp = prev['srcOut'], 'continue', 1.0
            if s1 - t0 < D:
                sp = max(MIN_SPEED_HARD, np.floor((s1 - t0) / D * 20) / 20)
        else:
            kind = 'cut'
            if s1 - s0 >= D:  # 샷이 넉넉하면: 이미 쓴 구간과 덜 겹치는 시작점, 같으면 모델이 고른 시작점에 가깝게
                cands = list(np.arange(s0, s1 - D + 1e-6, 0.1)) + [s1 - D]
                t0 = min(cands, key=lambda t: (round(overlap(sh['file'], t, t + D, avoid), 1), abs(t - want)))
                sp = 1.0
            else:
                t0 = s0
                sp = max(MIN_SPEED_HARD, np.floor((s1 - s0) / D * 20) / 20)
        if sp < MIN_SPEED:
            warns.append(f"슬롯 {s['slot']}: 샷 {sh['id']} 이 짧아 {sp:.2f}배속")
        t1 = t0 + D * sp
        ov = overlap(sh['file'], t0, t1, avoid)
        if ov > 0.3:
            warns.append(f"슬롯 {s['slot']}: 샷 {sh['id']} 이미 쓴 구간과 {ov:.1f}초 겹침")
        p = dict(s, file=sh['file'], shot=sh['id'], srcIn=round(float(t0), 3), srcOut=round(float(t1), 3), speed=float(sp),
                 kind=kind, why=x.get('why', ''), overlap=round(ov, 2))
        plan.append(p)
        avoid.append((p['file'], p['srcIn'], p['srcOut']))
        prev = p
    return guard_shot_edges(plan, shots, warns), warns


def other_plans_used(project, seq, tag):
    """같은 프로젝트에서 이 태그로 이미 만든 다른 광고들이 쓴 원본 구간"""
    truth = json.load(open(os.path.join('eval_data/truth', project + '.json'), encoding='utf8'))
    out = []
    for st in truth['sequences']:
        p = os.path.join('eval_data/plans', tag, f"{st['sequence']}.json")
        if st['sequence'] == seq or not os.path.exists(p):
            continue
        for c in json.load(open(p, encoding='utf8'))['plan']:
            out.append((c['file'], c['srcIn'], c['srcOut'], st['sequence'], c.get('shot')))
    return out


def cmd_used(a):
    """모델에게 줄 '이미 쓴 장면' 목록: 이 광고의 후킹 + 다른 광고들"""
    sl = json.load(open(os.path.join('eval_data/shots', a.project, f'slots_{a.seq}.json'), encoding='utf8'))
    shots = load_shots(a.project)
    hook = hook_pieces(sl['slots'][0], sl['hookSpec'], shots, [c['start'] for c in sl.get('captions', [])])
    res = {'sequence': a.seq,
           'hook_used': [{'shot': h['shot'], 'from': round(h['srcIn'], 2), 'to': round(float(h['srcOut']), 2)} for h in hook],
           'used_elsewhere': [{'shot': sh, 'from': round(t0, 2), 'to': round(t1, 2), 'in': sq}
                              for f, t0, t1, sq, sh in other_plans_used(a.project, a.seq, a.tag)]}
    out = os.path.join('eval_data/plans', a.tag, f'used_{a.seq}.json')
    json.dump(res, open(out, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
    print(out, f"후킹 {len(res['hook_used'])}개, 다른 광고 {len(res['used_elsewhere'])}개")


def write_app_plan(seq, plan, paths, duration, seq_cuts, out):
    """앱 '자동 편집 계획 불러오기'용 파일: <시퀀스>_app.json (+ 음성 <시퀀스>_voice.wav).
    지금은 정답표의 편집자 음성 배치(무음 제거된 TTS)를 wav 한 개로 만들어 함께 넣는다 — 계획 시각이 이 음성 기준이라서.
    (실제 기능에서는 앱 타임라인에 이미 있는 음성을 기준으로 계획을 만든다)"""
    from build_truth import voice_clips, render_voice
    wav = os.path.abspath(os.path.join(out, f'{seq}_voice.wav'))
    if not os.path.exists(wav):
        clips, _ = voice_clips(seq_cuts)
        render_voice(clips, duration, wav)
    app = {
        'format': 'auto-edit-plan/v1',
        'sequence': seq,
        'duration': round(float(duration), 3),
        'voice': {'path': wav, 'start': 0.0},
        'clips': [{'path': os.path.abspath(paths[p['file']]), 'file': p['file'], 'start': p['start'], 'end': p['end'],
                   'srcIn': p['srcIn'], 'speed': p['speed'], 'shot': p.get('shot'), 'text': p.get('text', ''),
                   'hook': p.get('kind') == 'hook'} for p in plan],
    }
    json.dump(app, open(os.path.join(out, f'{seq}_app.json'), 'w', encoding='utf8'), ensure_ascii=False, indent=1)


def cmd_apply(a):
    from flow_plan import review_sheet, preview
    from shot_match_eval import frame_list
    sl = json.load(open(os.path.join('eval_data/shots', a.project, f'slots_{a.seq}.json'), encoding='utf8'))
    assign = json.load(open(a.assign, encoding='utf8'))
    assign = assign.get('assign', assign) if isinstance(assign, dict) else assign
    shots = load_shots(a.project)
    avoid = [(f, t0, t1) for f, t0, t1, _sq, _sh in other_plans_used(a.project, a.seq, a.tag)]
    plan, warns = fit(sl['slots'], assign, shots, sl['hookSpec'], avoid, [c['start'] for c in sl.get('captions', [])])
    cuts = json.load(open(os.path.join('eval_data/cuts', a.project + '.json'), encoding='utf8'))
    paths = {}
    for s in cuts['sequences']:
        for c in s['video']:
            if c.get('src'):
                paths[os.path.basename(c['src'])] = c['src']
    sources = {}
    for f in {p['file'] for p in plan}:
        fl = frame_list(os.path.join('eval_data/frames', a.project, os.path.splitext(f)[0]))
        sources[f] = {'path': paths[f], 'times': np.array([t for _p, t in fl]), 'frames': [p for p, _t in fl]}
    for k, p in enumerate(plan):
        p['sentence'] = k  # 검토 이미지에 슬롯마다 대사 표시
    out = os.path.join('eval_data/plans', a.tag)
    os.makedirs(out, exist_ok=True)
    write_app_plan(a.seq, plan, paths, sl['duration'], next(s for s in cuts['sequences'] if s['name'] == a.seq), out)
    json.dump({'sequence': a.seq, 'tag': a.tag, 'plan': plan, 'warnings': warns},
              open(os.path.join(out, f'{a.seq}.json'), 'w', encoding='utf8'), ensure_ascii=False, indent=1)
    review_sheet(plan, sources, os.path.join(out, f'{a.seq}_review.jpg'), f'{a.seq} 슬롯 배정 [{a.tag}]')
    if a.preview:
        seq_cuts = next(s for s in cuts['sequences'] if s['name'] == a.seq)
        mp4 = os.path.join(out, f'{a.seq}_preview.mp4')
        preview(plan, sources, seq_cuts, sl['duration'], mp4)
        # 검사: 컷 경계가 아닌 곳에서 화면이 확 바뀌면 경고 (움직임이 큰 장면도 걸릴 수 있으니 눈으로 확인)
        from shots import scene_scores
        bounds = [p['start'] for p in plan][1:]
        odd = [round(t, 2) for t, sc in scene_scores(mp4) if sc >= 0.15 and not any(abs(t - b) < 0.05 for b in bounds)]
        if odd:
            warns.append(f'미리보기에서 컷 경계가 아닌 화면 전환 의심: {odd}초')
    for p in plan:
        print(f"  {p['start']:5.2f}-{p['end']:5.2f} {p.get('shot') or 'hook':6s} {p['file']} {p['srcIn']:.1f}-{p['srcOut']:.1f} "
              f"x{p['speed']} {p['kind']:8s} {p['text']}")
    for w in warns:
        print('  ! ' + w)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    s1 = sub.add_parser('slots')
    s1.add_argument('--project', required=True)
    s3 = sub.add_parser('used')
    s3.add_argument('--project', required=True)
    s3.add_argument('--seq', required=True)
    s3.add_argument('--tag', required=True)
    s2 = sub.add_parser('apply')
    s2.add_argument('--project', required=True)
    s2.add_argument('--seq', required=True)
    s2.add_argument('--assign', required=True)
    s2.add_argument('--tag', required=True)
    s2.add_argument('--preview', action='store_true')
    a = ap.parse_args()
    {'slots': cmd_slots, 'apply': cmd_apply, 'used': cmd_used}[a.cmd](a)


if __name__ == '__main__':
    main()
