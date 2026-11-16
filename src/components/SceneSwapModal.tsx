import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Repeat2, Film, ListOrdered } from 'lucide-react';
import { useEditorStore } from '../store/useEditorStore';
import type { AutoEditShot, AutoEditShotDesc, TimelineClip } from '../types/editor';
import { rankSceneCandidates, type SceneCandidate } from '../utils/sceneSwap';
import { selectMediaForSequence } from '../utils/autoEdit';

/**
 * 장면 바꾸기 도우미 (2026-11-16): 타임라인 영상 클립 우클릭 → "다른 장면 후보"
 *  - 그 컷 자막에 어울리는 장면 후보를 사진·설명·사용 기록과 함께 순서대로 보여 줌 → 누르면 바로 바뀜 (Ctrl+Z 가능)
 *  - '원본별 전체 장면' 탭: AI가 원본을 어떻게 장면으로 나눴고 각 장면을 무엇으로 봤는지 (주인공·단계·장소)
 *  - 이미 저장된 분석만 씀 → 비용 없음
 */
export const openSceneSwap = (clipId: string) => window.dispatchEvent(new CustomEvent('scene-swap:open', { detail: clipId }));

const mediaUrl = (p: string) => `media://local?path=${encodeURIComponent(p)}`;

// 사진은 한 장씩 차례로 만듦 (ffmpeg 를 수십 개 동시에 띄우지 않게)
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

const Thumb: React.FC<{ path: string; t: number; from: number; to: number }> = ({ path, t, from, to }) => {
  const [img, setImg] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const vref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    let alive = true;
    getThumb(path, t).then((x) => alive && setImg(x));
    return () => {
      alive = false;
    };
  }, [path, t]);
  return (
    <div
      className="relative w-[96px] h-[170px] shrink-0 bg-black rounded overflow-hidden"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="마우스를 올리면 그 장면이 재생됩니다"
    >
      {img && !hover && <img src={mediaUrl(img)} className="w-full h-full object-contain" />}
      {hover && (
        <video
          ref={vref}
          src={`${mediaUrl(path)}#t=${from.toFixed(2)}`}
          muted
          autoPlay
          className="w-full h-full object-contain"
          onLoadedMetadata={(e) => (e.currentTarget.currentTime = from)}
          onTimeUpdate={(e) => {
            if (e.currentTarget.currentTime >= to) e.currentTarget.currentTime = from;
          }}
        />
      )}
      {!img && !hover && <div className="absolute inset-0 flex items-center justify-center text-[10px] text-[#666]">사진 만드는 중</div>}
    </div>
  );
};

const DescLine: React.FC<{ d?: AutoEditShotDesc }> = ({ d }) =>
  d ? (
    <>
      <div className="text-[11px] text-[#cfcfcf]">
        <span className="text-[#7fb8ff]">{d.stage || '-'}</span> · 주인공 <b className="text-white">{d.subject || '-'}</b> · {d.place || '-'}
        {d.talk ? <span className="ml-1 text-[#f0b46a]">(카메라 보고 말함)</span> : null}
      </div>
      <div className="text-[11px] text-[#9a9a9a] leading-snug mt-0.5">{d.desc}</div>
    </>
  ) : (
    <div className="text-[11px] text-[#777]">(장면 설명 없음)</div>
  );

