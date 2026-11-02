/**
 * 자동 마스크: 원본에서 찾은 '글자 덩어리'(원본 좌표·원본 초) → 클립의 블러 마스크(출력 화면 좌표·클립 안 초)
 *  - 원본이 출력 화면에 '맞춤(contain)'으로 들어간다고 보고 좌표를 옮김
 *  - 위치가 거의 안 변하면 고정 마스크(덩어리 전체를 감싸는 사각형), 움직이면 꼭짓점 키프레임
 *  - 클립 안에서 보이는 구간(from~to)만 가림 — 장면마다 바뀌는 자막
 */
import type { AutoTextTrack, BlurMask, MaskPoint, TimelineClip } from '../types/editor';

/** 여백 기본값: 글자 상자 높이(세로쓰기면 폭)의 25% — 넓히면 두 줄 큰 글자에서 배경까지 가림 */
export const DEFAULT_MARGIN = 0.25;
const rectPoints = (x0: number, y0: number, x1: number, y1: number): MaskPoint[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/**
 * 같은 자리의 글자가 잠깐 안 잡혀 끊긴 덩어리 잇기 (밝은 배경에서 워터마크를 놓치는 경우 등):
 * 위치가 겹치고(작은 쪽 넓이의 60% 이상) 글자가 일부라도 같고 3초 안에 다시 나오면 하나로 → 빈틈 없이 가림
 */
export function mergeTrackGaps(tracks: AutoTextTrack[], maxGap = 3): AutoTextTrack[] {
  const union = (t: AutoTextTrack) =>
    [
      Math.min(...t.samples.map((s) => s.box[0])),
      Math.min(...t.samples.map((s) => s.box[1])),
      Math.max(...t.samples.map((s) => s.box[2])),
      Math.max(...t.samples.map((s) => s.box[3])),
    ] as const;
  const overlapMin = (a: readonly number[], b: readonly number[]) => {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const sa = (a[2] - a[0]) * (a[3] - a[1]);
    const sb = (b[2] - b[0]) * (b[3] - b[1]);
    return (ix * iy) / Math.max(1e-9, Math.min(sa, sb));
  };
  const shares = (a: string, b: string) => [...a].some((ch) => b.includes(ch));
  // 같은 글자인지: 짧은 쪽 글자의 75% 이상이 겹치고 2자 이상
  const sameText = (a: string, b: string) => {
    const [s, l] = a.length <= b.length ? [a, b] : [b, a];
    if (s.length < 2) return false;
    return [...s].filter((ch) => l.includes(ch)).length / s.length >= 0.75;
  };
  // 글자 굵기(표본 상자의 짧은 변 중간값) — 움직여서 합친 덩어리도 글자 크기로 비교
  const height = (t: AutoTextTrack) => {
    const v = t.samples.map((p) => Math.min(p.box[2] - p.box[0], p.box[3] - p.box[1])).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)] || 0;
  };
  const list = [...tracks].sort((a, b) => a.start - b.start).map((t) => ({ ...t, samples: [...t.samples] }));
  const out: AutoTextTrack[] = [];
  for (const t of list) {
    const prev =
      // 1) 같은 자리에서 잠깐 놓친 경우
      out.find((o) => t.start - o.end <= maxGap && t.start >= o.start && overlapMin(union(o), union(t)) >= 0.6 && shares(o.text, t.text)) ||
      // 2) 움직이는 워터마크: 같은 글자가 다른 자리에서 다시 잡힌 경우 (시간이 안 겹치고, 글자 크기 비슷) → 한 마스크로 따라감
      out
        .filter(
          (o) =>
            t.start >= o.end - 0.05 &&
            t.start - o.end <= maxGap &&
            sameText(o.text, t.text) &&
            Math.max(height(o), height(t)) <= Math.min(height(o), height(t)) * 1.8
        )
        .sort((a, b) => b.end - a.end)[0];
    if (prev) {
      prev.end = Math.max(prev.end, t.end);
      prev.samples.push(...t.samples);
      prev.samples.sort((a, b) => a.t - b.t);
      if (t.text.length > prev.text.length) prev.text = t.text; // 더 길게 읽힌 글자로
      prev.conf = Math.max(prev.conf, t.conf);
      prev.hasHan = prev.hasHan || t.hasHan;
    } else out.push(t);
  }
  return out;
}

