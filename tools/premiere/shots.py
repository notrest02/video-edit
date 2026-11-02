"""
원본 영상을 '샷'(화면 전환 없이 이어지는 구간) 단위로 나누고, 모델이 볼 장면 목록 시트를 만든다.

사용 (torch 없는 파이썬도 됨, Pillow + ffmpeg 필요):
    python -X utf8 tools/premiere/shots.py --project 길이조절거치대

  - ffmpeg 장면 점수 0.15 이상 = 화면 전환 (0.3 은 실제 전환을 놓침: 5.mp4 15.9/18.1/19.7, 6.mp4 14.9 등)
  - 0.4초 안에 붙은 전환은 하나로, 0.4초보다 짧은 샷은 앞 샷에 붙임
출력: eval_data/shots/<프로젝트>/shots.json, sheet_<파일>.jpg (0.5초 간격 썸네일, 샷 번호 표시)
"""
import argparse
import glob
import json
import os
import re
import subprocess

from PIL import Image, ImageDraw, ImageFont

FONT = 'C:/Windows/Fonts/malgun.ttf'
THRESH, MERGE, MIN_SHOT = 0.15, 0.4, 0.4
STEP = 0.5


def scene_scores(path):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', path, '-vf', "scale=160:-2,select='gte(scene,0)',metadata=print",
                        '-an', '-f', 'null', '-'], capture_output=True, stdin=subprocess.DEVNULL)
    t = r.stderr.decode('utf8', 'replace')
    pts = [float(x) for x in re.findall(r'pts_time:([\d.]+)', t)]
    sc = [float(x) for x in re.findall(r'scene_score=([\d.]+)', t)]
    return list(zip(pts, sc))


def duration(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                       capture_output=True, stdin=subprocess.DEVNULL)
    return float(r.stdout.decode().strip())


def detect_shots(path):
    dur = duration(path)
    cuts = []
    for t, s in scene_scores(path):
        if s < THRESH or t < MIN_SHOT or t > dur - MIN_SHOT:
            continue
        if cuts and t - cuts[-1][0] < MERGE:
            if s > cuts[-1][1]:
                cuts[-1] = (t, s)
            continue
        cuts.append((t, s))
    bounds = [0.0] + [t for t, _ in cuts] + [dur]
    shots = []
    for a, b in zip(bounds, bounds[1:]):
        if shots and b - a < MIN_SHOT:
            shots[-1][1] = b
        else:
            shots.append([a, b])
    return [(round(a, 2), round(b, 2)) for a, b in shots], dur


def sources_of(project):
    cuts = json.load(open(os.path.join('eval_data/cuts', project + '.json'), encoding='utf8'))
    srcs = {}
    for s in cuts['sequences']:
        for c in s['video']:
            if c.get('src') and os.path.exists(c['src']) and c['src'].lower().endswith(('.mp4', '.mov')):
                srcs[os.path.basename(c['src'])] = c['src']
    return dict(sorted(srcs.items()))


def sheet(fname, frames_dir, shots, out_jpg):
    """0.5초 간격 썸네일. 샷이 바뀌는 칸 위에 샷 번호(빨강)."""
    font = ImageFont.truetype(FONT, 16)
    big = ImageFont.truetype(FONT, 18)
    fs = sorted(glob.glob(os.path.join(frames_dir, 'f*.jpg')))
    tw, th, cols = 108, 192, 10
    rows = (len(fs) + cols - 1) // cols
    im = Image.new('RGB', (cols * tw, rows * (th + 44) + 28), 'white')
    d = ImageDraw.Draw(im)
    d.text((4, 2), f"{fname}  (샷 {len(shots)}개, 숫자 = 원본 초)", fill='black', font=big)
    for i, f in enumerate(fs):
        t = i * STEP + STEP / 2
        k = next((j for j, (a, b) in enumerate(shots) if a <= t < b), len(shots) - 1)
        x, y = (i % cols) * tw, 28 + (i // cols) * (th + 44)
        first = i == 0 or not (shots[k][0] <= t - STEP)
        if first:
            d.rectangle([x, y, x + tw - 2, y + 20], fill='#d00000')
            d.text((x + 3, y), shot_id(fname, k), fill='white', font=font)
        im.paste(Image.open(f).convert('RGB').resize((tw - 2, th)), (x, y + 22))
        d.text((x + 2, y + 22 + th), f"{t:.1f}", fill='black', font=font)
    im.save(out_jpg, quality=82)


def shot_id(fname, k):
    return f"{os.path.splitext(fname)[0]}-{k + 1:02d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--project', required=True)
    a = ap.parse_args()
    out_dir = os.path.join('eval_data/shots', a.project)
    os.makedirs(out_dir, exist_ok=True)
    res = []
    for fname, path in sources_of(a.project).items():
        shots, dur = detect_shots(path)
        frames_dir = os.path.join('eval_data/frames', a.project, os.path.splitext(fname)[0])
        sheet(fname, frames_dir, shots, os.path.join(out_dir, f"sheet_{os.path.splitext(fname)[0]}.jpg"))
        for k, (s, e) in enumerate(shots):
            res.append({'id': shot_id(fname, k), 'file': fname, 'start': s, 'end': e, 'dur': round(e - s, 2)})
        print(fname, f"{dur:.1f}초 → 샷 {len(shots)}개:", ' '.join(f"{s:.1f}-{e:.1f}" for s, e in shots))
    json.dump({'project': a.project, 'shots': res}, open(os.path.join(out_dir, 'shots.json'), 'w', encoding='utf8'),
              ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
