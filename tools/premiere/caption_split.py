"""
자막 한 줄 나누기 개선안 (말 쉼 + 말끝 + 길이) — 앱(scriptAligner.ts)에 옮기기 전 시험판

사용:
    python -X utf8 tools/premiere/caption_split.py [--show 시퀀스,...] [--grid]

근거 (편집자 완성본 자막 12개, eval_data/captions):
  - 편집자 자막 경계의 79%가 0.15초 이상 쉬는 곳, 경계가 아닌 곳은 15%만 그만큼 쉼 → 쉼이 가장 강한 단서
  - 한 줄 최대 띄어쓰기 포함 ~16자, 보통 10~11자. 의미 덩어리(말끝) 단위
점수: 줄마다 기본 비용 + 길이 초과/너무 짧음 감점 - 경계 보상(쉼 길이, 말끝, 문장 끝). 떼면 안 되는 곳은 금지
"""
import argparse
import glob
import itertools
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from caption_eval import load_truth_seq, editor_breaks, score, render  # noqa: E402

vlen = lambda s: len(re.sub(r"[.?!,~\"'“”‘’「」『』]", '', s))  # 앱 getVisualCharLength 와 같음 (띄어쓰기 포함)
strip = lambda s: re.sub(r"^[\"'“‘「『]+|[\"'”’」』.,?!~]+$", '', s)

# 뒤 어절과 떼면 안 되는 앞 어절 (앱 mergeInseparableKoreanTokens 와 같은 목록)
MOD1 = set('이 그 저 새 헌 한 두 세 네 전 현 다 더 안 못 잘 꼭 막 좀 늘 참'.split())
ADV = set('절대 너무 아주 정말 진짜 완전 전혀 결코 훨씬 가장 제일'.split())
# 앞 어절과 떼면 안 되는 뒤 어절 (의존명사, 보조용언)
BOUND = re.compile(r'^(것|것까지|것도|것은|것이|것을|거|거까지|거예요|걸|건|게|때|때도|때는|때부터|수|수도|수밖에|줄|듯|데|편|중|후|뿐|터|바|지|만큼|요|때문에)$')
AUX = re.compile(r'^(봐|봐요|봤어|봤어요|보세요|보여|보여요|보이는|보이나|보이고|보이더라고요|있어요|있습니다|있어|있고|있는|있던|있더라고요|계세요|싶어요|싶어|되니|되니까|돼요|됩니다|됐어요)$')
# 끊기 좋은 말끝 (연결어미/종결)
CLAUSE = re.compile(r'(으니|니|면서도|면서|으며|해서|아서|어서|져서|니까|때문에|거든요|거든|길래|느라|지만|는데|은데|던데|더라도|아도|어도|해도|다면|으면|려면|하면|도록|라며|라고|더니|고|서|며|면)$')
END = re.compile(r'[.?!]["\'”’]*$|요$|다$')
# 조사/어미로 끝나지 않는 '맨 명사'로 보이는 어절 뒤에서 쉼 없이 끊으면 명사 묶음을 쪼갬 ('오염 방지 | 테이프를')
PHRASE_END = re.compile(r'(은|는|이|가|을|를|에|에서|의|도|만|로|으로|와|과|랑|이랑|고|서|면|니|데|요|다|까|게|며|나|죠|야|께|한테|처럼|부터|까지|보다|하고|해|줘|어|아|던|든|ㄴ|던데|이고)$')

# 12개 전체에서 고른 값 (학습 3개 F1 0.91 / 처음 보는 9개 0.85 / 전체 0.87; 지금 앱 13자는 0.61 / 0.72)
DEFAULT = dict(maxlen=16, ideal_lo=8, line_cost=1.0, w_gap=8.0, g0=0.1, clause=1.0, end=1.5, short=2.0, over=6.0,
               noun=1.0)


