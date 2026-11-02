"""
prproj 에서 뽑은 컷 정보가 맞는지, 최종 렌더 영상(<시퀀스이름>.mp4)과 프레임을 비교해 검증한다.

각 샘플 시점 t 에서
  - 기대 프레임: 그 시점 가장 위 비디오 트랙 클립의 원본 파일 @ srcIn + (t - start) × speed
  - 대조 프레임: 같은 원본 @ 기대 시점 + 1초 (틀린 시점)
  렌더 프레임과의 PSNR 이 기대 쪽이 대조보다 확실히 높으면 '일치'

사용:
    python -X utf8 tools/premiere/check_against_render.py <cuts.json> <렌더 폴더> [--samples 12]
"""
import argparse
import json
import os
import subprocess
import sys

import math

FF = os.path.join(os.path.dirname(__file__), '..', '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
W, H = 108, 192  # 작게 줄인 흑백으로 비교 (자막·작은 위치 차이에 덜 민감)


FP = os.path.join(os.path.dirname(__file__), '..', '..', 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')
_vdur = {}


def video_duration(path):
    """영상 스트림 길이 (역재생 클립의 In/Out 은 이 길이의 끝에서부터 센다)"""
    if path not in _vdur:
        r = subprocess.run([FP, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration',
                            '-of', 'csv=p=0', path], capture_output=True, text=True, stdin=subprocess.DEVNULL)
        _vdur[path] = float((r.stdout.strip().splitlines() or ['0'])[0] or 0)
    return _vdur[path]


_vsize = {}


def video_size(path):
    if path not in _vsize:
        r = subprocess.run([FP, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                            '-of', 'csv=p=0', path], capture_output=True, text=True, stdin=subprocess.DEVNULL)
        w, h = (r.stdout.strip().splitlines() or ['0,0'])[0].split(',')[:2]
        _vsize[path] = (int(w), int(h))
    return _vsize[path]


def placed_frame(c, t_src, frame_w, frame_h):
    """Premiere 의 Motion(위치·크기·기준점·자르기)대로 원본을 시퀀스 화면에 배치한 프레임 (애니메이션/회전이면 None)"""
    m = c.get('motion')
    if not m or m.get('animated') or abs(m.get('rotation') or 0) > 0.01:
        return None
    sw, sh = video_size(c['src'])
    if not sw or not sh:
        return None
    sc = (m.get('scale') or 100) / 100
    scw = sc if m.get('uniform', True) else (m.get('scaleWidth') or 100) / 100
    w, h = sw * scw, sh * sc
    px, py = m.get('position') or [0.5, 0.5]
    ax, ay = m.get('anchor') or [0.5, 0.5]
    cl, ct = (m.get('cropLeft') or 0) / 100, (m.get('cropTop') or 0) / 100
    cr, cb = (m.get('cropRight') or 0) / 100, (m.get('cropBottom') or 0) / 100
    vis_w, vis_h = max(2, w * (1 - cl - cr)), max(2, h * (1 - ct - cb))
    x = px * frame_w - ax * w + w * cl
    y = py * frame_h - ay * h + h * ct
    # setpts: 탐색 후 원본 첫 프레임 시각이 0보다 늦으면 검은 배경만 먼저 합성되므로 둘 다 0부터 시작
    flip = 'hflip,' if is_flipped(c) else ''
    fg = (f"[0:v]setpts=PTS-STARTPTS,{flip}crop=iw*{1 - cl - cr:.5f}:ih*{1 - ct - cb:.5f}:iw*{cl:.5f}:ih*{ct:.5f},"
          f"scale={int(round(vis_w))}:{int(round(vis_h))}[s];[1:v]setpts=PTS-STARTPTS[b];"
          f"[b][s]overlay={x:.1f}:{y:.1f},scale={W}:{H},format=gray")
    r = subprocess.run([FF, '-v', 'error', '-ss', f'{max(0, t_src):.3f}', '-i', c['src'],
                        '-f', 'lavfi', '-i', f'color=c=black:s={frame_w}x{frame_h}:d=1',
                        '-filter_complex', fg, '-frames:v', '1', '-f', 'rawvideo', '-'],
                       capture_output=True, stdin=subprocess.DEVNULL)
    return r.stdout[: W * H] if len(r.stdout) >= W * H else None


def source_time(c, t):
    """타임라인 t 에 화면에 보이는 원본 시점"""
    rel = c['srcIn'] + (t - c['start']) * c['speed']
    return video_duration(c['src']) - rel if c.get('reverse') else rel


def is_flipped(c):
    return any('Horizontal Flip' in e for e in (c.get('effects') or []))


def frame(path, t, zoom=1.0, flip=False):
    crop = ('hflip,' if flip else '') + ('' if zoom == 1.0 else f'crop=iw/{zoom}:ih/{zoom},')
    r = subprocess.run(
        [FF, '-v', 'error', '-ss', f'{max(0, t):.3f}', '-i', path, '-frames:v', '1',
         '-vf', f'{crop}scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,format=gray',
         '-f', 'rawvideo', '-'],
        capture_output=True,
        stdin=subprocess.DEVNULL,
    )
    if len(r.stdout) < W * H:
        return None
    return r.stdout[: W * H]


def psnr(a, b):
    mse = sum((x - y) * (x - y) for x, y in zip(a, b)) / len(a)
    return 99.0 if mse < 1e-6 else 10 * math.log10(255 * 255 / mse)


def top_clip(video, t):
    best = None
    for c in video:
        if not c['enabled'] or not c['src'] or c['src'].startswith('sequence:'):
            continue
        if not c['src'].lower().endswith(('.mp4', '.mov', '.mkv', '.avi', '.m4v')):
            continue  # 이미지/그래픽 등 제외
        if c['start'] <= t < c['end'] and (best is None or c['track'] > best['track']):
            best = c
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cuts')
    ap.add_argument('render_dir')
    ap.add_argument('--samples', type=int, default=12)
    a = ap.parse_args()
    data = json.load(open(a.cuts, encoding='utf8'))
    total_ok = total = total_amb = 0
    for seq in data['sequences']:
        # 완성본: <시퀀스이름>.mp4 (없으면 '<시퀀스이름>_수정.mp4' 처럼 이름으로 시작하는 파일), 원본 소스 파일은 제외
        src_names = {os.path.basename(c['src'] or '') for q in data['sequences'] for c in q['video'] + q['audio']}
        cands = [f for f in sorted(os.listdir(a.render_dir))
                 if f.lower().endswith('.mp4') and f not in src_names
                 and (f[:-4] == seq['name'] or f.startswith(seq['name'] + '_'))]
        render = os.path.join(a.render_dir, cands[0]) if cands else ''
        if not render:
            print(f"{seq['name']}: 렌더 파일 없음 → 건너뜀")
            continue
        end = max((c['end'] for c in seq['video']), default=0)
        ok = n = amb = 0
        bad = []
        cuts = sorted({c['start'] for c in seq['video']} | {c['end'] for c in seq['video']})
        for k in range(a.samples):
            t = (k + 0.5) * end / a.samples
            # 컷 경계 바로 옆(0.15초 이내)은 렌더 프레임이 앞/뒤 어느 쪽인지 애매하므로 살짝 비켜서 샘플
            near = [x for x in cuts if abs(x - t) < 0.15]
            if near:
                t = near[0] + (0.2 if t >= near[0] else -0.2)
            c = top_clip(seq['video'], t)
            if c is None:
                continue
            src_t = source_time(c, t)
            fr = frame(render, t)
            if fr is None:
                continue
            pe = pc = -1.0
            fw, fh = video_size(render)
            # 1순위: 프로젝트의 Motion 값대로 정확히 배치한 화면과 비교
            for dt in (0.0, -0.07, 0.07, -0.15, 0.15):
                fe = placed_frame(c, src_t + dt, fw, fh)
                fc = placed_frame(c, src_t + 1.0, fw, fh)
                if fe is None or fc is None:
                    break
                if psnr(fr, fe) > pe:
                    pe, pc = psnr(fr, fe), psnr(fr, fc)
            # 2순위(애니메이션·회전 등 배치 계산이 어려울 때): 몇 가지 확대 비율 중 가장 비슷한 값
            # 프레임 레이트 변환·속도 조절로 생기는 몇 프레임 오차(±0.15초)는 허용
            for z in ((1.0, 1.1, 1.2, 1.3) if pe < 0 else ()):
                fc = frame(c['src'], src_t + 1.0, z, is_flipped(c))
                for dt in (0.0, -0.07, 0.07, -0.15, 0.15):
                    fe = frame(c['src'], src_t + dt, z, is_flipped(c))
                    if fe is None or fc is None:
                        continue
                    if psnr(fr, fe) > pe:
                        pe, pc = psnr(fr, fe), psnr(fr, fc)
            if pe < 0:
                continue
            n += 1
            good = pe > pc + 2.0 or pe > 30
            # 거의 움직임이 없는 장면: 1초 뒤 프레임과도 비슷해서 시점은 구분 불가 (파일은 일치)
            ambiguous = not good and abs(pe - pc) <= 2.0 and pe > 18
            ok += good
            amb += ambiguous
            if not good and not ambiguous:
                bad.append(f"t={t:.2f} {os.path.basename(c['src'])}@{src_t:.2f} 일치 {pe:.1f}dB / 대조 {pc:.1f}dB")
        total_ok += ok
        total += n
        total_amb += amb
        print(f"{seq['name']}: {ok}/{n} 일치" + (f', 정지 장면 구분 불가 {amb}' if amb else '')
              + ('' if not bad else '  틀림: ' + ' | '.join(bad[:4])))
    print(f'TOTAL 일치 {total_ok}/{total}, 구분 불가 {total_amb}, 틀림 {total - total_ok - total_amb}')


if __name__ == '__main__':
    sys.exit(main())
