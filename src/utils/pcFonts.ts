/**
 * 내 PC 글꼴 로딩 유틸
 *
 * 문제: Windows(GDI) 글꼴 이름("a개똥벌레", "Noto Sans KR DemiLight" 등)을 CSS font-family 로 넘기면
 * Chromium(DirectWrite)이 찾지 못하는 글꼴이 많아(이 PC 기준 451개 중 83개) 엉뚱한 대체 글꼴로 그려졌다.
 *
 * 해결: queryLocalFonts()로 받은 "글꼴 면(face)" 단위 데이터를 FontFace 로 직접 등록한다.
 *   - 값 형식: `"PCF:<postscriptName>", "<DirectWrite family>", sans-serif`
 *   - PCF 별칭 등록에 실패(일부 옛 HY 글꼴은 Chromium 폰트 검증기에 걸림)해도
 *     두 번째 이름(DirectWrite family)으로 시스템 글꼴을 그대로 찾아 쓰도록 한다.
 */
import type { SystemFontItem } from '../types/editor';
import { gdiFontValue } from './gdiFonts';

const PCF_PREFIX = 'PCF:';

type LocalFontData = {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob: () => Promise<Blob>;
};

let localFontsPromise: Promise<LocalFontData[]> | null = null;
const registered = new Map<string, Promise<boolean>>();

function queryAllLocalFonts(): Promise<LocalFontData[]> {
  if (!localFontsPromise) {
    const q = (window as any).queryLocalFonts as undefined | (() => Promise<LocalFontData[]>);
    localFontsPromise = q ? q().catch(() => []) : Promise.resolve([]);
  }
  return localFontsPromise;
}

const cssQuote = (name: string) => `"${name.replace(/["\\]/g, '')}"`;

const REGULAR_STYLE = /^(regular|normal|roman|book|보통|표준)$/i;

/** 글꼴 면 하나를 자막에서 쓸 CSS font-family 값으로 변환 */
export function pcFontValue(face: { family: string; postscriptName: string }): string {
  return `${cssQuote(PCF_PREFIX + face.postscriptName)}, ${cssQuote(face.family)}, sans-serif`;
}

