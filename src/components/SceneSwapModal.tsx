import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Repeat2, AlertTriangle } from 'lucide-react';
import { useEditorStore, MIN_CLIP_SPEED } from '../store/useEditorStore';
import type { AutoEditShot, AutoEditShotDesc, TimelineClip } from '../types/editor';
import { FIT_SPEED, STAGES, guessStage, placeAt, rankSceneCandidates, shotOfClip, stageOf, type SceneCandidate, type Stage } from '../utils/sceneSwap';
import { attachLooks, jumpLooksSame, selectMediaForSequence } from '../utils/autoEdit';
import { mergeTrackGaps } from '../utils/autoMask';
import { sourceMasksFromTracks, srcKeyOf } from '../utils/sourceMask';

/**
 * 클립 변경 (2026-11-16): 타임라인 영상 클립 우클릭 → "클립 변경…"
 *  - 자동 배치 뒤 검수용. AI가 원본을 나눈 장면을 단계 칸(문제상황/준비/실제사용/완성모습/기타)으로 보여 줌
 *    → 편집자는 원본 전체를 보지 않고, 대사에 맞는 칸의 장면만 비교 (처음 여는 칸 = 대사로 추정한 단계)
 *  - 고른 장면: 실제로 들어갈 구간만 반복 재생, 시작점 조정, 경고(느려짐·앞뒤 컷과 같아 보임·화면 전환 걸림·다른 광고에서 씀)
 *  - 편집자의 판단을 믿는다: 짧은 장면·같아 보이는 장면도 고르면 바꿈 (경고만). 타임라인 길이는 그대로
 *  - 원본 마스크(R41)는 새 원본 것이 자동으로 따라옴. 자동 마스크를 쓰는 프로젝트인데 이 원본만 아직이면 바꾸면서 글자 찾기(로컬, 비용 없음)
 *  - 이미 저장된 장면 분석만 씀 → 비용 없음
 */
export const openSceneSwap = (clipId: string) => window.dispatchEvent(new CustomEvent('scene-swap:open', { detail: clipId }));

const mediaUrl = (p: string) => `media://local?path=${encodeURIComponent(p)}`;

// 사진은 한 장씩 차례로 만듦 (ffmpeg 를 수십 개 동시에 띄우지 않게), 한 번 만든 건 저장돼 다음부터 바로
let thumbChain: Promise<unknown> = Promise.resolve();
const thumbCache = new Map<string, Promise<string | null>>();
const getThumb = (path: string, t: number): Promise<string | null> => {
  const k = `${path}|${t.toFixed(2)}`;
  let p = thumbCache.get(k);
  if (!p) {
    const api = window.electronAPI;
    p = (thumbChain = thumbChain.then(() => api?.sceneThumb?.({ path, t }).catch(() => null) ?? null)) as Promise<string | null>;
    thumbCache.set(k, p);
  }
  return p;
};

/** 구간 반복 재생 영상 (from~to, 소리 없음) */
const LoopVideo: React.FC<{ path: string; from: number; to: number; className?: string }> = ({ path, from, to, className }) => (
  <video
    key={`${path}|${from.toFixed(2)}`}
    src={`${mediaUrl(path)}#t=${from.toFixed(2)}`}
    muted
    autoPlay
    className={className}
    onLoadedMetadata={(e) => (e.currentTarget.currentTime = from)}
    onTimeUpdate={(e) => {
      if (e.currentTarget.currentTime >= to || e.currentTarget.currentTime < from - 0.3) e.currentTarget.currentTime = from;
    }}
  />
);

const Thumb: React.FC<{ path: string; t: number; from: number; to: number; w?: number; h?: number }> = ({ path, t, from, to, w = 96, h = 170 }) => {
  const [img, setImg] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    let alive = true;
    getThumb(path, t).then((x) => alive && setImg(x));
    return () => {
      alive = false;
    };
  }, [path, t]);
  return (
    <div
      className="relative shrink-0 bg-black rounded overflow-hidden"
      style={{ width: w, height: h }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="마우스를 올리면 실제로 들어갈 구간이 재생됩니다"
    >
      {img && !hover && <img src={mediaUrl(img)} className="w-full h-full object-contain" />}
      {hover && <LoopVideo path={path} from={from} to={to} className="w-full h-full object-contain" />}
      {!img && !hover && <div className="absolute inset-0 flex items-center justify-center text-[10px] text-[#666]">사진 만드는 중</div>}
    </div>
  );
};