export function tracksToMasks(
  tracks: AutoTextTrack[],
  clip: TimelineClip,
  src: { w: number; h: number },
  out: { w: number; h: number },
  margin = DEFAULT_MARGIN
): BlurMask[] {
  const sp = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const s0 = clip.sourceStart;
  const s1 = s0 + clip.duration * sp;
  // 원본 → 출력 화면 (맞춤)
  const k = Math.min(out.w / src.w, out.h / src.h);
  const ox = (out.w - src.w * k) / 2;
  const oy = (out.h - src.h * k) / 2;
  const mapX = (x: number) => (ox + x * src.w * k) / out.w;
  const mapY = (y: number) => (oy + y * src.h * k) / out.h;
  const toPts = ([x0, y0, x1, y1]: [number, number, number, number]): MaskPoint[] => {
    // 글자 높이(원본 px 기준)로 여백 — 세로쓰기면 가로/세로를 바꿔 적용
    const hPx = (y1 - y0) * src.h;
    const wPx = (x1 - x0) * src.w;
    const vertical = hPx > wPx * 1.5;
    const unit = vertical ? wPx : hPx; // 글자 한 줄의 굵기
    const mx = (unit * margin) / src.w;
    const my = (unit * margin) / src.h;
    return rectPoints(
      Math.max(0, mapX(x0 - mx)),
      Math.max(0, mapY(y0 - my)),
      Math.min(1, mapX(x1 + mx)),
      Math.min(1, mapY(y1 + my))
    );
  };
  const masks: BlurMask[] = [];
  for (const tr of tracks) {
    if (tr.end <= s0 || tr.start >= s1) continue;
    // 같은 순간에 조각으로 잡힌 상자(밝은 배경에서 한 줄이 '封闭道' + '全拍摄' 로 나뉨 등)는 하나로 합침
    const byT = new Map<string, { t: number; box: [number, number, number, number] }>();
    for (const p of tr.samples) {
      if (p.t < s0 - 0.2 || p.t > s1 + 0.2) continue;
      const k = p.t.toFixed(3);
      const o = byT.get(k);
      if (!o) byT.set(k, { t: p.t, box: [...p.box] as [number, number, number, number] });
      else o.box = [Math.min(o.box[0], p.box[0]), Math.min(o.box[1], p.box[1]), Math.max(o.box[2], p.box[2]), Math.max(o.box[3], p.box[3])];
    }
    const inside = [...byT.values()].sort((a, b) => a.t - b.t);
    if (!inside.length) continue;
    const from = Math.max(0, (tr.start - s0) / sp);
    const to = Math.min(clip.duration, (tr.end - s0) / sp);
    // 움직임 판단: 위치(가운데)가 화면 3% 넘게 실제로 옮겨갈 때만 키프레임.
    // 크기만 줄었다 늘었다 하면(자막 길이 차이 등) 가장 큰 영역 하나로 쭉 가림 (사용자 2026-11-03)
    const cx = inside.map((p) => (p.box[0] + p.box[2]) / 2);
    const cy = inside.map((p) => (p.box[1] + p.box[3]) / 2);
    // 가운데가 움직인 거리가 상자 자기 크기(중간값)의 절반을 넘을 때만 '진짜 이동' — 가운데 정렬 자막이 길어졌다 짧아지는 건 고정
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const mw = med(inside.map((p) => p.box[2] - p.box[0]));
    const mh = med(inside.map((p) => p.box[3] - p.box[1]));
    const dx = Math.max(...cx) - Math.min(...cx);
    const dy = Math.max(...cy) - Math.min(...cy);
    // 왔다갔다(방향이 두 번 이상 바뀜) 하면 따라가지 않고, 움직이는 범위 전체를 고정 마스크 하나로 가림
    const reversals = (v: number[], th: number) => {
      let dir = 0;
      let anchor = v[0];
      let n = 0;
      for (const x of v) {
        const d = x - anchor;
        if (Math.abs(d) < th) continue;
        const sd = Math.sign(d);
        if (dir && sd !== dir) n++;
        dir = sd;
        anchor = x;
      }
      return n;
    };
    const oscillating = reversals(cx, Math.max(0.02, mw * 0.25)) >= 2 || reversals(cy, Math.max(0.02, mh * 0.25)) >= 2;
    const moving = !oscillating && ((dx > 0.03 && dx > mw * 0.5) || (dy > 0.03 && dy > mh * 0.5));
    const union: [number, number, number, number] = [
      Math.min(...inside.map((p) => p.box[0])),
      Math.min(...inside.map((p) => p.box[1])),
      Math.max(...inside.map((p) => p.box[2])),
      Math.max(...inside.map((p) => p.box[3])),
    ];
    const mask: BlurMask = {
      id: `mask_auto_${tr.id}_${Math.random().toString(36).slice(2, 6)}`,
      points: toPts(union),
      blur: 30,
      feather: 6,
      from: +from.toFixed(3),
      to: +to.toFixed(3),
      auto: tr.id,
    };
    if (moving) {
      // 키프레임: 0.2초 간격 표본 중 직전과 1% 넘게 다른 것만
      const kfs: NonNullable<BlurMask['keyframes']> = [];
      let prev: MaskPoint[] | null = null;
      inside.forEach((p, i) => {
        const pts = toPts(p.box);
        const far = !prev || pts.some((q, j) => Math.abs(q[0] - prev![j][0]) > 0.01 || Math.abs(q[1] - prev![j][1]) > 0.01);
        if (far || i === inside.length - 1) {
          kfs.push({ t: +Math.max(0, (p.t - s0) / sp).toFixed(3), points: pts, ease: 'linear' });
          prev = pts;
        }
      });
      mask.keyframes = kfs;
    }
    masks.push(mask);
  }
  return masks;
}
