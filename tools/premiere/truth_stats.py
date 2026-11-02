"""
정답표(build_truth.py 출력)들에서 편집 습관 통계를 뽑는다 → 자동 편집 규칙/평가 기준

사용: python -X utf8 tools/premiere/truth_stats.py eval_data/truth/*.json
"""
import json
import statistics as st
import sys
from collections import Counter


def q(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * (len(xs) - 1) + 0.5))] if xs else None


def summary(name, xs, unit=''):
    if not xs:
        return f'{name}: -'
    return (f'{name}: n={len(xs)} 중앙 {q(xs, .5):.2f}{unit} (10% {q(xs, .1):.2f} ~ 90% {q(xs, .9):.2f}), '
            f'평균 {st.mean(xs):.2f}')


def main(paths):
    seen = set()
    cut_len, speeds, leads, per_sent, per_line, sent_len = [], [], [], [], [], []
    gaps = total_bounds = 0
    sent_start_cut = n_sent = 0
    reuse_cuts = all_cuts = 0
    hook = Counter()
    files_used = []
    for p in paths:
        d = json.load(open(p, encoding='utf8'))
        for s in d['sequences']:
            key = (s['sequence'], s['duration'])
            if key in seen:  # 같은 시퀀스가 다른 prproj 에 중복 (택배상자칼_1)
                continue
            seen.add(key)
            cuts = s['allCuts']
            ws = [w for w in s['words'] if w['start'] is not None]
            for c in cuts:
                cut_len.append(c['end'] - c['start'])
                speeds.append(round(c['speed'], 2))
            for c in cuts[1:]:
                total_bounds += 1
                if not any(w['start'] + 0.08 < c['start'] < w['end'] - 0.08 for w in ws):
                    gaps += 1
            for x in s['sentences']:
                if x['start'] is None:
                    continue
                n_sent += 1
                sent_len.append(x['end'] - x['start'])
                per_sent.append(len(x['cuts']))
                if x['lead'] is not None:
                    leads.append(x['lead'])
                    if x['lead'] < 0.4:
                        sent_start_cut += 1
            for x in s['lines']:
                if x['start'] is not None:
                    per_line.append(len(x['cuts']))
            # 재사용: 같은 파일의 원본 구간이 앞 컷과 0.3초 넘게 겹침
            for i, c in enumerate(cuts):
                all_cuts += 1
                lo, hi = sorted((c['srcIn'], c['srcOut']))
                for e in cuts[:i]:
                    lo2, hi2 = sorted((e['srcIn'], e['srcOut']))
                    if e['file'] == c['file'] and min(hi, hi2) - max(lo, lo2) > 0.3:
                        reuse_cuts += 1
                        break
            files_used.append(len({c['file'] for c in cuts}))
            hs, ha = s['hookSpec'], (s['hookActual'] or [None])[0]
            if hs and ha:
                hook['지정 있음'] += 1
                if ha['file'] == hs['file']:
                    hook['파일 일치'] += 1
                    if hs['from'] - 0.5 <= min(ha['srcIn'], ha['srcOut']) <= hs['to']:
                        hook['구간 일치'] += 1
                if ha['speed'] > 1.01:
                    hook['첫 컷 빠르게'] += 1
                if '빠르게' in (hs.get('note') or ''):
                    hook['대본에 빠르게'] += 1
    print(f'시퀀스 {len(seen)}개, 문장 {n_sent}개, 컷 {all_cuts}개')
    print(summary('컷 길이', cut_len, '초'))
    print(summary('문장 길이', sent_len, '초'))
    print(summary('문장당 컷 수', per_sent))
    print('  분포', sorted(Counter(per_sent).items()))
    print(summary('대본 줄당 컷 수', per_line))
    print(summary('문장 시작 - 컷 시작(lead)', leads, '초'))
    print(f'문장 시작에 컷이 바뀜(lead<0.4초): {sent_start_cut}/{n_sent} = {sent_start_cut / max(1, n_sent):.0%}')
    print(f'컷 경계가 단어 사이(쉼)에 있음: {gaps}/{total_bounds} = {gaps / max(1, total_bounds):.0%}')
    sp = Counter(speeds)
    print(f"속도: 1배 {sum(v for k, v in sp.items() if abs(k - 1) < .01)}, 느리게 {sum(v for k, v in sp.items() if k < .99)}, "
          f"빠르게 {sum(v for k, v in sp.items() if k > 1.01)}  (자주 쓴 값 {sp.most_common(8)})")
    print(f'같은 장면 재사용 컷: {reuse_cuts}/{all_cuts} = {reuse_cuts / max(1, all_cuts):.0%}')
    print(summary('시퀀스당 사용 파일 수', files_used, '개'))
    print('후킹:', dict(hook))


if __name__ == '__main__':
    main(sys.argv[1:])
