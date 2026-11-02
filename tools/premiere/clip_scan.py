"""
원본 영상 훑어보기 (자동 편집 2단계 준비, 전부 로컬에서 처리)

사용:
    python -X utf8 tools/premiere/clip_scan.py <cuts.json> --out <폴더>

cuts.json(prproj_cuts.py 출력)에서 쓴 원본 영상들을 모아 파일마다:
  - 길이, 해상도, fps
  - 장면 전환 시각 (ffmpeg scene 점수 > 0.3)
  - 1초 간격 저해상도 썸네일을 시각 표시와 함께 한 장에 모은 '목차 이미지' (<파일>_sheet.jpg)
결과: <폴더>/scan.json + 목차 이미지들
"""
import argparse
import json
import os
import re
import subprocess

VIDEO_EXT = ('.mp4', '.mov', '.m4v', '.avi', '.mkv', '.mts')
FONT = 'C\\:/Windows/Fonts/arial.ttf'


def probe(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                        'stream=width,height,r_frame_rate,duration:format=duration:stream_side_data=rotation',
                        '-of', 'json', path], capture_output=True, stdin=subprocess.DEVNULL)
    d = json.loads(r.stdout.decode('utf8') or '{}')
    st = (d.get('streams') or [{}])[0]
    num, den = (st.get('r_frame_rate') or '30/1').split('/')
    rot = 0
    for sd in st.get('side_data_list') or []:
        if 'rotation' in sd:
            rot = int(sd['rotation'])
    w, h = st.get('width'), st.get('height')
    if rot in (90, -90, 270, -270):
        w, h = h, w
    return {'width': w, 'height': h, 'fps': round(float(num) / float(den), 3),
            'duration': float(st.get('duration') or d.get('format', {}).get('duration') or 0)}


def scene_changes(path, thresh=0.3):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', path, '-vf', f"scale=320:-2,select='gt(scene,{thresh})',showinfo",
                        '-an', '-f', 'null', '-'], capture_output=True, stdin=subprocess.DEVNULL)
    err = r.stderr.decode('utf8', 'replace')
    return [round(float(m), 3) for m in re.findall(r'pts_time:([\d.]+)', err)]


def contact_sheet(path, out_jpg, duration, step=1.0, cols=6, width=240):
    n = max(1, int(duration / step + 0.999))
    rows = (n + cols - 1) // cols
    vf = (f"fps=1/{step},scale={width}:-2,"
          f"drawtext=fontfile='{FONT}':text='%{{pts\\:hms}}':x=4:y=4:fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.6,"
          f"tile={cols}x{rows}:padding=2")
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', path, '-vf', vf, '-frames:v', '1', '-q:v', '4', out_jpg],
                   check=True, stdin=subprocess.DEVNULL)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cuts')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    data = json.load(open(a.cuts, encoding='utf8'))
    srcs = sorted({c['src'] for s in data['sequences'] for c in s['video']
                   if c.get('src') and c['src'].lower().endswith(VIDEO_EXT) and os.path.exists(c['src'])})
    os.makedirs(a.out, exist_ok=True)
    result = []
    for src in srcs:
        info = probe(src)
        info['file'] = os.path.basename(src)
        info['path'] = src
        info['scenes'] = scene_changes(src)
        sheet = os.path.join(a.out, os.path.splitext(info['file'])[0] + '_sheet.jpg')
        contact_sheet(src, sheet, info['duration'])
        info['sheet'] = sheet
        result.append(info)
        print(f"{info['file']}: {info['duration']:.1f}초 {info['width']}x{info['height']} 장면전환 {len(info['scenes'])}개")
    json.dump({'project': data['project'], 'clips': result}, open(os.path.join(a.out, 'scan.json'), 'w', encoding='utf8'),
              ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
