import { TimelineClip } from '../types/editor';

/**
 * 자막 클립을 시퀀스 해상도(width x height) 투명 배경 PNG 데이터 URL로 렌더링합니다.
 * - 글자 크기(fontSize)를 절대 축소하지 않으며, 글자 크기에 맞춰 화면 안전 폭(88%)을 넘어가면 어절(띄어쓰기) 단위로 자동 줄바꿈합니다.
 * - 내 PC 글꼴(fontFamily), 굵기, 기울임, 자간, 글자/외곽선/그림자/배경 투명도 및 위치를 프리뷰 화면과 100% 동일하게 합성합니다.
 */
export function renderSubtitleClipToPngDataUrl(
  clip: TimelineClip,
  width = 1280,
  height = 720
): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx || !clip.text) return '';

  ctx.clearRect(0, 0, width, height);

  const referenceWidth = width < height ? 720 : 1280;
  const scaleRatio = Math.max(0.25, width / referenceWidth);
  const fontSize = Math.max(12, Math.round((clip.fontSize || 40) * scaleRatio));
  const fontFamily =
    clip.fontFamily || '"Pretendard", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
  const fontWeight = clip.fontWeight || 'bold';
  const fontStyle = clip.fontItalic ? 'italic' : 'normal';

  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
  if ('letterSpacing' in ctx) {
    (ctx as any).letterSpacing = `${((clip.letterSpacing ?? 0) * scaleRatio).toFixed(2)}px`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const maxBoxWidth = Math.floor(width * 0.88);
  const padX = Math.round(10 * scaleRatio);
  const padY = Math.round(4 * scaleRatio);
  const maxTextLineWidth = Math.max(80, maxBoxWidth - padX * 2);

  // 명시적 줄바꿈(\n) + 글자 크기에 맞춘 어절 단위 자동 줄바꿈 수행
  const rawParagraphs = clip.text.split(/\r?\n/);
  const lines: string[] = [];
  for (const para of rawParagraphs) {
    const wrapped = wrapParagraphByWord(ctx, para, maxTextLineWidth);
    lines.push(...wrapped);
  }

  const lineHeight = fontSize * 1.35;
  const totalTextHeight = lines.length * lineHeight;

  const posXRatio = (clip.positionX ?? 50) / 100;
  const posYRatio = (clip.positionY ?? 86) / 100;
  const centerX = width * posXRatio;
  const centerY = height * posYRatio;
  const startY = centerY - totalTextHeight / 2 + lineHeight / 2;

  let maxLineWidth = 0;
  for (const line of lines) {
    const metrics = ctx.measureText(line);
    if (metrics.width > maxLineWidth) maxLineWidth = metrics.width;
  }

  const clipOpacity = clip.opacity ?? 1;
  ctx.save();
  ctx.globalAlpha = clipOpacity;

  // 1. 배경 박스 그리기
  const bgEnabled =
    clip.backgroundEnabled ??
    (clip.backgroundColor !== 'transparent' && (clip.backgroundOpacity ?? 0.65) > 0);
  const bgOpacity = bgEnabled ? (clip.backgroundOpacity ?? 0.65) : 0;

  if (bgOpacity > 0 && clip.backgroundColor && clip.backgroundColor !== 'transparent') {
    const boxW = Math.min(maxBoxWidth, maxLineWidth + padX * 2);
    const boxH = totalTextHeight + padY * 2;
    const boxX = centerX - boxW / 2;
    const boxY = centerY - boxH / 2;
    const radius = Math.round((clip.backgroundRadius ?? 6) * scaleRatio);

    ctx.save();
    ctx.fillStyle = hexToRgba(clip.backgroundColor, bgOpacity);
    roundRect(ctx, boxX, boxY, boxW, boxH, radius);
    ctx.fill();
    ctx.restore();
  }

  // 2. 그림자 / 외곽선(Stroke) / 본문 텍스트 렌더링
  const strokeEnabled = clip.strokeEnabled ?? true;
  const rawStrokeWidth = clip.strokeWidth ?? 3;
  const strokePx = strokeEnabled ? Math.max(0, rawStrokeWidth * scaleRatio * 2.2) : 0;
  const strokeRgba = hexToRgba(clip.strokeColor || '#000000', clip.strokeOpacity ?? 1);

  const shadowEnabled = clip.shadowEnabled ?? true;
  const shadowRgba = hexToRgba(clip.shadowColor || '#000000', clip.shadowOpacity ?? 0.85);
  const shadowOffsetX = Math.round((clip.shadowOffsetX ?? 0) * scaleRatio * 1.2);
  const shadowOffsetY = Math.round((clip.shadowOffsetY ?? 2) * scaleRatio * 1.2);
  const shadowBlur = Math.round((clip.shadowBlur ?? 6) * scaleRatio * 1.2);

  const fontRgba = hexToRgba(clip.fontColor || '#ffffff', clip.fontOpacity ?? 1);

  for (let i = 0; i < lines.length; i++) {
    const y = startY + i * lineHeight;
    const textLine = lines[i];

    // 그림자 적용 (외곽선이 있으면 외곽선 단계에, 없으면 본문 단계에 그림자 적용)
    ctx.save();
    if (shadowEnabled) {
      ctx.shadowColor = shadowRgba;
      ctx.shadowBlur = shadowBlur;
      ctx.shadowOffsetX = shadowOffsetX;
      ctx.shadowOffsetY = shadowOffsetY;
    }

    if (strokePx > 0) {
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = strokePx;
      ctx.strokeStyle = strokeRgba;
      ctx.strokeText(textLine, centerX, y);
      // 본문 칠할 때는 그림자 중복 방지
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }

    ctx.fillStyle = fontRgba;
    ctx.fillText(textLine, centerX, y);
    ctx.restore();
  }

  ctx.restore();
  return canvas.toDataURL('image/png');
}

/**
 * 글자 크기에 맞춰 maxWidthPx를 초과할 때 어절(띄어쓰기) 단위로 자동 줄바꿈합니다.
 */
function wrapParagraphByWord(
  ctx: CanvasRenderingContext2D,
  paragraph: string,
  maxWidthPx: number
): string[] {
  const trimmed = paragraph.trim();
  if (!trimmed) return [''];
  if (ctx.measureText(trimmed).width <= maxWidthPx) {
    return [trimmed];
  }

  const words = trimmed.split(/\s+/);
  const result: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidthPx) {
      currentLine = candidate;
    } else {
      if (currentLine) {
        result.push(currentLine);
      }
      // 만약 띄어쓰기 없는 단일 어절 하나가 한 줄 전체 폭보다 길다면 글자 단위로 분할
      if (ctx.measureText(word).width > maxWidthPx) {
        let charChunk = '';
        for (const ch of word) {
          const nextChunk = charChunk + ch;
          if (ctx.measureText(nextChunk).width > maxWidthPx && charChunk) {
            result.push(charChunk);
            charChunk = ch;
          } else {
            charChunk = nextChunk;
          }
        }
        currentLine = charChunk;
      } else {
        currentLine = word;
      }
    }
  }

  if (currentLine) {
    result.push(currentLine);
  }

  return result.length > 0 ? result : [trimmed];
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
