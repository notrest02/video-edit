/**
 * 이 시퀀스에 쓸 원본 영상 고르기 (R42, 2026-11-16 사용자 요청)
 *  문제: 미디어에 두 제품 영상(물막이 1·2·3.mp4 + 제거기 1·2·3.mp4, 또는 한 폴더에 물막이1.mp4·제거기1.mp4)이 같이 올라가 있으면
 *        자동 배치가 6개를 모두 후보로 써서 다른 제품 장면이 섞일 수 있음. 후킹 선택 칸의 '1번 1.mp4'도 어느 것인지 모름.
 *  해결: 시퀀스마다 '쓸 원본' 목록을 저장(sequence.sourceVideos). 영상 묶음(폴더 + 이름 앞부분)이 여러 개면 처음 한 번 편집자가 고름.
 *        고르기 창은 단서로 미리 체크 (이 시퀀스가 이미 쓰는 영상 / 다른 시퀀스에서 쓴 영상 빼기 / 시퀀스·음성 이름과 폴더·파일 이름이 겹침)
 */
import type { SequenceItem, TimelineClip } from '../types/editor';
import { selectMediaForSequence } from './autoEdit';

type Vid = { path: string; name?: string; type?: string };
export type SourceGroup = {
  key: string;
  /** 보여 줄 이름 (예: "물막이/" 또는 "원본/물막이…") */
  label: string;
  paths: string[];
  /** 이 묶음 영상을 쓴 다른 시퀀스 이름 */
  usedBy: string[];
  /** 이 시퀀스가 이미 쓰는 영상이 있음 */
  usedHere: boolean;
  score: number;
};

const norm = (p: string) => p.split('\\').join('/').toLowerCase();
const dirOf = (p: string) => {
  const n = p.split('\\').join('/');
  const i = n.lastIndexOf('/');
  return i >= 0 ? n.slice(0, i) : '';
};
const baseOf = (p: string) => p.split(/[\\/]/).pop() || p;
/** 이름 앞부분: 확장자·끝 숫자·구분 기호를 뗀 것 (물막이1 → 물막이, 1 → '') */
export const namePrefix = (p: string) =>
  baseOf(p)
    .replace(/\.[^.]+$/, '')
    .replace(/[\s_\-()[\]]*\d+[\s_\-()[\]]*$/, '')
    .replace(/[\s_\-]+$/, '')
    .toLowerCase();
/** 이름 비교용 낱말: 숫자·기호·'음성' 같은 말 떼고 2글자 이상 */
const tokens = (s: string) =>
  s
    .replace(/\.[^.]+$/, '')
    .replace(/음성|보이스|voice|tts|최종|final|수정/gi, ' ')
    .split(/[\s_\-()[\]0-9.]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);

/** 영상 묶음: 같은 폴더 + 같은 이름 앞부분 */
export function groupSources(videos: Vid[]): Array<{ key: string; label: string; paths: string[] }> {
  const m = new Map<string, { key: string; label: string; paths: string[] }>();
  for (const v of videos) {
    const d = dirOf(v.path);
    const pre = namePrefix(v.path);
    const key = `${norm(d)}|${pre}`;
    const dn = d.split('/').pop() || d;
    const g = m.get(key) || { key, label: pre ? `${dn}/${pre}…` : `${dn}/`, paths: [] };
    g.paths.push(v.path);
    m.set(key, g);
  }
  return [...m.values()];
}

/**
 * 묶음마다 점수를 매겨 미리 체크할 영상을 고름.
 *  +10 이 시퀀스가 이미 쓰는 영상(클립·후킹 지정) / +3 시퀀스·음성 이름과 폴더·파일 이름이 겹침 / -5 다른 시퀀스에서 씀(이 시퀀스는 안 씀)
 *  가장 높은 묶음이 하나이고 0보다 크면 그것, 아니면 다른 시퀀스가 안 쓴 묶음이 하나뿐이면 그것, 그것도 아니면 미리 체크 없음
 */
