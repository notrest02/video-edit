"""
자막 나누기 채점: 편집자 완성본 자막(정답) vs 앱 자막 나누기 / 개선안

사용 (파이썬 + node):
    python -X utf8 tools/premiere/caption_eval.py [--max-chars 13] [--show]

정답: eval_data/captions/<시퀀스>.txt  (줄마다 "시각<TAB>자막", 편집자 렌더 화면에서 읽은 것)
대본 단어/시각: eval_data/truth/<프로젝트>.json (앱과 같은 강제 정렬 모델)
비교 단위: 단어 사이 경계 k (= k번째 단어 앞에서 자막이 바뀜). 편집자 자막 글자와 대본 글자가 조금 달라도
           (띄어쓰기, '구요/고요' 등) 글자 정렬로 가장 가까운 단어 경계에 맞춘다.
"""
import argparse
import difflib
import glob
import json
import os
import re
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
norm = lambda s: re.sub(r'[^가-힣0-9a-zA-Z]', '', s)


def load_truth_seq(seq_name):
    for f in glob.glob('eval_data/truth/*.json'):
        t = json.load(open(f, encoding='utf8'))
        for s in t['sequences']:
            if s['sequence'] == seq_name:
                return f, s
    raise KeyError(seq_name)


def editor_breaks(lines, words):
    """편집자 자막 줄 경계 → 대본 단어 경계 번호 집합"""
    script = ''.join(norm(w['text']) for w in words)
    wpos, n = [], 0  # 단어 k 시작 글자 위치
    for w in words:
        wpos.append(n)
        n += len(norm(w['text']))
    ed = ''.join(norm(x) for x in lines)
    sm = difflib.SequenceMatcher(None, ed, script, autojunk=False)
    emap = {}
    for a, b, size in sm.get_matching_blocks():
        for i in range(size):
            emap[a + i] = b + i
    out, n = set(), 0
    for x in lines[:-1]:
        n += len(norm(x))
        # n 번째 편집자 글자에 대응하는 대본 위치
        cands = [emap[j] - (j - n) for j in range(n, min(n + 3, len(ed))) if j in emap] or \
                [emap[j] + (n - j) for j in range(n - 1, max(n - 4, -1), -1) if j in emap]
        if not cands:
            continue
        p = cands[0]
        k = min(range(len(wpos)), key=lambda i: abs(wpos[i] - p))
        if k > 0:
            out.add(k)
    return out


def app_breaks(truth_path, seq_name, max_chars):
    r = subprocess.run(['node', os.path.join(HERE, 'caption_check.cjs'), truth_path, seq_name, str(max_chars)],
                       capture_output=True, stdin=subprocess.DEVNULL)
    caps = json.loads(r.stdout.decode('utf8'))['captions']
    return {c['firstWord'] for c in caps[1:]}, caps


def score(pred, gold):
    tp = len(pred & gold)
    p = tp / len(pred) if pred else 0
    r = tp / len(gold) if gold else 0
    return tp, len(pred), len(gold), (2 * p * r / (p + r) if p + r else 0)


def render(words, br):
    out, cur = [], []
    for k, w in enumerate(words):
        if k in br and cur:
            out.append(' '.join(cur))
            cur = []
        cur.append(w['text'])
    out.append(' '.join(cur))
    return ' | '.join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--max-chars', type=int, default=13)
    ap.add_argument('--show', action='store_true')
    a = ap.parse_args()
    tot = [0, 0, 0]
    for cf in sorted(glob.glob('eval_data/captions/*.txt')):
        seq = os.path.splitext(os.path.basename(cf))[0]
        lines = [l.split('\t', 1)[1].strip() for l in open(cf, encoding='utf8') if '\t' in l]
        tp_path, s = load_truth_seq(seq)
        words = s['words']
        gold = editor_breaks(lines, words)
        pred, _caps = app_breaks(tp_path, seq, a.max_chars)
        tp, np_, ng, f1 = score(pred, gold)
        tot = [tot[0] + tp, tot[1] + np_, tot[2] + ng]
        print(f'{seq}: 앱 {np_}개 / 편집자 {ng}개 / 일치 {tp}  F1 {f1:.2f}')
        if a.show:
            print('  편집자:', render(words, gold))
            print('  앱    :', render(words, pred))
    p, r = tot[0] / max(1, tot[1]), tot[0] / max(1, tot[2])
    print(f'합계: 일치 {tot[0]} / 앱 {tot[1]} / 편집자 {tot[2]}  정밀도 {p:.2f} 재현율 {r:.2f} F1 {2 * p * r / max(1e-9, p + r):.2f}')


if __name__ == '__main__':
    main()
