import React, { useEffect, useRef, useState } from 'react';
import {
  MousePointer,
  Scissors,
  Type,
  Hand,
  ArrowLeftRight,
  Magnet,
  Link2,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  Mic,
  Plus,
  Trash2,
  Wrench,
  Subtitles,
  ZoomIn,
  ZoomOut,
  X,
} from 'lucide-react';
import { useEditorStore } from '../store/useEditorStore';
import { TimelineClip, TimelineTrack } from '../types/editor';
import { formatFullTimecode } from '../utils/subtitleSnapper';
import { AudioWaveformCanvas } from './AudioWaveformCanvas';
import { AudioVuMeter } from './AudioVuMeter';

export const TimelinePanel: React.FC = () => {
  // 우측 타임라인(눈금자 + 트랙 레인 통합) 가로 스크롤 컨테이너
  const rightScrollRef = useRef<HTMLDivElement | null>(null);
  // 좌측 트랙 헤더 세로 스크롤 동기화용 ref
  const leftHeadersRef = useRef<HTMLDivElement | null>(null);

  const [snapGuideTime, setSnapGuideTime] = useState<number | null>(null);
  const [dragDropPreview, setDragDropPreview] = useState<{
    trackId: string;
    startTime: number;
    duration: number;
    assetName: string;
    isVideo: boolean;
  } | null>(null);

  const {
    tracks,
    clips,
    assets,
    sequences,
    activeSequenceId,
    openSequenceIds,
    fps,
    currentTime,
    isPlaying,
    zoomPxPerSec,
    snapEnabled,
    linkedSelection,
    activeTool,
    selectedClipId,
    selectedClipIds,
    selectedTrackId,
    snapThresholdFrames,
    setCurrentTime,
    setIsPlaying,
    setZoomPxPerSec,
    setSnapEnabled,
    setLinkedSelection,
    setActiveTool,
    setSelectedClipId,
    setSelectedClipIds,
    setSelectedTrackId,
    setSnapThresholdFrames,
    selectSequence,
    closeSequenceTab,
    openNewSequenceModal,
    openEditSequenceModal,
    addTrack,
    removeTrack,
    toggleTrackMute,
    toggleTrackSolo,
    toggleTrackVisible,
    toggleTrackLock,
    addAssets,
    addAssetToTimeline,
    addSubtitleClipAtCurrentTime,
    moveOrTrimClipWithLink,
    moveSelectedClips,
    recordHistorySnapshot,
    commitClipOverlapOverwrite,
    commitMultiClipsOverlapOverwrite,
    splitClipAtPlayhead,
    splitClipAtTime,
    deleteSelectedLayers,
    rippleCloseGaps,
    snapAllSubtitlesToClips,
    getTotalDuration,
  } = useEditorStore();

  const [marqueeBox, setMarqueeBox] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);

  // 시퀀스 총 길이 (여유 공간 포함하여 인디케이터를 오른쪽으로 더 끌고 갈 수 있도록 충분히 확보)
  const contentDuration = getTotalDuration();
  const totalDuration = Math.max(30, contentDuration + 15, currentTime + 10);
  const timelineWidthPx = Math.max(1000, Math.ceil(totalDuration * zoomPxPerSec));

  const selectedClip = clips.find((c) => c.id === selectedClipId) || null;

  // 오디오 파형 확대 보기 (프리미어처럼 오디오 트랙 높이를 키워 파형을 크게 표시)
  const [audioTrackHeight, setAudioTrackHeight] = useState<number>(84);
  const getTrackHeight = (track: TimelineTrack) =>
    track.type === 'audio' ? audioTrackHeight : 44;

  // 스냅 기준점(모든 클립 시작/끝 + 재생헤드)
  const snapPoints = React.useMemo(() => {
    const pts = new Set<number>([0, currentTime]);
    for (const c of clips) {
      pts.add(Number(c.startTime.toFixed(4)));
      pts.add(Number((c.startTime + c.duration).toFixed(4)));
    }
    return Array.from(pts);
  }, [clips, currentTime]);

  // 재생(Play) 중일 때 인디케이터가 오른쪽 화면 끝에 닿으면 자동으로 타임라인을 옆으로 넘겨줌
  useEffect(() => {
    if (!isPlaying || !rightScrollRef.current) return;
    const scroller = rightScrollRef.current;
    const playheadPx = currentTime * zoomPxPerSec;
    const viewLeft = scroller.scrollLeft;
    const viewRight = viewLeft + scroller.clientWidth;

    if (playheadPx > viewRight - 40) {
      scroller.scrollLeft = playheadPx - 80;
    } else if (playheadPx < viewLeft) {
      scroller.scrollLeft = Math.max(0, playheadPx - 40);
    }
  }, [currentTime, isPlaying, zoomPxPerSec]);

  // 우측 트랙 영역 세로 스크롤 시 좌측 트랙 헤더 세로 스크롤도 동기화
  const handleRightScroll = () => {
    if (rightScrollRef.current && leftHeadersRef.current) {
      leftHeadersRef.current.scrollTop = rightScrollRef.current.scrollTop;
    }
  };

  // 인디케이터(눈금자/재생헤드) 클릭 및 드래그 + 화면 양끝 도달 시 자동 가로 스크롤(Edge Auto-Scroll)!
  const handlePlayheadScrubStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    const scroller = rightScrollRef.current;
    if (!scroller) return;

    setIsPlaying(false);
    let lastClientX = e.clientX;
    let autoScrollRaf: number | null = null;

    const updateTimeFromClientX = (clientX: number) => {
      const scrollerRect = scroller.getBoundingClientRect();
      // 스크롤러 내부에서의 상대 X 좌표 + 현재 가로 스크롤 오프셋(scrollLeft)
      const xInViewport = clientX - scrollerRect.left;
      const absoluteX = Math.max(0, scroller.scrollLeft + xInViewport);
      const nextTime = absoluteX / useEditorStore.getState().zoomPxPerSec;
      setCurrentTime(Number(nextTime.toFixed(4)));
    };

    updateTimeFromClientX(e.clientX);

    // 마우스가 타임라인 좌/우 끝(Edge)에 있을 때 자동으로 시퀀스를 옆으로 넘겨주는 루프
    const edgeScrollLoop = () => {
      const scrollerRect = scroller.getBoundingClientRect();
      const edgeThreshold = 55; // 좌/우 끝 55px 구간 진입 시 자동 스크롤 작동
      const maxSpeed = 18;

      if (lastClientX > scrollerRect.right - edgeThreshold) {
        const dist = Math.min(edgeThreshold, lastClientX - (scrollerRect.right - edgeThreshold));
        const deltaPx = Math.max(3, Math.round((dist / edgeThreshold) * maxSpeed));
        scroller.scrollLeft += deltaPx;
        updateTimeFromClientX(lastClientX);
      } else if (lastClientX < scrollerRect.left + edgeThreshold && scroller.scrollLeft > 0) {
        const dist = Math.min(edgeThreshold, scrollerRect.left + edgeThreshold - lastClientX);
        const deltaPx = Math.max(3, Math.round((dist / edgeThreshold) * maxSpeed));
        scroller.scrollLeft = Math.max(0, scroller.scrollLeft - deltaPx);
        updateTimeFromClientX(lastClientX);
      }

      autoScrollRaf = requestAnimationFrame(edgeScrollLoop);
    };

    autoScrollRaf = requestAnimationFrame(edgeScrollLoop);

    const onMouseMove = (moveEvent: MouseEvent) => {
      lastClientX = moveEvent.clientX;
      updateTimeFromClientX(moveEvent.clientX);
    };

    const onMouseUp = () => {
      if (autoScrollRaf !== null) cancelAnimationFrame(autoScrollRaf);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // 타임라인 클립 드래그 이동 / 트림 (다중 선택된 클립들 일괄 동시 이동 지원!)
  const handleClipMouseDown = (
    e: React.MouseEvent,
    clip: TimelineClip,
    mode: 'move' | 'trim-start' | 'trim-end'
  ) => {
    e.stopPropagation();

    const clipTrack = tracks.find((t) => t.id === clip.trackId);
    if (clipTrack?.locked) return;

    const scroller = rightScrollRef.current;
    if (!scroller) return;

    // 면도칼(Razor) 도구일 때는 클릭한 정확한 위치에서 분할
    if (activeTool === 'razor' && mode === 'move') {
      const scrollerRect = scroller.getBoundingClientRect();
      const clickAbsoluteX = Math.max(0, scroller.scrollLeft + (e.clientX - scrollerRect.left));
      const clickTime = clickAbsoluteX / zoomPxPerSec;
      splitClipAtTime(clip.id, clickTime);
      return;
    }

    const isMultiKey = e.ctrlKey || e.metaKey || e.shiftKey;
    const curState = useEditorStore.getState();
    const isAlreadySelected = curState.selectedClipIds.includes(clip.id);

    // 1. 선택 상태 업데이트:
    // - Shift/Ctrl을 눌렀으면 다중 토글 추가/제거
    // - Shift 미입력 시: 이미 선택된 여러 개 중 하나를 클릭했다면 드래그 준비를 위해 즉시 선택을 해제하지 않음!
    if (isMultiKey) {
      setSelectedClipId(clip.id, true);
    } else if (!isAlreadySelected) {
      setSelectedClipId(clip.id, false);
    }

    const startClientX = e.clientX;
    const startScrollLeft = scroller.scrollLeft;
    let lastClientX = e.clientX;
    let lastClientY = e.clientY;
    let autoScrollRaf: number | null = null;

    let prevAppliedDeltaStart = 0;
    let prevAppliedDeltaDur = 0;
    let prevAppliedDeltaSource = 0;
    let hasChanged = false;
    const initialStart = clip.startTime;
    const initialDur = clip.duration;
    const initialSourceStart = clip.sourceStart;
    const frameSec = 1 / fps;
    const snapToleranceSec = snapEnabled ? (snapThresholdFrames / fps) * 1.25 : 0;

    // 다중 선택된 클립 이동 그룹 계산
    const activeSelectedIds =
      curState.selectedClipIds.includes(clip.id) && curState.selectedClipIds.length > 1
        ? curState.selectedClipIds
        : [clip.id];
    const movingClipsList = curState.clips.filter((c) => activeSelectedIds.includes(c.id));
    const minMovingInitialStart =
      movingClipsList.length > 0 ? Math.min(...movingClipsList.map((c) => c.startTime)) : initialStart;

    const ensureHistoryRecorded = () => {
      if (!hasChanged) {
        hasChanged = true;
        recordHistorySnapshot();
      }
    };

    const applyDragAtPosition = (clientX: number, clientY: number) => {
      const scrollDiff = scroller.scrollLeft - startScrollLeft;
      const totalDeltaPx = clientX - startClientX + scrollDiff;
      const rawDeltaSec = totalDeltaPx / useEditorStore.getState().zoomPxPerSec;

      let hoveredTrackId: string | undefined = undefined;
      if (mode === 'move') {
        const elUnderMouse = document.elementFromPoint(clientX, clientY);
        const trackLaneEl = elUnderMouse?.closest('[data-track-id]') as HTMLElement | null;
        if (trackLaneEl?.dataset.trackId) {
          hoveredTrackId = trackLaneEl.dataset.trackId;
        }
      }

      if (mode === 'move') {
        // 다중 클립 이동 시 어떤 클립도 0초 미만으로 내려가지 않도록 제한
        const clampedDeltaSec = Math.max(-minMovingInitialStart, rawDeltaSec);
        let targetStart = Math.max(0, initialStart + clampedDeltaSec);
        let targetEnd = targetStart + initialDur;
        let activeGuide: number | null = null;

        if (snapEnabled) {
          for (const pt of snapPoints) {
            if (Math.abs(targetStart - pt) <= snapToleranceSec) {
              targetStart = pt;
              activeGuide = pt;
              break;
            }
            if (Math.abs(targetEnd - pt) <= snapToleranceSec) {
              targetStart = Math.max(0, pt - initialDur);
              activeGuide = pt;
              break;
            }
          }
        }

        const totalDeltaStart = targetStart - initialStart;
        const stepDelta = totalDeltaStart - prevAppliedDeltaStart;
        prevAppliedDeltaStart = totalDeltaStart;

        setSnapGuideTime(activeGuide);
        if (Math.abs(stepDelta) > 1e-5 || hoveredTrackId) {
          ensureHistoryRecorded();
          if (activeSelectedIds.length > 1) {
            moveSelectedClips(
              activeSelectedIds,
              stepDelta,
              clip.id,
              hoveredTrackId,
              activeGuide !== null
            );
          } else {
            moveOrTrimClipWithLink(
              clip.id,
              stepDelta,
              0,
              0,
              hoveredTrackId,
              activeGuide !== null
            );
          }
        }
      } else if (mode === 'trim-start') {
        const maxDelta = initialDur - frameSec * 2;
        const minDelta =
          clip.type === 'text' ? -initialStart : -Math.min(initialStart, initialSourceStart);
        let clampedDelta = Math.max(minDelta, Math.min(maxDelta, rawDeltaSec));
        let newStart = initialStart + clampedDelta;
        let activeGuide: number | null = null;

        if (snapEnabled) {
          for (const pt of snapPoints) {
            if (
              Math.abs(newStart - pt) <= snapToleranceSec &&
              pt < initialStart + initialDur - frameSec * 2
            ) {
              newStart = pt;
              clampedDelta = newStart - initialStart;
              activeGuide = pt;
              break;
            }
          }
        }

        const stepStart = clampedDelta - prevAppliedDeltaStart;
        const stepDur = -clampedDelta - prevAppliedDeltaDur;
        const stepSource = clampedDelta - prevAppliedDeltaSource;

        prevAppliedDeltaStart = clampedDelta;
        prevAppliedDeltaDur = -clampedDelta;
        prevAppliedDeltaSource = clampedDelta;

        setSnapGuideTime(activeGuide);
        if (Math.abs(stepStart) > 1e-5 || Math.abs(stepDur) > 1e-5) {
          ensureHistoryRecorded();
          moveOrTrimClipWithLink(
            clip.id,
            stepStart,
            stepDur,
            stepSource,
            undefined,
            activeGuide !== null
          );
        }
      } else if (mode === 'trim-end') {
        let newDur = Math.max(frameSec * 2, initialDur + rawDeltaSec);
        let newEnd = initialStart + newDur;
        let activeGuide: number | null = null;

        if (snapEnabled) {
          for (const pt of snapPoints) {
            if (Math.abs(newEnd - pt) <= snapToleranceSec && pt > initialStart + frameSec * 2) {
              newEnd = pt;
              newDur = newEnd - initialStart;
              activeGuide = pt;
              break;
            }
          }
        }

        const totalDeltaDur = newDur - initialDur;
        const stepDur = totalDeltaDur - prevAppliedDeltaDur;
        prevAppliedDeltaDur = totalDeltaDur;

        setSnapGuideTime(activeGuide);
        if (Math.abs(stepDur) > 1e-5) {
          ensureHistoryRecorded();
          moveOrTrimClipWithLink(
            clip.id,
            0,
            stepDur,
            0,
            undefined,
            activeGuide !== null
          );
        }
      }
    };

    const edgeScrollLoop = () => {
      const scrollerRect = scroller.getBoundingClientRect();
      const edgeThreshold = 50;
      const maxSpeed = 15;

      if (lastClientX > scrollerRect.right - edgeThreshold) {
        const dist = Math.min(edgeThreshold, lastClientX - (scrollerRect.right - edgeThreshold));
        scroller.scrollLeft += Math.max(2, Math.round((dist / edgeThreshold) * maxSpeed));
        applyDragAtPosition(lastClientX, lastClientY);
      } else if (lastClientX < scrollerRect.left + edgeThreshold && scroller.scrollLeft > 0) {
        const dist = Math.min(edgeThreshold, scrollerRect.left + edgeThreshold - lastClientX);
        scroller.scrollLeft = Math.max(0, scroller.scrollLeft - Math.max(2, Math.round((dist / edgeThreshold) * maxSpeed)));
        applyDragAtPosition(lastClientX, lastClientY);
      }

      autoScrollRaf = requestAnimationFrame(edgeScrollLoop);
    };

    autoScrollRaf = requestAnimationFrame(edgeScrollLoop);

    const onMouseMove = (moveEvent: MouseEvent) => {
      lastClientX = moveEvent.clientX;
      lastClientY = moveEvent.clientY;
      applyDragAtPosition(moveEvent.clientX, moveEvent.clientY);
    };

    const onMouseUp = () => {
      if (autoScrollRaf !== null) cancelAnimationFrame(autoScrollRaf);
      setSnapGuideTime(null);
      if (hasChanged) {
        // 드래그 이동 완료 시 겹친 구간 덮어쓰기 처리
        if (activeSelectedIds.length > 1) {
          commitMultiClipsOverlapOverwrite(activeSelectedIds);
        } else {
          commitClipOverlapOverwrite(clip.id);
        }
      } else if (!isMultiKey && isAlreadySelected && curState.selectedClipIds.length > 1) {
        // 드래그하지 않고 다중 선택된 클립 중 하나를 클릭만 한 경우: 해당 클립 단일 선택으로 전환
        setSelectedClipId(clip.id, false);
      }
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // 타임라인 빈 공간 클릭 & 드래그 영역 선택(마키 / 러버밴드 선택) 핸들러
  const handleTrackAreaMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-clip-id]') || target.closest('button') || target.closest('input')) {
      return;
    }

    const scroller = rightScrollRef.current;
    if (!scroller) return;

    const scrollerRect = scroller.getBoundingClientRect();
    const startX = scroller.scrollLeft + (e.clientX - scrollerRect.left);
    const startY = scroller.scrollTop + (e.clientY - scrollerRect.top);
    const isAdditive = e.shiftKey || e.ctrlKey || e.metaKey;
    const initialSelectedIds = isAdditive ? [...useEditorStore.getState().selectedClipIds] : [];

    let hasDragged = false;

    setMarqueeBox({
      startX,
      startY,
      currentX: startX,
      currentY: startY,
    });

    const onMouseMove = (moveEvt: MouseEvent) => {
      const currentX = scroller.scrollLeft + (moveEvt.clientX - scrollerRect.left);
      const currentY = scroller.scrollTop + (moveEvt.clientY - scrollerRect.top);

      if (Math.abs(currentX - startX) > 4 || Math.abs(currentY - startY) > 4) {
        hasDragged = true;
      }

      setMarqueeBox({
        startX,
        startY,
        currentX,
        currentY,
      });

      if (!hasDragged) return;

      const boxMinX = Math.min(startX, currentX);
      const boxMaxX = Math.max(startX, currentX);
      const boxMinY = Math.min(startY, currentY);
      const boxMaxY = Math.max(startY, currentY);

      const boxStartTime = boxMinX / zoomPxPerSec;
      const boxEndTime = boxMaxX / zoomPxPerSec;

      // 트랙별 Y 범위 계산 (상단 눈금자 48px 고려)
      let currentTrackY = 48;
      const intersectingTrackIds = new Set<string>();

      for (const trk of tracks) {
        const trkHeight = getTrackHeight(trk);
        const trkTop = currentTrackY;
        const trkBottom = trkTop + trkHeight;
        currentTrackY = trkBottom;

        if (boxMaxY >= trkTop && boxMinY <= trkBottom) {
          intersectingTrackIds.add(trk.id);
        }
      }

      const allClips = useEditorStore.getState().clips;
      const intersectingClipIds = new Set<string>(initialSelectedIds);
      for (const c of allClips) {
        if (!intersectingTrackIds.has(c.trackId)) continue;
        const clipStart = c.startTime;
        const clipEnd = c.startTime + c.duration;
        if (boxEndTime >= clipStart && boxStartTime <= clipEnd) {
          intersectingClipIds.add(c.id);
        }
      }

      setSelectedClipIds(Array.from(intersectingClipIds));
    };

    const onMouseUp = () => {
      setMarqueeBox(null);
      if (!hasDragged && !isAdditive) {
        setSelectedClipId(null);
      }
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // 프로젝트 미디어 패널에서 트랙 레인으로 드래그 오버 시 위치 계산
  const handleTrackDragOver = (e: React.DragEvent<HTMLDivElement>, track: TimelineTrack) => {
    e.preventDefault();
    if (track.locked) return;
    e.dataTransfer.dropEffect = 'copy';

    const rect = e.currentTarget.getBoundingClientRect();
    const rawTime = Math.max(0, (e.clientX - rect.left) / zoomPxPerSec);
    let dropTime = rawTime;

    if (snapEnabled) {
      const snapTol = (snapThresholdFrames / fps) * 1.5;
      for (const pt of snapPoints) {
        if (Math.abs(rawTime - pt) <= snapTol) {
          dropTime = pt;
          break;
        }
      }
    }

    const assetId = e.dataTransfer.getData('application/x-agy-asset-id');
    const asset = assets.find((a) => a.id === assetId);

    setDragDropPreview({
      trackId: track.id,
      startTime: dropTime,
      duration: asset?.duration || 6,
      assetName: asset?.name || '미디어 드롭',
      isVideo: asset ? asset.type === 'video' : track.type === 'video',
    });
  };

  const handleTrackDrop = async (e: React.DragEvent<HTMLDivElement>, track: TimelineTrack) => {
    e.preventDefault();
    setDragDropPreview(null);
    if (track.locked) return;

    const rect = e.currentTarget.getBoundingClientRect();
    let dropTime = Math.max(0, (e.clientX - rect.left) / zoomPxPerSec);

    if (snapEnabled) {
      const snapTol = (snapThresholdFrames / fps) * 1.5;
      for (const pt of snapPoints) {
        if (Math.abs(dropTime - pt) <= snapTol) {
          dropTime = pt;
          break;
        }
      }
    }

    const assetId = e.dataTransfer.getData('application/x-agy-asset-id');
    if (assetId) {
      addAssetToTimeline(assetId, {
        targetTrackId: track.id,
        startTime: dropTime,
      });
      return;
    }

    if (window.electronAPI && e.dataTransfer.files.length > 0) {
      let cursor = dropTime;
      for (const file of Array.from(e.dataTransfer.files)) {
        const filePath = (file as any).path;
        if (filePath) {
          try {
            const info = await window.electronAPI.probeMedia(filePath);
            const created = addAssets([info]);
            if (created[0]) {
              addAssetToTimeline(created[0].id, {
                targetTrackId: track.id,
                startTime: cursor,
              });
              cursor += created[0].duration;
            }
          } catch (err) {
            console.error('Drop probe failed:', err);
          }
        }
      }
    }
  };

  // 눈금자 틱 간격
  const stepSeconds = zoomPxPerSec >= 80 ? 1 : zoomPxPerSec >= 35 ? 5 : 10;
  const ticks: number[] = [];
  for (let t = 0; t <= totalDuration; t += stepSeconds) {
    ticks.push(t);
  }

  const videoTracks = tracks.filter((t) => t.type === 'video');
  const lastVideoTrackId = videoTracks[videoTracks.length - 1]?.id;

  return (
    <section className="flex-1 flex min-w-0 h-full bg-[#1d1d1d] select-none text-[#cccccc] overflow-hidden">
      {/* 1. 좌측 세로 툴 스트립 */}
      <div className="w-9 shrink-0 bg-[#181818] border-r border-[#111111] py-2 flex flex-col items-center gap-1.5">
        <button
          onClick={() => setActiveTool('select')}
          title="선택 도구 (V)"
          className={`w-7 h-7 rounded flex items-center justify-center transition ${
            activeTool === 'select'
              ? 'bg-[#2d8ceb] text-white shadow'
              : 'text-[#999999] hover:text-white hover:bg-[#2a2a2a]'
          }`}
        >
          <MousePointer className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => setActiveTool('razor')}
          title="면도칼(자르기) 도구 (C)"
          className={`w-7 h-7 rounded flex items-center justify-center transition ${
            activeTool === 'razor'
              ? 'bg-[#2d8ceb] text-white shadow'
              : 'text-[#999999] hover:text-white hover:bg-[#2a2a2a]'
          }`}
        >
          <Scissors className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={rippleCloseGaps}
          title="잔물결 빈 공간 이어붙이기 (Ripple Close Gaps)"
          className="w-7 h-7 rounded flex items-center justify-center text-[#999999] hover:text-white hover:bg-[#2a2a2a] transition"
        >
          <ArrowLeftRight className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => {
            setActiveTool('text');
            addSubtitleClipAtCurrentTime();
          }}
          title="문자(자막 추가) 도구 (T)"
          className={`w-7 h-7 rounded flex items-center justify-center transition ${
            activeTool === 'text'
              ? 'bg-[#2d8ceb] text-white shadow'
              : 'text-[#999999] hover:text-white hover:bg-[#2a2a2a]'
          }`}
        >
          <Type className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => setActiveTool('hand')}
          title="손 도구 (H)"
          className={`w-7 h-7 rounded flex items-center justify-center transition ${
            activeTool === 'hand'
              ? 'bg-[#2d8ceb] text-white shadow'
              : 'text-[#999999] hover:text-white hover:bg-[#2a2a2a]'
          }`}
        >
          <Hand className="w-3.5 h-3.5" />
        </button>

        <div className="w-5 h-[1px] bg-[#2e2e2e] my-1" />

        <button
          onClick={() => snapAllSubtitlesToClips()}
          title="클립 경계에 모든 자막 칼맞춤"
          className="w-7 h-7 rounded flex items-center justify-center bg-[#f5a623]/15 text-[#f5a623] hover:bg-[#f5a623]/30 transition"
        >
          <Magnet className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => deleteSelectedLayers()}
          disabled={!selectedClipId && selectedClipIds.length === 0 && !selectedTrackId}
          title="선택한 클립 또는 트랙 레이어 삭제 (Delete)"
          className="w-7 h-7 rounded flex items-center justify-center text-[#999999] hover:text-rose-400 disabled:opacity-30 transition mt-auto"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 2. 중앙 타임라인 본체 */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* 상단: 시퀀스 멀티 탭 헤더 + 트랙 추가 버튼 */}
        <div className="h-7 shrink-0 bg-[#161616] border-b border-[#2b2b2b] flex items-center justify-between px-2">
          <div className="flex items-center h-full overflow-x-auto gap-1">
            {openSequenceIds.length === 0 ? (
              <div className="h-full flex items-center text-[#777777] text-[11px] px-2">
                (시퀀스 없음 — 미디어를 드래그하거나 좌측 하단에서 시퀀스를 선택하세요)
              </div>
            ) : (
              openSequenceIds.map((seqId) => {
                const seqItem = sequences.find((s) => s.id === seqId);
                if (!seqItem) return null;
                const isTabActive = seqItem.id === activeSequenceId;
                return (
                  <div
                    key={seqItem.id}
                    onClick={() => selectSequence(seqItem.id)}
                    onDoubleClick={() => openEditSequenceModal(seqItem.id)}
                    title="클릭 시 시퀀스 전환 · 더블클릭 시 시퀀스 규격/이름 편집"
                    className={`h-full flex items-center gap-1.5 px-2.5 text-[11px] cursor-pointer border-b-2 transition whitespace-nowrap ${
                      isTabActive
                        ? 'border-[#2d8ceb] bg-[#1d1d1d] text-white font-semibold'
                        : 'border-transparent text-[#888888] hover:text-[#dddddd] hover:bg-[#1b1b1b]'
                    }`}
                  >
                    <span className="w-2 h-2 bg-[#3fb950] rounded-xs inline-block" />
                    <span>{seqItem.name}</span>
                    <span className="text-[9px] font-mono text-[#79b8ff]">
                      ({seqItem.width}×{seqItem.height})
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openEditSequenceModal(seqItem.id);
                      }}
                      title="이 시퀀스 이름/해상도/FPS 편집"
                      className="px-1 py-0.2 rounded bg-[#2d8ceb]/25 hover:bg-[#2d8ceb] text-[#79b8ff] hover:text-white text-[9px] font-normal"
                    >
                      편집
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        closeSequenceTab(seqItem.id);
                      }}
                      title="시퀀스 탭 닫기"
                      className="p-0.5 rounded hover:bg-white/15 text-[#888888] hover:text-white"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                );
              })
            )}
            <button
              onClick={openNewSequenceModal}
              title="새 시퀀스 만들기"
              className="px-1.5 py-0.5 rounded hover:bg-[#2a2a2a] text-[#999999] hover:text-white text-[10px] flex items-center gap-0.5"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={rippleCloseGaps}
              title="타임라인의 모든 트랙이 동시에 비어있는 빈 공간(간격)을 일괄 닫고 이어붙입니다 (오디오/비디오 싱크 완벽 보존)"
              className="px-2.5 py-0.5 rounded bg-[#272727] hover:bg-[#2d8ceb] text-[#eeeeee] hover:text-white border border-[#3e3e3e] hover:border-[#2d8ceb] text-[10px] font-semibold flex items-center gap-1 transition shadow-xs"
            >
              <ArrowLeftRight className="w-3 h-3 text-[#2d8ceb]" />
              <span>간격 일괄 닫기</span>
            </button>

            <div className="h-3 w-[1px] bg-[#333333] mx-0.5" />

            <button
              onClick={() => addTrack('video')}
              className="px-2 py-0.5 rounded bg-[#242424] hover:bg-[#2d8ceb] text-[#dddddd] hover:text-white border border-[#3a3a3a] text-[10px] font-semibold flex items-center gap-0.5 transition"
            >
              <Plus className="w-3 h-3" /> V트랙 추가
            </button>
            <button
              onClick={() => addTrack('audio')}
              className="px-2 py-0.5 rounded bg-[#242424] hover:bg-[#2d8ceb] text-[#dddddd] hover:text-white border border-[#3a3a3a] text-[10px] font-semibold flex items-center gap-0.5 transition"
            >
              <Plus className="w-3 h-3" /> A트랙 추가
            </button>
            <button
              onClick={() => addTrack('text')}
              className="px-2 py-0.5 rounded bg-[#242424] hover:bg-[#2d8ceb] text-[#dddddd] hover:text-white border border-[#3a3a3a] text-[10px] font-semibold flex items-center gap-0.5 transition"
            >
              <Plus className="w-3 h-3" /> 자막트랙 추가
            </button>
          </div>
        </div>

        {/* 본문: [좌측 210px 고정 컬럼(타임코드 + 트랙 헤더)] + [우측 통합 가로 스크롤 영역(눈금자 + 트랙 레인 + 일체형 인디케이터)] */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* A. 좌측 210px 완전 고정 컬럼 (절대 클립이나 파란 수직선이 침범하지 않음!) */}
          <div className="w-[210px] shrink-0 bg-[#1d1d1d] border-r border-[#2b2b2b] flex flex-col z-20">
            {/* 좌측 상단 타임코드 및 스냅/클립맞춤 박스 (높이 48px = 눈금자 높이와 정확히 동일!) */}
            <div className="h-12 shrink-0 border-b border-[#2b2b2b] px-2.5 py-1 flex flex-col justify-between bg-[#1d1d1d]">
              <div className="font-mono font-bold text-[#2d8ceb] text-xs tracking-wider">
                {formatFullTimecode(currentTime, fps)}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setSnapEnabled(!snapEnabled)}
                  title="타임라인 스냅 켜기/끄기"
                  className={`p-1 rounded border text-[11px] transition ${
                    snapEnabled
                      ? 'bg-[#1473e6] border-[#2d8ceb] text-white'
                      : 'bg-[#262626] border-[#383838] text-[#888888]'
                  }`}
                >
                  <Magnet className="w-3 h-3" />
                </button>

                <button
                  onClick={() => setLinkedSelection(!linkedSelection)}
                  title="연결된 선택 (V+A 동시 편집) 켜기/끄기"
                  className={`p-1 rounded border text-[11px] transition ${
                    linkedSelection
                      ? 'bg-[#1473e6] border-[#2d8ceb] text-white'
                      : 'bg-[#262626] border-[#383838] text-[#888888]'
                  }`}
                >
                  <Link2 className="w-3 h-3" />
                </button>

                <button
                  onClick={splitClipAtPlayhead}
                  title="현재 재생 헤드 위치에서 분할 (S)"
                  className="p-1 rounded bg-[#262626] hover:bg-[#333333] border border-[#383838] text-[#cccccc]"
                >
                  <Scissors className="w-3 h-3" />
                </button>

                <Wrench className="w-3 h-3 text-[#888888] mx-0.5" />

                <button
                  onClick={() => snapAllSubtitlesToClips()}
                  title={`컷 편집된 클립 시작/끝과 자막의 미세 오차(±${snapThresholdFrames}프레임)를 0프레임으로 칼맞춤`}
                  className="ml-auto px-1.5 py-0.5 rounded bg-[#f5a623]/20 hover:bg-[#f5a623]/35 border border-[#f5a623]/50 text-[#f5a623] text-[10px] font-bold flex items-center gap-0.5 transition"
                >
                  <Subtitles className="w-3 h-3" />
                  클립맞춤
                </button>
              </div>
            </div>

            {/* 좌측 하단 트랙 헤더 리스트 (세로 스크롤이 우측 트랙과 동기화됨) */}
            <div ref={leftHeadersRef} className="flex-1 overflow-hidden flex flex-col">
              {tracks.map((track) => {
                const isAfterLastVideo = track.id === lastVideoTrackId;
                const isCaption = track.type === 'text';
                const isVideo = track.type === 'video';
                const isAudio = track.type === 'audio';

                return (
                  <div
                    key={track.id}
                    onClick={() => setSelectedTrackId(track.id)}
                    style={{ height: `${getTrackHeight(track)}px` }}
                    title="트랙 클릭 선택 후 Delete 키를 누르면 이 트랙 레이어를 삭제할 수 있습니다"
                    className={`shrink-0 px-2 flex items-center justify-between cursor-pointer group ${
                      selectedTrackId === track.id
                        ? 'bg-[#233246] border-l-2 border-l-[#2d8ceb]'
                        : 'bg-[#1d1d1d] hover:bg-[#242424]'
                    } ${
                      isAfterLastVideo
                        ? 'border-b-[3px] border-b-[#0a0a0a]'
                        : 'border-b border-[#2b2b2b]'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleTrackLock(track.id);
                        }}
                        title={track.locked ? '트랙 잠금 해제' : '트랙 잠금'}
                        className={`p-1 rounded ${
                          track.locked ? 'text-[#f5a623]' : 'text-[#888888] hover:text-white'
                        }`}
                      >
                        {track.locked ? (
                          <Lock className="w-3.5 h-3.5" />
                        ) : (
                          <Unlock className="w-3.5 h-3.5" />
                        )}
                      </button>

                      <div
                        className={`w-7 h-7 rounded flex items-center justify-center text-[11px] font-bold text-white shadow-xs ${
                          isCaption ? 'bg-[#7c4dff]' : 'bg-[#1473e6]'
                        }`}
                      >
                        {track.code}
                      </div>

                      <span className="text-[10px] text-[#777777] font-mono select-none">⊞</span>

                      {(isVideo || isCaption) && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleTrackVisible(track.id);
                          }}
                          title={track.visible ? '트랙 출력 숨기기' : '트랙 출력 켜기'}
                          className={`p-1 rounded ${
                            track.visible ? 'text-[#cccccc] hover:text-white' : 'text-[#555555]'
                          }`}
                        >
                          {track.visible ? (
                            <Eye className="w-3.5 h-3.5" />
                          ) : (
                            <EyeOff className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}

                      {isAudio && (
                        <div className="flex items-center gap-1.5 ml-0.5">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleTrackMute(track.id);
                            }}
                            title="트랙 음소거 (Mute)"
                            className={`w-5 h-5 rounded text-[11px] font-bold flex items-center justify-center transition ${
                              track.muted
                                ? 'bg-[#2d8ceb] text-white'
                                : 'text-[#bbbbbb] hover:bg-[#333333]'
                            }`}
                          >
                            M
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleTrackSolo(track.id);
                            }}
                            title="트랙 솔로 (Solo)"
                            className={`w-5 h-5 rounded text-[11px] font-bold flex items-center justify-center transition ${
                              track.solo
                                ? 'bg-[#f5a623] text-black'
                                : 'text-[#bbbbbb] hover:bg-[#333333]'
                            }`}
                          >
                            S
                          </button>
                          <Mic className="w-3.5 h-3.5 text-[#888888] ml-0.5" />
                        </div>
                      )}
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeTrack(track.id);
                      }}
                      title={`${track.code} 트랙 삭제`}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-rose-500/20 text-[#777777] hover:text-rose-400 transition"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* B. 우측 통합 가로/세로 스크롤 영역 (눈금자 + 트랙 레인 + 일체형 파란 인디케이터/수직선) */}
          <div
            ref={rightScrollRef}
            onScroll={handleRightScroll}
            className="flex-1 overflow-x-auto overflow-y-auto relative bg-[#161616]"
          >
            <div style={{ width: `${timelineWidthPx}px` }} className="relative min-h-full flex flex-col">
              {/* 1) 상단 눈금자 (Ruler) — sticky top-0으로 세로 스크롤 시에도 항상 상단에 고정되며 가로 스크롤은 트랙과 100% 함께 움직임! */}
              <div
                onMouseDown={handlePlayheadScrubStart}
                className="h-12 shrink-0 sticky top-0 z-20 bg-[#191919] border-b border-[#2b2b2b] relative cursor-ew-resize"
              >
                {ticks.map((t) => (
                  <div
                    key={t}
                    style={{ left: `${t * zoomPxPerSec}px` }}
                    className="absolute top-0 bottom-0 border-l border-[#333333] pl-1.5 pt-1.5 text-[10px] font-mono text-[#999999] pointer-events-none"
                  >
                    {formatFullTimecode(t, fps)}
                    <div className="absolute bottom-0 left-0 h-2 w-[1px] bg-[#555555]" />
                  </div>
                ))}
              </div>

              {/* 2) 트랙 클립 레인들 (마우스 드래그 영역 선택 지원) */}
              <div
                onMouseDown={handleTrackAreaMouseDown}
                className="flex-1 flex flex-col relative select-none"
              >
                {/* 러버밴드 마키(영역 드래그) 선택 사각형 */}
                {marqueeBox && (
                  <div
                    style={{
                      left: `${Math.min(marqueeBox.startX, marqueeBox.currentX)}px`,
                      top: `${Math.max(0, Math.min(marqueeBox.startY, marqueeBox.currentY) - 48)}px`,
                      width: `${Math.abs(marqueeBox.currentX - marqueeBox.startX)}px`,
                      height: `${Math.abs(marqueeBox.currentY - marqueeBox.startY)}px`,
                    }}
                    className="absolute border border-[#2d8ceb] bg-[#2d8ceb]/25 pointer-events-none z-30 rounded-xs shadow-sm"
                  />
                )}

                {tracks.map((track) => {
                  const isAfterLastVideo = track.id === lastVideoTrackId;
                  const trackClips = clips.filter((c) => c.trackId === track.id);

                  let showGhostHere = false;
                  if (dragDropPreview) {
                    if (dragDropPreview.trackId === track.id) {
                      showGhostHere = true;
                    } else if (
                      dragDropPreview.isVideo &&
                      track.type === 'audio' &&
                      track.code === 'A1'
                    ) {
                      showGhostHere = true;
                    }
                  }

                  return (
                    <div
                      key={track.id}
                      data-track-id={track.id}
                      onDragOver={(e) => handleTrackDragOver(e, track)}
                      onDragLeave={() => setDragDropPreview(null)}
                      onDrop={(e) => handleTrackDrop(e, track)}
                      style={{ height: `${getTrackHeight(track)}px` }}
                      className={`shrink-0 relative ${
                        isAfterLastVideo
                          ? 'border-b-[3px] border-b-[#0a0a0a]'
                          : 'border-b border-[#252525]'
                      } ${
                        track.locked || !track.visible || track.muted
                          ? 'bg-[#121212] opacity-60'
                          : 'bg-[#191919]'
                      }`}
                    >
                      {showGhostHere && dragDropPreview && (
                        <div
                          style={{
                            left: `${dragDropPreview.startTime * zoomPxPerSec}px`,
                            width: `${Math.max(30, dragDropPreview.duration * zoomPxPerSec)}px`,
                          }}
                          className={`absolute top-1 bottom-1 rounded border-2 border-dashed px-2 flex items-center text-[10px] font-semibold pointer-events-none z-20 ${
                            track.type === 'audio'
                              ? 'bg-[#2ea043]/25 border-[#3fb950] text-[#7ee787]'
                              : 'bg-[#2d8ceb]/25 border-[#2d8ceb] text-[#79b8ff]'
                          }`}
                        >
                          + {dragDropPreview.assetName} ({track.code})
                        </div>
                      )}

                      {trackClips.map((clip) => {
                        const leftPx = clip.startTime * zoomPxPerSec;
                        const widthPx = Math.max(16, clip.duration * zoomPxPerSec);
                        const isSelected =
                          clip.id === selectedClipId ||
                          selectedClipIds.includes(clip.id) ||
                          (linkedSelection &&
                            selectedClip?.linkedGroupId &&
                            clip.linkedGroupId === selectedClip.linkedGroupId);

                        let clipStyle =
                          'bg-[#52468b] border-[#7e6bc4] text-white hover:bg-[#5e519e]';
                        if (clip.type === 'audio') {
                          clipStyle =
                            'bg-[#1c3014] border-[#3d6928] text-white hover:bg-[#233d1a]';
                        } else if (clip.type === 'text') {
                          clipStyle = clip.snappedToClip
                            ? 'bg-[#b35e19] border-[#f5a623] text-white'
                            : 'bg-[#8c4b27] border-[#c47041] text-white';
                        }

                        return (
                          <div
                            key={clip.id}
                            data-clip-id={clip.id}
                            style={{
                              left: `${leftPx}px`,
                              width: `${widthPx}px`,
                            }}
                            onMouseDown={(e) => handleClipMouseDown(e, clip, 'move')}
                            className={`group absolute top-[3px] bottom-[3px] rounded-xs border px-2 py-0.5 overflow-hidden flex flex-col ${
                              clip.type === 'audio' ? 'justify-start' : 'justify-center'
                            } transition-colors ${
                              activeTool === 'razor'
                                ? 'cursor-crosshair'
                                : 'cursor-grab active:cursor-grabbing'
                            } ${clipStyle} ${
                              isSelected ? 'ring-2 ring-white z-10 brightness-110' : ''
                            }`}
                          >
                            <div
                              onMouseDown={(e) => handleClipMouseDown(e, clip, 'trim-start')}
                              className="absolute left-0 top-0 bottom-0 w-2 bg-black/25 hover:bg-white/70 cursor-ew-resize z-20"
                            />

                            <div className="relative z-10 flex items-center justify-between gap-1 text-[11px] font-medium truncate pointer-events-none">
                              <span className="truncate drop-shadow-[0_1px_1px_rgba(0,0,0,0.9)]">
                                {clip.type === 'text' ? clip.text || clip.name : clip.name}
                              </span>
                              {clip.snappedToClip && clip.type === 'text' && (
                                <span className="text-[9px] bg-black/40 text-[#f5a623] px-1 rounded shrink-0">
                                  🧲
                                </span>
                              )}
                            </div>

                            {clip.type === 'audio' && (
                              <AudioWaveformCanvas
                                sourcePath={clip.sourcePath}
                                sourceStart={clip.sourceStart}
                                duration={clip.duration}
                                widthPx={widthPx}
                                heightPx={getTrackHeight(track) - 8}
                                volume={clip.volume}
                                muted={clip.muted}
                              />
                            )}

                            <div
                              onMouseDown={(e) => handleClipMouseDown(e, clip, 'trim-end')}
                              className="absolute right-0 top-0 bottom-0 w-2 bg-black/25 hover:bg-white/70 cursor-ew-resize z-20"
                            />
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>

              {/* 스냅 가이드라인 */}
              {snapGuideTime !== null && (
                <div
                  style={{ left: `${snapGuideTime * zoomPxPerSec}px` }}
                  className="absolute top-0 bottom-0 w-[1.5px] bg-[#f5a623] z-30 pointer-events-none"
                />
              )}

              {/* 3) 일체형 파란색 인디케이터 헤드 + 수직선 (눈금자 헤드와 수직선이 하나로 묶여 절대 어긋나지 않으며, 헤드를 잡고 바로 드래그 가능!) */}
              <div
                style={{ left: `${currentTime * zoomPxPerSec}px` }}
                className="absolute top-0 bottom-0 z-30 pointer-events-none"
              >
                {/* 상단 파란 인디케이터 핸들 (잡고 좌우로 끌면 화면 끝에서 자동 스크롤됨) */}
                <div
                  onMouseDown={handlePlayheadScrubStart}
                  title="드래그하여 재생 위치 이동 (화면 끝으로 끌면 자동 스크롤)"
                  className="sticky top-7 -ml-[7px] w-[15px] h-5 flex flex-col items-center cursor-ew-resize pointer-events-auto"
                >
                  <div className="w-3.5 h-3 bg-[#2d8ceb] rounded-t-xs shadow" />
                  <div className="w-0 h-0 border-l-[7px] border-l-transparent border-r-[7px] border-r-transparent border-t-[6px] border-t-[#2d8ceb]" />
                </div>

                {/* 하단 끝까지 이어지는 파란 수직선 */}
                <div className="absolute top-8 bottom-0 left-0 w-[1.5px] bg-[#2d8ceb] shadow-[0_0_4px_#2d8ceb]" />
              </div>
            </div>
          </div>
        </div>

        {/* 타임라인 하단 줌 스크롤바 */}
        <div className="h-6 shrink-0 bg-[#181818] border-t border-[#2b2b2b] px-3 flex items-center justify-between text-[11px] text-[#888888]">
          <div className="flex items-center gap-2">
            <span>
              도구: <strong className="text-[#cccccc] uppercase">{activeTool}</strong>
            </span>
            <span>·</span>
            <span>
              스냅 범위:
              <select
                value={snapThresholdFrames}
                onChange={(e) => setSnapThresholdFrames(Number(e.target.value))}
                className="ml-1 bg-[#222222] border border-[#3a3a3a] rounded px-1 text-[#f5a623] font-mono text-[10px]"
              >
                <option value={2}>±2F</option>
                <option value={3}>±3F</option>
                <option value={5}>±5F</option>
                <option value={8}>±8F</option>
                <option value={12}>±12F</option>
              </select>
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[#7ee787]" title="오디오 트랙 높이(파형 크기) 조절">
              🎵 파형 높이
            </span>
            <input
              type="range"
              min={44}
              max={180}
              step={4}
              value={audioTrackHeight}
              onChange={(e) => setAudioTrackHeight(Number(e.target.value))}
              className="w-20 accent-[#3fb950]"
            />
            <div className="h-3 w-[1px] bg-[#333333] mx-1" />
            <ZoomOut
              onClick={() => setZoomPxPerSec(zoomPxPerSec - 12)}
              className="w-3.5 h-3.5 cursor-pointer hover:text-white"
            />
            <input
              type="range"
              min={15}
              max={600}
              value={zoomPxPerSec}
              onChange={(e) => setZoomPxPerSec(Number(e.target.value))}
              className="w-28 accent-[#2d8ceb]"
            />
            <ZoomIn
              onClick={() => setZoomPxPerSec(zoomPxPerSec + 12)}
              className="w-3.5 h-3.5 cursor-pointer hover:text-white"
            />
          </div>
        </div>
      </div>

      {/* 3. 우측 끝 오디오 레벨 미터 (실제 오디오 파형/신호와 1:1 실시간 매칭) */}
      <AudioVuMeter />
    </section>
  );
};