export function guessSources(
  videos: Vid[],
  seq: Pick<SequenceItem, 'name' | 'clips' | 'adSegments'> | undefined,
  others: Array<Pick<SequenceItem, 'name' | 'clips' | 'adSegments'>>,
  activeClips?: Array<Pick<TimelineClip, 'type' | 'sourcePath' | 'name'>>
): { groups: SourceGroup[]; suggested: string[]; ambiguous: boolean } {
  const base = groupSources(videos.filter((v) => !v.type || v.type === 'video'));
  const pathsOf = (s?: Pick<SequenceItem, 'clips' | 'adSegments'>, clips?: Array<Pick<TimelineClip, 'type' | 'sourcePath'>>) => {
    const set = new Set<string>();
    for (const c of clips ?? s?.clips ?? []) if (c.type === 'video' && c.sourcePath) set.add(norm(c.sourcePath));
    for (const g of s?.adSegments || []) if (g.hook?.path) set.add(norm(g.hook.path));
    return set;
  };
  const here = pathsOf(seq, activeClips);
  const words = new Set<string>([
    ...tokens(seq?.name || ''),
    ...(activeClips ?? seq?.clips ?? []).filter((c) => c.type === 'audio').flatMap((c) => tokens((c as { name?: string }).name || '')),
  ]);
  const hit = (s: string) => tokens(s).some((t) => [...words].some((w) => t.includes(w) || w.includes(t)));
  const groups: SourceGroup[] = base.map((g) => {
    const usedHere = g.paths.some((p) => here.has(norm(p)));
    const usedBy = others.filter((o) => g.paths.some((p) => pathsOf(o).has(norm(p)))).map((o) => o.name);
    const dn = dirOf(g.paths[0]).split('/').pop() || '';
    let score = 0;
    if (usedHere) score += 10;
    if (hit(dn) || g.paths.some((p) => hit(baseOf(p)))) score += 3;
    if (!usedHere && usedBy.length) score -= 5;
    return { ...g, usedBy, usedHere, score };
  });
  const ambiguous = groups.length > 1;
  let suggested: string[] = [];
  if (!ambiguous) suggested = groups.flatMap((g) => g.paths);
  else {
    const top = Math.max(...groups.map((g) => g.score));
    const best = groups.filter((g) => g.score === top);
    if (top > 0 && best.length === 1) suggested = best[0].paths;
    else {
      const free = groups.filter((g) => !g.usedBy.length && !g.usedHere);
      if (free.length === 1) suggested = free[0].paths;
    }
  }
  return { groups, suggested, ambiguous };
}

/**
 * 이 시퀀스가 쓸 원본 영상 (자동 배치·장면 분석·후킹 선택·클립 변경이 모두 이것을 씀)
 *  - 편집자가 고른 목록(sequence.sourceVideos)이 있으면 그것 (미디어에 아직 있는 것만)
 *  - 없으면: 묶음이 하나면 전부, 여러 개면 미리 체크 결과, 그것도 없으면 예전 방식(selectMediaForSequence)
 */
export function videosForSequence<T extends Vid>(
  videos: T[],
  seq: (Pick<SequenceItem, 'name' | 'clips' | 'adSegments'> & { sourceVideos?: string[] }) | undefined,
  others: Array<Pick<SequenceItem, 'name' | 'clips' | 'adSegments'>>,
  activeClips?: Array<Pick<TimelineClip, 'type' | 'sourcePath' | 'name'>>
): { list: T[]; decided: boolean; needsChoice: boolean } {
  const vids = videos.filter((v) => !v.type || v.type === 'video');
  if (seq?.sourceVideos?.length) {
    const want = new Set(seq.sourceVideos.map(norm));
    const list = vids.filter((v) => want.has(norm(v.path)));
    if (list.length) return { list, decided: true, needsChoice: false };
  }
  const g = guessSources(vids, seq, others, activeClips);
  if (!g.ambiguous) return { list: vids, decided: true, needsChoice: false };
  if (g.suggested.length) {
    const want = new Set(g.suggested.map(norm));
    return { list: vids.filter((v) => want.has(norm(v.path))), decided: false, needsChoice: true };
  }
  return { list: selectMediaForSequence(vids, seq, others, activeClips), decided: false, needsChoice: true };
}