const FIT_BADGE: Record<SceneCandidate['fit'], [string, string]> = {
  ok: ['✅ 길이 충분', 'bg-[#1e3a2a] text-[#7fd6a0]'],
  slow: ['⚠️ 조금 느려짐', 'bg-[#4a3a1e] text-[#f0c46a]'],
  short: ['❌ 짧음', 'bg-[#4a1e1e] text-[#f08a8a]'],
};

const Tile: React.FC<{ c: SceneCandidate; D: number; selected: boolean; onClick: () => void }> = ({ c, D, selected, onClick }) => {
  const span = D * c.speed;
  const mid = c.desc?.key && c.desc.key > c.srcIn && c.desc.key < c.srcIn + span ? c.desc.key : c.srcIn + span / 2;
  const [label, cls] = FIT_BADGE[c.fit];
  return (
    <div
      onClick={onClick}
      className={`flex gap-2 p-1.5 rounded border cursor-pointer ${selected ? 'border-[#2d8ceb] bg-[#1d2a3a]' : 'border-[#333] bg-[#222] hover:border-[#555]'} ${c.fit === 'short' ? 'opacity-60' : ''}`}
    >
      <Thumb path={c.shot.path} t={mid} from={c.srcIn} to={c.srcIn + span} w={72} h={128} />
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="text-[11px] text-[#bbb] truncate">
          <b className="text-white">{c.shot.id}</b> {c.shot.file} · {c.shot.dur.toFixed(1)}초
        </div>
        <div className="text-[11px] text-[#ddd] truncate">주인공 {c.desc?.subject || '-'}</div>
        <div className="text-[10px] text-[#999] leading-snug line-clamp-3">{c.desc?.desc || '(장면 설명 없음)'}</div>
        <div className="flex flex-wrap gap-1 mt-auto">
          <span className={`text-[10px] px-1 rounded ${cls}`}>{label}</span>
          {c.usedIn.length > 0 || c.usedHere || c.usedOther ? (
            <span className="text-[10px] px-1 rounded bg-[#4a2e1e] text-[#f0b46a]">{c.usedIn.length ? `${c.usedIn.join('·')}에서 씀` : '쓴 장면'}</span>
          ) : (
            <span className="text-[10px] px-1 rounded bg-[#1e2e3a] text-[#8ac4f0]">안 쓴 장면</span>
          )}
          {c.desc?.talk && <span className="text-[10px] px-1 rounded bg-[#3a2e1e] text-[#f0b46a]">말하는 장면</span>}
          {c.similar && <span className="text-[10px] px-1 rounded bg-[#1e3a2a] text-[#7fd6a0]">비슷한 상황</span>}
        </div>
      </div>
    </div>
  );
};

type Data = { shots: AutoEditShot[]; descs: AutoEditShotDesc[]; missing: string[]; alias: Record<string, string> };

