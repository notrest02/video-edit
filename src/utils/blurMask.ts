/**
 * 블러 마스크 (원본에 박힌 중국어 자막·워터마크 가리기). 프리미어의 '가우시안 흐림 + 마스크'에 해당.
 * 좌표는 출력 화면(시퀀스) 기준 0~1. 네 꼭짓점을 따로 움직일 수 있는 사각형.
 * keyframes 가 있으면 클립 안 시각(초)에 따라 꼭짓점이 선형으로 움직임 (움직이는 글자, 2단계).
 */
import type { BlurMask, MaskPoint } from '../types/editor';
import { easeFn } from './keyframes';

export function newBlurMask(): BlurMask {
  return {
    id: `mask_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    points: [
      [0.25, 0.04],
      [0.75, 0.04],
      [0.75, 0.12],
      [0.25, 0.12],
    ],
    blur: 25,
    feather: 6,
  };
}

/** 클립 안 시각 t(초)에서의 꼭짓점 (키프레임 사이 선형 보간) */
export function maskPointsAt(mask: BlurMask, t: number): MaskPoint[] {
  const kf = mask.keyframes;
  if (!kf || kf.length === 0) return mask.points;
  const ks = [...kf].sort((a, b) => a.t - b.t);
  if (t <= ks[0].t) return ks[0].points;
  if (t >= ks[ks.length - 1].t) return ks[ks.length - 1].points;
  for (let i = 0; i + 1 < ks.length; i++) {
    const [a, b] = [ks[i], ks[i + 1]];
    if (t >= a.t && t < b.t) {
      const r = easeFn(a.ease, (t - a.t) / Math.max(1e-6, b.t - a.t));
      return a.points.map((p, k) => [p[0] + (b.points[k][0] - p[0]) * r, p[1] + (b.points[k][1] - p[1]) * r]) as MaskPoint[];
    }
  }
  return mask.points;
}

/**
 * 블러 범위 넓히기/줄이기: 다각형 각 변을 d px 만큼 바깥(+)/안쪽(-)으로 평행 이동 (출력 px 기준)
 * 사각형이면 가로·세로 모두 정확히 d px 씩 넓어짐. 너무 줄여 뒤집히지 않게 짧은 변의 45%까지만 줄임
 */
export function expandPoints(points: MaskPoint[], d: number, width: number, height: number): MaskPoint[] {
  if (!d || points.length < 3) return points;
  const P = points.map(([x, y]) => [x * width, y * height]);
  const n = P.length;
  // 도는 방향 (넓이 부호) → 바깥쪽 법선 방향 결정
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [a, b] = [P[i], P[(i + 1) % n]];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sgn = area >= 0 ? 1 : -1;
  if (d < 0) {
    const minEdge = Math.min(...P.map((a, i) => Math.hypot(P[(i + 1) % n][0] - a[0], P[(i + 1) % n][1] - a[1])));
    d = Math.max(d, -minEdge * 0.45);
  }
  const normal = (a: number[], b: number[]) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    return [(dy / L) * sgn, (-dx / L) * sgn];
  };
  return P.map((p, i) => {
    const n1 = normal(P[(i - 1 + n) % n], p);
    const n2 = normal(p, P[(i + 1) % n]);
    const dot = n1[0] * n2[0] + n1[1] * n2[1];
    const k = d / Math.max(0.2, 1 + dot);
    return [Math.min(1.2, Math.max(-0.2, (p[0] + (n1[0] + n2[0]) * k) / width)), Math.min(1.2, Math.max(-0.2, (p[1] + (n1[1] + n2[1]) * k) / height))] as MaskPoint;
  });
}

/** 실제로 흐리게 되는 영역 (꼭짓점 + 블러 범위) */
export function blurPointsAt(mask: BlurMask, t: number, width: number, height: number): MaskPoint[] {
  return expandPoints(maskPointsAt(mask, t), mask.expand || 0, width, height);
}

/** 미리보기용: 부드러운 가장자리를 가진 다각형을 CSS mask-image 로 (SVG 데이터 URL) */
export function maskSvgDataUrl(points: MaskPoint[], width: number, height: number, feather: number): string {
  const pts = points.map(([x, y]) => `${(x * width).toFixed(1)},${(y * height).toFixed(1)}`).join(' ');
  const f = Math.max(0, feather);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}' width='${width}' height='${height}'>` +
    (f > 0 ? `<filter id='f' x='-20%' y='-20%' width='140%' height='140%'><feGaussianBlur stdDeviation='${f}'/></filter>` : '') +
    `<polygon points='${pts}' fill='white'${f > 0 ? " filter='url(#f)'" : ''}/></svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}

/** 내보내기용: 출력 크기의 흑백 마스크 PNG (흰색 = 흐리게 할 곳, 가장자리 부드럽게) */
export function maskPngDataUrl(points: MaskPoint[], width: number, height: number, feather: number): string {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  if (feather > 0) ctx.filter = `blur(${feather}px)`;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x * width, y * height) : ctx.moveTo(x * width, y * height)));
  ctx.closePath();
  ctx.fill();
  return c.toDataURL('image/png');
}
