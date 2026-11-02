import React, { useEffect, useState } from 'react';
import { Undo2, Redo2, Download, Loader2, Save, FolderOpen, FilePlus, Keyboard } from 'lucide-react';
import { ShortcutSettingsModal } from './ShortcutSettingsModal';
import { useEditorStore } from '../store/useEditorStore';
import { renderSubtitleClipToPngDataUrl } from '../utils/subtitleCanvasRenderer';
import { ensureFontsForValues } from '../utils/pcFonts';
import { ensureGdiClipsReady } from '../utils/gdiFonts';
import type { TimelineClip } from '../types/editor';

/**
 * 렌더 구간 [rangeStart, rangeEnd) 안으로 클립을 잘라내고 0초 기준으로 당긴다.
 * 구간 밖 클립은 제외, 걸친 클립은 원본 시작점(sourceStart)도 함께 보정.
 */
function clipToRange(c: TimelineClip, rangeStart: number, rangeEnd: number): TimelineClip | null {
  const s = Math.max(c.startTime, rangeStart);
  const e = Math.min(c.startTime + c.duration, rangeEnd);
  if (e - s < 1e-4) return null;
  return {
    ...c,
    startTime: s - rangeStart,
    duration: e - s,
    sourceStart:
      c.type === 'text' ? c.sourceStart : c.sourceStart + (s - c.startTime) * (c.speed && c.speed > 0 ? c.speed : 1),
  };
}

