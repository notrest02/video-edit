/**
 * 시퀀스 전체 자동 마스크: 시퀀스에 쓰인 원본 영상을 차례로 분석(저장된 분석은 바로 사용) →
 * 한자가 들어 있는 글자를 모든 영상 클립에 마스크로 적용. 블러는 편집 마지막 단계라 한 번에.
 *  - 이미 자동 마스크가 있는 클립은 기본으로 건너뜀 (손으로 고친 것 보호)
 *  - 손으로 만든 마스크는 항상 그대로
 *  - 되돌리기 한 번에 전체 취소
 */
import React, { useState } from 'react';
import { Loader2, Layers } from 'lucide-react';
import { useEditorStore } from '../store/useEditorStore';
import { DEFAULT_MARGIN, mergeTrackGaps, tracksToMasks } from '../utils/autoMask';

export const SequenceAutoMask: React.FC = () => {
  const clips = useEditorStore((s) => s.clips);
  const setStatusMessage = useEditorStore((s) => s.setStatusMessage);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [skipDone, setSkipDone] = useState(true);
  const [margin, setMargin] = useState(DEFAULT_MARGIN);
  const cancelRef = React.useRef(false);
  const api = window.electronAPI;

  const videoClips = clips.filter((c) => c.type === 'video' && c.sourcePath);
  const sources = [...new Set(videoClips.map((c) => c.sourcePath as string))];
  const withAuto = videoClips.filter((c) => c.blurMasks?.some((m) => m.auto)).length;

  const run = async () => {
    if (!api?.textMaskAnalyze || !sources.length) return;
    cancelRef.current = false;
    setBusy(true);
    let idx = 0;
    const off = api.onTextMaskProgress?.((m) => setMsg(`원본 ${idx}/${sources.length} — ${m}`));
    let nClips = 0;
    let nMasks = 0;
    let nSkip = 0;
    let first = true;
    const failed: string[] = [];
    try {
      for (const src of sources) {
        if (cancelRef.current) break;
        idx++;
        const name = src.split(/[\\/]/).pop();
        setMsg(`원본 ${idx}/${sources.length} — ${name} 준비 중...`);
        const st0 = useEditorStore.getState();
        const asset = st0.assets.find((a) => a.path === src);
        const srcSize = { w: asset?.width || 1080, h: asset?.height || 1920 };
        let tracks;
        try {
          const r = await api.textMaskAnalyze({ path: src, width: srcSize.w, height: srcSize.h });
          tracks = mergeTrackGaps(r.tracks).filter((t) => t.hasHan);
        } catch (e) {
          if (cancelRef.current) break;
          failed.push(`${name}: ${(e as Error).message}`);
          continue;
        }
        // 분석하는 동안 바뀌었을 수 있으니 지금 상태로 적용
        const st = useEditorStore.getState();
        const out = { w: st.sequence.width || 1080, h: st.sequence.height || 1920 };
        for (const c of st.clips.filter((x) => x.type === 'video' && x.sourcePath === src)) {
          if (skipDone && c.blurMasks?.some((m) => m.auto)) {
            nSkip++;
            continue;
          }
          const auto = tracksToMasks(tracks, c, srcSize, out, margin);
          st.updateClip(c.id, { blurMasks: [...(c.blurMasks || []).filter((m) => !m.auto), ...auto] }, first);
          first = false;
          nClips++;
          nMasks += auto.length;
        }
      }
    } finally {
      off?.();
      setBusy(false);
    }
    const text =
      `${cancelRef.current ? '취소됨 — 그 전까지 ' : ''}영상 클립 ${nClips}개에 자동 마스크 ${nMasks}개 적용` +
      (nSkip ? `, 이미 있던 ${nSkip}개 건너뜀` : '') +
      (failed.length ? ` / 실패: ${failed.join(', ')}` : '') +
      '. 되돌리기(Ctrl+Z) 한 번이면 전체 취소.';
    setMsg(text);
    setStatusMessage(text);
  };

  const cancel = () => {
    cancelRef.current = true;
    api?.textMaskCancel?.();
    setMsg('취소하는 중...');
  };

  return (
    <div className="bg-[#1a1d14] border border-[#3fb950]/40 rounded p-2 space-y-1.5">
      <div className="flex items-center justify-between gap-1">
        <span className="text-[#cccccc] flex items-center gap-1">
          <Layers className="w-3.5 h-3.5 text-[#3fb950]" /> 시퀀스 전체 자동 마스크
        </span>
        {busy ? (
          <button onClick={cancel} className="px-2 py-0.5 rounded bg-[#5a2a2a] hover:bg-[#6e3232] text-white text-[10px] font-semibold flex items-center gap-1">
            <Loader2 className="w-3 h-3 animate-spin" /> 취소
          </button>
        ) : (
          <button
            onClick={run}
            disabled={!sources.length}
            className="px-2 py-0.5 rounded bg-[#2ea043] hover:bg-[#278a39] text-white text-[10px] font-semibold disabled:opacity-40"
            title="시퀀스에 쓰인 원본을 모두 분석해 영상 클립 전체에 한자 글자 마스크 적용"
          >
            모든 영상 클립에 적용
          </button>
        )}
      </div>
      <div className="text-[10px] text-[#999999]">
        영상 클립 {videoClips.length}개 · 원본 {sources.length}개{withAuto ? ` · 자동 마스크 있음 ${withAuto}개` : ''}. 처음 분석하는 원본은 시간이
        걸리고(28초 영상 약 17초), 한 번 분석한 원본은 바로 적용됩니다.
      </div>
      <div className="flex items-center gap-1.5 text-[10px]">
        <span className="text-[#999999] shrink-0">여백</span>
        <input type="range" min={0} max={1.5} step={0.05} value={margin} disabled={busy} onChange={(e) => setMargin(Number(e.target.value))} className="flex-1 accent-[#3fb950]" />
        <span className="font-mono text-[#7ee787] w-10 text-right">{Math.round(margin * 100)}%</span>
      </div>
      <label className="flex items-center gap-1.5 text-[10px] text-[#cccccc] cursor-pointer">
        <input type="checkbox" checked={skipDone} disabled={busy} onChange={(e) => setSkipDone(e.target.checked)} className="accent-[#3fb950]" />
        이미 자동 마스크가 있는 클립은 건너뛰기 (손으로 고친 것 보호)
      </label>
      {msg && <div className="text-[10px] text-[#aaaaaa] leading-relaxed">{msg}</div>}
    </div>
  );
};
