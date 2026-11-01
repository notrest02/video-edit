/**
 * Chromium 이 읽지 못하는 옛 글꼴(a개똥벌레, a뉴굴림 등)을 Windows GDI+ 윤곽선으로 그리기 위한 렌더러 측 유틸.
 *
 * - 자막 fontFamily 값 형식: `"GDI:<글꼴 이름>", sans-serif`
 * - 글자별 윤곽선(SVG path, 100px 기준)과 글자 폭을 메인 프로세스에서 받아 캐시하고,
 *   canvas 에서 Path2D 로 채우기/외곽선/그림자를 그린다.
 * - 캐시에 없는 글자는 그릴 수 없으므로 그리기 전에 ensureGdiTextReady() 로 미리 받아둔다.
 */
import type { TimelineClip } from '../types/editor';

const GDI_PREFIX = 'GDI:';
const EM = 100;

type Glyph = { adv: number; path: Path2D | null };
type GdiFace = {
  asc: number;
  desc: number;
  synthBold: boolean;
  glyphs: Map<number, Glyph>;
  inflight: Map<number, Promise<void>>;
};

const faces = new Map<string, GdiFace>();
const listeners = new Set<() => void>();

export function gdiFontValue(family: string): string {
  return `"${GDI_PREFIX}${family.replace(/["\\]/g, '')}", sans-serif`;
}

export function extractGdiFamily(value?: string): string | null {
  if (!value) return null;
  const m = value.match(/"GDI:([^"]+)"/);
  return m ? m[1] : null;
}

/** 굵게/기울임 → GDI+ FontStyle 비트 */
export function gdiStyleOf(clip: Pick<TimelineClip, 'fontWeight' | 'fontItalic'>): number {
  const bold = (clip.fontWeight || 'bold') !== 'normal';
  return (bold ? 1 : 0) | (clip.fontItalic ? 2 : 0);
}

const faceKey = (family: string, style: number) => `${family}|${style}`;

export function getGdiFace(family: string, style: number): GdiFace | null {
  return faces.get(faceKey(family, style)) || null;
}

/** 글자 윤곽선이 새로 도착하면 호출 (미리보기 다시 그리기용) */
export function onGdiGlyphsLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 해당 글꼴/스타일로 text 를 그리는 데 필요한 글자 윤곽선을 모두 받아둔다 */
export async function ensureGdiTextReady(family: string, style: number, text: string): Promise<void> {
  const api = window.electronAPI;
  if (!api?.gdiGlyphs) return;
  const key = faceKey(family, style);
  let face = faces.get(key);
  if (!face) {
    face = { asc: 80, desc: 20, synthBold: false, glyphs: new Map(), inflight: new Map() };
    faces.set(key, face);
  }
  const f = face;
  const cps = Array.from(new Set(Array.from(text.replace(/\r?\n/g, '')).map((c) => c.codePointAt(0)!)));
  const waits: Promise<void>[] = [];
  const missing: number[] = [];
  for (const cp of cps) {
    if (f.glyphs.has(cp)) continue;
    const pending = f.inflight.get(cp);
    if (pending) waits.push(pending);
    else missing.push(cp);
  }
  if (missing.length > 0) {
    const job = (async () => {
      const res = await api.gdiGlyphs!({
        family,
        style,
        chars: String.fromCodePoint(...missing),
      });
      if (!res) {
        // 실패한 글자는 빈 글자로 표시해 무한 재요청 방지
        for (const cp of missing) f.glyphs.set(cp, { adv: EM * 0.5, path: null });
        return;
      }
      f.asc = res.asc;
      f.desc = res.desc;
      f.synthBold = res.synthBold;
      for (const g of res.glyphs) {
        f.glyphs.set(g.cp, { adv: g.adv, path: g.d ? new Path2D(g.d) : null });
      }
      for (const cp of missing) {
        if (!f.glyphs.has(cp)) f.glyphs.set(cp, { adv: EM * 0.5, path: null });
      }
    })().finally(() => {
      for (const cp of missing) f.inflight.delete(cp);
      listeners.forEach((fn) => fn());
    });
    for (const cp of missing) f.inflight.set(cp, job);
    waits.push(job);
  }
  await Promise.all(waits);
}

/** 여러 자막 클립에 쓰인 GDI 글꼴 글자를 모두 받아둔다 (렌더 직전 호출) */
export async function ensureGdiClipsReady(clips: TimelineClip[]): Promise<void> {
  await Promise.all(
    clips.map((c) => {
      const fam = extractGdiFamily(c.fontFamily);
      return fam && c.text ? ensureGdiTextReady(fam, gdiStyleOf(c), c.text) : Promise.resolve();
    })
  );
}

/** 캐시된 윤곽선으로 한 줄을 그리는 텍스트 엔진 (canvas 의 measureText/fillText 대체) */
export class GdiTextEngine {
  private k: number;
  /**
   * fallbackMeasure: 글꼴에 없는 글자(옛 글꼴은 KS X 1001 한글 2,350자만 있는 경우가 많음)를
   * 대체 글꼴로 그릴 때의 폭을 재는 함수
   */
  constructor(
    private face: GdiFace,
    private fontSizePx: number,
    private letterSpacingPx: number,
    private fallbackMeasure: (ch: string) => number
  ) {
    this.k = fontSizePx / EM;
  }

  private isMissing(ch: string, g: Glyph | undefined): boolean {
    return !g?.path && !/\s/.test(ch);
  }

  private advance(ch: string): number {
    const g = this.face.glyphs.get(ch.codePointAt(0)!);
    if (this.isMissing(ch, g)) return this.fallbackMeasure(ch);
    return (g ? g.adv : EM * 0.5) * this.k;
  }

  /** 글꼴에 없어서 대체 글꼴로 그려야 하는 글자와 그 가운데 x 좌표 */
  fallbackChars(line: string, centerX: number): Array<{ ch: string; x: number }> {
    const out: Array<{ ch: string; x: number }> = [];
    let x = centerX - this.measure(line) / 2;
    for (const ch of line) {
      const g = this.face.glyphs.get(ch.codePointAt(0)!);
      const adv = this.advance(ch);
      if (this.isMissing(ch, g)) out.push({ ch, x: x + adv / 2 });
      x += adv + this.letterSpacingPx;
    }
    return out;
  }

  get synthBold() {
    return this.face.synthBold;
  }

  measure(line: string): number {
    let w = 0;
    let n = 0;
    for (const ch of line) {
      w += this.advance(ch) + this.letterSpacingPx;
      n++;
    }
    return n > 0 ? w - this.letterSpacingPx : 0;
  }

  /** centerX 기준 가운데 정렬, y 는 줄의 세로 중앙 (canvas textBaseline='middle' 과 동일한 의미) */
  buildLinePath(line: string, centerX: number, y: number): Path2D {
    const out = new Path2D();
    const width = this.measure(line);
    let x = centerX - width / 2;
    const top = y - ((this.face.asc + this.face.desc) / 2) * this.k;
    for (const ch of line) {
      const g = this.face.glyphs.get(ch.codePointAt(0)!);
      if (g?.path) {
        out.addPath(g.path, new DOMMatrix().translate(x, top).scale(this.k));
      }
      x += this.advance(ch) + this.letterSpacingPx;
    }
    return out;
  }
}
