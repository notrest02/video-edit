"""
정답표 만들기: 대본 문장 ↔ 실제로 쓴 영상 컷 (자동 편집 평가용)

사용:
    python -X utf8 tools/premiere/build_truth.py <cuts.json> <대본.txt> [--out truth.json]

  cuts.json : prproj_cuts.py 출력 (최종 시퀀스 <프로젝트>NN 들)
  대본.txt  : 클라이언트 대본. 버전마다 '3초 : 4번 1~6초 [빠르게]' 줄로 시작하는 블록

방법:
  1) 시퀀스의 음성(TTS) 조각들을 타임라인 위치 그대로 이어 붙여 음성 트랙을 다시 만든다 (무음 잘라낸 것까지 반영)
  2) 그 음성에 대본 블록을 강제 정렬 (align_cli.cjs, 앱과 같은 모델) → 문장마다 타임라인 [시작, 끝]
  3) 문장 구간에 화면에 보이던 영상 컷(가장 위 트랙)을 기록

출력 (시퀀스마다):
  hookSpec : 대본에 적힌 후킹 지정 {sec, file, from, to, note} (없으면 null)
  hookActual : 실제 첫 3초 동안 쓴 컷들
  sentences : [{i, text, start, end, cuts: [{file, start, end, srcIn, srcOut, speed, reverse, track}], lead}]
     lead = 문장 시작 - 그 시점 컷의 시작 (양수: 컷이 문장보다 먼저 바뀜)
"""
import argparse
import difflib
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
VIDEO_EXT = ('.mp4', '.mov', '.m4v', '.avi', '.mkv', '.mts')
HOOK_RE = re.compile(r'^\s*(\d+(?:\.\d+)?)\s*초\s*:\s*(\d+)\s*번\s*(\d+(?:\.\d+)?)\s*~\s*(\d+(?:\.\d+)?)\s*초?\s*(.*)$')


# ---------- 대본 ----------

def parse_script(path):
    """대본 → 블록들 [{hook, lines}] (첫 줄 제품명/링크는 건너뜀)"""
    raw = open(path, encoding='utf8', errors='replace').read().replace('\r', '')
    blocks, cur = [], None
    for line in raw.split('\n'):
        s = line.strip()
        m = HOOK_RE.match(s)
        if m:
            cur = {'hook': {'sec': float(m.group(1)), 'file': m.group(2) + '.mp4', 'from': float(m.group(3)),
                            'to': float(m.group(4)), 'note': m.group(5).strip()}, 'lines': []}
            blocks.append(cur)
        elif s and cur is not None:
            cur['lines'].append(s)
    if not blocks:  # 후킹 지정 없는 대본: 빈 줄로 블록 나눔
        for chunk in re.split(r'\n\s*\n', raw):
            ls = [l.strip() for l in chunk.split('\n') if l.strip()]
            if ls:
                blocks.append({'hook': None, 'lines': ls})
    return blocks


def split_sentences(lines):
    """줄들을 이어 붙여 문장 단위로 나눔. 각 문장이 어느 줄의 몇 번째 단어부터인지도 함께"""
    words = []
    for li, l in enumerate(lines):
        for w in l.split():
            words.append((li, w))
    end_re = r'[.?!~]["\')]*$'
    # 문장부호를 거의 안 쓴 대본(줄 수의 절반 미만)은 줄 끝도 문장 끝으로 봄
    line_break = sum(1 for _li, w in words if re.search(end_re, w)) < len(lines) / 2
    sents, cur = [], []
    for k, (li, w) in enumerate(words):
        cur.append(k)
        last_in_line = k == len(words) - 1 or words[k + 1][0] != li
        if re.search(end_re, w) or k == len(words) - 1 or (line_break and last_in_line):
            sents.append(cur)
            cur = []
    return words, sents


# ---------- 음성 트랙 ----------

def voice_clips(seq):
    """음성(TTS) 조각만: 영상 파일의 소리, 배경음악(한 조각이 시퀀스 대부분을 덮음) 제외"""
    seq_end = max([c['end'] for c in seq['audio'] + seq['video']] or [0])
    out = []
    for c in seq['audio']:
        src = c.get('src') or ''
        if not c['enabled'] or not src or src.startswith('sequence:') or src.lower().endswith(VIDEO_EXT):
            continue
        name = os.path.basename(src)
        if re.search(r'브금|bgm|music|MP_', name, re.I):
            continue
        if seq_end and (c['end'] - c['start']) > 0.7 * seq_end and len(
                [d for d in seq['audio'] if d.get('src') == src]) == 1:
            continue
        out.append(c)
    return out, seq_end


