"""
흐름 기반 자동 컷 배치 v1 (정답표의 음성/대본 정렬을 입력으로 사용) + 검토 자료 만들기

사용 (torch/transformers 있는 파이썬):
    python -X utf8 tools/premiere/flow_plan.py --projects 길이조절거치대,햇빛가리개,스티커1 [--preview]

규칙 (정답표 통계 기반):
  - 후킹: 대본 지정(파일, 시작~끝, '빠르게')이 있으면 그대로, 없으면 첫 문장과 가장 어울리는 장면
  - 컷 경계: 문장 시작 직전(말 사이 틈). 3.4초 넘는 구간은 말 사이 틈에서 ~2초 단위로 나눔
  - 다음 장면: 같은 파일 이어서 / 다음 장면 전환 지점으로 건너뛰기 / (문장 시작에서만) 다른 파일로
      점수 = 문장-장면 어울림(한국어 CLIP, 문장 안에서 표준화) + 흐름 가산점
             - 이미 쓴 구간 다시 쓰기 감점 - 원본 장면 전환에 걸치는 컷 감점
출력: eval_data/plans/<프로젝트>.json, 검토 이미지 <시퀀스>_review.jpg, (--preview) 미리보기 <시퀀스>_preview.mp4
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_truth import voice_clips, render_voice  # noqa: E402
from shot_match_eval import STEP, extract_frames, frame_list, video_duration, load_model  # noqa: E402

FONT = 'C:/Windows/Fonts/malgun.ttf'
MAX_CUT, TARGET_CUT, MIN_CUT = 3.4, 2.0, 0.9
PIECE_MIN = 1.2      # 이보다 짧은 자투리 컷은 만들지 않음 (대신 속도를 줄여 이어감)
MIN_SPEED = 0.75     # 느리게 늘릴 수 있는 한계 (편집자 주로 0.6~0.95)
MAX_SHOT = 3.6       # 한 장면(같은 구도로 이어 쓰기 포함)을 끄는 최대 길이
SIMILAR = 0.92       # 앞 컷 끝과 새 컷 시작 그림이 이보다 비슷하면 바꾼 의미가 없음
BONUS = {'continue': 0.6, 'skip': 0.3, 'switch': 0.0}
REUSE_PENALTY, STRADDLE_PENALTY = 3.0, 0.5


def scene_changes(path, thresh=0.3):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', path, '-vf', f"scale=320:-2,select='gt(scene,{thresh})',showinfo",
                        '-an', '-f', 'null', '-'], capture_output=True, stdin=subprocess.DEVNULL)
    return [float(m) for m in re.findall(r'pts_time:([\d.]+)', r.stderr.decode('utf8', 'replace'))]


# ---------- 원본 영상 준비 (프레임, 임베딩, 장면 전환) ----------

def prepare_sources(pname, cuts_json, model, frames_root='eval_data/frames'):
    srcs = {}
    for s in cuts_json['sequences']:
        for c in s['video']:
            if c.get('src') and os.path.exists(c['src']) and c['src'].lower().endswith(('.mp4', '.mov')):
                srcs[os.path.basename(c['src'])] = c['src']
    out = {}
    for fname, src in sorted(srcs.items()):
        fd = os.path.join(frames_root, pname, os.path.splitext(fname)[0])
        extract_frames(src, fd)
        fl = frame_list(fd)
        cache = os.path.join(fd, 'koclip.npz')
        if os.path.exists(cache):
            z = np.load(cache)
            emb, scenes, dur = z['emb'], list(z['scenes']), float(z['dur'])
        else:
            emb = model.images([p for p, _t in fl])
            scenes = scene_changes(src)
            dur = video_duration(src) or len(fl) * STEP
            np.savez(cache, emb=emb, scenes=np.array(scenes), dur=dur)
        out[fname] = {'path': src, 'times': np.array([t for _p, t in fl]), 'frames': [p for p, _t in fl],
                      'emb': emb, 'scenes': scenes, 'dur': dur}
    return out


# ---------- 타임라인 구간 나누기 ----------

def segments(seq_truth):
    """(시작, 끝, 문장 번호, 문장 시작 여부). 경계는 말 사이 틈(다음 단어 시작 0.08초 전).
    3.4초 넘는 구간은 쉼이 가장 긴 곳부터 나눔 (말 호흡 단위로 화면 전환)"""
    ws = [w for w in seq_truth['words'] if w['start'] is not None]
    sents = [x for x in seq_truth['sentences'] if x['start'] is not None]
    total = seq_truth['duration']
    starts = [0.0] + [max(0.0, x['start'] - 0.08) for x in sents[1:]]
    pauses = [(max(w2['start'] - 0.08, w1['end']), w2['start'] - w1['end']) for w1, w2 in zip(ws, ws[1:])]

    def split(a, b):
        if b - a <= MAX_CUT:
            return [a, b]
        cand = [(t, pz) for t, pz in pauses if a + PIECE_MIN <= t <= b - PIECE_MIN]
        if not cand:
            return [a, b]
        t = max(cand, key=lambda x: (round(x[1], 2), -abs(x[0] - (a + b) / 2)))[0]
        return split(a, t)[:-1] + split(t, b)

    out = []
    for i, x in enumerate(sents):
        a = starts[i]
        b = starts[i + 1] if i + 1 < len(sents) else total
        cuts = split(a, b)
        for k in range(len(cuts) - 1):
            out.append((cuts[k], cuts[k + 1], i, k == 0))
    return out, sents


# ---------- 배치 ----------

def window_score(src, sim_row, t0, t1):
    m = (src['times'] >= t0 - 0.25) & (src['times'] <= t1 + 0.25)
    return float(sim_row[m].mean()) if m.any() else None


def overlap_used(used, f, t0, t1):
    return sum(max(0.0, min(t1, b) - max(t0, a)) for uf, a, b in used if uf == f)


def straddles(src, t0, t1):
    return any(t0 + 0.3 < c < t1 - 0.3 for c in src['scenes'])


def plan_sequence(seq_truth, sources, sent_emb):
    """v2: 컷 안에 원본 장면 전환이 들어가지 않게 (장면이 짧으면 말 사이 틈에서 컷을 더 나눔)"""
    segs, sents = segments(seq_truth)
    hs = seq_truth.get('hookSpec')
    hook_end = (hs or {}).get('sec', 3.0)
    gaps = sorted({max(0.0, w['start'] - 0.08) for w in seq_truth['words'] if w['start'] is not None})
    # 대본 전체와의 관련도: 제품과 상관없는 장면(다른 용도 시연 등) 덜 고르게
    sv = sent_emb.mean(0)
    sv = sv / (np.linalg.norm(sv) + 1e-9)
    allr = np.concatenate([src['emb'] @ sv for src in sources.values()])
    rel = {f: (src['emb'] @ sv - allr.mean()) / (allr.std() + 1e-6) for f, src in sources.items()}
    used, plan = [], []
    cur = None  # (file, 원본 위치)
    shot_len, last_emb = 0.0, None
    queue = list(segs)
    first = True
    while queue:
        a, b, sidx, sent_start = queue.pop(0)
        cands = []
        sims = {f: src['emb'] @ sent_emb[sidx] for f, src in sources.items()}
        allv = np.concatenate(list(sims.values()))
        mu, sd = allv.mean(), allv.std() + 1e-6

        def add(kind, f, t0, speed=1.0, bonus=None):
            src = sources[f]
            if t0 < 0 or t0 > src['dur'] - 0.3:
                return
            scene_end = min([c for c in src['scenes'] if c > t0 + 0.05] + [src['dur'] - 0.05])
            pen = 0.0
            if (scene_end - t0) / speed >= b - a - 0.02:
                end = b
            elif kind != 'hook' and (scene_end - t0) / (b - a) >= MIN_SPEED:
                # 장면이 조금 모자라면 느리게 늘려서 한 장면으로 끝까지 (자투리 컷 대신)
                speed = max(MIN_SPEED, np.floor((scene_end - t0) / (b - a) * 20) / 20)
                end = b
                pen += 0.1
            else:
                avail = (scene_end - t0) / speed
                gs = [g for g in gaps if a + PIECE_MIN <= g <= a + avail and g <= b - PIECE_MIN]
                if not gs:
                    return
                end = max(gs)
                pen += 0.2
            if kind == 'continue' and shot_len + (end - a) > MAX_SHOT:
                return  # 같은 구도로 너무 오래 끌지 않음
            t1 = t0 + (end - a) * speed
            w = window_score(src, sims[f], t0, t1)
            if w is None:
                return
            m = (src['times'] >= t0 - 0.25) & (src['times'] <= t1 + 0.25)
            sc = (w - mu) / sd + (BONUS.get(kind, 0) if bonus is None else bonus) + 0.5 * float(rel[f][m].mean()) - pen
            sc -= REUSE_PENALTY * overlap_used(used, f, t0, t1) / (end - a)
            if kind in ('skip', 'switch') and last_emb is not None:
                i0 = int(np.argmin(np.abs(src['times'] - (t0 + 0.25))))
                if float(src['emb'][i0] @ last_emb) > SIMILAR:
                    sc -= 0.6
            cands.append((kind, f, t0, speed, sc, end))

        in_hook = hs is not None and a < hook_end - 0.3
        if first and hs and hs['file'] in sources:
            speed = 1.5 if '빠르게' in (hs.get('note') or '') else 1.0
            add('hook', hs['file'], hs['from'], speed, bonus=99.0)
            if not cands:
                cands.append(('hook', hs['file'], hs['from'], speed, 99.0, b))
        else:
            if cur:
                f, pos = cur
                add('continue', f, pos)
                for c in sources[f]['scenes']:
                    if pos + 0.5 < c <= pos + 6.0:
                        add('skip', f, c)
                if in_hook:  # 후킹 구간 안에서는 지정 파일 유지
                    cands = [c for c in cands if c[1] == f] or cands
            if (sent_start or not cands) and not (in_hook and cands):
                for f, src in sources.items():
                    if cur and f == cur[0]:
                        continue
                    starts = [0.0] + [c for c in src['scenes']] + list(np.arange(0.0, src['dur'], 1.0))
                    for t0 in sorted(set(round(float(x), 2) for x in starts)):
                        add('switch', f, t0)
        if not cands:  # 어떤 장면도 안 맞으면 가장 긴 파일 처음부터 (장면 전환 허용)
            f = max(sources, key=lambda k: sources[k]['dur'])
            cands.append(('fallback', f, 0.0, 1.0, -9, b))
        kind, f, t0, speed, sc, end = max(cands, key=lambda c: c[4])
        t1 = t0 + (end - a) * speed
        plan.append({'start': round(a, 3), 'end': round(end, 3), 'file': f, 'srcIn': round(float(t0), 3),
                     'srcOut': round(float(t1), 3), 'speed': float(speed), 'kind': kind, 'sentence': sidx,
                     'text': sents[sidx]['text'], 'score': round(float(sc), 2)})
        used.append((f, t0, t1))
        cur = (f, t1)
        shot_len = shot_len + (end - a) if kind == 'continue' else (end - a)
        src = sources[f]
        last_emb = src['emb'][int(np.argmin(np.abs(src['times'] - (t1 - 0.25))))]
        first = False
        if end < b - 1e-3:
            queue.insert(0, (end, b, sidx, False))
    return merge_short_tails(plan, sources)


def merge_short_tails(plan, sources, tail=1.6, min_speed=0.65):
    """문장 끝 짧은 자투리 컷 → 앞 장면을 느리게 늘려 하나로 (사용자 피드백: '시커먼 물때… / 진짜 순식간이잖아요')"""
    i = 1
    while i < len(plan):
        p = plan[i]
        last_of_sentence = i == len(plan) - 1 or plan[i + 1]['sentence'] != p['sentence']
        if (p['end'] - p['start'] < tail and last_of_sentence and plan[i - 1]['sentence'] == p['sentence']
                and p['kind'] != 'hook'):
            j = i - 1
            while j > 0 and plan[j]['kind'] == 'continue' and plan[j - 1]['file'] == plan[j]['file']:
                j -= 1
            q = plan[j]
            if q['kind'] != 'hook':
                src = sources[q['file']]
                scene_end = min([c for c in src['scenes'] if c > q['srcIn'] + 0.05] + [src['dur'] - 0.05])
                span = p['end'] - q['start']
                sp = (scene_end - q['srcIn']) / span
                if sp >= min_speed:
                    sp = min(1.0, np.floor(sp * 20) / 20)
                    merged = dict(q, end=p['end'], srcOut=round(float(q['srcIn'] + span * sp), 3), speed=float(sp), merged=True)
                    plan[j:i + 1] = [merged]
                    i = j + 1
                    continue
        i += 1
    return plan


# ---------- 검토 자료 ----------

def review_sheet(plan, sources, out_jpg, title):
    font = ImageFont.truetype(FONT, 22)
    small = ImageFont.truetype(FONT, 18)
    tw, th = 135, 240
    rows = []
    for p in plan:
        src = sources[p['file']]
        ts = [p['srcIn'] + (p['srcOut'] - p['srcIn']) * r for r in (0.1, 0.5, 0.9)]
        ims = []
        for t in ts:
            i = int(np.argmin(np.abs(src['times'] - t)))
            ims.append(Image.open(src['frames'][i]).convert('RGB').resize((tw, th)))
        rows.append((p, ims))
    W, H = 3 * tw + 620, 40 + len(rows) * (th + 8)
    sheet = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(sheet)
    d.text((8, 6), title, fill='black', font=font)
    y = 40
    last_sent = None
    for p, ims in rows:
        for k, im in enumerate(ims):
            sheet.paste(im, (k * tw, y))
        x = 3 * tw + 12
        d.text((x, y), f"{p['start']:.1f}~{p['end']:.1f}초  {p['file']} {p['srcIn']:.1f}~{p['srcOut']:.1f}  [{p['kind']}]",
               fill='#0050a0', font=small)
        text = p['text'] if p['sentence'] != last_sent else '(같은 문장 이어서)'
        last_sent = p['sentence']
        line, yy = '', y + 28
        for ch in text:
            if d.textlength(line + ch, font=font) > 600:
                d.text((x, yy), line, fill='black', font=font)
                line, yy = '', yy + 28
            line += ch
        d.text((x, yy), line, fill='black', font=font)
        y += th + 8
    sheet.save(out_jpg, quality=85)


def preview(plan, sources, seq_cuts, total, out_mp4):
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, 'v.wav')
        clips, _ = voice_clips(seq_cuts)
        render_voice(clips, total, wav)
        args = ['ffmpeg', '-v', 'error', '-y']
        filt = []
        for i, p in enumerate(plan):
            args += ['-ss', f"{p['srcIn']:.3f}", '-t', f"{p['srcOut'] - p['srcIn']:.3f}", '-i', sources[p['file']]['path']]
            filt.append(f"[{i}:v]setpts=(PTS-STARTPTS)/{p['speed']},scale=540:960:force_original_aspect_ratio=increase,"
                        f"crop=540:960,fps=30,trim=duration={p['end'] - p['start']:.3f},setsar=1[v{i}]")
        n = len(plan)
        filt.append(''.join(f'[v{i}]' for i in range(n)) + f'concat=n={n}:v=1:a=0[vout]')
        args += ['-i', wav, '-filter_complex', ';'.join(filt), '-map', '[vout]', '-map', f'{n}:a',
                 '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-shortest', out_mp4]
        subprocess.run(args, check=True, stdin=subprocess.DEVNULL)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--projects', default='')
    ap.add_argument('--out', default='eval_data/plans')
    ap.add_argument('--preview', action='store_true')
    a = ap.parse_args()
    want = [p for p in a.projects.split(',') if p]
    model = load_model('koclip')
    os.makedirs(a.out, exist_ok=True)
    for tp in sorted(glob.glob('eval_data/truth/*.json')):
        pname = os.path.splitext(os.path.basename(tp))[0]
        if (want and pname not in want) or pname.endswith('_1'):
            continue
        truth = json.load(open(tp, encoding='utf8'))
        cuts = json.load(open(os.path.join('eval_data/cuts', pname + '.json'), encoding='utf8'))
        sources = prepare_sources(pname, cuts, model)
        result = []
        for st in truth['sequences']:
            sents = [x for x in st['sentences'] if x['start'] is not None]
            sent_emb = model.texts([x['text'] for x in sents])
            plan = plan_sequence(st, sources, sent_emb)
            result.append({'sequence': st['sequence'], 'plan': plan})
            review_sheet(plan, sources, os.path.join(a.out, f"{st['sequence']}_review.jpg"), f"{st['sequence']} 자동 배치 v3.1")
            if a.preview:
                seq_cuts = next(s for s in cuts['sequences'] if s['name'] == st['sequence'])
                preview(plan, sources, seq_cuts, st['duration'], os.path.join(a.out, f"{st['sequence']}_preview.mp4"))
            kinds = {}
            for p in plan:
                kinds[p['kind']] = kinds.get(p['kind'], 0) + 1
            lens = [p['end'] - p['start'] for p in plan]
            print(f"{st['sequence']}: 컷 {len(plan)}개, 길이 중앙 {sorted(lens)[len(lens) // 2]:.1f}초, {kinds}", flush=True)
        json.dump({'project': pname, 'sequences': result}, open(os.path.join(a.out, pname + '.json'), 'w', encoding='utf8'),
                  ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
