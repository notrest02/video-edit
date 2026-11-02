"""
PC 모델로 '대본 문장 → 원본 장면' 고르기를 정답표에 대어 채점 (자동 편집 2단계 시험)

사용 (torch/transformers 있는 파이썬):
    python -X utf8 tools/premiere/shot_match_eval.py --truth eval_data/truth --model siglip2-base [--projects 길이조절거치대,햇빛가리개]

방법:
  - 정답표에 나온 원본 영상마다 0.5초 간격 프레임(짧은 변 384px)을 뽑아 캐시 (eval_data/frames)
  - 문장(후킹 3초 안 문장 제외)마다 모델 점수로 프레임 순위 → 1.5초 안 중복 제거
  - 상위 k개 중 하나라도 실제로 쓴 컷(같은 파일, 원본 구간 ±0.5초)에 들어가면 적중
  - 무작위 기준선: 쓴 컷 구간이 전체 원본 길이에서 차지하는 비율로 계산한 기대 적중률
"""
import argparse
import glob
import json
import os
import subprocess
import sys

import numpy as np
import torch
from PIL import Image

STEP = 0.5


def _feat(e):
    """transformers 5: get_*_features 가 출력 객체를 돌려줌 → 임베딩 텐서만"""
    if hasattr(e, 'pooler_output') and e.pooler_output is not None:
        e = e.pooler_output
    elif hasattr(e, 'image_embeds'):
        e = e.image_embeds
    elif hasattr(e, 'text_embeds'):
        e = e.text_embeds
    return e
KS = (1, 3, 5)


# ---------- 프레임 ----------

def extract_frames(src, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    if glob.glob(os.path.join(out_dir, '*.jpg')):
        return
    subprocess.run(['ffmpeg', '-v', 'error', '-i', src, '-vf', f"fps={1 / STEP},scale='if(gt(iw,ih),-2,384)':'if(gt(iw,ih),384,-2)'",
                    '-q:v', '3', os.path.join(out_dir, 'f%05d.jpg')], check=True, stdin=subprocess.DEVNULL)


def frame_list(out_dir):
    fs = sorted(glob.glob(os.path.join(out_dir, 'f*.jpg')))
    # fps 필터는 0, 0.5, 1.0 ... 근처 프레임 → i 번째 = (i) * STEP + STEP/2 근처. 중앙값으로 둠
    return [(f, i * STEP + STEP / 2) for i, f in enumerate(fs)]


def video_duration(src):
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration',
                        '-of', 'csv=p=0', src], capture_output=True, stdin=subprocess.DEVNULL)
    try:
        return float(r.stdout.decode().strip().split('\n')[0])
    except ValueError:
        return None


# ---------- 모델 ----------

class SigLIP:
    NAMES = {'siglip2-base': 'google/siglip2-base-patch16-384', 'siglip2-so400m': 'google/siglip2-so400m-patch14-384',
             'siglip2-large': 'google/siglip2-large-patch16-384'}

    def __init__(self, name):
        from transformers import AutoModel, AutoProcessor
        mid = self.NAMES[name]
        self.proc = AutoProcessor.from_pretrained(mid)
        self.model = AutoModel.from_pretrained(mid, torch_dtype=torch.float16).cuda().eval()

    @torch.no_grad()
    def images(self, paths, bs=64):
        out = []
        for i in range(0, len(paths), bs):
            ims = [Image.open(p).convert('RGB') for p in paths[i:i + bs]]
            x = self.proc(images=ims, return_tensors='pt').to('cuda')
            e = self.model.get_image_features(pixel_values=x['pixel_values'].half())
            out.append(torch.nn.functional.normalize(_feat(e).float(), dim=-1).cpu())
        return torch.cat(out).numpy()

    @torch.no_grad()
    def texts(self, texts):
        x = self.proc(text=texts, padding='max_length', max_length=64, truncation=True, return_tensors='pt').to('cuda')
        e = self.model.get_text_features(input_ids=x['input_ids'])
        return torch.nn.functional.normalize(_feat(e).float(), dim=-1).cpu().numpy()


class KoCLIP:
    """한국어로 증류한 CLIP (Bingsu/clip-vit-large-patch14-ko)"""

    def __init__(self, name):
        from transformers import AutoModel, AutoProcessor
        mid = 'Bingsu/clip-vit-large-patch14-ko'
        self.proc = AutoProcessor.from_pretrained(mid)
        self.model = AutoModel.from_pretrained(mid, torch_dtype=torch.float16).cuda().eval()

    @torch.no_grad()
    def images(self, paths, bs=64):
        out = []
        for i in range(0, len(paths), bs):
            ims = [Image.open(p).convert('RGB') for p in paths[i:i + bs]]
            x = self.proc(images=ims, return_tensors='pt').to('cuda')
            e = self.model.get_image_features(pixel_values=x['pixel_values'].half())
            out.append(torch.nn.functional.normalize(_feat(e).float(), dim=-1).cpu())
        return torch.cat(out).numpy()

    @torch.no_grad()
    def texts(self, texts):
        x = self.proc(text=texts, padding=True, truncation=True, max_length=77, return_tensors='pt').to('cuda')
        e = self.model.get_text_features(input_ids=x['input_ids'], attention_mask=x['attention_mask'])
        return torch.nn.functional.normalize(_feat(e).float(), dim=-1).cpu().numpy()


