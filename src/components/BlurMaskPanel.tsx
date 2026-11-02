/**
 * 오른쪽 속성 창: 영상 클립의 블러 마스크 (원본에 박힌 글자 가리기)
 * 마스크 추가/삭제, 블러 강도, 가장자리 부드럽게, 같은 원본의 모든 클립에 적용
 */
import React from 'react';
import { useEditorStore } from '../store/useEditorStore';
import type { TimelineClip } from '../types/editor';
import { maskPointsAt, newBlurMask } from '../utils/blurMask';
import { EASE_LABEL, type KfEase } from '../utils/keyframes';
import { Timer } from 'lucide-react';
import { KeyframeStrip } from './KeyframeStrip';
import { AutoMaskSection } from './AutoMaskSection';
import { MaskRangeBar } from './MaskRangeBar';
import { SequenceAutoMask } from './SequenceAutoMask';

export const BlurMaskPanel: React.FC<{ clip: TimelineClip }> = ({ clip }) => {
  const updateClip = useEditorStore((s) => s.updateClip);
  const setStatusMessage = useEditorStore((s) => s.setStatusMessage);
  const masks = clip.blurMasks || [];
  const currentTime = useEditorStore((s) => s.currentTime);
  const setCurrentTime = useEditorStore((s) => s.setCurrentTime);
  const t = Math.min(clip.duration, Math.max(0, currentTime - clip.startTime));
  const near = (a: number) => Math.abs(a - t) <= 1 / 60;
  const visibleNow = (m: NonNullable<TimelineClip['blurMasks']>[number]) =>
    (m.from === undefined || t >= m.from) && (m.to === undefined || t < m.to);
  const [showAll, setShowAll] = React.useState(true); // 기본: 모든 마스크 목록
  const selectedMaskId = useEditorStore((s) => s.selectedMaskId);
  const setSelectedMaskId = useEditorStore((s) => s.setSelectedMaskId);
  // 미리보기에서 마스크를 고르면 목록에서 그 마스크로 스크롤
  React.useEffect(() => {
    if (selectedMaskId) document.getElementById(`maskrow_${selectedMaskId}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedMaskId]);
  const pickMask = (m: NonNullable<TimelineClip['blurMasks']>[number]) => {
    setSelectedMaskId(m.id);
    if (!visibleNow(m)) setCurrentTime(clip.startTime + (m.from ?? 0) + 0.02); // 안 보이는 시간이면 보이는 시간으로
  };
  const shown = masks.map((m, i) => ({ m, i })).filter(({ m }) => showAll || visibleNow(m));
  // 블러 강도·가장자리 일괄 적용: 이 클립의 모든 마스크 / 시퀀스의 모든 영상 클립 마스크
  const applyLook = (m: NonNullable<TimelineClip['blurMasks']>[number], all: boolean) => {
    const st = useEditorStore.getState();
    const targets = all ? st.clips.filter((c) => c.type === 'video' && c.blurMasks?.length) : [clip];
    let n = 0;
    targets.forEach((c, i) => {
      const cur = st.clips.find((x) => x.id === c.id)?.blurMasks || [];
      n += cur.length;
      st.updateClip(c.id, { blurMasks: cur.map((x) => ({ ...x, blur: m.blur, feather: m.feather, expand: m.expand })) }, i === 0);
    });
    setStatusMessage(`블러 ${m.blur} / 가장자리 ${m.feather} / 범위 ${m.expand || 0} 를 ${all ? `영상 클립 ${targets.length}개의 ` : '이 클립의 '}마스크 ${n}개에 적용했습니다.`);
  };
  const patchMask = (id: string, fn: (m: NonNullable<TimelineClip['blurMasks']>[number]) => NonNullable<TimelineClip['blurMasks']>[number]) =>
    setMasks(masks.map((x) => (x.id === id ? fn(x) : x)), true);
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
  // 마스크가 보이는 구간 (클립 안 초). 클립 전체면 from/to 없앰
  const setRange = (id: string, from: number | undefined, to: number | undefined, history = true) => {
    const whole = (from ?? 0) <= 1e-4 && (to ?? clip.duration) >= clip.duration - 1e-4;
    setMasks(
      masks.map((x) => (x.id === id ? { ...x, from: whole ? undefined : from, to: whole ? undefined : to } : x)),
      history
    );
  };
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

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
      <SequenceAutoMask />
      <AutoMaskSection key={clip.id} clip={clip} />
      {masks.length === 0 ? (
        <div className="text-[10px] text-[#888888] leading-relaxed">
          원본에 박힌 중국어 자막·워터마크를 흐리게 가립니다. [+ 마스크 추가] 후 미리보기에서 꼭짓점을 끌어 맞추세요.
          점 클릭/빈 곳을 끌어 여러 점 선택, Shift+끌기 = 45도 간격 이동, 안쪽을 끌면 통째로 이동.
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-[#999999]">
              {showAll ? `전체 마스크 ${masks.length}개` : `지금 위치에 보이는 마스크 ${shown.length}개 / 전체 ${masks.length}개`}
            </span>
            <button onClick={() => setShowAll(!showAll)} className="px-1.5 py-0.5 rounded bg-[#2b2b2b] text-[#dddddd]">
              {showAll ? '지금 위치만 보기' : '모든 마스크 보기'}
            </button>
          </div>
          {/* 마스크 구간 한눈에: 막대 = 그 마스크가 보이는 시간, 빨간 선 = 재생헤드 */}
          <div className="bg-[#161616] border border-[#2a2a2a] rounded p-1.5 space-y-1">
            <div className="flex justify-between text-[10px] text-[#999999]">
              <span>마스크 구간 (끝을 끌어 시작·끝 조절)</span>
              <span className="font-mono">0 ~ {clip.duration.toFixed(1)}초</span>
            </div>
            <div className="max-h-44 overflow-y-auto space-y-0.5 pr-0.5">
              {masks.map((m, i) => (
                <div key={m.id} className="flex items-center gap-1">
                  <span className={`w-4 text-right text-[9px] font-mono ${m.id === selectedMaskId ? 'text-[#e5a038]' : 'text-[#777777]'}`}>{i + 1}</span>
                  <MaskRangeBar
                    clipStart={clip.startTime}
                    duration={clip.duration}
                    from={m.from}
                    to={m.to}
                    selected={m.id === selectedMaskId}
                    onSelect={() => pickMask(m)}
                    onChange={(f, e, h) => setRange(m.id, f, e, h)}
                  />
                </div>
              ))}
            </div>
          </div>
          {shown.length === 0 && (
            <div className="text-[10px] text-[#777777]">재생헤드 위치에 보이는 마스크가 없습니다. 재생헤드를 옮기거나 [모든 마스크 보기]를 누르세요.</div>
          )}
          {shown.map(({ m, i }) => (
            <div
              key={m.id}
              id={`maskrow_${m.id}`}
              onClick={() => pickMask(m)}
              className={`rounded p-2 space-y-1.5 border cursor-pointer ${
                m.id === selectedMaskId ? 'bg-[#2a2216] border-[#e5a038]' : visibleNow(m) ? 'bg-[#161616] border-[#3b4454]' : 'bg-[#141414] border-[#2a2a2a] opacity-70'
              }`}
              title="클릭: 미리보기에서 이 마스크 선택 (안 보이는 시간이면 그 시간으로 이동)"
            >
              <div className="flex items-center justify-between">
                <span className={m.id === selectedMaskId ? 'text-[#e5a038] font-semibold' : 'text-[#cccccc]'}>
                  {m.id === selectedMaskId ? '▶ ' : ''}마스크 {i + 1}
                  {visibleNow(m) && <span className="ml-1 text-[9px] text-[#3fb950]">지금 보임</span>}
                  {m.auto && <span className="ml-1 text-[9px] text-[#79b8ff]">자동</span>}
                  {(m.from !== undefined || m.to !== undefined) && (
                    <span className="ml-1 text-[9px] text-[#888888]">
                      ({(m.from ?? 0).toFixed(1)}~{(m.to ?? clip.duration).toFixed(1)}초만)
                    </span>
                  )}
                </span>
                <button
                  onClick={stop(() => setMasks(masks.filter((x) => x.id !== m.id), true))}
                  className="px-1.5 py-0.5 rounded bg-[#2b2b2b] text-[#ff9b9b] text-[10px]"
                >
                  삭제
                </button>
              </div>
              {/* 보이는 구간: 재생헤드 위치로 시작/끝 정하기 */}
              <div className="flex items-center gap-1 text-[10px]">
                <span className="text-[#999999] shrink-0">구간</span>
                <span className="font-mono text-[#dddddd] shrink-0">
                  {(m.from ?? 0).toFixed(2)}~{(m.to ?? clip.duration).toFixed(2)}초
                </span>
                <button
                  onClick={stop(() => t < (m.to ?? clip.duration) - 1e-3 && setRange(m.id, +t.toFixed(4), m.to))}
                  className="ml-auto px-1.5 py-0.5 rounded bg-[#2b2b2b] hover:bg-[#3a3a3a] text-[#dddddd]"
                  title="이 마스크가 재생헤드 위치부터 보이게"
                >
                  ⇤ 시작=지금
                </button>
                <button
                  onClick={stop(() => t > (m.from ?? 0) + 1e-3 && setRange(m.id, m.from, +t.toFixed(4)))}
                  className="px-1.5 py-0.5 rounded bg-[#2b2b2b] hover:bg-[#3a3a3a] text-[#dddddd]"
                  title="이 마스크가 재생헤드 위치까지만 보이게"
                >
                  끝=지금 ⇥
                </button>
                <button
                  onClick={stop(() => setRange(m.id, undefined, undefined))}
                  className="px-1.5 py-0.5 rounded bg-[#2b2b2b] hover:bg-[#3a3a3a] text-[#dddddd]"
                  title="클립 처음부터 끝까지"
                >
                  전체
                </button>
              </div>
              {/* 꼭짓점 위치 키프레임 (움직이는 글자 따라가기) */}
              <div className="flex items-center gap-1">
                <button
                  onClick={() =>
                    patchMask(m.id, (x) =>
                      x.keyframes?.length
                        ? { ...x, points: maskPointsAt(x, t), keyframes: undefined }
                        : { ...x, keyframes: [{ t: +t.toFixed(3), points: maskPointsAt(x, t), ease: 'linear' }] }
                    )
                  }
                  className={`p-0.5 rounded ${m.keyframes?.length ? 'text-[#2d8ceb] bg-[#2d8ceb]/15' : 'text-[#777777] hover:text-white'}`}
                  title={m.keyframes?.length ? '키프레임 끄기 (지금 모양으로 고정)' : '꼭짓점 키프레임 켜기 — 재생헤드를 옮기고 점을 움직이면 키프레임이 생김'}
                >
                  <Timer className="w-3.5 h-3.5" />
                </button>
                <span className="text-[#999999]">꼭짓점 위치</span>
                {m.keyframes?.length ? (
                  <>
                    <button
                      onClick={() => {
                        const k = [...m.keyframes!].sort((a, b) => b.t - a.t).find((f) => f.t < t - 1e-3);
                        if (k) setCurrentTime(clip.startTime + k.t);
                      }}
                      className="px-1 text-[#aaaaaa] hover:text-white"
                      title="이전 키프레임"
                    >
                      ◀
                    </button>
                    <button
                      onClick={() =>
                        patchMask(m.id, (x) =>
                          x.keyframes!.some((f) => near(f.t))
                            ? { ...x, keyframes: x.keyframes!.filter((f) => !near(f.t)) }
                            : { ...x, keyframes: [...x.keyframes!, { t: +t.toFixed(3), points: maskPointsAt(x, t), ease: 'linear' as KfEase }].sort((a, b) => a.t - b.t) }
                        )
                      }
                      className={`px-1 ${m.keyframes.some((f) => near(f.t)) ? 'text-[#2d8ceb]' : 'text-[#777777] hover:text-white'}`}
                      title="이 위치 키프레임 추가/지우기"
                    >
                      ◆
                    </button>
                    <button
                      onClick={() => {
                        const k = [...m.keyframes!].sort((a, b) => a.t - b.t).find((f) => f.t > t + 1e-3);
                        if (k) setCurrentTime(clip.startTime + k.t);
                      }}
                      className="px-1 text-[#aaaaaa] hover:text-white"
                      title="다음 키프레임"
                    >
                      ▶
                    </button>
                    <KeyframeStrip
                      clipStart={clip.startTime}
                      duration={clip.duration}
                      times={m.keyframes.map((f) => f.t)}
                      onMove={(i, nt, history) =>
                        setMasks(
                          masks.map((x) =>
                            x.id === m.id
                              ? { ...x, keyframes: x.keyframes!.map((f, j) => (j === i ? { ...f, t: nt } : f)) }
                              : x
                          ),
                          history
                        )
                      }
                    />
                    <select
                      value={m.keyframes.find((f) => near(f.t))?.ease || 'linear'}
                      disabled={!m.keyframes.some((f) => near(f.t))}
                      onChange={(e) =>
                        patchMask(m.id, (x) => ({ ...x, keyframes: x.keyframes!.map((f) => (near(f.t) ? { ...f, ease: e.target.value as KfEase } : f)) }))
                      }
                      className="bg-[#111318] border border-[#333947] rounded px-0.5 py-0.5 text-[9px] text-[#dddddd] disabled:opacity-40 max-w-[80px]"
                      title="이 키프레임에서 다음 키프레임까지 움직임"
                    >
                      {(Object.keys(EASE_LABEL) as KfEase[]).map((k) => (
                        <option key={k} value={k}>
                          {EASE_LABEL[k]}
                        </option>
                      ))}
                    </select>
                  </>
                ) : (
                  <span className="text-[10px] text-[#666666]">(고정)</span>
                )}
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
              <div className="flex justify-between">
                <span className="text-[#999999]" title="가장자리를 바깥(+)으로 넓히거나 안쪽(-)으로 줄임. 꼭짓점 손잡이는 그대로, 점선 = 실제 흐려지는 곳">
                  블러 범위 (넓히기 + / 줄이기 −)
                </span>
                <span className="font-mono text-[#6cb6ff]">
                  {(m.expand || 0) > 0 ? '+' : ''}
                  {m.expand || 0}
                </span>
              </div>
              <input
                type="range"
                min={-60}
                max={120}
                value={m.expand || 0}
                onChange={(e) => setMasks(masks.map((x) => (x.id === m.id ? { ...x, expand: Number(e.target.value) } : x)))}
                onDoubleClick={() => setMasks(masks.map((x) => (x.id === m.id ? { ...x, expand: 0 } : x)))}
                className="w-full accent-[#2d8ceb]"
              />
              <div className="flex gap-1">
                <button
                  onClick={() => applyLook(m, false)}
                  className="flex-1 py-0.5 rounded bg-[#242933] hover:bg-[#2e3542] border border-[#3b4454] text-[#cccccc] text-[10px]"
                  title="이 마스크의 블러 강도·가장자리·범위 값을 이 클립의 모든 마스크에"
                >
                  이 클립 전체에 적용
                </button>
                <button
                  onClick={() => applyLook(m, true)}
                  className="flex-1 py-0.5 rounded bg-[#242933] hover:bg-[#2e3542] border border-[#3b4454] text-[#cccccc] text-[10px]"
                  title="이 마스크의 블러 강도·가장자리·범위 값을 시퀀스의 모든 영상 클립 마스크에"
                >
                  모든 클립에 적용
                </button>
              </div>
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