def render_voice(clips, total, out_wav):
    """조각들을 타임라인 위치에 놓은 16kHz 모노 wav"""
    args = ['ffmpeg', '-v', 'error', '-y']
    filt = []
    for i, c in enumerate(clips):
        dur = (c['end'] - c['start']) * c['speed']
        args += ['-ss', f"{c['srcIn']:.4f}", '-t', f'{dur:.4f}', '-i', c['src']]
        tempo = f",atempo={c['speed']}" if abs(c['speed'] - 1) > 1e-3 else ''
        filt.append(f"[{i}:a]aresample=16000,aformat=channel_layouts=mono{tempo},adelay={int(round(c['start'] * 1000))}:all=1[a{i}]")
    n = len(clips)
    filt.append(''.join(f'[a{i}]' for i in range(n)) + f'amix=inputs={n}:normalize=0:duration=longest,apad=whole_dur={total:.3f}[out]')
    args += ['-filter_complex', ';'.join(filt), '-map', '[out]', '-ac', '1', '-ar', '16000', '-t', f'{total:.3f}', out_wav]
    subprocess.run(args, check=True, stdin=subprocess.DEVNULL)


def align(wav, lines):
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf8') as f:
        json.dump({'audio': wav, 'lines': lines}, f, ensure_ascii=False)
        inp = f.name
    try:
        r = subprocess.run(['node', os.path.join(HERE, 'align_cli.cjs'), inp], capture_output=True, stdin=subprocess.DEVNULL)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.decode('utf8', 'replace'))
        return json.loads(r.stdout.decode('utf8'))
    finally:
        os.unlink(inp)


# ---------- 화면에 보이는 컷 ----------

def visible_segments(seq):
    """시간마다 가장 위 트랙의 영상 컷 → 연속 구간 [{clip, start, end}]"""
    vids = [c for c in seq['video'] if c['enabled'] and c.get('src') and c['src'].lower().endswith(VIDEO_EXT)]
    pts = sorted({p for c in vids for p in (c['start'], c['end'])})
    segs = []
    for a, b in zip(pts, pts[1:]):
        if b - a < 1e-3:
            continue
        mid = (a + b) / 2
        on = [c for c in vids if c['start'] <= mid < c['end']]
        if not on:
            continue
        top = max(on, key=lambda c: c['track'])
        if segs and segs[-1]['clip'] is top and abs(segs[-1]['end'] - a) < 1e-3:
            segs[-1]['end'] = b
        else:
            segs.append({'clip': top, 'start': a, 'end': b})
    return segs


def cut_view(seg, a, b):
    """보이는 구간 seg 중 [a, b] 부분을 원본 시간으로"""
    c = seg['clip']
    s, e = max(a, seg['start']), min(b, seg['end'])
    def src_at(t):
        off = c['srcIn'] + (t - c['start']) * c['speed']
        return off  # 거꾸로 재생 클립은 reverse 표시로 구분 (원본 시각은 정방향 기준 오프셋)
    return {'file': os.path.basename(c['src']), 'start': round(s, 3), 'end': round(e, 3),
            'srcIn': round(src_at(s), 3), 'srcOut': round(src_at(e), 3), 'speed': c['speed'],
            'reverse': c.get('reverse', False), 'track': c['track'],
            'cutStart': round(c['start'], 3) if abs(seg['start'] - c['start']) < 1e-3 else round(seg['start'], 3)}


# ---------- 시퀀스 ↔ 대본 블록 짝짓기 ----------

def hangul(s):
    return re.sub(r'[^가-힣]', '', s)


