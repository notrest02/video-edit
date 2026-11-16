/**
 * 블러 마스크 칸 위쪽: [자동 마스크 (글자 찾기)]
 *  원본을 한 번 분석(저장됨) → 찾은 글자 목록(한자 포함이면 기본 체크) → 이 클립 / 같은 원본 모든 클립에 적용
 *  다시 적용하면 예전 자동 마스크는 바꾸고, 손으로 만든 마스크는 그대로 둠
 */
import React, { useState } from 'react';
import { Loader2, ScanText } from 'lucide-react';
import { useEditorStore } from '../store/useEditorStore';
import type { AutoTextTrack, TimelineClip } from '../types/editor';
import { DEFAULT_MARGIN, mergeTrackGaps } from '../utils/autoMask';
import { sourceMasksFromTracks, srcKeyOf } from '../utils/sourceMask';

export const AutoMaskSection: React.FC<{ clip: TimelineClip }> = ({ clip }) => {
  const assets = useEditorStore((s) => s.assets);
  // 이 원본을 쓰는 영상 클립 수 (지금 시퀀스 + 다른 시퀀스) — 원본 마스크가 보이는 곳
  const usingCount = useEditorStore(
    (s) =>
      s.clips.filter((c) => c.type === 'video' && srcKeyOf(c.sourcePath) === srcKeyOf(clip.sourcePath)).length +
      s.sequences.filter((q) => q.id !== s.activeSequenceId).reduce((n, q) => n + (q.clips || []).filter((c) => c.type === 'video' && srcKeyOf(c.sourcePath) === srcKeyOf(clip.sourcePath)).length, 0)
  );
  const setStatusMessage = useEditorStore((s) => s.setStatusMessage);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [tracks, setTracks] = useState<AutoTextTrack[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [margin, setMargin] = useState(DEFAULT_MARGIN);
  const asset = assets.find((a) => a.id === clip.assetId) || assets.find((a) => a.path === clip.sourcePath);
  const api = window.electronAPI;
  const sp = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const inClip = (t: AutoTextTrack) => t.end > clip.sourceStart && t.start < clip.sourceStart + clip.duration * sp;

  const analyze = async () => {
    if (!api?.textMaskAnalyze || !clip.sourcePath) return;
    setBusy(true);
    setMsg('준비 중...');
    const off = api.onTextMaskProgress?.((m) => setMsg(m));
    try {
      const r = await api.textMaskAnalyze({ path: clip.sourcePath, width: asset?.width || 1080, height: asset?.height || 1920 });
      const merged = mergeTrackGaps(r.tracks); // 잠깐 놓쳐 끊긴 같은 자리 글자 잇기
      setTracks(merged);
      setChecked(new Set(merged.filter((t) => t.hasHan).map((t) => t.id)));
      setMsg(`글자 ${merged.length}개를 찾았습니다${r.cached ? ' (저장된 분석 사용)' : ''}. 한자가 들어 있는 것을 체크해 두었습니다.`);
    } catch (e) {
      setMsg(`글자 찾기 실패: ${(e as Error).message}`);
    } finally {
      off?.();
      setBusy(false);
    }
  };

  // 원본 마스크(R41): 원본에 한 번 넣으면 이 원본을 쓰는 모든 컷에 보임. 예전 자동 마스크만 바뀌고 손으로 만든 마스크는 그대로
  const apply = () => {
    if (!tracks || !clip.sourcePath) return;
    const chosen = tracks.filter((t) => checked.has(t.id));
    const auto = sourceMasksFromTracks(chosen, { w: asset?.width || 1080, h: asset?.height || 1920 }, asset?.duration || 0, margin);
    useEditorStore.getState().setSourceAutoMasks(clip.sourcePath, auto, true);
    setStatusMessage(`원본 자동 마스크 ${auto.length}개를 넣었습니다 — 이 원본을 쓰는 영상 클립 ${usingCount}개에 보입니다. (손으로 만든 마스크는 그대로)`);
  };

  return (
    <div className="bg-[#161b22] border border-[#2d8ceb]/40 rounded p-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[#cccccc] flex items-center gap-1">
          <ScanText className="w-3.5 h-3.5 text-[#2d8ceb]" /> 자동 마스크 (글자 찾기)
        </span>
        <button
          onClick={analyze}
          disabled={busy}
          className="px-2 py-0.5 rounded bg-[#2d8ceb] hover:bg-[#1e78d6] text-white text-[10px] font-semibold disabled:opacity-50 flex items-center gap-1"
        >
          {busy && <Loader2 className="w-3 h-3 animate-spin" />}
          {tracks ? '다시 찾기' : '원본에서 글자 찾기'}
        </button>
      </div>
      {msg && <div className="text-[10px] text-[#aaaaaa] leading-relaxed">{msg}</div>}
      {tracks && tracks.length > 0 && (
        <>
          <div className="max-h-40 overflow-y-auto space-y-0.5 bg-[#111318] border border-[#2a2a2a] rounded p-1">
            {tracks.map((t) => (
              <label
                key={t.id}
                className={`flex items-center gap-1.5 text-[10px] cursor-pointer ${inClip(t) ? 'text-[#dddddd]' : 'text-[#777777]'}`}
                title={inClip(t) ? '이 클립 구간에 나옴' : '이 클립 구간 밖 (같은 원본의 다른 클립에 나옴)'}
              >
                <input
                  type="checkbox"
                  checked={checked.has(t.id)}
                  onChange={(e) => {
                    const next = new Set(checked);
                    e.target.checked ? next.add(t.id) : next.delete(t.id);
                    setChecked(next);
                  }}
                  className="accent-[#2d8ceb]"
                />
                <span className="truncate flex-1">{t.text}</span>
                <span className="shrink-0 font-mono text-[#888888]">
                  {t.start.toFixed(1)}~{t.end.toFixed(1)}초{t.samples.length > 1 ? '' : ''}
                </span>
              </label>
            ))}
          </div>
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="text-[#999999] shrink-0">여백</span>
            <input type="range" min={0} max={1.5} step={0.05} value={margin} onChange={(e) => setMargin(Number(e.target.value))} className="flex-1 accent-[#2d8ceb]" />
            <span className="font-mono text-[#6cb6ff] w-10 text-right">{Math.round(margin * 100)}%</span>
          </div>
          <div className="text-[9px] text-[#777777]">글자 끝이 덜 가려지면 여백을 늘리고 다시 적용하세요 (두 줄 큰 글자는 작게).</div>
          <button
            onClick={apply}
            className="w-full py-1 rounded bg-[#2d8ceb] hover:bg-[#1e78d6] text-white text-[10px] font-semibold"
            title="원본에 자동 마스크를 넣습니다 — 이 원본을 쓰는 모든 컷(다른 시퀀스 포함)에 같이 보입니다"
          >
            원본에 적용 (이 원본을 쓰는 클립 {usingCount}개)
          </button>
        </>
      )}
    </div>
  );
};