def split_words(words, prm=None):
    """words: [{'text', 'start', 'end'}] (한 시퀀스/문단 전체). 반환: 끊는 단어 번호 집합 (k = k번째 단어 앞)"""
    prm = dict(DEFAULT, **(prm or {}))
    n = len(words)
    txt = [w['text'] for w in words]

    def gap(k):
        a, b = words[k - 1], words[k]
        if a.get('end') is None or b.get('start') is None:
            return 0.15
        return b['start'] - a['end']

    quote_open = [0] * (n + 1)  # k 앞까지 작은따옴표가 열려 있나
    for k in range(n):
        quote_open[k + 1] = quote_open[k] ^ ((txt[k].count("'") + txt[k].count('‘') + txt[k].count('’')) % 2)

    def bscore(k):
        prev, cur = txt[k - 1], txt[k]
        ps, cs = strip(prev), strip(cur)
        if prev in MOD1 or ps in ADV:
            return -9
        if BOUND.match(cs) or (AUX.match(cs) and re.search(r'(고|어|아|여|해|워|와|까|나|도|면|야)$', ps)):
            return -9
        if quote_open[k]:
            return -9
        g = gap(k)
        s = prm['w_gap'] * (min(g, 0.4) - prm['g0'])
        if CLAUSE.search(ps) or prev.endswith(','):
            s += prm['clause']
        if END.search(prev):
            s += prm['end']
        if not PHRASE_END.search(ps) and not re.search(r'[,.?!]', prev) and g < 0.15:
            s -= prm['noun']
        return s

    best = [0.0] + [1e18] * n
    back = [0] * (n + 1)
    for j in range(1, n + 1):
        for i in range(j - 1, -1, -1):
            L = vlen(' '.join(txt[i:j]))
            if L > prm['maxlen'] + 4 and j - i > 1:
                break
            c = prm['line_cost']
            if L > prm['maxlen']:
                c += prm['over'] * (L - prm['maxlen'])
            if L < prm['ideal_lo']:
                c += prm['short'] * (prm['ideal_lo'] - L) / prm['ideal_lo']
            if i > 0:
                c -= bscore(i)
            if best[i] + c < best[j]:
                best[j], back[j] = best[i] + c, i
    br, j = set(), n
    while j > 0:
        i = back[j]
        if i > 0:
            br.add(i)
        j = i
    return br


TRAIN = {'길이조절거치대01', '스티커1_01', '햇빛가리개02'}


def dataset():
    for cf in sorted(glob.glob('eval_data/captions/*.txt')):
        seq = os.path.splitext(os.path.basename(cf))[0]
        lines = [l.split('\t', 1)[1].strip() for l in open(cf, encoding='utf8') if '\t' in l]
        _, s = load_truth_seq(seq)
        yield seq, s['words'], editor_breaks(lines, s['words'])


def evaluate(prm=None, data=None, show=()):
    res = {'train': [0, 0, 0], 'test': [0, 0, 0]}
    for seq, ws, gold in data:
        pred = split_words(ws, prm)
        tp, a, b, f = score(pred, gold)
        t = res['train' if seq in TRAIN else 'test']
        t[0] += tp; t[1] += a; t[2] += b
        if seq in show:
            print(f'== {seq}: F1 {f:.2f}\n  편집자: {render(ws, gold)}\n  개선안: {render(ws, pred)}')
    f1 = lambda t: 2 * t[0] / max(1, t[1] + t[2])
    return f1(res['train']), f1(res['test']), res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--show', default='')
    ap.add_argument('--grid', action='store_true')
    a = ap.parse_args()
    data = list(dataset())
    if a.grid:  # 학습 3개로만 고르고 나머지로 확인
        best = None
        for ml, lc, g0, nn in itertools.product([14, 15, 16], [0.5, 1, 2], [0.08, 0.1, 0.12], [0, 1, 2, 3]):
            p = dict(maxlen=ml, line_cost=lc, g0=g0, noun=nn)
            tr, te, _ = evaluate(p, data)
            if best is None or tr > best[0]:
                best = (tr, te, p)
        print('학습 최고', best)
    tr, te, res = evaluate(None, data, show=set(filter(None, a.show.split(','))))
    print(f'기본값: 학습 3개 F1 {tr:.2f} / 처음 보는 9개 F1 {te:.2f}', res)


if __name__ == '__main__':
    main()
