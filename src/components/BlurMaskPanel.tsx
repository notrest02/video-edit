/**
 * 오른쪽 속성 창: 영상 클립의 블러 마스크 (원본에 박힌 글자 가리기)
 * 마스크 추가/삭제, 블러 강도, 가장자리 부드럽게, 같은 원본의 모든 클립에 적용
 */
import React from 'react';
import { useEditorStore } from '../store/useEditorStore';
import type { TimelineClip } from '../types/editor';
import { newBlurMask } from '../utils/blurMask';

export const BlurMaskPanel: React.FC<{ clip: TimelineClip }> = ({ clip }) => {
  const updateClip = useEditorStore((s) => s.updateClip);
  const setStatusMessage = useEditorStore((s) => s.setStatusMessage);
  const masks = clip.blurMasks || [];
  const clipboard = useEditorStore((s) => s.maskClipboard);
  const setClipboard = useEditorStore((s) => s.setMaskClipboard);
  const selectedIds = useEditorStore((s) => s.selectedClipIds);
  const fresh = (list: NonNullable<TimelineClip['blurMasks']>, tag: string) =>
    list.map((m, i) => ({ ...JSON.parse(JSON.stringify(m)), id: `mask_${Date.now()}_${tag}_${i}`, keyframes: undefined }));
  // 붙여넣기: 선택한 영상 클립이 여러 개면 모두에, 아니면 이 클립에 (기존 마스크 뒤에 더함)
  const paste = () => {
    if (!clipboard?.length) return;
    const st = useEditorStore.getState();
    const targets = st.clips.filter((c) => c.type === 'video' && (selectedIds.length > 1 ? selectedIds.includes(c.id) : c.id === clip.id));
    targets.forEach((c, i) => st.updateClip(c.id, { blurMasks: [...(c.blurMasks || []), ...fresh(clipboard, String(i))] }, i === 0));
    setStatusMessage(`블러 마스크 ${clipboard.length}개를 영상 클립 ${targets.length}개에 붙여넣었습니다.`);
  };
  const setMasks = (next: TimelineClip['blurMasks'], history = false) => updateClip(clip.id, { blurMasks: next }, history);

  const applyToSameSource = () => {
    const st = useEditorStore.getState();
    const targets = st.clips.filter((c) => c.type === 'video' && c.sourcePath === clip.sourcePath && c.id !== clip.id);
    targets.forEach((c, i) =>
      st.updateClip(
        c.id,
        { blurMasks: masks.map((m) => ({ ...JSON.parse(JSON.stringify(m)), id: `${m.id}_${i}`, keyframes: undefined })) },
        i === 0
      )
    );
    setStatusMessage(`같은 원본(${(clip.sourcePath || '').split(/[\\/]/).pop()}) 영상 클립 ${targets.length}개에 블러 마스크를 적용했습니다.`);
  };

  return (
    <div className="bg-[#202020] border border-[#2e2e2e] rounded p-2.5 space-y-2 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-white">블러 마스크 (글자 가리기)</span>
        <span className="flex gap-1">
        <button
          onClick={() => {
            setClipboard(JSON.parse(JSON.stringify(masks)));
            setStatusMessage(`블러 마스크 ${masks.length}개를 복사했습니다. 다른 클립(여러 개 선택 가능)을 고르고 [붙여넣기]를 누르세요.`);
          }}
          disabled={!masks.length}
          className="px-2 py-0.5 rounded bg-[#2b2b2b] text-[#dddddd] text-[10px] disabled:opacity-40"
          title="이 클립의 마스크 복사"
        >
          복사
        </button>
        <button
          onClick={paste}
          disabled={!clipboard?.length}
          className="px-2 py-0.5 rounded bg-[#2b2b2b] text-[#dddddd] text-[10px] disabled:opacity-40"
          title="복사한 마스크 붙여넣기 (타임라인에서 영상 클립을 여러 개 선택하면 모두에)"
        >
          붙여넣기{selectedIds.length > 1 ? ` (${selectedIds.length}개)` : ''}
        </button>
        <button
          onClick={() => setMasks([...masks, newBlurMask()], true)}
          className="px-2 py-0.5 rounded bg-[#2d8ceb] hover:bg-[#1e78d6] text-white text-[10px] font-semibold"
        >
          + 마스크 추가
        </button>
        </span>
      </div>
      {masks.length === 0 ? (
        <div className="text-[10px] text-[#888888] leading-relaxed">
          원본에 박힌 중국어 자막·워터마크를 흐리게 가립니다. [+ 마스크 추가] 후 미리보기에서 꼭짓점을 끌어 맞추세요.
          점 클릭/빈 곳을 끌어 여러 점 선택, Shift+끌기 = 45도 간격 이동, 안쪽을 끌면 통째로 이동.
        </div>
      ) : (
        <>
          {masks.map((m, i) => (
            <div key={m.id} className="bg-[#161616] border border-[#2a2a2a] rounded p-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[#cccccc]">마스크 {i + 1}</span>
                <button
                  onClick={() => setMasks(masks.filter((x) => x.id !== m.id), true)}
                  className="px-1.5 py-0.5 rounded bg-[#2b2b2b] text-[#ff9b9b] text-[10px]"
                >
                  삭제
                </button>
              </div>
              <div className="flex justify-between">
                <span className="text-[#999999]">블러 강도</span>
                <span className="font-mono text-[#6cb6ff]">{m.blur}</span>
              </div>
              <input
                type="range"
                min={2}
                max={80}
                value={m.blur}
                onChange={(e) => setMasks(masks.map((x) => (x.id === m.id ? { ...x, blur: Number(e.target.value) } : x)))}
                className="w-full accent-[#2d8ceb]"
              />
              <div className="flex justify-between">
                <span className="text-[#999999]">가장자리 부드럽게</span>
                <span className="font-mono text-[#6cb6ff]">{m.feather}</span>
              </div>
              <input
                type="range"
                min={0}
                max={40}
                value={m.feather}
                onChange={(e) => setMasks(masks.map((x) => (x.id === m.id ? { ...x, feather: Number(e.target.value) } : x)))}
                className="w-full accent-[#2d8ceb]"
              />
            </div>
          ))}
          <button
            onClick={applyToSameSource}
            className="w-full py-1 rounded bg-[#242933] hover:bg-[#2e3542] border border-[#3b4454] text-[#cccccc] text-[10px]"
            title="같은 원본 파일에서 잘라 쓴 모든 영상 클립에 지금 마스크를 복사 (기존 마스크는 바뀜)"
          >
            같은 원본의 모든 클립에 적용
          </button>
        </>
      )}
    </div>
  );
};