const CandCard: React.FC<{ c: SceneCandidate; D: number; onPick?: () => void; rank?: number }> = ({ c, D, onPick, rank }) => {
  const span = D * c.speed;
  const mid = c.desc?.key && c.desc.key > c.srcIn && c.desc.key < c.srcIn + span ? c.desc.key : c.srcIn + span / 2;
  return (
    <div className={`flex gap-2 p-2 rounded border ${c.ok ? 'border-[#3a3a3a] bg-[#232323]' : 'border-[#2a2a2a] bg-[#1c1c1c] opacity-60'}`}>
      <Thumb path={c.shot.path} t={mid} from={c.srcIn} to={c.srcIn + span} />
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="text-[11px] text-[#bbbbbb]">
          {rank !== undefined && <span className="mr-1 text-[#888]">{rank}.</span>}
          <b className="text-white">{c.shot.id}</b> {c.shot.file} · {c.shot.start.toFixed(1)}~{c.shot.end.toFixed(1)}초 ({c.shot.dur.toFixed(1)}초)
        </div>
        <DescLine d={c.desc} />
        <div className="flex flex-wrap gap-1 mt-1">
          {c.reasons.map((r) => (
            <span
              key={r}
              className={`text-[10px] px-1.5 py-0.5 rounded ${/씀|느려짐|짧음/.test(r) ? 'bg-[#4a2e1e] text-[#f0b46a]' : 'bg-[#1e3a2a] text-[#7fd6a0]'}`}
            >
              {r}
            </span>
          ))}
        </div>
        <div className="mt-auto pt-1">
          {onPick && (
            <button
              disabled={!c.ok}
              onClick={onPick}
              className="text-[11px] px-2 py-1 rounded bg-[#2d8ceb] text-white disabled:bg-[#444] disabled:text-[#888]"
              title={`원본 ${c.srcIn.toFixed(2)}초부터${c.speed < 1 ? ` ${c.speed.toFixed(2)}배로` : ''} 넣습니다 (타임라인 길이는 그대로)`}
            >
              이 장면으로 바꾸기
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export const SceneSwapModal: React.FC = () => {
  const [clipId, setClipId] = useState<string | null>(null);
  const [data, setData] = useState<{ shots: AutoEditShot[]; descs: AutoEditShotDesc[]; missing: string[]; alias: Record<string, string> } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'rank' | 'all'>('rank');
  const [showAll, setShowAll] = useState(false);
  const clip = useEditorStore((s) => (clipId ? s.clips.find((c) => c.id === clipId) : undefined));

  useEffect(() => {
    const on = (e: Event) => {
      setClipId((e as CustomEvent<string>).detail);
      setTab('rank');
      setShowAll(false);
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
      .then(setData)
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
    const texts = st.clips
      .filter((c) => c.type === 'text' && (c.text || '').trim() && Math.min(b, c.startTime + c.duration) - Math.max(a, c.startTime) > 0.1)
      .sort((x, y) => x.startTime - y.startTime)
      .map((c) => (c.text || '').trim());
    const text = texts.join(' ');
    // 복사본 경로는 대표 경로로 바꿔서 셈 (같은 장면을 다른 장면으로 보지 않게)
    const canon = <T extends Pick<TimelineClip, 'sourcePath'>>(c: T): T => (c.sourcePath && data.alias?.[c.sourcePath] ? { ...c, sourcePath: data.alias[c.sourcePath] } : c);
    const hereClips = st.clips.filter((c) => c.type === 'video' && c.id !== clip.id).map(canon);
    const otherClips: TimelineClip[] = st.sequences.filter((s) => s.id !== st.activeSequenceId).flatMap((s) => s.clips || []).map(canon);
    return { text, ...rankSceneCandidates({ clip: canon(clip), text, shots: data.shots, descs: data.descs, hereClips, otherClips }) };
  }, [clip, data]);

  if (!clipId) return null;
  const close = () => setClipId(null);
  const pick = (c: SceneCandidate) => {
    useEditorStore.getState().replaceClipSource(clipId, { path: c.shot.path, sourceStart: c.srcIn, speed: c.speed });
    close();
  };
  const D = clip?.duration || 0;
  const shown = ranked ? (showAll ? ranked.list : ranked.list.filter((c) => c.ok).slice(0, 12)) : [];
  // 원본별 전체 장면 (AI가 나눈 순서 그대로)
  const byFile = ranked
    ? Array.from(
        [...ranked.list, ...(ranked.current ? [{ shot: ranked.current, desc: ranked.currentDesc } as SceneCandidate] : [])]
          .sort((x, y) => x.shot.id.localeCompare(y.shot.id, undefined, { numeric: true }))
          .reduce((m, c) => m.set(c.shot.file, [...(m.get(c.shot.file) || []), c]), new Map<string, SceneCandidate[]>())
      )
    : [];

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 select-none" onMouseDown={close}>
      <div className="w-[760px] max-w-full max-h-[90vh] flex flex-col bg-[#1b1b1b] border border-[#3a3a3a] rounded-lg shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#333]">
          <Repeat2 size={16} className="text-[#2d8ceb]" />
          <div className="text-sm text-white font-medium">다른 장면 후보</div>
          <div className="text-[11px] text-[#888]">저장된 장면 분석만 씀 · 비용 없음 · 바꾼 뒤 Ctrl+Z로 되돌리기</div>
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
            <div className="px-4 py-2 border-b border-[#333] flex gap-3">
              {ranked.current ? (
                <CandCard
                  c={{ shot: ranked.current, desc: ranked.currentDesc, srcIn: clip.sourceStart, speed: clip.speed || 1, ok: true, score: 0, similar: true, usedHere: 0, usedOther: 0, reasons: ['지금 장면'] }}
                  D={D}
                />
              ) : (
                <div className="text-[11px] text-[#888]">지금 클립의 장면을 분석에서 찾지 못했습니다.</div>
              )}
              <div className="w-[260px] shrink-0 text-[12px] text-[#ddd]">
                <div className="text-[11px] text-[#888] mb-1">
                  이 컷 자막 ({clip.startTime.toFixed(2)}~{(clip.startTime + clip.duration).toFixed(2)}초, {D.toFixed(2)}초)
                </div>
                <div className="leading-snug">「{ranked.text || '(자막 없음)'}」</div>
                {data && data.missing.length > 0 && (
                  <div className="mt-2 text-[10px] text-[#f0b46a]">분석이 없는 원본 {data.missing.length}개는 후보에서 빠졌습니다.</div>
                )}
              </div>
            </div>

            <div className="flex gap-1 px-4 pt-2">
              <button
                onClick={() => setTab('rank')}
                className={`text-[11px] px-2 py-1 rounded flex items-center gap-1 ${tab === 'rank' ? 'bg-[#2d8ceb] text-white' : 'bg-[#2a2a2a] text-[#aaa]'}`}
              >
                <ListOrdered size={12} /> 추천 후보
              </button>
              <button
                onClick={() => setTab('all')}
                className={`text-[11px] px-2 py-1 rounded flex items-center gap-1 ${tab === 'all' ? 'bg-[#2d8ceb] text-white' : 'bg-[#2a2a2a] text-[#aaa]'}`}
                title="AI가 원본을 어떻게 장면으로 나눴고, 각 장면을 무엇으로 봤는지"
              >
                <Film size={12} /> 원본별 전체 장면 ({data?.shots.length || 0})
              </button>
              {tab === 'rank' && (
                <label className="ml-auto text-[11px] text-[#999] flex items-center gap-1">
                  <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> 못 쓰는 장면까지 모두
                </label>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2">
              {tab === 'rank' &&
                (shown.length ? (
                  shown.map((c, i) => <CandCard key={c.shot.id} c={c} D={D} rank={i + 1} onPick={() => pick(c)} />)
                ) : (
                  <div className="text-[12px] text-[#888]">이 길이({D.toFixed(2)}초)에 쓸 수 있는 다른 장면이 없습니다.</div>
                ))}
              {tab === 'all' &&
                byFile.map(([file, list]) => (
                  <div key={file}>
                    <div className="text-[12px] text-white font-medium mt-1 mb-1">
                      {file} <span className="text-[#888] font-normal">— 장면 {list.length}개</span>
                    </div>
                    <div className="space-y-2">
                      {list.map((c) =>
                        c.shot.id === ranked.current?.id ? (
                          <div key={c.shot.id} className="ring-1 ring-[#2d8ceb] rounded">
                            <CandCard c={{ ...c, srcIn: clip.sourceStart, speed: clip.speed || 1, ok: true, reasons: ['지금 장면'] }} D={D} />
                          </div>
                        ) : (
                          <CandCard key={c.shot.id} c={c} D={D} onPick={() => pick(c)} />
                        )
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