export const TopHeader: React.FC = () => {
  const [isExporting, setIsExporting] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  // 렌더 범위: 전체 시퀀스 / 인~아웃 구간
  const [renderRange, setRenderRange] = useState<'all' | 'inout'>('inout');
  const [exportProgress, setExportProgress] = useState(0);

  const {
    projectName,
    projectFilePath,
    isDirty,
    clips,
    tracks,
    fps,
    sequence,
    past,
    future,
    statusMessage,
    setProjectName,
    saveProject,
    openProject,
    newProject,
    undo,
    redo,
    getTotalDuration,
    setStatusMessage,
    inPoint,
    outPoint,
  } = useEditorStore();
  const hasInOut = inPoint !== null || outPoint !== null;
  const useInOutRange = hasInOut && renderRange === 'inout';

  useEffect(() => {
    if (!window.electronAPI) return;
    const unsubscribe = window.electronAPI.onExportProgress((prog) => {
      setExportProgress(prog);
    });
    return () => unsubscribe();
  }, []);

  const handleExportMp4 = async () => {
    if (!window.electronAPI) return;
    const visibleTrackIds = new Set(tracks.filter((t) => t.visible !== false).map((t) => t.id));
    const audioTracks = tracks.filter((t) => t.type === 'audio');
    const anySolo = audioTracks.some((t) => t.solo);
    const activeAudioTrackIds = new Set(
      audioTracks.filter((t) => (anySolo ? t.solo : !t.muted)).map((t) => t.id)
    );

    if (clips.length === 0) {
      setStatusMessage('내보낼 클립이 타임라인에 없습니다.');
      return;
    }

    const fullDuration = getTotalDuration();
    const rangeStart = useInOutRange ? Math.max(0, inPoint ?? 0) : 0;
    const rangeEnd = useInOutRange ? Math.min(fullDuration, outPoint ?? fullDuration) : fullDuration;
    if (rangeEnd - rangeStart < 0.05) {
      setStatusMessage('인/아웃 구간이 너무 짧거나 클립이 없는 위치입니다.');
      return;
    }
    const rangedClips = useInOutRange
      ? (clips
          .map((c) => clipToRange(c, rangeStart, rangeEnd))
          .filter(Boolean) as TimelineClip[])
      : clips;

    setIsExporting(true);
    setExportProgress(1);
    setStatusMessage('MP4 렌더링 준비 중...');

    try {
      const videoClips = rangedClips
        .filter((c) => c.type === 'video' && visibleTrackIds.has(c.trackId) && c.sourcePath)
        .map((c) => ({
          id: c.id,
          sourcePath: c.sourcePath!,
          startTime: c.startTime,
          duration: c.duration,
          sourceStart: c.sourceStart,
          speed: c.speed && c.speed > 0 ? c.speed : 1,
          volume: c.volume,
          muted: c.muted,
        }));

      const audioClips = rangedClips
        .filter((c) => c.type === 'audio' && activeAudioTrackIds.has(c.trackId) && c.sourcePath)
        .map((c) => ({
          id: c.id,
          sourcePath: c.sourcePath!,
          startTime: c.startTime,
          duration: c.duration,
          sourceStart: c.sourceStart,
          speed: c.speed && c.speed > 0 ? c.speed : 1,
          volume: c.volume,
          muted: c.muted,
        }));

      const outW = sequence.width || 1920;
      const outH = sequence.height || 1080;

      // 자막에 쓰인 내 PC 글꼴을 모두 불러온 뒤에 그려야 기본 글꼴로 렌더되지 않음
      await ensureFontsForValues(rangedClips.map((c) => c.fontFamily));
      // Windows(GDI) 렌더 글꼴은 자막에 쓰인 글자 윤곽선을 미리 받아둔다
      await ensureGdiClipsReady(rangedClips.filter((c) => c.type === 'text'));

      const subtitleOverlays = rangedClips
        .filter(
          (c) =>
            c.type === 'text' &&
            visibleTrackIds.has(c.trackId) &&
            c.text &&
            c.text.trim().length > 0
        )
        .map((c) => ({
          id: c.id,
          startTime: c.startTime,
          endTime: c.startTime + c.duration,
          pngDataUrl: renderSubtitleClipToPngDataUrl(c, outW, outH),
        }))
        .filter((s) => s.pngDataUrl.length > 0);

      const res = await window.electronAPI.exportVideo({
        videoClips,
        audioClips,
        subtitleOverlays,
        totalDuration: rangeEnd - rangeStart,
        fps: sequence.fps || fps,
        width: outW,
        height: outH,
      });

      if (res.canceled) {
        setStatusMessage('내보내기가 취소되었습니다.');
      } else {
        setStatusMessage(
          `MP4 내보내기 완료${useInOutRange ? ' (인~아웃 구간)' : ''}: ${res.outputPath}`
        );
      }
    } catch (err: any) {
      setStatusMessage(`MP4 내보내기 실패: ${err.message}`);
    } finally {
      setIsExporting(false);
      setExportProgress(0);
    }
  };

  return (
    <header className="h-9 shrink-0 bg-[#161616] border-b border-[#111111] px-3 flex items-center justify-between select-none text-xs text-[#cccccc]">
      {/* 좌측: 프로젝트(새로만들기/열기/저장) | 가져오기 | 시퀀스 | 내보내기 */}
      <div className="flex items-center gap-2.5 h-full">

        {/* 프로젝트 관리 그룹 (새 프로젝트, 열기, 저장) */}
        <div className="flex items-center gap-1 bg-[#202020] px-1 py-0.5 rounded border border-[#2d2d2d]">
          <button
            onClick={() => newProject()}
            title="새 프로젝트 (Ctrl+N)"
            className="px-1.5 py-0.5 rounded hover:bg-[#2e2e2e] text-[#aaaaaa] hover:text-white transition flex items-center gap-1 text-[11px]"
          >
            <FilePlus className="w-3.5 h-3.5 text-[#888888]" />
            <span className="hidden sm:inline">새로만들기</span>
          </button>

          <button
            onClick={() => openProject()}
            title="프로젝트 열기 (Ctrl+O)"
            className="px-1.5 py-0.5 rounded hover:bg-[#2e2e2e] text-[#aaaaaa] hover:text-white transition flex items-center gap-1 text-[11px]"
          >
            <FolderOpen className="w-3.5 h-3.5 text-[#e5a038]" />
            <span>열기</span>
          </button>

          <button
            onClick={() => saveProject(false)}
            title="프로젝트 저장 (Ctrl+S)"
            className="px-2 py-0.5 rounded hover:bg-[#2e2e2e] text-[#aaaaaa] hover:text-white transition flex items-center gap-1 text-[11px]"
          >
            <Save className={`w-3.5 h-3.5 ${isDirty ? 'text-[#e5a038]' : 'text-[#3fb950]'}`} />
            <span className={isDirty ? 'text-[#e5a038] font-bold' : ''}>
              저장{isDirty ? '*' : ''}
            </span>
          </button>

          <button
            onClick={() => saveProject(true)}
            title="다른 이름으로 저장 (Ctrl+Shift+S)"
            className="px-1.5 py-0.5 rounded hover:bg-[#2e2e2e] text-[#888888] hover:text-[#eeeeee] transition text-[11px]"
          >
            다른이름저장
          </button>
        </div>

        <div className="h-3.5 w-[1px] bg-[#333333] mx-0.5" />

        <div className="flex items-center gap-1">
          <button
            onClick={undo}
            disabled={past.length === 0}
            title="실행 취소 (Ctrl+Z)"
            className="p-1 rounded hover:bg-[#2a2a2a] disabled:opacity-30 text-[#cccccc]"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={redo}
            disabled={future.length === 0}
            title="다시 실행 (Ctrl+Y)"
            className="p-1 rounded hover:bg-[#2a2a2a] disabled:opacity-30 text-[#cccccc]"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="h-3.5 w-[1px] bg-[#333333] mx-0.5" />
        <button
          onClick={() => setShowShortcuts(true)}
          title="키보드 단축키 보기 / 바꾸기"
          className="px-1.5 py-0.5 rounded hover:bg-[#2e2e2e] text-[#aaaaaa] hover:text-white transition flex items-center gap-1 text-[11px]"
        >
          <Keyboard className="w-3.5 h-3.5" />
          <span>단축키</span>
        </button>
      </div>

      {/* 중앙: 프로젝트 이름 & 상태 표시 */}
      <div className="flex items-center gap-2 max-w-xl truncate">
        <div
          title={projectFilePath || '저장되지 않은 프로젝트 (Ctrl+S로 저장)'}
          className="flex items-center gap-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-0.5"
        >
          {isDirty && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-[#f5a623]"
              title="저장되지 않은 변경사항 있음"
            />
          )}
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            className="bg-transparent text-center font-medium text-[#dddddd] focus:outline-none focus:bg-[#222222] rounded px-1 w-32 text-xs"
          />
          <span className="text-[10px] text-[#666666]">.agproj</span>
        </div>
        {statusMessage && (
          <span className="text-[11px] text-[#79b8ff] bg-[#1b2838] border border-[#2d8ceb]/40 px-2.5 py-0.5 rounded truncate max-w-[340px]">
            {statusMessage}
          </span>
        )}
      </div>

      {/* 우측: 빠른 클립-자막 맞춤 & 워크스페이스/내보내기 */}
      <div className="flex items-center gap-2.5">
        <select
          value={hasInOut ? renderRange : 'all'}
          onChange={(e) => setRenderRange(e.target.value as 'all' | 'inout')}
          disabled={isExporting}
          title="렌더 범위 (타임라인에서 I / O 키로 인·아웃 지점 지정)"
          className="bg-[#262626] border border-[#3a3a3a] rounded px-1.5 py-1 text-[11px] text-[#dddddd] focus:outline-none"
        >
          <option value="all">전체</option>
          <option value="inout" disabled={!hasInOut}>
            인~아웃{hasInOut ? '' : ' (없음)'}
          </option>
        </select>

        <button
          onClick={handleExportMp4}
          disabled={isExporting}
          className="px-2.5 py-1 rounded bg-[#2d8ceb] hover:bg-[#1e78d6] text-white text-[11px] font-semibold flex items-center gap-1 transition"
        >
          {isExporting ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Download className="w-3 h-3" />
          )}
          {isExporting ? `내보내는 중 ${exportProgress}%` : 'MP4 출력'}
        </button>

      </div>
      {showShortcuts && <ShortcutSettingsModal onClose={() => setShowShortcuts(false)} />}
    </header>
  );
};