export const SceneSwapModal: React.FC = () => {
  const [clipId, setClipId] = useState<string | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Stage | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [start, setStart] = useState<number | null>(null);
  const clip = useEditorStore((s) => (clipId ? s.clips.find((c) => c.id === clipId) : undefined));

  useEffect(() => {
    const on = (e: Event) => {
      setClipId((e as CustomEvent<string>).detail);
      setTab(null);
      setSelId(null);
      setStart(null);
    };
    window.addEventListener('scene-swap:open', on);
    return () => window.removeEventListener('scene-swap:open', on);
  }, []);

  useEffect(() => {
    if (!clipId) return;
    const api = window.electronAPI;
    if (!api?.sceneCached) {
      setErr('데스크톱 앱에서만 쓸 수 있습니다.');
      return;
    }
    setErr(null);
    setData(null);
    // 이 시퀀스가 쓰는 원본(자동 배치와 같은 고르기)을 먼저 → 내용이 같은 복사본이 여러 폴더에 있으면 이 시퀀스 쪽이 대표가 됨
    const st = useEditorStore.getState();
    const vids = st.assets.filter((a) => a.type === 'video');
    const mine = selectMediaForSequence(vids, st.sequences.find((s) => s.id === st.activeSequenceId), st.sequences.filter((s) => s.id !== st.activeSequenceId), st.clips);
    const media = [...mine, ...vids.filter((v) => !mine.includes(v))].map((a) => ({ path: a.path }));
    api
      .sceneCached({ media })
      .then((r) => setData({ ...r, shots: attachLooks(r.shots, r.looks, r.look) }))
      .catch((e) => setErr(String(e?.message || e)));
  }, [clipId]);

  useEffect(() => {
    if (!clipId) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setClipId(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clipId]);

  const ranked = useMemo(() => {
    if (!clip || !data || !data.shots.length) return null;
    const st = useEditorStore.getState();
    const a = clip.startTime;
    const b = clip.startTime + clip.duration;
    // 이 컷 시간에 나오는 자막 (조금이라도 겹치면)
    const text = st.clips
      .filter((c) => c.type === 'text' && (c.text || '').trim() && Math.min(b, c.startTime + c.duration) - Math.max(a, c.startTime) > 0.1)
      .sort((x, y) => x.startTime - y.startTime)
      .map((c) => (c.text || '').trim())
      .join(' ');
    // 복사본 경로는 대표 경로로 바꿔서 셈 (같은 장면을 다른 장면으로 보지 않게)
    const canon = <T extends Pick<TimelineClip, 'sourcePath'>>(c: T): T => (c.sourcePath && data.alias?.[c.sourcePath] ? { ...c, sourcePath: data.alias[c.sourcePath] } : c);
    // 어디서 썼는지: 이 시퀀스 = 광고 구간 이름, 다른 시퀀스 = 시퀀스 이름
    const seq = st.sequences.find((s) => s.id === st.activeSequenceId);
    const segs = seq?.adSegments || [];
    const segName = (t: number) => segs.find((g) => t >= g.start - 0.02 && t < g.end - 0.02)?.name;
    const hereClips = st.clips.filter((c) => c.type === 'video' && c.id !== clip.id).map((c) => ({ ...canon(c), label: segName(c.startTime + 0.01) }));
    const otherClips = st.sequences
      .filter((s) => s.id !== st.activeSequenceId)
      .flatMap((s) => (s.clips || []).filter((c) => c.type === 'video').map((c) => ({ ...canon(c), label: s.name })));
    const r = rankSceneCandidates({ clip: canon(clip), text, shots: data.shots, descs: data.descs, hereClips, otherClips });
    // 앞뒤 컷 (같은 트랙에서 바로 붙어 있는 영상 클립) — '같아 보임' 경고용 (R13, 경고만)
    const track = st.clips.filter((c) => c.type === 'video' && c.trackId === clip.trackId && c.id !== clip.id);
    const prev = track.find((c) => Math.abs(c.startTime + c.duration - clip.startTime) < 0.05);
    const next = track.find((c) => Math.abs(c.startTime - (clip.startTime + clip.duration)) < 0.05);
    const nb = (c?: TimelineClip) => (c ? { shot: shotOfClip(canon(c), data.shots), a: c.sourceStart, b: c.sourceStart + c.duration * (c.speed || 1) } : undefined);
    return { text, guess: guessStage(text), prev: nb(prev), next: nb(next), ...r };
  }, [clip, data]);

  const curStage = stageOf(ranked?.currentDesc);
  const openTab: Stage = tab || ranked?.guess || curStage;
  const inTab = ranked ? ranked.list.filter((c) => c.stage === openTab) : [];
  const sel = ranked?.list.find((c) => c.shot.id === selId) || null;
  const D = clip?.duration || 0;

  // 고른 장면을 실제로 놓을 자리 (편집자가 시작점을 옮길 수 있음)
  const placed = useMemo(() => {
    if (!sel || !ranked) return null;
    const p = placeAt(sel.shot, D, start ?? sel.srcIn, MIN_CLIP_SPEED);
    const warn = [...p.warnings];
    if (ranked.prev?.shot && jumpLooksSame(ranked.prev.shot, ranked.prev.b, sel.shot, p.srcIn)) warn.push('앞 컷과 같은 컷이 두 번 나온 것처럼 보일 수 있습니다');
    if (ranked.next?.shot && jumpLooksSame(sel.shot, p.srcIn + D * p.speed, ranked.next.shot, ranked.next.a)) warn.push('뒤 컷과 같은 컷이 두 번 나온 것처럼 보일 수 있습니다');
    if (sel.usedIn.length || sel.usedHere || sel.usedOther) warn.push(`이미 쓴 장면입니다${sel.usedIn.length ? ` (${sel.usedIn.join('·')})` : ''}`);
    if (sel.desc?.talk && !ranked.currentDesc?.talk) warn.push('카메라 보고 말하는 장면입니다');
    return { ...p, warn };
  }, [sel, start, ranked, D]);

  if (!clipId) return null;
  const close = () => setClipId(null);

  const apply = () => {
    if (!sel || !placed || !clip) return;
    const st = useEditorStore.getState();
    const swappedId = clipId;
    st.replaceClipSource(clipId, { path: sel.shot.path, sourceStart: placed.srcIn, speed: placed.speed });
    // 원본 마스크: 자동 마스크를 이미 쓰는 프로젝트인데 이 원본만 아직이면 글자 찾기를 돌려 넣음 (로컬, 비용 없음)
    const sm = st.sourceMasks;
    const usingAuto = Object.values(sm).some((l) => l.some((m) => m.auto)) || st.clips.some((c) => c.blurMasks?.some((m) => m.auto));
    const api = window.electronAPI;
    if (usingAuto && !sm[srcKeyOf(sel.shot.path)]?.some((m) => m.auto) && api?.textMaskAnalyze) {
      const asset = st.assets.find((x) => srcKeyOf(x.path) === srcKeyOf(sel.shot.path));
      const w = asset?.width || 1080;
      const h = asset?.height || 1920;
      st.setStatusMessage(`장면을 바꿨습니다. 이 원본은 자동 마스크 전이라 글자를 찾는 중... (${sel.shot.file})`);
      api
        .textMaskAnalyze({ path: sel.shot.path, width: w, height: h })
        .then((r) => {
          // 글자 찾기는 오래 걸릴 수 있음 → 그사이 다른 프로젝트를 열었거나 클립이 바뀌었으면 넣지 않음, 이미 넣었으면 그대로
          const now = useEditorStore.getState();
          const cur = now.clips.find((c) => c.id === swappedId);
          if (!cur || srcKeyOf(cur.sourcePath) !== srcKeyOf(sel.shot.path) || now.sourceMasks[srcKeyOf(sel.shot.path)]?.some((m) => m.auto)) return;
          const auto = sourceMasksFromTracks(mergeTrackGaps(r.tracks).filter((t) => t.hasHan), { w, h }, asset?.duration || 0);
          // 되돌리기 한 번으로 이 자동 마스크만 뺄 수 있게 따로 기록
          now.setSourceAutoMasks(sel.shot.path, auto, true);
          now.setStatusMessage(`장면을 바꿨습니다. 이 원본의 자동 마스크 ${auto.length}개를 넣었습니다.`);
        })
        .catch((e) => useEditorStore.getState().setStatusMessage(`장면은 바꿨지만 글자 찾기 실패: ${(e as Error).message}`));
    }
    close();
  };

  const s0 = sel ? sel.shot.start + 0.06 : 0;
  const s1 = sel ? sel.shot.end - 0.06 : 0;
  const slideMax = sel ? Math.max(s0, s1 - D * Math.min(1, (s1 - s0) / D)) : 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 select-none" onMouseDown={close}>
      <div className="w-[1040px] max-w-full h-[90vh] flex flex-col bg-[#1b1b1b] border border-[#3a3a3a] rounded-lg shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#333]">
          <Repeat2 size={16} className="text-[#2d8ceb]" />
          <div className="text-sm text-white font-medium">클립 변경</div>
          <div className="text-[11px] text-[#888]">AI가 나눈 장면을 단계별로 · 저장된 분석만 씀(비용 없음) · 바꾼 뒤 Ctrl+Z로 되돌리기</div>
          <button className="ml-auto text-[#999] hover:text-white" onClick={close}>
            <X size={16} />
          </button>
        </div>

        {err && <div className="p-4 text-[12px] text-[#f08a8a]">{err}</div>}
        {!err && !data && <div className="p-4 text-[12px] text-[#aaa]">장면 분석 불러오는 중...</div>}
        {!err && data && !data.shots.length && (
          <div className="p-4 text-[12px] text-[#cfcfcf] leading-relaxed">
            이 프로젝트의 원본 영상은 아직 장면 분석이 없습니다. STEP 3 AI 자동 배치를 한 번 돌리면 분석이 저장되고, 그다음부터 이 창을 쓸 수 있습니다.
            <br />
            (장면 분석은 처음 한 번만 AI 비용이 듭니다.)
          </div>
        )}

        {ranked && clip && (
          <>
            {/* 위: 지금 컷 */}
            <div className="px-4 py-2 border-b border-[#333] flex gap-3 items-start">
              {ranked.current ? (
                <Thumb path={ranked.current.path} t={clip.sourceStart + (D * (clip.speed || 1)) / 2} from={clip.sourceStart} to={clip.sourceStart + D * (clip.speed || 1)} w={72} h={128} />
              ) : (
                <div className="w-[72px] h-[128px] bg-black rounded" />
              )}
              <div className="flex-1 min-w-0 text-[12px]">
                <div className="text-[11px] text-[#888]">
                  지금 컷 · {clip.startTime.toFixed(2)}~{(clip.startTime + D).toFixed(2)}초 ({D.toFixed(2)}초) · 장면 {ranked.current?.id || '?'} ({curStage})
                </div>
                <div className="text-white mt-0.5 leading-snug">「{ranked.text || '(자막 없음)'}」</div>
                <div className="text-[11px] text-[#9a9a9a] mt-1 truncate">{ranked.currentDesc?.desc || ''}</div>
                <div className="text-[11px] mt-1">
                  {ranked.guess ? (
                    <span className="text-[#7fb8ff]">대사로 본 단계: {ranked.guess}</span>
                  ) : (
                    <span className="text-[#888]">대사로 단계를 알 수 없어 지금 장면의 단계 칸을 엽니다</span>
                  )}
                </div>
                {data && data.missing.length > 0 && <div className="mt-1 text-[10px] text-[#f0b46a]">분석이 없는 원본 {data.missing.length}개는 빠졌습니다.</div>}
              </div>
            </div>

            {/* 단계 칸 */}
            <div className="flex gap-1 px-4 pt-2 flex-wrap">
              {STAGES.map((stg) => {
                const n = ranked.list.filter((c) => c.stage === stg).length;
                return (
                  <button
                    key={stg}
                    onClick={() => {
                      setTab(stg);
                      setSelId(null);
                      setStart(null);
                    }}
                    className={`text-[11px] px-2.5 py-1 rounded flex items-center gap-1 ${openTab === stg ? 'bg-[#2d8ceb] text-white' : 'bg-[#2a2a2a] text-[#aaa] hover:text-white'}`}
                  >
                    {stg} <span className="opacity-70">{n}</span>
                    {ranked.guess === stg && <span className="text-[9px] px-1 rounded bg-black/30">대사</span>}
                    {curStage === stg && <span className="text-[9px] px-1 rounded bg-black/30">지금 장면</span>}
                  </button>
                );
              })}
            </div>

            <div className="flex-1 min-h-0 flex gap-3 px-4 py-2">
              {/* 왼쪽: 이 칸의 장면들 */}
              <div className="flex-1 min-w-0 overflow-y-auto pr-1">
                {inTab.length === 0 && <div className="text-[12px] text-[#888] p-2">이 칸에는 다른 장면이 없습니다. 다른 단계 칸을 눌러 보세요.</div>}
                {openTab === '기타'
                  ? // 기타는 많아서 주인공별로 묶음
                    Array.from(inTab.reduce((m, c) => m.set(c.desc?.subject || '(주인공 없음)', [...(m.get(c.desc?.subject || '(주인공 없음)') || []), c]), new Map<string, SceneCandidate[]>())).map(([subj, list]) => (
                      <div key={subj} className="mb-2">
                        <div className="text-[11px] text-[#9a9a9a] mb-1">주인공: {subj}</div>
                        <div className="grid grid-cols-2 gap-1.5">
                          {list.map((c) => (
                            <Tile key={c.shot.id} c={c} D={D} selected={c.shot.id === selId} onClick={() => (setSelId(c.shot.id), setStart(null))} />
                          ))}
                        </div>
                      </div>
                    ))
                  : (
                    <div className="grid grid-cols-2 gap-1.5">
                      {inTab.map((c) => (
                        <Tile key={c.shot.id} c={c} D={D} selected={c.shot.id === selId} onClick={() => (setSelId(c.shot.id), setStart(null))} />
                      ))}
                    </div>
                  )}
              </div>

              {/* 오른쪽: 고른 장면 미리 보기 + 시작점 + 경고 */}
              <div className="w-[260px] shrink-0 flex flex-col gap-2 text-[11px]">
                {!sel || !placed ? (
                  <div className="text-[#888] leading-relaxed p-2">
                    왼쪽에서 장면을 고르면 이 컷에 실제로 들어갈 구간이 여기서 반복 재생됩니다.
                    <br />
                    사진에 마우스를 올려도 재생됩니다.
                  </div>
                ) : (
                  <>
                    <div className="flex justify-center">
                      <LoopVideo path={sel.shot.path} from={placed.srcIn} to={placed.srcIn + D * placed.speed} className="w-[180px] h-[320px] bg-black rounded object-contain" />
                    </div>
                    <div className="text-[#ddd]">
                      <b className="text-white">{sel.shot.id}</b> {sel.shot.file} · 원본 {placed.srcIn.toFixed(2)}~{(placed.srcIn + D * placed.speed).toFixed(2)}초
                      {placed.speed < 1 ? ` · ${placed.speed.toFixed(2)}배` : ''}
                    </div>
                    {slideMax > s0 + 0.02 ? (
                      <label className="flex flex-col gap-0.5 text-[#999]">
                        시작점 (장면 안에서 옮기기)
                        <input
                          type="range"
                          min={s0}
                          max={slideMax}
                          step={0.033}
                          value={placed.srcIn}
                          onChange={(e) => setStart(Number(e.target.value))}
                          className="accent-[#2d8ceb]"
                        />
                      </label>
                    ) : (
                      <div className="text-[#888]">장면이 이 컷보다 짧아 처음부터 씁니다{placed.speed < FIT_SPEED ? ' (느려짐)' : ''}.</div>
                    )}
                    {placed.warn.length > 0 && (
                      <div className="rounded border border-[#5a4a1e] bg-[#2a2416] p-1.5 space-y-0.5">
                        {placed.warn.map((w) => (
                          <div key={w} className="text-[#f0c46a] flex gap-1">
                            <AlertTriangle size={12} className="shrink-0 mt-[1px]" /> {w}
                          </div>
                        ))}
                        <div className="text-[10px] text-[#998]">경고만 합니다 — 괜찮으면 그대로 바꾸세요.</div>
                      </div>
                    )}
                    <button onClick={apply} className="py-1.5 rounded bg-[#2d8ceb] hover:bg-[#1e78d6] text-white text-[12px] font-medium">
                      이 장면으로 바꾸기
                    </button>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