def match_blocks(seqs, blocks):
    """음성 파일 이름(대본 앞부분으로 지어짐)과 블록 첫 문장을 비교. 애매하면 순서대로"""
    out = {}
    used = set()
    for si, seq in enumerate(seqs):
        clips, _ = voice_clips(seq)
        first = sorted(clips, key=lambda c: c['start'])
        name = hangul(os.path.splitext(os.path.basename(first[0]['src']))[0]) if first else ''
        best, best_r = None, 0.0
        for bi, b in enumerate(blocks):
            head = hangul(' '.join(b['lines']))[:max(len(name), 6)]
            r = difflib.SequenceMatcher(None, name, head).ratio() if name else 0
            if r > best_r + 1e-9 and bi not in used:
                best, best_r = bi, r
        if best is None or best_r < 0.5:
            best = si if si < len(blocks) and si not in used else None
        if best is not None:
            used.add(best)
        out[seq['name']] = (best, round(best_r, 2))
    return out


def build(cuts_path, script_path, tmpdir):
    data = json.load(open(cuts_path, encoding='utf8'))
    blocks = parse_script(script_path)
    seqs = [s for s in data['sequences'] if voice_clips(s)[0] and visible_segments(s)]
    if blocks and all(b['hook'] is None for b in blocks) and len(seqs) < len(blocks):
        # 후킹 지정 없는 대본 + 시퀀스 하나에 여러 버전을 이어 붙인 경우 (예: 루시아이): 전체를 한 블록으로
        blocks = [{'hook': None, 'lines': [l for b in blocks for l in b['lines']],
                   'lineBlock': [bi for bi, b in enumerate(blocks) for _ in b['lines']]}]
    pairing = match_blocks(seqs, blocks)
    result = []
    for seq in seqs:
        bi, ratio = pairing[seq['name']]
        if bi is None:
            print(f"{seq['name']}: 대본 블록을 찾지 못함 → 건너뜀", file=sys.stderr)
            continue
        block = blocks[bi]
        clips, total = voice_clips(seq)
        wav = os.path.join(tmpdir, 'voice.wav')
        render_voice(clips, total, wav)
        al = align(wav, block['lines'])
        words, sents = split_sentences(block['lines'])
        spans = [(w[2], w[3]) for w in al['words']]
        segs = visible_segments(seq)
        def units(groups):
            out = []
            for i, idxs in enumerate(groups):
                text = ' '.join(words[k][1] for k in idxs)
                got = [spans[k] for k in idxs if spans[k][0] is not None]
                if not got:
                    out.append({'i': i, 'text': text, 'start': None, 'end': None, 'cuts': [], 'lead': None})
                    continue
                a, b = got[0][0], got[-1][1]
                cs = [cut_view(g, a, b) for g in segs if g['end'] > a + 1e-3 and g['start'] < b - 1e-3]
                out.append({'i': i, 'text': text, 'start': round(a, 3), 'end': round(b, 3), 'cuts': cs,
                            'lead': round(a - cs[0]['cutStart'], 3) if cs else None,
                            'scriptBlock': block['lineBlock'][words[idxs[0]][0]] if 'lineBlock' in block else bi})
            return out
        line_groups = [[k for k, w in enumerate(words) if w[0] == li] for li in range(len(block['lines']))]
        sentences = units(sents)
        lines_out = units([g for g in line_groups if g])
        words_out = [{'text': w[1], 'line': w[0], 'start': sp[0], 'end': sp[1]} for w, sp in zip(words, spans)]
        hook_end = (block['hook'] or {}).get('sec', 3.0)
        hook_actual = [cut_view(g, 0, hook_end) for g in segs if g['start'] < hook_end - 1e-3]
        result.append({
            'sequence': seq['name'], 'scriptBlock': bi, 'blockMatch': ratio,
            'duration': round(total, 3), 'hookSpec': block['hook'], 'hookActual': hook_actual,
            'sentences': sentences, 'lines': lines_out, 'words': words_out,
            'allCuts': [cut_view(g, g['start'], g['end']) for g in segs],
        })
    return {'project': data['project'], 'script': os.path.basename(script_path), 'sequences': result}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cuts')
    ap.add_argument('script')
    ap.add_argument('--out')
    a = ap.parse_args()
    with tempfile.TemporaryDirectory() as td:
        out = build(a.cuts, a.script, td)
    text = json.dumps(out, ensure_ascii=False, indent=1)
    if a.out:
        open(a.out, 'w', encoding='utf8').write(text)
    else:
        sys.stdout.write(text)


if __name__ == '__main__':
    main()