def load_model(name):
    if name.startswith('siglip2'):
        return SigLIP(name)
    if name == 'koclip':
        return KoCLIP(name)
    raise SystemExit('모르는 모델: ' + name)


# ---------- 채점 ----------

def truth_ranges(sentence, durations):
    """문장에 실제로 쓴 컷들의 원본 구간 [(file, lo, hi)] (거꾸로 재생은 원본 시각으로 뒤집음)"""
    out = []
    for c in sentence['cuts']:
        lo, hi = sorted((c['srcIn'], c['srcOut']))
        if c.get('reverse'):
            d = durations.get(c['file'])
            if d:
                lo, hi = d - hi, d - lo
        out.append((c['file'], lo - 0.5, hi + 0.5))
    return out


def pick_top(scores, frames, k_max, gap=1.5):
    order = np.argsort(-scores)
    picked = []
    for i in order:
        f, t = frames[i]
        if all(not (f == pf and abs(t - pt) < gap) for pf, pt in picked):
            picked.append((f, t))
        if len(picked) >= k_max:
            break
    return picked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--truth', default='eval_data/truth')
    ap.add_argument('--frames', default='eval_data/frames')
    ap.add_argument('--model', default='siglip2-base')
    ap.add_argument('--projects', default='')
    ap.add_argument('--out', default=None)
    ap.add_argument('--norm', action='store_true', help='장면별 쏠림 보정')
    a = ap.parse_args()
    want = [p for p in a.projects.split(',') if p]
    model = load_model(a.model)
    hits = {k: 0 for k in KS}
    rand = {k: 0.0 for k in KS}
    n = 0
    per_project = {}
    details = []
    seen_seq = set()
    for tp in sorted(glob.glob(os.path.join(a.truth, '*.json'))):
        pname = os.path.splitext(os.path.basename(tp))[0]
        if want and pname not in want:
            continue
        d = json.load(open(tp, encoding='utf8'))
        cuts = json.load(open(os.path.join('eval_data/cuts', pname + '.json'), encoding='utf8'))
        srcs = {}
        for s in cuts['sequences']:
            for c in s['video']:
                if c.get('src') and os.path.exists(c['src']) and c['src'].lower().endswith(('.mp4', '.mov')):
                    srcs[os.path.basename(c['src'])] = c['src']
        # 프레임 + 임베딩 (원본 영상별)
        frames, durs = [], {}
        for fname, src in sorted(srcs.items()):
            fd = os.path.join(a.frames, pname, os.path.splitext(fname)[0])
            extract_frames(src, fd)
            frames += [(fname, t) for _p, t in frame_list(fd)]
            durs[fname] = video_duration(src)
        paths = []
        for fname, _src in sorted(srcs.items()):
            paths += [p for p, _t in frame_list(os.path.join(a.frames, pname, os.path.splitext(fname)[0]))]
        img = model.images(paths)
        total_len = sum(v or 0 for v in durs.values())
        all_texts = [x['text'] for s in d['sequences'] for x in s['sentences'] if x['start'] is not None]
        ph = {k: 0 for k in KS}
        pn = 0
        for s in d['sequences']:
            key = (s['sequence'], s['duration'])
            if key in seen_seq:
                continue
            seen_seq.add(key)
            hook_end = (s.get('hookSpec') or {}).get('sec', 3.0)
            sents = [x for x in s['sentences'] if x['start'] is not None and x['cuts'] and x['end'] > hook_end + 0.3]
            if not sents:
                continue
            txt = model.texts([x['text'] for x in sents])
            sims = txt @ img.T
            if a.norm:
                # 쏠림 보정: 장면마다 '아무 문장에나 높게 나오는 정도'를 빼줌 (프로젝트 전체 문장 기준)
                bank = model.texts(all_texts)
                ref = bank @ img.T
                sims = (sims - ref.mean(0)) / (ref.std(0) + 1e-6)
            for x, sc in zip(sents, sims):
                tr = truth_ranges(x, durs)
                top = pick_top(sc, frames, max(KS))
                ok = [any(f == tf and lo <= t <= hi for tf, lo, hi in tr) for f, t in top]
                cover = sum(hi - lo for _f, lo, hi in tr) / max(1e-6, total_len)
                for k in KS:
                    if any(ok[:k]):
                        hits[k] += 1
                        ph[k] += 1
                    rand[k] += 1 - (1 - min(1, cover)) ** k
                n += 1
                pn += 1
                details.append({'project': pname, 'seq': s['sequence'], 'text': x['text'],
                                'truth': [(f, round(lo, 1), round(hi, 1)) for f, lo, hi in tr],
                                'top': [(f, round(t, 1)) for f, t in top], 'hitRank': next((i + 1 for i, o in enumerate(ok) if o), None)})
        per_project[pname] = (pn, {k: ph[k] for k in KS})
        print(f"{pname}: 문장 {pn}개  " + '  '.join(f'top{k} {ph[k]}/{pn}' for k in KS), flush=True)
    print(f"\n[{a.model}] 전체 문장 {n}개")
    for k in KS:
        print(f"  top{k}: {hits[k]}/{n} = {hits[k] / max(1, n):.0%}   (무작위 기대 {rand[k] / max(1, n):.0%})")
    if a.out:
        json.dump({'model': a.model, 'n': n, 'hits': hits, 'random': rand, 'details': details},
                  open(a.out, 'w', encoding='utf8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