/** font-family 값 안에 들어있는 PCF 별칭(postscriptName) 추출 */
export function extractPcfPostscriptName(value?: string): string | null {
  if (!value) return null;
  const m = value.match(/"PCF:([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * 내 PC 글꼴 목록(면 단위) 생성.
 * ipcFonts(Windows 한글/영문 이름 쌍)는 한글 라벨을 붙이는 용도로만 사용한다.
 * queryLocalFonts 를 쓸 수 없으면 null 을 돌려주어 기존 방식으로 대체하게 한다.
 */
export async function buildPcFontList(ipcFonts: SystemFontItem[]): Promise<SystemFontItem[] | null> {
  const faces = await queryAllLocalFonts();
  if (faces.length === 0) return null;

  const koByEn = new Map<string, string>();
  for (const f of ipcFonts) {
    if (f.familyKo && f.familyEn && f.familyKo !== f.familyEn) {
      koByEn.set(f.familyEn.toLowerCase(), f.familyKo);
    }
  }

  const items: SystemFontItem[] = [];
  const seen = new Set<string>();
  for (const face of faces) {
    if (!face.postscriptName || seen.has(face.postscriptName)) continue;
    seen.add(face.postscriptName);

    const ko =
      koByEn.get(face.fullName.toLowerCase()) || koByEn.get(face.family.toLowerCase()) || '';
    const style = (face.style || '').trim();
    const isRegular = !style || REGULAR_STYLE.test(style);
    // 스타일 이름이 이미 전체 이름에 들어있는 글꼴(예: "Yj BACDOO Bold")은 전체 이름을 그대로 사용
    const enName = face.fullName && face.fullName !== face.family ? face.fullName : face.family;
    const enLabel = isRegular || enName !== face.family ? enName : `${face.family} ${style}`;
    // Windows 가 한글 이름을 깨뜨려 돌려준 경우('?' 포함)는 영문 이름만 표시
    const label = ko && !ko.includes('?') ? `${ko} (${enLabel})` : enLabel;

    items.push({
      label,
      value: pcFontValue(face),
      familyKo: ko || face.family,
      familyEn: enLabel,
    });
  }

  // 이 앱(Chromium)에서 실제로 그릴 수 없는 글꼴은 목록에서 뺀다.
  // 이름으로 바로 찾히면 통과, 아니면 글꼴 파일을 직접 등록해 보고 그래도 실패하면 제외
  // (예: a개똥벌레 등 옛 한글 글꼴은 Chromium 이 파일 형식을 거부해 어떤 방법으로도 표시 불가)
  const usable: SystemFontItem[] = [];
  const gdiCandidates = new Map<string, SystemFontItem>(); // family → 대표 항목
  for (const item of items) {
    const ps = extractPcfPostscriptName(item.value);
    const family = item.value.split(',')[1]?.trim() || '';
    if (!ps || isResolvableByName(family)) {
      usable.push(item);
      continue;
    }
    if (await ensurePcFont(ps)) {
      usable.push(item);
      continue;
    }
    // Chromium 이 못 읽는 글꼴 → Windows(GDI+)로 그릴 수 있으면 GDI 방식으로 사용
    const rawFamily = family.replace(/^"|"$/g, '');
    if (rawFamily && !gdiCandidates.has(rawFamily)) gdiCandidates.set(rawFamily, item);
  }
  if (gdiCandidates.size > 0 && window.electronAPI?.gdiCheckFonts) {
    const fams = Array.from(gdiCandidates.keys());
    const ok = await window.electronAPI.gdiCheckFonts(fams).catch(() => fams.map(() => false));
    fams.forEach((fam, i) => {
      if (!ok[i]) return;
      const item = gdiCandidates.get(fam)!;
      usable.push({
        ...item,
        label: `${item.label} · Windows 렌더`,
        value: gdiFontValue(fam),
      });
    });
  }

  usable.sort((a, b) => {
    const aKo = /[가-힣]/.test(a.label);
    const bKo = /[가-힣]/.test(b.label);
    if (aKo !== bKo) return aKo ? -1 : 1;
    return a.label.localeCompare(b.label, 'ko');
  });
  return usable;
}

let measureCtx: CanvasRenderingContext2D | null = null;
/** CSS 이름만으로 시스템 글꼴이 찾아지는지 (대체 글꼴을 바꿔도 폭이 같으면 실제 글꼴로 그려진 것) */
function isResolvableByName(quotedFamily: string): boolean {
  if (!quotedFamily) return false;
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  const ctx = measureCtx;
  if (!ctx) return true;
  const width = (fallback: string, sample: string) => {
    ctx.font = `40px ${quotedFamily}, ${fallback}`;
    return ctx.measureText(sample).width;
  };
  const same = (sample: string) => Math.abs(width('monospace', sample) - width('serif', sample)) < 0.5;
  return same('ABC abc xyz 123') || same('가나다 빨래바구니');
}

/** PCF 별칭 글꼴 하나를 실제 글꼴 파일 데이터로 등록 (이미 등록했으면 재사용) */
export function ensurePcFont(postscriptName: string): Promise<boolean> {
  let p = registered.get(postscriptName);
  if (!p) {
    p = (async () => {
      try {
        const faces = await queryAllLocalFonts();
        const face = faces.find((f) => f.postscriptName === postscriptName);
        if (!face) return false;
        const data = await (await face.blob()).arrayBuffer();
        const ff = new FontFace(PCF_PREFIX + postscriptName, data);
        await ff.load();
        document.fonts.add(ff);
        return true;
      } catch (err) {
        // 일부 옛 글꼴은 Chromium 폰트 검증(OTS)에 실패 → 두 번째 이름(시스템 family)으로 대체 렌더
        console.warn('[pcFonts] FontFace 등록 실패, 시스템 이름으로 대체:', postscriptName, err);
        return false;
      }
    })();
    registered.set(postscriptName, p);
  }
  return p;
}

/** 여러 font-family 값에 포함된 PC 글꼴을 모두 등록하고 완료까지 기다림 (렌더 전 호출) */
export async function ensureFontsForValues(values: Array<string | undefined>): Promise<void> {
  const names = new Set<string>();
  for (const v of values) {
    const ps = extractPcfPostscriptName(v);
    if (ps) names.add(ps);
  }
  await Promise.all(Array.from(names).map((n) => ensurePcFont(n)));
  try {
    await (document as any).fonts?.ready;
  } catch {
    // ignore
  }
}
