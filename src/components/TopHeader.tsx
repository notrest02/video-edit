import React, { useEffect, useState } from 'react';
import {
  Home,
  Undo2,
  Redo2,
  Download,
  Magnet,
  Loader2,
  LayoutGrid,
  Volume2,
  Save,
  FolderOpen,
  FilePlus,
} from 'lucide-react';
import { useEditorStore } from '../store/useEditorStore';
import { renderSubtitleClipToPngDataUrl } from '../utils/subtitleCanvasRenderer';

export const TopHeader: React.FC = () => {
  const [isExporting, setIsExporting] = useState(false);
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
    openNewSequenceModal,
    addAssets,
    addAssetToTimeline,
    undo,
    redo,
    snapAllSubtitlesToClips,
    getTotalDuration,
    setStatusMessage,
  } = useEditorStore();

  useEffect(() => {
    if (!window.electronAPI) return;
    const unsubscribe = window.electronAPI.onExportProgress((prog) => {
      setExportProgress(prog);
    });
    return () => unsubscribe();
  }, []);

  const handleOpenImport = async () => {
    if (!window.electronAPI) return;
    const files = await window.electronAPI.openMediaDialog();
    if (files && files.length > 0) {
      const created = addAssets(files);
      if (clips.length === 0 && created[0]) {
        addAssetToTimeline(created[0].id);
      }
    }
  };

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

    setIsExporting(true);
    setExportProgress(1);
    setStatusMessage('MP4 렌더링 준비 중...');

    try {
      const videoClips = clips
        .filter((c) => c.type === 'video' && visibleTrackIds.has(c.trackId) && c.sourcePath)
        .map((c) => ({
          id: c.id,
          sourcePath: c.sourcePath!,
          startTime: c.startTime,
          duration: c.duration,
          sourceStart: c.sourceStart,
          volume: c.volume,
          muted: c.muted,
        }));

      const audioClips = clips
        .filter((c) => c.type === 'audio' && activeAudioTrackIds.has(c.trackId) && c.sourcePath)
        .map((c) => ({
          id: c.id,
          sourcePath: c.sourcePath!,
          startTime: c.startTime,
          duration: c.duration,
          sourceStart: c.sourceStart,
          volume: c.volume,
          muted: c.muted,
        }));

      const outW = sequence.width || 1920;
      const outH = sequence.height || 1080;

      const subtitleOverlays = clips
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
        totalDuration: getTotalDuration(),
        fps: sequence.fps || fps,
        width: outW,
        height: outH,
      });

      if (res.canceled) {
        setStatusMessage('내보내기가 취소되었습니다.');
      } else {
        setStatusMessage(`MP4 내보내기 완료: ${res.outputPath}`);
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
        <Home className="w-4 h-4 text-[#888888] hover:text-white cursor-pointer mr-0.5" />

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

        <button
          onClick={handleOpenImport}
          className="h-full px-1 text-[#aaaaaa] hover:text-white transition"
        >
          미디어 가져오기
        </button>
        <button
          onClick={openNewSequenceModal}
          className="h-full px-1 text-[#aaaaaa] hover:text-white transition"
        >
          + 새 시퀀스
        </button>
        <button
          onClick={handleExportMp4}
          disabled={isExporting}
          className="h-full px-1 text-[#aaaaaa] hover:text-white transition flex items-center gap-1"
        >
          {isExporting ? `내보내는 중 (${exportProgress}%)` : '내보내기'}
        </button>

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
        <button
          onClick={() => snapAllSubtitlesToClips()}
          className="px-2.5 py-1 rounded bg-[#262626] hover:bg-[#333333] border border-[#3e3e3e] text-[#f5a623] text-[11px] font-semibold flex items-center gap-1 transition"
        >
          <Magnet className="w-3 h-3" />
          클립에 자막 맞추기
        </button>

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
          MP4 출력
        </button>

        <LayoutGrid className="w-3.5 h-3.5 text-[#888888]" />
        <Volume2 className="w-3.5 h-3.5 text-[#888888]" />
      </div>
    </header>
  );
};
