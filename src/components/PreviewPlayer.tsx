import React, { useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  Scissors,
  Magnet,
  Wrench,
  Camera,
} from 'lucide-react';
import { useEditorStore } from '../store/useEditorStore';
import { formatFullTimecode } from '../utils/subtitleSnapper';
import { splitSentenceIntoNaturalChunks } from '../utils/scriptAligner';

export const PreviewPlayer: React.FC = () => {
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const subtitleInputRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const lastCursorPosRef = useRef<Record<string, number>>({});
  const lastVideoClipIdRef = useRef<string | null>(null);
  const lastAudioClipIdRef = useRef<string | null>(null);
  const [canvasWidth, setCanvasWidth] = useState<number>(360);

  const {
    clips,
    tracks,
    fps,
    sequence,
    currentTime,
    isPlaying,
    selectedClipId,
    activeSequenceId,
    captionLineMode,
    captionMaxCharsPerLine,
    isQuickSplitMergeMode,
    setCurrentTime,
    setIsPlaying,
    setSelectedClipId,
    setIsQuickSplitMergeMode,
    openEditSequenceModal,
    openNewSequenceModal,
    splitClipAtPlayhead,
    snapAllSubtitlesToClips,
    updateClip,
    splitSubtitleClipAtTextCursor,
    mergeSubtitleClipWithAdjacent,
    getTotalDuration,
  } = useEditorStore();

  const totalDuration = getTotalDuration();

  // 트랙 가시성(Eye) 및 오디오 Mute(M)/Solo(S) 계산
  const visibleTrackIds = new Set(tracks.filter((t) => t.visible !== false).map((t) => t.id));
  const audioTracks = tracks.filter((t) => t.type === 'audio');
  const anyAudioSolo = audioTracks.some((t) => t.solo);
  const playableAudioTrackIds = new Set(
    audioTracks
      .filter((t) => (anyAudioSolo ? t.solo : !t.muted))
      .map((t) => t.id)
  );

  // V3 -> V2 -> V1 순서(tracks 배열 순서)대로 가장 위쪽 가시 트랙의 클립을 우선 표시
  const videoTrackOrder = tracks.filter((t) => t.type === 'video' && visibleTrackIds.has(t.id));
  let activeVideoClip = undefined;
  for (const vt of videoTrackOrder) {
    const found = clips.find(
      (c) =>
        c.trackId === vt.id &&
        currentTime >= c.startTime &&
        currentTime < c.startTime + c.duration
    );
    if (found) {
      activeVideoClip = found;
      break;
    }
  }

  // 오디오 트랙에서 현재 재생 중인 클립 찾기
  const activeAudioClip = clips.find(
    (c) =>
      c.type === 'audio' &&
      playableAudioTrackIds.has(c.trackId) &&
      !c.muted &&
      currentTime >= c.startTime &&
      currentTime < c.startTime + c.duration
  );

  // 전체 자막 클립 목록 (시간순) 및 현재 시간의 자막(캡션) 클립들
  const allSubtitleClips = clips
    .filter((c) => c.type === 'text' && visibleTrackIds.has(c.trackId))
    .sort((a, b) => a.startTime - b.startTime);

  const activeSubtitles = allSubtitleClips.filter(
    (c) => currentTime >= c.startTime && currentTime < c.startTime + c.duration
  );

  const primaryActiveSub =
    activeSubtitles.find((s) => s.id === selectedClipId) || activeSubtitles[0] || null;
  const activeSubIndex = primaryActiveSub
    ? allSubtitleClips.findIndex((s) => s.id === primaryActiveSub.id)
    : -1;

  const jumpToAdjacentSubtitle = (dir: -1 | 1) => {
    if (allSubtitleClips.length === 0) return;
    setIsPlaying(false);
    if (activeSubIndex !== -1) {
      const nextIdx = Math.max(0, Math.min(allSubtitleClips.length - 1, activeSubIndex + dir));
      const target = allSubtitleClips[nextIdx];
      setSelectedClipId(target.id);
      setCurrentTime(Number((target.startTime + 0.01).toFixed(4)));
    } else {
      // 현재 재생헤드 기준 이전/다음 자막 찾기
      if (dir === 1) {
        const next =
          allSubtitleClips.find((s) => s.startTime > currentTime) || allSubtitleClips[0];
        setSelectedClipId(next.id);
        setCurrentTime(Number((next.startTime + 0.01).toFixed(4)));
      } else {
        const prev =
          [...allSubtitleClips].reverse().find((s) => s.startTime < currentTime) ||
          allSubtitleClips[allSubtitleClips.length - 1];
        setSelectedClipId(prev.id);
        setCurrentTime(Number((prev.startTime + 0.01).toFixed(4)));
      }
    }
  };

  // 시퀀스 캔버스 실제 렌더링 폭 감지 (9:16 세로형 시퀀스에서도 한 줄/두 줄이 절대 세로로 꺾이지 않도록 폭 계산)
  useEffect(() => {
    const el = canvasContainerRef.current;
    if (!el) return;
    const updateSize = () => {
      if (el.clientWidth > 0) {
        setCanvasWidth(el.clientWidth);
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [sequence.width, sequence.height]);

  // 재생 루프
  useEffect(() => {
    if (!isPlaying) return;

    let animId: number;
    let prevWall = performance.now();

    const tick = (now: number) => {
      const dt = (now - prevWall) / 1000;
      prevWall = now;

      const nextTime = useEditorStore.getState().currentTime + dt;
      const maxDur = useEditorStore.getState().getTotalDuration();

      if (nextTime >= maxDur) {
        setCurrentTime(0);
        setIsPlaying(false);
        return;
      }

      setCurrentTime(nextTime);
      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [isPlaying, setCurrentTime, setIsPlaying]);

  // 비디오 동기화
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    if (!activeVideoClip || !activeVideoClip.sourcePath) {
      videoEl.pause();
      lastVideoClipIdRef.current = null;
      return;
    }

    const mediaUrl = `media://local?path=${encodeURIComponent(activeVideoClip.sourcePath)}`;
    if (videoEl.dataset.srcPath !== activeVideoClip.sourcePath) {
      videoEl.dataset.srcPath = activeVideoClip.sourcePath;
      videoEl.src = mediaUrl;
    }

    const targetMediaTime =
      activeVideoClip.sourceStart + (currentTime - activeVideoClip.startTime);

    // 음성이 A 트랙으로 분리된 경우 video 자체 소리는 끔
    videoEl.volume = activeVideoClip.muted
      ? 0
      : Math.min(1, Math.max(0, activeVideoClip.volume));

    if (
      lastVideoClipIdRef.current !== activeVideoClip.id ||
      Math.abs(videoEl.currentTime - targetMediaTime) > (isPlaying ? 0.22 : 0.02)
    ) {
      videoEl.currentTime = Math.max(0, targetMediaTime);
      lastVideoClipIdRef.current = activeVideoClip.id;
    }

    if (isPlaying && videoEl.paused) {
      videoEl.play().catch(() => {});
    } else if (!isPlaying && !videoEl.paused) {
      videoEl.pause();
    }
  }, [activeVideoClip, currentTime, isPlaying]);

  // 분리된 오디오(A1/A2/A3) 동기화
  useEffect(() => {
    const audioEl = audioRef.current;
    if (!audioEl) return;

    if (!activeAudioClip || !activeAudioClip.sourcePath) {
      audioEl.pause();
      lastAudioClipIdRef.current = null;
      return;
    }

    const mediaUrl = `media://local?path=${encodeURIComponent(activeAudioClip.sourcePath)}`;
    if (audioEl.dataset.srcPath !== activeAudioClip.sourcePath) {
      audioEl.dataset.srcPath = activeAudioClip.sourcePath;
      audioEl.src = mediaUrl;
    }

    const targetAudioTime =
      activeAudioClip.sourceStart + (currentTime - activeAudioClip.startTime);

    audioEl.volume = activeAudioClip.muted
      ? 0
      : Math.min(1, Math.max(0, activeAudioClip.volume));

    if (
      lastAudioClipIdRef.current !== activeAudioClip.id ||
      Math.abs(audioEl.currentTime - targetAudioTime) > (isPlaying ? 0.25 : 0.03)
    ) {
      audioEl.currentTime = Math.max(0, targetAudioTime);
      lastAudioClipIdRef.current = activeAudioClip.id;
    }

    if (isPlaying && audioEl.paused) {
      audioEl.play().catch(() => {});
    } else if (!isPlaying && !audioEl.paused) {
      audioEl.pause();
    }
  }, [activeAudioClip, currentTime, isPlaying]);

  const stepFrame = (deltaFrames: number) => {
    setIsPlaying(false);
    const frameSec = 1 / fps;
    const next = Math.max(0, Math.min(totalDuration, currentTime + deltaFrames * frameSec));
    setCurrentTime(Number(next.toFixed(5)));
  };

  const sequenceTitle = sequence.name || '시퀀스 01';

  return (
    <main className="flex-1 bg-[#1d1d1d] border-r border-[#111111] flex flex-col justify-between min-w-0 select-none text-[#cccccc]">
      {/* 1. 상단 프리미어 프로그램 모니터 탭 헤더 + 단축키 분할/합치기 토글 + 현재 시퀀스 규격 배지 */}
      <div className="h-8 bg-[#161616] border-b border-[#2b2b2b] flex items-center justify-between px-3 gap-2">
        <div className="h-full flex items-center border-b-2 border-[#2d8ceb] text-white text-[11px] font-semibold px-1 truncate shrink-0">
          프로그램: {sequenceTitle} ≡
        </div>

        <div className="flex items-center gap-1.5 min-w-0">
          {/* 화면 자막 단축키 즉시 나누기(Enter) / 합치기(Backspace) 토글 스위치 */}
          <button
            onClick={() => setIsQuickSplitMergeMode(!isQuickSplitMergeMode)}
            title="켜면 프리뷰 화면 자막에서 Enter로 즉시 나누기, Backspace로 앞 자막과 즉시 합치기가 작동합니다. 끄면 일반 글자 타이핑 수정이 가능합니다."
            className={`px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-1 border transition truncate ${
              isQuickSplitMergeMode
                ? 'bg-[#2ea043] border-[#3fb950] text-white shadow'
                : 'bg-[#242424] border-[#3a3a3a] text-[#999999] hover:text-white'
            }`}
          >
            <span>
              {isQuickSplitMergeMode
                ? '⚡ 화면 단축키 모드 ON (Enter:나누기 / Backspace:합치기)'
                : '✏️ 화면 단축키 모드 OFF (일반 글자 수정)'}
            </span>
          </button>

          <button
            onClick={() =>
              activeSequenceId ? openEditSequenceModal(activeSequenceId) : openNewSequenceModal()
            }
            title="클릭하여 현재 시퀀스 규격 수정 또는 새 시퀀스 생성"
            className="px-2 py-0.5 rounded bg-[#242424] hover:bg-[#2d8ceb] text-[#bbbbbb] hover:text-white border border-[#383838] text-[10px] font-mono flex items-center gap-1.5 transition shrink-0"
          >
            <span>
              {sequence.width}×{sequence.height} · {sequence.fps}fps
            </span>
            <span className="text-[9px] px-1 rounded bg-black/40 text-[#79b8ff]">
              {sequence.isCustom ? '커스텀' : '자동'}
            </span>
          </button>
        </div>
      </div>

      {/* 2. 중앙 시퀀스 규격 비율(aspectRatio) 비디오 캔버스 영역 */}
      <div className="flex-1 p-3 flex items-center justify-center min-h-0 bg-[#151515] overflow-hidden relative">
        {/* 상단 플로팅 화면 자막 즉시 제어 바 (보여지는 창 기준 나누기/합치기/이동) */}
        {allSubtitleClips.length > 0 && (
          <div className="absolute top-2.5 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 bg-[#12161f]/90 backdrop-blur border border-[#388bfd]/40 px-2.5 py-1 rounded-full shadow-lg text-[10px]">
            <button
              onClick={() => jumpToAdjacentSubtitle(-1)}
              className="px-1.5 py-0.5 rounded bg-[#21262d] hover:bg-[#30363d] text-[#cccccc] hover:text-white font-semibold"
              title="이전 자막으로 이동"
            >
              ◀ 이전
            </button>
            <span className="font-mono text-[#79b8ff] px-1">
              {primaryActiveSub
                ? `자막 #${activeSubIndex + 1}/${allSubtitleClips.length}`
                : `자막 ${allSubtitleClips.length}개`}
            </span>
            <button
              onClick={() => jumpToAdjacentSubtitle(1)}
              className="px-1.5 py-0.5 rounded bg-[#21262d] hover:bg-[#30363d] text-[#cccccc] hover:text-white font-semibold"
              title="다음 자막으로 이동"
            >
              다음 ▶
            </button>

            {primaryActiveSub && (
              <>
                <div className="h-3 w-[1px] bg-[#30363d] mx-0.5" />
                <button
                  onClick={() => {
                    const cursor = lastCursorPosRef.current[primaryActiveSub.id];
                    const nextId = splitSubtitleClipAtTextCursor(primaryActiveSub.id, cursor);
                    if (nextId) {
                      setTimeout(() => subtitleInputRefs.current[nextId]?.focus(), 30);
                    }
                  }}
                  className="px-2 py-0.5 rounded bg-[#2d8ceb] hover:bg-[#1f6feb] text-white font-bold flex items-center gap-1"
                  title="현재 화면 자막의 커서 위치에서 2개 캡션으로 즉시 나누기 (단축키: Enter)"
                >
                  <span>✂️ 나누기 (Enter)</span>
                </button>
                <button
                  onClick={() => {
                    const mergedId = mergeSubtitleClipWithAdjacent(primaryActiveSub.id, 'prev');
                    if (mergedId) {
                      setTimeout(() => subtitleInputRefs.current[mergedId]?.focus(), 30);
                    }
                  }}
                  className="px-2 py-0.5 rounded bg-[#2ea043] hover:bg-[#238636] text-white font-bold flex items-center gap-1"
                  title="현재 화면 자막을 앞 자막과 하나로 즉시 합치기 (단축키: Backspace)"
                >
                  <span>🔗 앞 자막과 합치기 (Backspace)</span>
                </button>
              </>
            )}
          </div>
        )}

        <div
          ref={canvasContainerRef}
          style={{
            aspectRatio: `${sequence.width} / ${sequence.height}`,
          }}
          className="relative max-w-full max-h-full h-full bg-black border border-[#2a2a2a] shadow-2xl flex items-center justify-center overflow-hidden"
        >
          <video
            ref={videoRef}
            style={{
              transform: `scale(${(activeVideoClip?.scale ?? 100) / 100})`,
            }}
            className={`w-full h-full transition-transform duration-75 ${
              sequence.fitMode === 'cover' ? 'object-cover' : 'object-contain'
            } ${activeVideoClip ? 'block' : 'hidden'}`}
            playsInline
          />
          <audio ref={audioRef} />

          {/* 실시간 자막 오버레이: 실제 렌더링되는 화면 위에서 직접 클릭해 글자 수정 또는 Enter(나누기)/Backspace(합치기) 수행! */}
          {activeSubtitles.map((sub) => {
            const bgEnabled =
              sub.backgroundEnabled ??
              (sub.backgroundColor !== 'transparent' && (sub.backgroundOpacity ?? 0.65) > 0);
            const bgOpacity = bgEnabled ? (sub.backgroundOpacity ?? 0.65) : 0;
            const bgRadius = sub.backgroundRadius ?? 6;
            const clipOpacity = sub.opacity ?? 1;

            const isSelected = sub.id === selectedClipId;
            const rawText = sub.text || '';

            const displayLines = rawText.split(/\r?\n/);

            // 글자 크기(fontSize)는 자막 글자 수(길이)에 따라 절대 작아지지 않고,
            // 오직 사용자가 설정한 fontSize와 시퀀스/프리뷰 화면 비율에 의해서만 고정 결정됩니다.
            // 긴 자막이나 글자 크기를 키운 자막은 화면 안전 폭(maxBoxWidthPx)에 맞춰 자동으로 다음 줄로 줄바꿈됩니다.
            const referenceWidth = sequence.width < sequence.height ? 720 : 1280;
            const scaleRatio = Math.max(0.2, canvasWidth / referenceWidth);
            const computedFontSize = Math.max(
              10,
              Math.round((sub.fontSize || 40) * scaleRatio * 10) / 10
            );
            const maxBoxWidthPx = Math.max(120, Math.floor(canvasWidth * 0.88));

            // 글자 색상 + 글자 불투명도
            const resolvedFontColor = hexToRgba(
              sub.fontColor || '#ffffff',
              sub.fontOpacity ?? 1
            );

            // 글자 외곽선 (Stroke) 계산
            const strokeEnabled = sub.strokeEnabled ?? true;
            const rawStrokeWidth = sub.strokeWidth ?? 3;
            const scaledStrokePx = strokeEnabled
              ? Number(Math.max(0, rawStrokeWidth * scaleRatio * 1.35).toFixed(2))
              : 0;
            const resolvedStrokeColor = hexToRgba(
              sub.strokeColor || '#000000',
              sub.strokeOpacity ?? 1
            );

            // 글자 그림자 (Shadow) 계산
            const shadowEnabled = sub.shadowEnabled ?? true;
            const shadowColorRgba = hexToRgba(
              sub.shadowColor || '#000000',
              sub.shadowOpacity ?? 0.85
            );
            const shadowX = Math.round((sub.shadowOffsetX ?? 0) * scaleRatio * 1.2);
            const shadowY = Math.round((sub.shadowOffsetY ?? 2) * scaleRatio * 1.2);
            const shadowBlur = Math.round((sub.shadowBlur ?? 6) * scaleRatio * 1.2);
            const computedTextShadow = shadowEnabled
              ? `${shadowX}px ${shadowY}px ${shadowBlur}px ${shadowColorRgba}`
              : 'none';

            const sharedTypographyStyle: React.CSSProperties = {
              fontFamily:
                sub.fontFamily ||
                '"Pretendard", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
              fontSize: `${computedFontSize}px`,
              fontWeight: sub.fontWeight || 'bold',
              fontStyle: sub.fontItalic ? 'italic' : 'normal',
              letterSpacing: `${((sub.letterSpacing ?? 0) * scaleRatio).toFixed(2)}px`,
              lineHeight: 1.35,
              whiteSpace: 'pre-wrap',
              wordBreak: 'keep-all',
              overflowWrap: 'break-word',
              boxSizing: 'border-box',
            };

            const posX = sub.positionX ?? 50;
            const posY = sub.positionY ?? 86;

            return (
              <div
                key={sub.id}
                style={{
                  top: `${posY}%`,
                  left: `${posX}%`,
                  transform: 'translate(-50%, -50%)',
                  opacity: clipOpacity,
                }}
                className="absolute w-full z-20 flex flex-col items-center justify-center px-2 pointer-events-none"
              >
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedClipId(sub.id);
                    setIsPlaying(false);
                  }}
                  style={{
                    maxWidth: `${maxBoxWidthPx + 8}px`,
                  }}
                  className={`pointer-events-auto cursor-text px-1 py-0.5 rounded transition-shadow w-max text-center ${
                    isSelected
                      ? isQuickSplitMergeMode
                        ? 'ring-2 ring-[#3fb950]'
                        : 'ring-2 ring-[#2d8ceb]'
                      : 'hover:ring-1 hover:ring-white/50'
                  }`}
                >
                  {/* inline-grid 미러링 구조로 실제 렌더링 폭/높이와 100% 동일한 화면 위에서 직접 커서 배치 및 수정 가능 */}
                  <div
                    style={{
                      ...sharedTypographyStyle,
                      maxWidth: `${maxBoxWidthPx}px`,
                      backgroundColor:
                        bgOpacity > 0 && sub.backgroundColor !== 'transparent'
                          ? hexToRgba(sub.backgroundColor || '#000000', bgOpacity)
                          : 'transparent',
                      borderRadius: `${bgRadius}px`,
                    }}
                    className="relative inline-grid items-center justify-items-center"
                  >
                    {/* 폭/높이 측정용 미러 레이어: 글자 크기에 맞춰 maxBoxWidthPx를 넘으면 어절 단위로 자연스럽게 줄바꿈 */}
                    <div
                      aria-hidden="true"
                      style={{
                        ...sharedTypographyStyle,
                        maxWidth: `${maxBoxWidthPx}px`,
                      }}
                      className="col-start-1 row-start-1 invisible px-2.5 py-1 pointer-events-none select-none min-w-[2ch] text-center"
                    >
                      {(displayLines.join('\n') || ' ') + (rawText.endsWith('\n') ? '\u200b' : '')}
                    </div>

                    {/* 실제 화면 위에서 커서를 두고 수정하거나 Enter/Backspace를 누르는 레이어 */}
                    <textarea
                      ref={(el) => {
                        subtitleInputRefs.current[sub.id] = el;
                      }}
                      value={rawText}
                      cols={1}
                      rows={1}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedClipId(sub.id);
                        setIsPlaying(false);
                        lastCursorPosRef.current[sub.id] = e.currentTarget.selectionStart ?? 0;
                      }}
                      onKeyUp={(e) => {
                        lastCursorPosRef.current[sub.id] = e.currentTarget.selectionStart ?? 0;
                      }}
                      onSelect={(e) => {
                        lastCursorPosRef.current[sub.id] = e.currentTarget.selectionStart ?? 0;
                      }}
                      onChange={(e) => {
                        lastCursorPosRef.current[sub.id] = e.currentTarget.selectionStart ?? 0;
                        updateClip(sub.id, { text: e.target.value });
                      }}
                      onKeyDown={(e) => {
                        const cursor = e.currentTarget.selectionStart ?? 0;
                        lastCursorPosRef.current[sub.id] = cursor;

                        // 단축키 분할/합치기 토글이 켜져 있을 때:
                        // Enter = 현재 커서 위치에서 즉시 자막 나누기
                        // Backspace = 앞 자막과 즉시 하나로 합치기 (Shift+Backspace는 뒤 자막과 합치기)
                        if (isQuickSplitMergeMode) {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            e.stopPropagation();
                            const nextId = splitSubtitleClipAtTextCursor(sub.id, cursor);
                            if (nextId) {
                              setTimeout(() => {
                                const el = subtitleInputRefs.current[nextId];
                                if (el) {
                                  el.focus();
                                  el.setSelectionRange(0, 0);
                                }
                              }, 30);
                            }
                            return;
                          }

                          if (e.key === 'Backspace') {
                            e.preventDefault();
                            e.stopPropagation();
                            const dir = e.shiftKey ? 'next' : 'prev';
                            const mergedId = mergeSubtitleClipWithAdjacent(sub.id, dir);
                            if (mergedId) {
                              setTimeout(() => {
                                const el = subtitleInputRefs.current[mergedId];
                                if (el) {
                                  el.focus();
                                }
                              }, 30);
                            }
                            return;
                          }
                        }
                      }}
                      style={{
                        ...sharedTypographyStyle,
                        color: resolvedFontColor,
                        WebkitTextStroke:
                          scaledStrokePx > 0
                            ? `${scaledStrokePx}px ${resolvedStrokeColor}`
                            : undefined,
                        paintOrder: 'stroke fill',
                        textShadow: computedTextShadow,
                      }}
                      className="col-start-1 row-start-1 min-w-0 w-full h-full bg-transparent text-center resize-none overflow-hidden focus:outline-none px-2.5 py-1 select-text caret-[#3fb950]"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 3. 하단 타임코드 / 스크럽 바 / 트랜스포트 버튼 (스크린샷 완벽 재현) */}
      <div className="px-4 pb-2.5 pt-1 bg-[#1d1d1d] space-y-2">
        {/* 타임코드 및 줌/해상도 드롭다운 줄 */}
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-3">
            <span className="font-mono font-bold text-[#2d8ceb] text-xs tracking-wider">
              {formatFullTimecode(currentTime, fps)}
            </span>
            <select className="bg-[#262626] border border-[#3a3a3a] rounded px-2 py-0.5 text-[11px] text-[#dddddd] focus:outline-none">
              <option>맞추기</option>
              <option>50%</option>
              <option>100%</option>
            </select>
          </div>

          <div className="flex items-center gap-3">
            <select className="bg-[#262626] border border-[#3a3a3a] rounded px-2 py-0.5 text-[11px] text-[#dddddd] focus:outline-none">
              <option>전체</option>
              <option>1/2</option>
              <option>1/4</option>
            </select>
            <Wrench className="w-3.5 h-3.5 text-[#999999]" />
            <span className="font-mono text-[#bbbbbb] text-xs tracking-wider">
              {formatFullTimecode(totalDuration, fps)}
            </span>
          </div>
        </div>

        {/* 전체 폭 스크럽 슬라이더 바 */}
        <div className="relative flex items-center">
          <input
            type="range"
            min={0}
            max={Math.max(0.1, totalDuration)}
            step={1 / fps}
            value={Math.min(currentTime, totalDuration)}
            onChange={(e) => {
              setIsPlaying(false);
              setCurrentTime(Number(e.target.value));
            }}
            className="w-full h-1.5 bg-[#333333] rounded-lg appearance-none cursor-pointer accent-[#2d8ceb]"
          />
        </div>

        {/* 하단 중앙 아이콘 트랜스포트 바 */}
        <div className="flex items-center justify-center gap-3 pt-0.5 text-[#bbbbbb]">
          <button
            onClick={() => {
              setIsPlaying(false);
              setCurrentTime(0);
            }}
            title="처음으로 이동"
            className="p-1 hover:text-white transition"
          >
            <SkipBack className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => stepFrame(-1)}
            title="1프레임 뒤로 (←)"
            className="p-1 hover:text-white transition flex items-center gap-0.5 text-[11px] font-mono"
          >
            <StepBack className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => setIsPlaying(!isPlaying)}
            title="재생 / 일시정지 (Space)"
            className="p-1.5 rounded bg-[#2b2b2b] hover:bg-[#383838] text-white transition"
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={() => stepFrame(1)}
            title="1프레임 앞으로 (→)"
            className="p-1 hover:text-white transition flex items-center gap-0.5 text-[11px] font-mono"
          >
            <StepForward className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => {
              setIsPlaying(false);
              setCurrentTime(totalDuration);
            }}
            title="끝으로 이동"
            className="p-1 hover:text-white transition"
          >
            <SkipForward className="w-3.5 h-3.5" />
          </button>

          <div className="h-3.5 w-[1px] bg-[#333333] mx-1" />

          <button
            onClick={splitClipAtPlayhead}
            title="재생 헤드 위치에서 클립 분할 (S)"
            className="p-1 hover:text-white transition"
          >
            <Scissors className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => snapAllSubtitlesToClips()}
            title="클립 경계에 자막 칼맞춤"
            className="p-1 text-[#f5a623] hover:text-amber-300 transition"
          >
            <Magnet className="w-3.5 h-3.5" />
          </button>

          <Camera className="w-3.5 h-3.5 text-[#777777]" />
        </div>
      </div>
    </main>
  );
};

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
