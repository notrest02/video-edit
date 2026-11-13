import type { TimelineClip } from '../types/editor';

export interface SubtitleStyleTemplate {
  id: string;
  name: string;
  style: Partial<TimelineClip>;
  createdAt: number;
}

const STORAGE_KEY = 'agy_subtitle_style_templates_v1';

/** 자막 클립에서 글자 스타일·외곽선·그림자·배경·위치 속성만 추출 */
export function extractSubtitleStyle(clip: TimelineClip): Partial<TimelineClip> {
  return {
    fontFamily: clip.fontFamily,
    fontSize: clip.fontSize,
    fontWeight: clip.fontWeight,
    fontItalic: clip.fontItalic,
    letterSpacing: clip.letterSpacing,
    fontColor: clip.fontColor,
    fontOpacity: clip.fontOpacity,
    strokeEnabled: clip.strokeEnabled,
    strokeColor: clip.strokeColor,
    strokeWidth: clip.strokeWidth,
    strokeOpacity: clip.strokeOpacity,
    shadowEnabled: clip.shadowEnabled,
    shadowColor: clip.shadowColor,
    shadowOpacity: clip.shadowOpacity,
    shadowBlur: clip.shadowBlur,
    shadowOffsetX: clip.shadowOffsetX,
    shadowOffsetY: clip.shadowOffsetY,
    opacity: clip.opacity,
    backgroundEnabled: clip.backgroundEnabled,
    backgroundColor: clip.backgroundColor,
    backgroundOpacity: clip.backgroundOpacity,
    backgroundRadius: clip.backgroundRadius,
    backgroundPaddingX: clip.backgroundPaddingX,
    backgroundPaddingY: clip.backgroundPaddingY,
    positionX: clip.positionX,
    positionY: clip.positionY,
    anchorY: clip.anchorY,
    boxWidthPct: clip.boxWidthPct,
  };
}

export function loadSubtitleTemplates(): SubtitleStyleTemplate[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is SubtitleStyleTemplate =>
        t && typeof t.id === 'string' && typeof t.name === 'string' && t.style && typeof t.style === 'object'
    );
  } catch {
    return [];
  }
}

export function saveSubtitleTemplates(templates: SubtitleStyleTemplate[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
  } catch {
    // ignore storage quota errors
  }
}
