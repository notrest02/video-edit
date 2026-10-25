import { create } from 'zustand';
import {
  AlignedSubtitleItem,
  EditorTool,
  MediaAsset,
  ProjectFileData,
  SequenceItem,
  SequenceSettings,
  SnapResultSummary,
  TimelineClip,
  TimelineTrack,
  TrackType,
} from '../types/editor';
import { snapSubtitleClipsToMediaCuts } from '../utils/subtitleSnapper';
import {
  CaptionDiffItem,
  CaptionLineMode,
  alignScriptLinesToExistingCaptions,
  reformatSubtitleClipsByLineMode,
} from '../utils/scriptAligner';

interface HistorySnapshot {
  tracks: TimelineTrack[];
  clips: TimelineClip[];
}

interface EditorState {
  projectName: string;
  projectFilePath: string | null;
  isDirty: boolean;
  fps: number;
  sequence: SequenceSettings;
  sequences: SequenceItem[];
  activeSequenceId: string | null;
  openSequenceIds: string[];
  editingSequenceId: string | null; // 모달에서 기존 시퀀스 수정 시 ID, 새 시퀀스 생성 시 null
  isSequenceModalOpen: boolean;

  assets: MediaAsset[];
  missingAssetIds: string[];
  isRelinkModalOpen: boolean;
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  selectedClipId: string | null;
  selectedClipIds: string[];
  selectedTrackId: string | null;
  selectedBinItem: { type: 'sequence' | 'asset'; id: string } | null;
  currentTime: number;
  isPlaying: boolean;
  zoomPxPerSec: number;
  snapEnabled: boolean;
  linkedSelection: boolean;
  activeTool: EditorTool;
  snapThresholdFrames: number;
  lastSnapSummary: SnapResultSummary | null;
  statusMessage: string | null;

  // AI Settings
  aiEngine: 'local' | 'openai';
  localWhisperModel: string;
  openAiApiKey: string;
  scriptText: string;
  captionLineMode: CaptionLineMode;
  captionMaxCharsPerLine: number;
  autoSplitOnCaptionGenerate: boolean;
  isQuickSplitMergeMode: boolean; // 프리뷰 화면에서 Enter(나누기) / Backspace(합치기) 단축키 토글 모드
  autoSyncSubtitleStyle: boolean; // 한 자막 스타일 변경 시 나머지 자막에도 즉시 동기화할지 여부

  // History for Undo/Redo
  past: HistorySnapshot[];
  future: HistorySnapshot[];

  // Actions
  setProjectName: (name: string) => void;
  openNewSequenceModal: () => void;
  openEditSequenceModal: (seqId: string) => void;
  setIsSequenceModalOpen: (open: boolean) => void;
  createNewSequence: (settings: Omit<SequenceSettings, 'isCustom'>) => SequenceItem;
  updateSequenceItem: (seqId: string, patch: Partial<SequenceSettings>) => void;
  selectSequence: (seqId: string) => void;
  closeSequenceTab: (seqId: string) => void;
  deleteSequence: (seqId: string) => void;
  setSequenceSettings: (settings: Partial<SequenceSettings>, markCustom?: boolean) => void;

  setCurrentTime: (time: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setZoomPxPerSec: (zoom: number) => void;
  setSelectedClipId: (id: string | null, multiToggle?: boolean) => void;
  setSelectedClipIds: (ids: string[]) => void;
  setSelectedTrackId: (trackId: string | null) => void;
  setSelectedBinItem: (item: { type: 'sequence' | 'asset'; id: string } | null) => void;
  deleteSelectedLayers: () => void;
  removeAsset: (assetId: string) => void;
  duplicateSequence: (seqId: string) => void;
  setSnapEnabled: (enabled: boolean) => void;
  setLinkedSelection: (linked: boolean) => void;
  setActiveTool: (tool: EditorTool) => void;
  setSnapThresholdFrames: (frames: number) => void;
  setStatusMessage: (msg: string | null) => void;
  setAiEngine: (engine: 'local' | 'openai') => void;
  setLocalWhisperModel: (model: string) => void;
  setOpenAiApiKey: (key: string) => void;
  setScriptText: (text: string) => void;
  setCaptionLineMode: (mode: CaptionLineMode) => void;
  setCaptionMaxCharsPerLine: (maxChars: number) => void;
  setAutoSplitOnCaptionGenerate: (auto: boolean) => void;
  setIsQuickSplitMergeMode: (enabled: boolean) => void;
  setAutoSyncSubtitleStyle: (sync: boolean) => void;
  applySubtitleStyleToAll: (
    sourceClipId?: string,
    scope?: 'all' | 'same-track'
  ) => void;
  reformatAllCaptionsLineLayout: (
    customMode?: CaptionLineMode,
    customMaxChars?: number
  ) => void;
  applyScriptLinesDirectly: (customScript?: string) => CaptionDiffItem[];
  splitSubtitleClipAtTextCursor: (
    clipId: string,
    cursorIndex?: number
  ) => string | null;
  mergeSubtitleClipWithAdjacent: (
    clipId: string,
    preferDirection?: 'prev' | 'next'
  ) => string | null;

  // Track Management
  addTrack: (type: TrackType) => void;
  removeTrack: (trackId: string) => void;
  toggleTrackMute: (trackId: string) => void;
  toggleTrackSolo: (trackId: string) => void;
  toggleTrackVisible: (trackId: string) => void;
  toggleTrackLock: (trackId: string) => void;

  // Asset & Clip Management
  addAssets: (newAssets: Array<Omit<MediaAsset, 'id'>>) => MediaAsset[];
  addAssetToTimeline: (
    assetId: string,
    options?: { targetTrackId?: string; startTime?: number }
  ) => void;
  addSubtitleClipAtCurrentTime: (
    defaultText?: string,
    targetTrackId?: string,
    customTime?: number
  ) => void;
  updateClip: (clipId: string, patch: Partial<TimelineClip>, saveHistory?: boolean) => void;
  moveOrTrimClipWithLink: (
    clipId: string,
    deltaStart: number,
    deltaDuration: number,
    deltaSourceStart: number,
    targetTrackId?: string,
    snapped?: boolean
  ) => void;
  moveSelectedClips: (
    clipIds: string[],
    deltaStart: number,
    primaryClipId?: string,
    targetTrackId?: string,
    snapped?: boolean
  ) => void;
  recordHistorySnapshot: () => void;
  commitClipOverlapOverwrite: (clipId: string) => void;
  commitMultiClipsOverlapOverwrite: (clipIds: string[]) => void;
  unlinkClip: (clipId?: string) => void;
  deleteClip: (clipId?: string) => void;
  splitClipAtPlayhead: () => void;
  splitClipAtTime: (clipId: string, splitTime: number) => void;
  rippleCloseGaps: () => void;
  replaceClipWithSegments: (
    clipId: string,
    segments: Array<{ start: number; end: number }>,
    rippleCompact: boolean
  ) => void;
  applyAlignedSubtitles: (items: AlignedSubtitleItem[], autoSnapToCuts: boolean) => void;
  addRawAiCaptions: (segments: Array<{ text: string; start: number; end: number }>) => void;
  applyScriptCorrectionsToCaptions: (
    diffs: Array<{ clipId: string; beforeText: string; afterText: string }>
  ) => void;
  snapAllSubtitlesToClips: (customThresholdFrames?: number) => SnapResultSummary;
  undo: () => void;
  redo: () => void;
  getTotalDuration: () => number;

  // Project Management (.agproj)
  setIsDirty: (dirty: boolean) => void;
  getProjectExportData: () => ProjectFileData;
  saveProject: (saveAs?: boolean) => Promise<boolean>;
  openProject: () => Promise<boolean>;
  loadProjectData: (data: any, filePath?: string) => Promise<void>;
  newProject: () => void;
  setIsRelinkModalOpen: (open: boolean) => void;
  relinkAsset: (assetId: string, newPath: string) => Promise<boolean>;
  relinkAssetsInBatch: (relinkMap: Record<string, string>) => Promise<number>;
}

export function createDefaultTracks(): TimelineTrack[] {
  return [
    { id: 'track-c1', code: 'C1', name: '캡션 / 자막 1', type: 'text', muted: false, solo: false, visible: true, locked: false },
    { id: 'track-v3', code: 'V3', name: '비디오 3', type: 'video', muted: false, solo: false, visible: true, locked: false },
    { id: 'track-v2', code: 'V2', name: '비디오 2', type: 'video', muted: false, solo: false, visible: true, locked: false },
    { id: 'track-v1', code: 'V1', name: '비디오 1', type: 'video', muted: false, solo: false, visible: true, locked: false },
    { id: 'track-a1', code: 'A1', name: '오디오 1', type: 'audio', muted: false, solo: false, visible: true, locked: false },
    { id: 'track-a2', code: 'A2', name: '오디오 2', type: 'audio', muted: false, solo: false, visible: true, locked: false },
    { id: 'track-a3', code: 'A3', name: '오디오 3', type: 'audio', muted: false, solo: false, visible: true, locked: false },
  ];
}

const DEFAULT_SAMPLE_SCRIPT = `안녕하세요 안티그래비티 AI 비디오 편집기입니다
대본을 입력하면 오타 없이 대본 글자 그대로 자막이 생성됩니다
무음 구간 자동 컷 편집을 한 뒤에도
클립 맞추기 버튼 하나로 1프레임 오차까지 칼같이 정렬됩니다`;

/**
 * 새로 올라오거나 이동/트림된 클립(activeClipIds)과 같은 트랙에서 시간이 겹치는 기존 클립을
 * 프리미어 프로 방식(Overwrite)으로 자동 삭제(완전 겹침 시) 또는 잘라내기(부분 겹침 시)합니다.
 * 이를 통해 동일 트랙 위에서 두 클립이 겹쳐 음성이 이중으로 들리는 현상을 원천 방지합니다.
 */
function overwriteOverlappingClips(
  allClips: TimelineClip[],
  activeClipIds: Set<string>
): { clips: TimelineClip[]; overwrittenCount: number } {
  let workingClips = [...allClips];
  let overwrittenCount = 0;
  const minRemain = 0.08; // 남은 조각이 0.08초(약 2프레임) 미만이면 완전히 삭제

  const activeClips = workingClips.filter((c) => activeClipIds.has(c.id));

  for (const active of activeClips) {
    const aStart = active.startTime;
    const aEnd = active.startTime + active.duration;
    const nextList: TimelineClip[] = [];

    for (const c of workingClips) {
      if (activeClipIds.has(c.id) || c.trackId !== active.trackId) {
        nextList.push(c);
        continue;
      }

      const oStart = c.startTime;
      const oEnd = c.startTime + c.duration;

      // 겹치지 않는 경우 그대로 유지
      if (oEnd <= aStart + 0.002 || oStart >= aEnd - 0.002) {
        nextList.push(c);
        continue;
      }

      // 겹치는 경우!
      overwrittenCount++;
      const leftRemain = aStart - oStart;
      const rightRemain = oEnd - aEnd;

      if (leftRemain < minRemain && rightRemain < minRemain) {
        // 1) 기존 클립이 새 클립에 완전히 덮인 경우 -> 기존 클립 완전 삭제
        continue;
      } else if (leftRemain >= minRemain && rightRemain < minRemain) {
        // 2) 기존 클립의 오른쪽 부분이 덮인 경우 -> 겹친 뒷부분 삭제
        nextList.push({
          ...c,
          duration: Number(leftRemain.toFixed(4)),
        });
      } else if (leftRemain < minRemain && rightRemain >= minRemain) {
        // 3) 기존 클립의 왼쪽 부분이 덮인 경우 -> 겹친 앞부분 삭제 및 sourceStart 이동
        const cutDelta = aEnd - oStart;
        nextList.push({
          ...c,
          startTime: Number(aEnd.toFixed(4)),
          duration: Number(rightRemain.toFixed(4)),
          sourceStart:
            c.type === 'text' ? 0 : Number(Math.max(0, c.sourceStart + cutDelta).toFixed(4)),
        });
      } else {
        // 4) 새 클립이 기존 긴 클립의 한가운데 올라온 경우 -> 가운데 겹친 구간을 삭제하고 앞/뒤로 분할
        const cutDelta = aEnd - oStart;
        nextList.push(
          {
            ...c,
            duration: Number(leftRemain.toFixed(4)),
          },
          {
            ...c,
            id: `${c.id}_ow_${Date.now().toString(36).slice(-4)}_${Math.random().toString(36).slice(2, 5)}`,
            startTime: Number(aEnd.toFixed(4)),
            duration: Number(rightRemain.toFixed(4)),
            sourceStart:
              c.type === 'text' ? 0 : Number(Math.max(0, c.sourceStart + cutDelta).toFixed(4)),
          }
        );
      }
    }

    workingClips = nextList;
  }

  return { clips: workingClips, overwrittenCount };
}

export const useEditorStore = create<EditorState>((set, get) => {
  const pushHistory = () => {
    const { tracks, clips, past } = get();
    const snapshot: HistorySnapshot = {
      tracks: JSON.parse(JSON.stringify(tracks)),
      clips: JSON.parse(JSON.stringify(clips)),
    };
    set({
      past: [...past.slice(-29), snapshot],
      future: [],
      isDirty: true,
    });
  };

  // 현재 활성 시퀀스의 tracks / clips 변경 사항을 sequences 배열에도 동기화
  const syncActiveSequenceData = (
    nextTracks: TimelineTrack[],
    nextClips: TimelineClip[],
    nextSeqSettings?: SequenceSettings,
    nextCurrentTime?: number
  ) => {
    const { sequences, activeSequenceId, sequence, currentTime } = get();
    if (!activeSequenceId) return sequences;
    const seqMeta = nextSeqSettings || sequence;
    const cTime = nextCurrentTime !== undefined ? nextCurrentTime : currentTime;

    return sequences.map((s) =>
      s.id === activeSequenceId
        ? {
            ...s,
            name: seqMeta.name,
            width: seqMeta.width,
            height: seqMeta.height,
            fps: seqMeta.fps,
            fitMode: seqMeta.fitMode,
            isCustom: seqMeta.isCustom,
            tracks: nextTracks,
            clips: nextClips,
            currentTime: cTime,
          }
        : s
    );
  };

  return {
    projectName: '무제 - 편집됨',
    projectFilePath: null,
    isDirty: false,
    fps: 30,
    sequence: {
      name: '시퀀스 01',
      width: 1920,
      height: 1080,
      fps: 30,
      fitMode: 'contain',
      isCustom: false,
    },
    sequences: [],
    activeSequenceId: null,
    openSequenceIds: [],
    editingSequenceId: null,
    isSequenceModalOpen: false,

    assets: [],
    missingAssetIds: [],
    isRelinkModalOpen: false,
    tracks: createDefaultTracks(),
    clips: [],
    selectedClipId: null,
    selectedClipIds: [],
    selectedTrackId: null,
    selectedBinItem: null,
    currentTime: 0,
    isPlaying: false,
    zoomPxPerSec: 55,
    snapEnabled: true,
    linkedSelection: true,
    activeTool: 'select',
    snapThresholdFrames: 5,
    lastSnapSummary: null,
    statusMessage:
      '좌측 하단에서 [+ 새 시퀀스]를 만들거나, 미디어를 바로 타임라인으로 드래그하면 영상 규격에 맞는 시퀀스가 자동 생성됩니다.',

    aiEngine: 'local',
    localWhisperModel: 'Xenova/whisper-tiny',
    openAiApiKey: localStorage.getItem('agy_openai_key') || '',
    scriptText: DEFAULT_SAMPLE_SCRIPT,
    captionLineMode: 'single-line',
    captionMaxCharsPerLine: 13,
    autoSplitOnCaptionGenerate: true,
    isQuickSplitMergeMode: true,
    autoSyncSubtitleStyle: false,

    past: [],
    future: [],

    setProjectName: (projectName) => set({ projectName, isDirty: true }),

    openNewSequenceModal: () => set({ editingSequenceId: null, isSequenceModalOpen: true }),
    openEditSequenceModal: (seqId) => set({ editingSequenceId: seqId, isSequenceModalOpen: true }),
    setIsSequenceModalOpen: (isSequenceModalOpen) => set({ isSequenceModalOpen }),

    // 새 시퀀스 아이템 생성 (좌측 하단 프로젝트 목록에 추가되고 즉시 해당 시퀀스로 진입!)
    createNewSequence: (settings) => {
      const { sequences, openSequenceIds, activeSequenceId, tracks, clips, currentTime } = get();

      // 기존에 열려 있던 시퀀스가 있다면 그 상태를 먼저 저장
      const updatedPrevSequences = activeSequenceId
        ? syncActiveSequenceData(tracks, clips, undefined, currentTime)
        : sequences;

      const freshTracks = createDefaultTracks();
      const newSeq: SequenceItem = {
        id: `seq_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: settings.name || `시퀀스 0${updatedPrevSequences.length + 1}`,
        width: settings.width,
        height: settings.height,
        fps: settings.fps,
        fitMode: settings.fitMode,
        isCustom: true,
        tracks: freshTracks,
        clips: [],
        currentTime: 0,
      };

      set({
        sequences: [...updatedPrevSequences, newSeq],
        activeSequenceId: newSeq.id,
        openSequenceIds: [...openSequenceIds, newSeq.id],
        sequence: {
          name: newSeq.name,
          width: newSeq.width,
          height: newSeq.height,
          fps: newSeq.fps,
          fitMode: newSeq.fitMode,
          isCustom: true,
        },
        fps: newSeq.fps,
        tracks: freshTracks,
        clips: [],
        selectedClipId: null,
        currentTime: 0,
        isPlaying: false,
        past: [],
        future: [],
        isSequenceModalOpen: false,
        editingSequenceId: null,
        statusMessage: `새 시퀀스 '${newSeq.name}' (${newSeq.width}×${newSeq.height} · ${newSeq.fps}fps)가 프로젝트 패널에 생성되었습니다.`,
      });

      return newSeq;
    },

    // 기존 시퀀스 규격 수정
    updateSequenceItem: (seqId, patch) => {
      const { sequences, activeSequenceId, sequence, tracks, clips } = get();
      const target = sequences.find((s) => s.id === seqId);
      if (!target) return;

      const updatedSeqs = sequences.map((s) =>
        s.id === seqId
          ? {
              ...s,
              ...patch,
              isCustom: true,
            }
          : s
      );

      if (activeSequenceId === seqId) {
        const nextSeqMeta: SequenceSettings = {
          ...sequence,
          ...patch,
          isCustom: true,
        };
        set({
          sequences: syncActiveSequenceData(tracks, clips, nextSeqMeta),
          sequence: nextSeqMeta,
          fps: nextSeqMeta.fps,
          isSequenceModalOpen: false,
          editingSequenceId: null,
          statusMessage: `시퀀스 '${nextSeqMeta.name}' 규격이 ${nextSeqMeta.width}×${nextSeqMeta.height} (${nextSeqMeta.fps}fps)로 변경되었습니다.`,
        });
      } else {
        set({
          sequences: updatedSeqs,
          isSequenceModalOpen: false,
          editingSequenceId: null,
          statusMessage: `시퀀스 규격이 변경되었습니다.`,
        });
      }
    },

    // 좌측 하단 프로젝트 패널이나 타임라인 탭에서 시퀀스를 클릭해 해당 시퀀스 내부로 진입!
    selectSequence: (seqId) => {
      const { sequences, activeSequenceId, openSequenceIds, tracks, clips, currentTime } = get();
      if (seqId === activeSequenceId) return;

      const savedSequences = activeSequenceId
        ? syncActiveSequenceData(tracks, clips, undefined, currentTime)
        : sequences;

      const target = savedSequences.find((s) => s.id === seqId);
      if (!target) return;

      const nextOpenIds = openSequenceIds.includes(seqId)
        ? openSequenceIds
        : [...openSequenceIds, seqId];

      set({
        sequences: savedSequences,
        activeSequenceId: target.id,
        openSequenceIds: nextOpenIds,
        sequence: {
          name: target.name,
          width: target.width,
          height: target.height,
          fps: target.fps,
          fitMode: target.fitMode,
          isCustom: target.isCustom,
        },
        fps: target.fps,
        tracks: target.tracks,
        clips: target.clips,
        currentTime: target.currentTime || 0,
        selectedClipId: null,
        isPlaying: false,
        past: [],
        future: [],
        statusMessage: `'${target.name}' (${target.width}×${target.height}) 시퀀스를 열었습니다.`,
      });
    },

    closeSequenceTab: (seqId) => {
      const { openSequenceIds, activeSequenceId, sequences, tracks, clips, currentTime } = get();
      const savedSequences = activeSequenceId
        ? syncActiveSequenceData(tracks, clips, undefined, currentTime)
        : sequences;

      const remainingOpen = openSequenceIds.filter((id) => id !== seqId);
      if (activeSequenceId !== seqId) {
        set({ sequences: savedSequences, openSequenceIds: remainingOpen });
        return;
      }

      const nextActiveId = remainingOpen[remainingOpen.length - 1] || null;
      const nextTarget = savedSequences.find((s) => s.id === nextActiveId) || null;

      if (nextTarget) {
        set({
          sequences: savedSequences,
          openSequenceIds: remainingOpen,
          activeSequenceId: nextTarget.id,
          sequence: {
            name: nextTarget.name,
            width: nextTarget.width,
            height: nextTarget.height,
            fps: nextTarget.fps,
            fitMode: nextTarget.fitMode,
            isCustom: nextTarget.isCustom,
          },
          fps: nextTarget.fps,
          tracks: nextTarget.tracks,
          clips: nextTarget.clips,
          currentTime: nextTarget.currentTime || 0,
          selectedClipId: null,
          isPlaying: false,
        });
      } else {
        set({
          sequences: savedSequences,
          openSequenceIds: [],
          activeSequenceId: null,
          clips: [],
          selectedClipId: null,
          currentTime: 0,
          isPlaying: false,
          statusMessage: '열려 있는 시퀀스가 없습니다. 좌측 하단에서 시퀀스를 더블클릭하거나 새 시퀀스를 만드세요.',
        });
      }
    },

    deleteSequence: (seqId) => {
      const { sequences, openSequenceIds, activeSequenceId } = get();
      const target = sequences.find((s) => s.id === seqId);
      if (!target) return;

      const nextSeqs = sequences.filter((s) => s.id !== seqId);
      const nextOpen = openSequenceIds.filter((id) => id !== seqId);

      if (activeSequenceId === seqId) {
        const fallback = nextSeqs[nextSeqs.length - 1] || null;
        set({
          sequences: nextSeqs,
          openSequenceIds: fallback ? (nextOpen.includes(fallback.id) ? nextOpen : [...nextOpen, fallback.id]) : [],
          activeSequenceId: fallback ? fallback.id : null,
          sequence: fallback
            ? {
                name: fallback.name,
                width: fallback.width,
                height: fallback.height,
                fps: fallback.fps,
                fitMode: fallback.fitMode,
                isCustom: fallback.isCustom,
              }
            : get().sequence,
          fps: fallback ? fallback.fps : 30,
          tracks: fallback ? fallback.tracks : createDefaultTracks(),
          clips: fallback ? fallback.clips : [],
          selectedClipId: null,
          currentTime: 0,
          isPlaying: false,
          statusMessage: `'${target.name}' 시퀀스가 삭제되었습니다.`,
        });
      } else {
        set({
          sequences: nextSeqs,
          openSequenceIds: nextOpen,
          statusMessage: `'${target.name}' 시퀀스가 삭제되었습니다.`,
        });
      }
    },

    setSequenceSettings: (patch, markCustom = true) =>
      set((state) => {
        const nextSeq: SequenceSettings = {
          ...state.sequence,
          ...patch,
          isCustom: markCustom ? true : state.sequence.isCustom,
        };
        return {
          sequence: nextSeq,
          fps: nextSeq.fps,
          sequences: syncActiveSequenceData(state.tracks, state.clips, nextSeq),
          statusMessage: `시퀀스 규격이 ${nextSeq.width}×${nextSeq.height} (${nextSeq.fps}fps)로 설정되었습니다.`,
        };
      }),

    setCurrentTime: (time) => {
      const safe = Math.max(0, time);
      set({ currentTime: safe });
    },
    setIsPlaying: (isPlaying) => set({ isPlaying }),
    setZoomPxPerSec: (zoom) => set({ zoomPxPerSec: Math.min(600, Math.max(12, zoom)) }),
    setSelectedClipId: (selectedClipId, multiToggle = false) =>
      set((state) => {
        if (!selectedClipId) {
          return { selectedClipId: null, selectedClipIds: [] };
        }
        if (multiToggle) {
          const exists = state.selectedClipIds.includes(selectedClipId);
          const nextIds = exists
            ? state.selectedClipIds.filter((id) => id !== selectedClipId)
            : [...state.selectedClipIds, selectedClipId];
          return {
            selectedClipId: nextIds[nextIds.length - 1] || null,
            selectedClipIds: nextIds,
            selectedTrackId: null,
            selectedBinItem: null,
          };
        }
        return {
          selectedClipId,
          selectedClipIds: [selectedClipId],
          selectedTrackId: null,
          selectedBinItem: null,
        };
      }),
    setSelectedClipIds: (selectedClipIds) =>
      set({
        selectedClipIds,
        selectedClipId: selectedClipIds[selectedClipIds.length - 1] || null,
        selectedTrackId: null,
        selectedBinItem: null,
      }),
    setSelectedTrackId: (selectedTrackId) =>
      set({
        selectedTrackId,
        selectedClipId: null,
        selectedClipIds: [],
        selectedBinItem: null,
      }),
    setSelectedBinItem: (selectedBinItem) =>
      set({
        selectedBinItem,
        selectedClipId: null,
        selectedClipIds: [],
        selectedTrackId: null,
      }),
    removeAsset: (assetId) =>
      set((state) => ({
        assets: state.assets.filter((a) => a.id !== assetId),
        selectedBinItem:
          state.selectedBinItem?.id === assetId ? null : state.selectedBinItem,
        statusMessage: '미디어 항목이 삭제되었습니다.',
      })),
    duplicateSequence: (seqId) => {
      const { sequences, openSequenceIds, activeSequenceId, tracks, clips, currentTime } = get();
      const savedSequences = activeSequenceId
        ? syncActiveSequenceData(tracks, clips, undefined, currentTime)
        : sequences;
      const orig = savedSequences.find((s) => s.id === seqId);
      if (!orig) return;

      const copySeq: SequenceItem = {
        ...JSON.parse(JSON.stringify(orig)),
        id: `seq_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: `${orig.name} (복사본)`,
      };

      set({
        sequences: [...savedSequences, copySeq],
        openSequenceIds: [...openSequenceIds, copySeq.id],
        activeSequenceId: copySeq.id,
        sequence: {
          name: copySeq.name,
          width: copySeq.width,
          height: copySeq.height,
          fps: copySeq.fps,
          fitMode: copySeq.fitMode,
          isCustom: copySeq.isCustom,
        },
        fps: copySeq.fps,
        tracks: copySeq.tracks,
        clips: copySeq.clips,
        currentTime: copySeq.currentTime || 0,
        statusMessage: `'${orig.name}' 시퀀스가 복제되었습니다.`,
      });
    },
    deleteSelectedLayers: () => {
      const {
        selectedClipIds,
        selectedClipId,
        selectedTrackId,
        selectedBinItem,
        clips,
        tracks,
        linkedSelection,
      } = get();

      // 1. 선택된 타임라인 클립(레이어)들이 있는 경우 모두 삭제
      const targetClipIds =
        selectedClipIds.length > 0
          ? selectedClipIds
          : selectedClipId
          ? [selectedClipId]
          : [];

      if (targetClipIds.length > 0) {
        pushHistory();
        const idSet = new Set(targetClipIds);
        const groupSet = new Set<string>();

        if (linkedSelection) {
          for (const c of clips) {
            if (idSet.has(c.id) && c.linkedGroupId) {
              groupSet.add(c.linkedGroupId);
            }
          }
        }

        const nextClips = clips.filter(
          (c) => !idSet.has(c.id) && !(c.linkedGroupId && groupSet.has(c.linkedGroupId))
        );
        const removedCount = clips.length - nextClips.length;

        set({
          clips: nextClips,
          sequences: syncActiveSequenceData(tracks, nextClips),
          selectedClipId: null,
          selectedClipIds: [],
          statusMessage: `${removedCount}개의 클립(레이어)이 삭제되었습니다.`,
        });
        return;
      }

      // 2. 선택된 트랙(V1~V3, A1~A3, C1 레이어 트랙)이 있는 경우 해당 트랙 삭제
      if (selectedTrackId) {
        get().removeTrack(selectedTrackId);
        set({ selectedTrackId: null });
        return;
      }

      // 3. 프로젝트 보관함에서 시퀀스나 미디어가 선택되어 있는 경우 삭제
      if (selectedBinItem) {
        if (selectedBinItem.type === 'sequence') {
          get().deleteSequence(selectedBinItem.id);
        } else {
          get().removeAsset(selectedBinItem.id);
        }
        set({ selectedBinItem: null });
      }
    },
    setSnapEnabled: (snapEnabled) => set({ snapEnabled }),
    setLinkedSelection: (linkedSelection) => set({ linkedSelection }),
    setActiveTool: (activeTool) => set({ activeTool }),
    setSnapThresholdFrames: (snapThresholdFrames) =>
      set({ snapThresholdFrames: Math.max(1, Math.min(30, snapThresholdFrames)) }),
    setStatusMessage: (statusMessage) => set({ statusMessage }),
    setAiEngine: (aiEngine) => set({ aiEngine }),
    setLocalWhisperModel: (localWhisperModel) => set({ localWhisperModel }),
    setOpenAiApiKey: (openAiApiKey) => {
      localStorage.setItem('agy_openai_key', openAiApiKey);
      set({ openAiApiKey });
    },
    setScriptText: (scriptText) => set({ scriptText }),
    setCaptionLineMode: (captionLineMode) => set({ captionLineMode }),
    setCaptionMaxCharsPerLine: (captionMaxCharsPerLine) =>
      set({ captionMaxCharsPerLine: Math.max(6, Math.min(30, captionMaxCharsPerLine)) }),
    setAutoSplitOnCaptionGenerate: (autoSplitOnCaptionGenerate) =>
      set({ autoSplitOnCaptionGenerate }),
    setIsQuickSplitMergeMode: (isQuickSplitMergeMode) =>
      set({
        isQuickSplitMergeMode,
        statusMessage: isQuickSplitMergeMode
          ? '⚡ [단축키 분할/합치기 모드 ON] 프리뷰 화면 자막에서 원하는 위치에 커서를 두고 [Enter]로 나누기, [Backspace]로 앞 자막과 합치기가 가능합니다!'
          : '✏️ [일반 자막 텍스트 편집 모드] 프리뷰 화면 자막을 클릭해 직접 오타를 수정할 수 있습니다.',
      }),
    setAutoSyncSubtitleStyle: (autoSyncSubtitleStyle) =>
      set({
        autoSyncSubtitleStyle,
        statusMessage: autoSyncSubtitleStyle
          ? '🔗 [스타일 자동 동기화 ON] 이제 한 자막의 스타일을 바꾸면 시퀀스 내 모든 자막이 동시에 변경됩니다.'
          : '스타일 자동 동기화가 꺼졌습니다. [모든 자막에 스타일 일괄 적용] 버튼으로 원할 때 일괄 적용할 수 있습니다.',
      }),

    // 선택된(특정) 자막 클립의 텍스트 스타일(폰트·크기·색상·외곽선·그림자·투명도·배경·위치)을 나머지 모든 자막 클립에 일괄 적용!
    applySubtitleStyleToAll: (sourceClipId, scope = 'all') => {
      const { clips, tracks, selectedClipId } = get();
      const targetId = sourceClipId || selectedClipId;
      const sourceClip = clips.find((c) => c.id === targetId && c.type === 'text');
      if (!sourceClip) {
        set({ statusMessage: '기준이 될 자막 클립을 먼저 선택해 주세요.' });
        return;
      }

      const stylePatch: Partial<TimelineClip> = {
        fontFamily: sourceClip.fontFamily,
        fontSize: sourceClip.fontSize,
        fontWeight: sourceClip.fontWeight,
        fontItalic: sourceClip.fontItalic,
        letterSpacing: sourceClip.letterSpacing,
        fontColor: sourceClip.fontColor,
        fontOpacity: sourceClip.fontOpacity,
        strokeEnabled: sourceClip.strokeEnabled,
        strokeColor: sourceClip.strokeColor,
        strokeWidth: sourceClip.strokeWidth,
        strokeOpacity: sourceClip.strokeOpacity,
        shadowEnabled: sourceClip.shadowEnabled,
        shadowColor: sourceClip.shadowColor,
        shadowOpacity: sourceClip.shadowOpacity,
        shadowBlur: sourceClip.shadowBlur,
        shadowOffsetX: sourceClip.shadowOffsetX,
        shadowOffsetY: sourceClip.shadowOffsetY,
        opacity: sourceClip.opacity,
        backgroundEnabled: sourceClip.backgroundEnabled,
        backgroundColor: sourceClip.backgroundColor,
        backgroundOpacity: sourceClip.backgroundOpacity,
        backgroundRadius: sourceClip.backgroundRadius,
        backgroundPaddingX: sourceClip.backgroundPaddingX,
        backgroundPaddingY: sourceClip.backgroundPaddingY,
        positionX: sourceClip.positionX,
        positionY: sourceClip.positionY,
      };

      pushHistory();
      let appliedCount = 0;

      const nextClips = clips.map((c) => {
        if (c.type !== 'text') return c;
        if (scope === 'same-track' && c.trackId !== sourceClip.trackId) return c;
        appliedCount++;
        return {
          ...c,
          ...stylePatch,
        };
      });

      set({
        clips: nextClips,
        sequences: syncActiveSequenceData(tracks, nextClips),
        statusMessage: `✨ 현재 자막('${sourceClip.name}')의 스타일(폰트·외곽선·그림자·투명도·위치)이 전체 자막 ${appliedCount}개에 일괄 적용되었습니다!`,
      });
    },

    // [방안 1] 사용자가 대본 입력창에서 줄바꿈(Enter)한 한 줄 한 줄을 그대로 자막 클립 1개씩으로 매칭 적용
    applyScriptLinesDirectly: (customScript) => {
      const { clips, tracks, fps, scriptText } = get();
      const targetScript = customScript ?? scriptText;
      const textClips = clips.filter((c) => c.type === 'text');
      if (textClips.length === 0 || !targetScript.trim()) {
        set({
          statusMessage:
            '먼저 1단계에서 AI 캡션을 생성하고, 2단계에 줄바꿈된 대본을 입력해 주세요.',
        });
        return [];
      }

      pushHistory();
      const { updatedClips, diffs } = alignScriptLinesToExistingCaptions(
        clips,
        targetScript,
        fps
      );

      set({
        clips: updatedClips,
        sequences: syncActiveSequenceData(tracks, updatedClips),
        statusMessage: `[내 대본 줄바꿈(Enter) 그대로 적용 완료] 대본의 ${diffs.length}개 줄이 그대로 타임라인 자막 클립 ${diffs.length}개로 구성되었습니다!`,
      });

      return diffs;
    },

    // [방안 2 - Enter 단축키] 프리뷰 화면(또는 캡션 창)에서 현재 커서 위치를 기준으로 자막 클립을 즉시 2개로 분할
    splitSubtitleClipAtTextCursor: (clipId, cursorIndex) => {
      const { clips, tracks, fps } = get();
      const target = clips.find((c) => c.id === clipId && c.type === 'text');
      if (!target) return null;

      const rawText = target.text || '';
      if (rawText.trim().length < 2) {
        set({ statusMessage: '더 이상 나눌 수 없는 짧은 자막입니다.' });
        return null;
      }

      let splitPos = cursorIndex ?? -1;
      let firstPart = '';
      let secondPart = '';

      if (splitPos > 0 && splitPos < rawText.length) {
        firstPart = rawText.slice(0, splitPos).trim();
        secondPart = rawText.slice(splitPos).trim();
      }

      // 만약 커서가 맨 앞이나 맨 끝에 있어서 한쪽이 비어 있다면, 가운데 어절(띄어쓰기) 위치에서 자동 분할
      if (!firstPart || !secondPart) {
        const clean = rawText.replace(/\r?\n/g, ' ').trim();
        const words = clean.split(/\s+/).filter(Boolean);
        if (words.length >= 2) {
          const midWordIdx = Math.max(1, Math.floor(words.length / 2));
          firstPart = words.slice(0, midWordIdx).join(' ');
          secondPart = words.slice(midWordIdx).join(' ');
        } else {
          const midChar = Math.max(1, Math.floor(clean.length / 2));
          firstPart = clean.slice(0, midChar).trim();
          secondPart = clean.slice(midChar).trim();
        }
      }

      if (!firstPart || !secondPart) return null;

      pushHistory();
      const frameSec = 1 / Math.max(1, fps);
      const w1 = Math.max(1, firstPart.replace(/\s+/g, '').length);
      const w2 = Math.max(1, secondPart.replace(/\s+/g, '').length);
      const ratio = w1 / (w1 + w2);

      const firstDur = Math.max(
        frameSec * 2,
        Math.min(target.duration - frameSec * 2, Number((target.duration * ratio).toFixed(4)))
      );
      const secondStart = Number((target.startTime + firstDur).toFixed(4));
      const secondDur = Math.max(
        frameSec * 2,
        Number((target.startTime + target.duration - secondStart).toFixed(4))
      );

      const secondClipId = `${target.id}_sp_${Date.now().toString(36).slice(-4)}`;
      const groupId = target.sentenceGroupId || `cap_grp_${target.id}`;

      const firstClip: TimelineClip = {
        ...target,
        sentenceGroupId: groupId,
        text: firstPart,
        name: firstPart.replace(/\r?\n/g, ' ').slice(0, 18),
        duration: firstDur,
      };

      const secondClip: TimelineClip = {
        ...target,
        id: secondClipId,
        sentenceGroupId: groupId,
        text: secondPart,
        name: secondPart.replace(/\r?\n/g, ' ').slice(0, 18),
        startTime: secondStart,
        duration: secondDur,
      };

      const nextClips: TimelineClip[] = [];
      for (const c of clips) {
        if (c.id === target.id) {
          nextClips.push(firstClip, secondClip);
        } else {
          nextClips.push(c);
        }
      }

      const nextTime = Number((secondStart + 0.01).toFixed(4));
      set({
        clips: nextClips,
        sequences: syncActiveSequenceData(tracks, nextClips, undefined, nextTime),
        selectedClipId: secondClipId,
        selectedClipIds: [secondClipId],
        currentTime: nextTime,
        statusMessage: `✂️ [Enter 자막 나누기] "${firstPart}" / "${secondPart}" 두 개의 캡션으로 즉시 분할되었습니다!`,
      });

      return secondClipId;
    },

    // [방안 2 - Backspace 단축키] 프리뷰 화면(또는 캡션 창)에서 현재 자막 클립을 바로 앞(또는 뒤) 자막 클립과 즉시 하나로 병합
    mergeSubtitleClipWithAdjacent: (clipId, preferDirection = 'prev') => {
      const { clips, tracks, captionLineMode } = get();
      const target = clips.find((c) => c.id === clipId && c.type === 'text');
      if (!target) return null;

      const sameTrackSubs = clips
        .filter((c) => c.type === 'text' && c.trackId === target.trackId)
        .sort((a, b) => a.startTime - b.startTime);

      if (sameTrackSubs.length <= 1) {
        set({ statusMessage: '합칠 수 있는 인접 자막 클립이 없습니다.' });
        return null;
      }

      const idx = sameTrackSubs.findIndex((c) => c.id === target.id);
      if (idx === -1) return null;

      let firstClip: TimelineClip;
      let secondClip: TimelineClip;

      if (preferDirection === 'prev') {
        if (idx > 0) {
          firstClip = sameTrackSubs[idx - 1];
          secondClip = sameTrackSubs[idx];
        } else {
          // 맨 첫 번째 자막에서 Backspace를 누른 경우 바로 다음 자막과 합침
          firstClip = sameTrackSubs[0];
          secondClip = sameTrackSubs[1];
        }
      } else {
        if (idx < sameTrackSubs.length - 1) {
          firstClip = sameTrackSubs[idx];
          secondClip = sameTrackSubs[idx + 1];
        } else {
          firstClip = sameTrackSubs[idx - 1];
          secondClip = sameTrackSubs[idx];
        }
      }

      pushHistory();

      const t1 = (firstClip.text || '').trim();
      const t2 = (secondClip.text || '').trim();
      const joiner =
        captionLineMode === 'double-line' && !t1.includes('\n') && !t2.includes('\n')
          ? '\n'
          : ' ';
      const mergedText = `${t1}${joiner}${t2}`.trim();
      const mergedStart = Math.min(firstClip.startTime, secondClip.startTime);
      const mergedEnd = Math.max(
        firstClip.startTime + firstClip.duration,
        secondClip.startTime + secondClip.duration
      );
      const mergedDuration = Number(Math.max(0.1, mergedEnd - mergedStart).toFixed(4));

      const mergedClip: TimelineClip = {
        ...firstClip,
        text: mergedText,
        name: mergedText.replace(/\r?\n/g, ' ').slice(0, 18),
        startTime: Number(mergedStart.toFixed(4)),
        duration: mergedDuration,
      };

      const nextClips = clips
        .filter((c) => c.id !== secondClip.id)
        .map((c) => (c.id === firstClip.id ? mergedClip : c));

      const nextTime = Number((mergedStart + Math.min(0.05, mergedDuration * 0.5)).toFixed(4));
      set({
        clips: nextClips,
        sequences: syncActiveSequenceData(tracks, nextClips, undefined, nextTime),
        selectedClipId: mergedClip.id,
        selectedClipIds: [mergedClip.id],
        currentTime: nextTime,
        statusMessage: `🔗 [Backspace 자막 합치기] "${t1.replace(/\r?\n/g, ' ')}" + "${t2.replace(/\r?\n/g, ' ')}" 자막이 하나로 합쳐졌습니다!`,
      });

      return mergedClip.id;
    },

    reformatAllCaptionsLineLayout: (customMode, customMaxChars) => {
      const { clips, tracks, fps, captionLineMode, captionMaxCharsPerLine } = get();
      const targetMode = customMode ?? captionLineMode;
      const targetMaxChars = customMaxChars ?? captionMaxCharsPerLine;

      const textClips = clips.filter((c) => c.type === 'text');
      if (textClips.length === 0) {
        set({
          captionLineMode: targetMode,
          captionMaxCharsPerLine: targetMaxChars,
          statusMessage: '재구성할 자막(캡션) 클립이 타임라인에 없습니다.',
        });
        return;
      }

      pushHistory();
      const { updatedClips, beforeCount, afterCount } = reformatSubtitleClipsByLineMode(
        clips,
        {
          mode: targetMode,
          maxCharsPerLine: targetMaxChars,
          fps,
        }
      );

      const modeLabel =
        targetMode === 'single-line'
          ? `한 줄씩 표시 (1줄 최대 ${targetMaxChars}자 기준 클립 분할)`
          : `화면 두 줄 이내 표시 (1줄 ${targetMaxChars}자 기준 최대 2줄 묶음)`;

      set({
        captionLineMode: targetMode,
        captionMaxCharsPerLine: targetMaxChars,
        clips: updatedClips,
        sequences: syncActiveSequenceData(tracks, updatedClips),
        statusMessage: `[캡션 줄 구성 완료] '${modeLabel}' 설정으로 자막이 재구성되었습니다! (${beforeCount}개 → ${afterCount}개 클립)`,
      });
    },

    addTrack: (type) => {
      pushHistory();
      const { tracks, clips } = get();
      const sameTypeTracks = tracks.filter((t) => t.type === type);
      const nextNum = sameTypeTracks.length + 1;

      const prefix = type === 'video' ? 'V' : type === 'audio' ? 'A' : 'C';
      const labelPrefix = type === 'video' ? '비디오' : type === 'audio' ? '오디오' : '캡션 / 자막';
      const code = `${prefix}${nextNum}`;
      const newTrack: TimelineTrack = {
        id: `track-${prefix.toLowerCase()}${Date.now()}`,
        code,
        name: `${labelPrefix} ${nextNum}`,
        type,
        muted: false,
        solo: false,
        visible: true,
        locked: false,
      };

      const textTracks = tracks.filter((t) => t.type === 'text');
      const videoTracks = tracks.filter((t) => t.type === 'video');
      const audioTracks = tracks.filter((t) => t.type === 'audio');

      let nextTracks: TimelineTrack[] = [];
      if (type === 'text') {
        nextTracks = [newTrack, ...textTracks, ...videoTracks, ...audioTracks];
      } else if (type === 'video') {
        nextTracks = [...textTracks, newTrack, ...videoTracks, ...audioTracks];
      } else {
        nextTracks = [...textTracks, ...videoTracks, ...audioTracks, newTrack];
      }

      set({
        tracks: nextTracks,
        sequences: syncActiveSequenceData(nextTracks, clips),
        statusMessage: `${code} (${newTrack.name}) 트랙이 추가되었습니다.`,
      });
    },

    removeTrack: (trackId) => {
      const { tracks, clips } = get();
      const target = tracks.find((t) => t.id === trackId);
      if (!target) return;
      const sameTypeCount = tracks.filter((t) => t.type === target.type).length;
      if (sameTypeCount <= 1) {
        set({ statusMessage: `최소 1개의 ${target.type.toUpperCase()} 트랙은 유지되어야 합니다.` });
        return;
      }
      pushHistory();
      const nextTracks = tracks.filter((t) => t.id !== trackId);
      const nextClips = clips.filter((c) => c.trackId !== trackId);
      set({
        tracks: nextTracks,
        clips: nextClips,
        sequences: syncActiveSequenceData(nextTracks, nextClips),
        statusMessage: `${target.code} 트랙이 삭제되었습니다.`,
      });
    },

    toggleTrackMute: (trackId) =>
      set((state) => {
        const nextTracks = state.tracks.map((t) =>
          t.id === trackId ? { ...t, muted: !t.muted } : t
        );
        return {
          tracks: nextTracks,
          sequences: syncActiveSequenceData(nextTracks, state.clips),
        };
      }),

    toggleTrackSolo: (trackId) =>
      set((state) => {
        const nextTracks = state.tracks.map((t) =>
          t.id === trackId ? { ...t, solo: !t.solo } : t
        );
        return {
          tracks: nextTracks,
          sequences: syncActiveSequenceData(nextTracks, state.clips),
        };
      }),

    toggleTrackVisible: (trackId) =>
      set((state) => {
        const nextTracks = state.tracks.map((t) =>
          t.id === trackId ? { ...t, visible: !t.visible } : t
        );
        return {
          tracks: nextTracks,
          sequences: syncActiveSequenceData(nextTracks, state.clips),
        };
      }),

    toggleTrackLock: (trackId) =>
      set((state) => {
        const nextTracks = state.tracks.map((t) =>
          t.id === trackId ? { ...t, locked: !t.locked } : t
        );
        return {
          tracks: nextTracks,
          sequences: syncActiveSequenceData(nextTracks, state.clips),
        };
      }),

    addAssets: (newAssets) => {
      const created: MediaAsset[] = newAssets.map((a, idx) => ({
        ...a,
        hasAudio: a.hasAudio ?? true,
        id: `asset_${Date.now()}_${idx}`,
      }));
      set((state) => ({
        assets: [...state.assets, ...created],
      }));
      return created;
    },

    // 미디어를 타임라인으로 드래그 앤 드롭했을 때:
    // 1) 만약 현재 열려 있는 시퀀스가 없다면 -> 그 영상의 원본 사이즈/FPS로 새 시퀀스 아이템을 좌측 하단 프로젝트 패널에 자동 생성하고 진입!
    // 2) 만약 이미 내가 시퀀스를 만들어 열어둔 상태라면 -> 그 시퀀스 규격 안에 영상을 배치!
    addAssetToTimeline: (assetId, options = {}) => {
      const state = get();
      const asset = state.assets.find((a) => a.id === assetId);
      if (!asset) return;

      pushHistory();

      let currentTracks = state.tracks;
      let currentClips = state.clips;
      let currentSeqMeta = { ...state.sequence };
      let currentSeqs = [...state.sequences];
      let currentActiveSeqId = state.activeSequenceId;
      let currentOpenSeqIds = [...state.openSequenceIds];
      let autoCreatedSequence = false;

      // 열린 시퀀스가 아예 없는 상태에서 드래그한 경우 -> 원본 영상 규격에 맞춘 시퀀스를 프로젝트 패널에 자동 생성!
      if (!currentActiveSeqId) {
        const freshTracks = createDefaultTracks();
        const autoSeqName = asset.name.replace(/\.[^/.]+$/, '') || `시퀀스 0${currentSeqs.length + 1}`;
        const autoSeq: SequenceItem = {
          id: `seq_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: autoSeqName,
          width: asset.width || 1920,
          height: asset.height || 1080,
          fps: asset.fps || 30,
          fitMode: 'contain',
          isCustom: false,
          tracks: freshTracks,
          clips: [],
          currentTime: 0,
        };
        currentSeqs.push(autoSeq);
        currentActiveSeqId = autoSeq.id;
        currentOpenSeqIds = [...currentOpenSeqIds, autoSeq.id];
        currentTracks = freshTracks;
        currentClips = [];
        currentSeqMeta = {
          name: autoSeq.name,
          width: autoSeq.width,
          height: autoSeq.height,
          fps: autoSeq.fps,
          fitMode: autoSeq.fitMode,
          isCustom: false,
        };
        autoCreatedSequence = true;
      } else if (
        asset.type === 'video' &&
        !currentSeqMeta.isCustom &&
        currentClips.filter((c) => c.type === 'video').length === 0 &&
        asset.width &&
        asset.height
      ) {
        currentSeqMeta = {
          ...currentSeqMeta,
          width: asset.width,
          height: asset.height,
          fps: asset.fps || currentSeqMeta.fps,
        };
      }

      const videoTracks = currentTracks.filter((t) => t.type === 'video' && !t.locked);
      const audioTracks = currentTracks.filter((t) => t.type === 'audio' && !t.locked);

      if (asset.type === 'video') {
        let vTrack = currentTracks.find(
          (t) => t.id === options.targetTrackId && t.type === 'video' && !t.locked
        );
        if (!vTrack) {
          vTrack =
            videoTracks.find((t) => t.code === 'V1') ||
            videoTracks[videoTracks.length - 1] ||
            currentTracks[0];
        }

        const vNumber = vTrack.code.replace(/\D/g, '') || '1';
        let aTrack =
          audioTracks.find((t) => t.code === `A${vNumber}`) ||
          audioTracks.find((t) => t.code === 'A1') ||
          audioTracks[0];

        const droppedOnAudio = currentTracks.find(
          (t) => t.id === options.targetTrackId && t.type === 'audio' && !t.locked
        );
        if (droppedOnAudio) {
          aTrack = droppedOnAudio;
        }

        let startTime = options.startTime;
        if (startTime === undefined) {
          const existingOnV = currentClips.filter((c) => c.trackId === vTrack!.id);
          startTime =
            existingOnV.length > 0
              ? Math.max(...existingOnV.map((c) => c.startTime + c.duration))
              : 0;
        }
        const safeStart = Number(Math.max(0, startTime).toFixed(4));
        const safeDur = Number(asset.duration.toFixed(4));
        const hasAudioStream = asset.hasAudio !== false && Boolean(aTrack);
        const linkedGroupId = hasAudioStream
          ? `link_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
          : undefined;

        const newVideoClip: TimelineClip = {
          id: `clip_v_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          trackId: vTrack.id,
          type: 'video',
          name: `${asset.name} [V]`,
          startTime: safeStart,
          duration: safeDur,
          sourceStart: 0,
          sourcePath: asset.path,
          assetId: asset.id,
          linkedGroupId,
          volume: 1.0,
          muted: hasAudioStream,
        };

        const addedClips: TimelineClip[] = [newVideoClip];

        if (hasAudioStream && aTrack) {
          const newAudioClip: TimelineClip = {
            id: `clip_a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            trackId: aTrack.id,
            type: 'audio',
            name: `${asset.name} [A]`,
            startTime: safeStart,
            duration: safeDur,
            sourceStart: 0,
            sourcePath: asset.path,
            assetId: asset.id,
            linkedGroupId,
            volume: 1.0,
            muted: false,
          };
          addedClips.push(newAudioClip);
        }

        const rawNextClips = [...currentClips, ...addedClips];
        const { clips: nextClips, overwrittenCount } = overwriteOverlappingClips(
          rawNextClips,
          new Set(addedClips.map((c) => c.id))
        );
        const updatedSeqs = currentSeqs.map((s) =>
          s.id === currentActiveSeqId
            ? {
                ...s,
                width: currentSeqMeta.width,
                height: currentSeqMeta.height,
                fps: currentSeqMeta.fps,
                tracks: currentTracks,
                clips: nextClips,
              }
            : s
        );

        set({
          sequences: updatedSeqs,
          activeSequenceId: currentActiveSeqId,
          openSequenceIds: currentOpenSeqIds,
          sequence: currentSeqMeta,
          fps: currentSeqMeta.fps,
          tracks: currentTracks,
          clips: nextClips,
          selectedClipId: newVideoClip.id,
          statusMessage: autoCreatedSequence
            ? `원본 영상 규격(${currentSeqMeta.width}×${currentSeqMeta.height})에 맞춘 시퀀스 '${currentSeqMeta.name}'가 좌측 하단에 생성되었습니다!`
            : overwrittenCount > 0
            ? `'${asset.name}' 미디어가 배치되며 위치가 겹친 기존 클립 구간이 자동 삭제(덮어쓰기)되었습니다.`
            : `'${asset.name}' 미디어가 시퀀스 '${currentSeqMeta.name}' (${currentSeqMeta.width}×${currentSeqMeta.height}) 안에 배치되었습니다.`,
        });
      } else {
        let aTrack = currentTracks.find(
          (t) => t.id === options.targetTrackId && t.type === 'audio' && !t.locked
        );
        if (!aTrack) {
          aTrack =
            audioTracks.find((t) => t.code === 'A1') ||
            audioTracks[0] ||
            currentTracks[currentTracks.length - 1];
        }

        let startTime = options.startTime;
        if (startTime === undefined) {
          const existingOnA = currentClips.filter((c) => c.trackId === aTrack!.id);
          startTime =
            existingOnA.length > 0
              ? Math.max(...existingOnA.map((c) => c.startTime + c.duration))
              : 0;
        }

        const newAudioClip: TimelineClip = {
          id: `clip_a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          trackId: aTrack.id,
          type: 'audio',
          name: asset.name,
          startTime: Number(Math.max(0, startTime).toFixed(4)),
          duration: Number(asset.duration.toFixed(4)),
          sourceStart: 0,
          sourcePath: asset.path,
          assetId: asset.id,
          volume: 1.0,
          muted: false,
        };

        const rawNextClips = [...currentClips, newAudioClip];
        const { clips: nextClips, overwrittenCount } = overwriteOverlappingClips(
          rawNextClips,
          new Set([newAudioClip.id])
        );
        const updatedSeqs = currentSeqs.map((s) =>
          s.id === currentActiveSeqId
            ? { ...s, tracks: currentTracks, clips: nextClips }
            : s
        );

        set({
          sequences: updatedSeqs,
          activeSequenceId: currentActiveSeqId,
          openSequenceIds: currentOpenSeqIds,
          tracks: currentTracks,
          clips: nextClips,
          selectedClipId: newAudioClip.id,
          statusMessage:
            overwrittenCount > 0
              ? `'${asset.name}' 오디오가 ${aTrack.code} 트랙에 배치되며 겹친 기존 클립 구간이 자동 삭제(덮어쓰기)되었습니다.`
              : `'${asset.name}' 오디오가 ${aTrack.code} 트랙에 배치되었습니다.`,
        });
      }
    },

    addSubtitleClipAtCurrentTime: (defaultText = '자막을 입력하세요', targetTrackId, customTime) => {
      const { currentTime, clips, tracks } = get();
      pushHistory();

      const textTrack =
        tracks.find((t) => t.id === targetTrackId && t.type === 'text') ||
        tracks.find((t) => t.type === 'text') ||
        tracks[0];

      const placeTime = customTime !== undefined ? customTime : currentTime;

      const newClip: TimelineClip = {
        id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        trackId: textTrack.id,
        type: 'text',
        name: defaultText.slice(0, 14),
        startTime: Number(Math.max(0, placeTime).toFixed(4)),
        duration: 2.5,
        sourceStart: 0,
        volume: 1,
        muted: false,
        text: defaultText,
        fontSize: 40,
        fontColor: '#ffffff',
        backgroundColor: '#000000',
        backgroundOpacity: 0.65,
        strokeColor: '#000000',
        positionY: 86,
      };

      const rawNextClips = [...clips, newClip];
      const { clips: nextClips } = overwriteOverlappingClips(
        rawNextClips,
        new Set([newClip.id])
      );
      set({
        clips: nextClips,
        sequences: syncActiveSequenceData(tracks, nextClips),
        selectedClipId: newClip.id,
        statusMessage: `${textTrack.code} 트랙에 새 자막 클립이 추가되었습니다.`,
      });
    },

    updateClip: (clipId, patch, saveHistory = false) => {
      if (saveHistory) pushHistory();
      set((state) => {
        const target = state.clips.find((c) => c.id === clipId);
        const styleKeys: Array<keyof TimelineClip> = [
          'fontFamily',
          'fontSize',
          'fontWeight',
          'fontItalic',
          'letterSpacing',
          'fontColor',
          'fontOpacity',
          'strokeEnabled',
          'strokeColor',
          'strokeWidth',
          'strokeOpacity',
          'shadowEnabled',
          'shadowColor',
          'shadowOpacity',
          'shadowBlur',
          'shadowOffsetX',
          'shadowOffsetY',
          'opacity',
          'backgroundEnabled',
          'backgroundColor',
          'backgroundOpacity',
          'backgroundRadius',
          'backgroundPaddingX',
          'backgroundPaddingY',
          'positionX',
          'positionY',
        ];

        const sharedStylePatch: Partial<TimelineClip> = {};
        let hasStyleChange = false;
        if (state.autoSyncSubtitleStyle && target?.type === 'text') {
          for (const k of styleKeys) {
            if (k in patch) {
              (sharedStylePatch as any)[k] = patch[k];
              hasStyleChange = true;
            }
          }
        }

        const nextClips = state.clips.map((c) => {
          if (c.id === clipId) {
            return {
              ...c,
              ...patch,
              name:
                patch.text !== undefined
                  ? patch.text.slice(0, 18) || '자막'
                  : patch.name ?? c.name,
            };
          }
          if (hasStyleChange && c.type === 'text') {
            return {
              ...c,
              ...sharedStylePatch,
            };
          }
          return c;
        });

        return {
          clips: nextClips,
          sequences: syncActiveSequenceData(state.tracks, nextClips),
        };
      });
    },

    recordHistorySnapshot: () => {
      pushHistory();
    },

    moveOrTrimClipWithLink: (
      clipId,
      deltaStart,
      deltaDuration,
      deltaSourceStart,
      targetTrackId,
      snapped
    ) => {
      const { clips, tracks, linkedSelection } = get();
      const primary = clips.find((c) => c.id === clipId);
      if (!primary) return;

      const targetTrack = targetTrackId ? tracks.find((t) => t.id === targetTrackId) : null;
      const canChangeTrack =
        targetTrack && !targetTrack.locked && targetTrack.type === primary.type;

      const isLinkedActive = linkedSelection && Boolean(primary.linkedGroupId);

      const movedClips: TimelineClip[] = [];
      const restClips: TimelineClip[] = [];

      for (const c of clips) {
        const isSelf = c.id === clipId;
        const isLinkedPartner =
          isLinkedActive && c.id !== clipId && c.linkedGroupId === primary.linkedGroupId;

        if (!isSelf && !isLinkedPartner) {
          restClips.push(c);
          continue;
        }

        movedClips.push({
          ...c,
          trackId: isSelf && canChangeTrack ? targetTrack!.id : c.trackId,
          startTime: Number(Math.max(0, c.startTime + deltaStart).toFixed(4)),
          duration: Number(Math.max(0.05, c.duration + deltaDuration).toFixed(4)),
          sourceStart:
            c.type === 'text'
              ? 0
              : Number(Math.max(0, c.sourceStart + deltaSourceStart).toFixed(4)),
          snappedToClip: snapped ?? c.snappedToClip,
        });
      }

      // 드래그 중인 클립이 항상 배열 맨 뒤(가장 위 레이어)에 오도록 배치
      const nextClips = [...restClips, ...movedClips];

      set({
        clips: nextClips,
        sequences: syncActiveSequenceData(tracks, nextClips),
      });
    },

    // 다중 선택된 클립들 일괄 동시 이동 (상대적 시간 간격 유지)
    moveSelectedClips: (clipIds, deltaStart, primaryClipId, targetTrackId, snapped) => {
      const { clips, tracks, linkedSelection } = get();
      if (clipIds.length === 0) return;

      const idSet = new Set(clipIds);
      if (linkedSelection) {
        for (const c of clips) {
          if (idSet.has(c.id) && c.linkedGroupId) {
            for (const p of clips) {
              if (p.linkedGroupId === c.linkedGroupId) {
                idSet.add(p.id);
              }
            }
          }
        }
      }

      const primary = primaryClipId ? clips.find((c) => c.id === primaryClipId) : null;
      const targetTrack = targetTrackId ? tracks.find((t) => t.id === targetTrackId) : null;
      const canChangeTrack =
        primary && targetTrack && !targetTrack.locked && targetTrack.type === primary.type;

      const movedClips: TimelineClip[] = [];
      const restClips: TimelineClip[] = [];

      for (const c of clips) {
        if (!idSet.has(c.id)) {
          restClips.push(c);
          continue;
        }

        const isPrimary = c.id === primaryClipId;
        movedClips.push({
          ...c,
          trackId: isPrimary && canChangeTrack ? targetTrack!.id : c.trackId,
          startTime: Number(Math.max(0, c.startTime + deltaStart).toFixed(4)),
          snappedToClip: snapped ?? c.snappedToClip,
        });
      }

      const nextClips = [...restClips, ...movedClips];
      set({
        clips: nextClips,
        sequences: syncActiveSequenceData(tracks, nextClips),
      });
    },

    // 마우스 드래그/트림 완료 시(mouseUp) 새로 올라온 클립과 겹친 기존 클립을 즉시 삭제/덮어쓰기 처리
    commitClipOverlapOverwrite: (clipId) => {
      const { clips, tracks, linkedSelection } = get();
      const primary = clips.find((c) => c.id === clipId);
      if (!primary) return;

      const isLinkedActive = linkedSelection && Boolean(primary.linkedGroupId);
      const activeIds = new Set<string>([clipId]);
      if (isLinkedActive && primary.linkedGroupId) {
        for (const c of clips) {
          if (c.linkedGroupId === primary.linkedGroupId) {
            activeIds.add(c.id);
          }
        }
      }

      const { clips: nextClips, overwrittenCount } = overwriteOverlappingClips(clips, activeIds);
      if (overwrittenCount > 0) {
        set({
          clips: nextClips,
          sequences: syncActiveSequenceData(tracks, nextClips),
          statusMessage: `클립 위치가 겹쳐 기존에 있던 클립(구간) ${overwrittenCount}개가 새로 올라온 클립에 의해 삭제(덮어쓰기)되었습니다.`,
        });
      }
    },

    commitMultiClipsOverlapOverwrite: (clipIds) => {
      const { clips, tracks, linkedSelection } = get();
      if (clipIds.length === 0) return;

      const activeIds = new Set<string>(clipIds);
      if (linkedSelection) {
        for (const c of clips) {
          if (activeIds.has(c.id) && c.linkedGroupId) {
            for (const p of clips) {
              if (p.linkedGroupId === c.linkedGroupId) {
                activeIds.add(p.id);
              }
            }
          }
        }
      }

      const { clips: nextClips, overwrittenCount } = overwriteOverlappingClips(clips, activeIds);
      if (overwrittenCount > 0) {
        set({
          clips: nextClips,
          sequences: syncActiveSequenceData(tracks, nextClips),
          statusMessage: `클립 위치가 겹쳐 기존 클립(구간) ${overwrittenCount}개가 새로 이동된 클립들에 의해 덮어쓰기(삭제)되었습니다.`,
        });
      }
    },

    unlinkClip: (clipId) => {
      const targetId = clipId || get().selectedClipId;
      if (!targetId) return;
      const target = get().clips.find((c) => c.id === targetId);
      if (!target || !target.linkedGroupId) {
        set({ statusMessage: '선택한 클립은 연결된 비디오/오디오 쌍이 없습니다.' });
        return;
      }
      pushHistory();
      const groupId = target.linkedGroupId;
      set((state) => {
        const nextClips = state.clips.map((c) =>
          c.linkedGroupId === groupId ? { ...c, linkedGroupId: undefined } : c
        );
        return {
          clips: nextClips,
          sequences: syncActiveSequenceData(state.tracks, nextClips),
          statusMessage: '비디오(V)와 오디오(A) 클립의 연결이 해제되어 개별 편집이 가능합니다.',
        };
      });
    },

    deleteClip: (clipId) => {
      const { clips, tracks, selectedClipId, linkedSelection } = get();
      const targetId = clipId || selectedClipId;
      if (!targetId) return;
      const target = clips.find((c) => c.id === targetId);
      if (!target) return;

      pushHistory();
      const deleteGroup = linkedSelection && target.linkedGroupId ? target.linkedGroupId : null;
      const nextClips = clips.filter((c) =>
        deleteGroup ? c.linkedGroupId !== deleteGroup : c.id !== targetId
      );

      set({
        clips: nextClips,
        sequences: syncActiveSequenceData(tracks, nextClips),
        selectedClipId: null,
        statusMessage: deleteGroup
          ? '연결된 비디오(V) 및 오디오(A) 클립이 함께 삭제되었습니다.'
          : '클립이 삭제되었습니다.',
      });
    },

    splitClipAtPlayhead: () => {
      const { clips, tracks, currentTime, selectedClipId, linkedSelection } = get();

      const candidates = clips.filter(
        (c) => currentTime > c.startTime + 0.04 && currentTime < c.startTime + c.duration - 0.04
      );
      if (candidates.length === 0) {
        set({ statusMessage: '재생 헤드(파란 선)가 분할할 클립 내부에 위치해야 합니다.' });
        return;
      }

      let targets = candidates;
      if (selectedClipId && candidates.some((c) => c.id === selectedClipId)) {
        const sel = candidates.find((c) => c.id === selectedClipId)!;
        targets = candidates.filter(
          (c) =>
            c.id === sel.id ||
            (linkedSelection && sel.linkedGroupId && c.linkedGroupId === sel.linkedGroupId)
        );
      }

      pushHistory();

      const targetIds = new Set(targets.map((t) => t.id));
      const newGroupMap = new Map<string, string>();
      const nextClips: TimelineClip[] = [];

      for (const clip of clips) {
        if (!targetIds.has(clip.id)) {
          nextClips.push(clip);
          continue;
        }

        const firstDuration = Number((currentTime - clip.startTime).toFixed(4));
        const secondDuration = Number((clip.duration - firstDuration).toFixed(4));

        let secondGroupId = clip.linkedGroupId;
        if (clip.linkedGroupId) {
          if (!newGroupMap.has(clip.linkedGroupId)) {
            newGroupMap.set(
              clip.linkedGroupId,
              `link_split_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
            );
          }
          secondGroupId = newGroupMap.get(clip.linkedGroupId);
        }

        nextClips.push(
          { ...clip, duration: firstDuration },
          {
            ...clip,
            id: `${clip.id}_s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
            startTime: Number(currentTime.toFixed(4)),
            duration: secondDuration,
            sourceStart:
              clip.type === 'text' ? 0 : Number((clip.sourceStart + firstDuration).toFixed(4)),
            linkedGroupId: secondGroupId,
          }
        );
      }

      set({
        clips: nextClips,
        sequences: syncActiveSequenceData(tracks, nextClips),
        statusMessage: '재생 헤드 위치에서 클립이 분할되었습니다.',
      });
    },

    splitClipAtTime: (clipId, splitTime) => {
      const { clips, tracks, linkedSelection } = get();
      const target = clips.find((c) => c.id === clipId);
      if (!target) return;
      if (
        splitTime <= target.startTime + 0.04 ||
        splitTime >= target.startTime + target.duration - 0.04
      ) {
        return;
      }

      pushHistory();
      const splitPartners = clips.filter(
        (c) =>
          c.id === clipId ||
          (linkedSelection && target.linkedGroupId && c.linkedGroupId === target.linkedGroupId)
      );
      const partnerIds = new Set(splitPartners.map((p) => p.id));
      const newLinkGroupId = target.linkedGroupId
        ? `link_razor_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`
        : undefined;

      const nextClips: TimelineClip[] = [];
      for (const c of clips) {
        if (!partnerIds.has(c.id)) {
          nextClips.push(c);
          continue;
        }
        const firstDur = Number((splitTime - c.startTime).toFixed(4));
        const secondDur = Number((c.duration - firstDur).toFixed(4));
        if (firstDur <= 0.03 || secondDur <= 0.03) {
          nextClips.push(c);
          continue;
        }
        nextClips.push(
          { ...c, duration: firstDur },
          {
            ...c,
            id: `${c.id}_rz_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
            startTime: Number(splitTime.toFixed(4)),
            duration: secondDur,
            sourceStart: c.type === 'text' ? 0 : Number((c.sourceStart + firstDur).toFixed(4)),
            linkedGroupId: newLinkGroupId,
          }
        );
      }

      set({
        clips: nextClips,
        sequences: syncActiveSequenceData(tracks, nextClips),
        statusMessage: '면도칼(Razor) 도구로 클립을 분할했습니다.',
      });
    },

    rippleCloseGaps: () => {
      const { clips, tracks } = get();
      if (clips.length === 0) return;

      // 1. 잠기지 않은 모든 활성 트랙 대상
      const unlockedTrackIds = new Set(tracks.filter((t) => !t.locked).map((t) => t.id));
      const activeClips = clips.filter((c) => unlockedTrackIds.has(c.trackId));
      if (activeClips.length === 0) return;

      // 2. 모든 트랙의 점유 구간들을 합집합(Union) 처리하여
      // "어느 한 트랙이라도 영상이나 음성이 채워져 있는 구간"들을 찾음
      // (예: 오디오는 비어있어도 비디오가 차있다면 그 구간은 점유된 상태이므로 싱크가 보존됨)
      const sortedClips = [...activeClips].sort((a, b) => a.startTime - b.startTime);
      const occupiedIntervals: Array<{ start: number; end: number }> = [];

      for (const c of sortedClips) {
        const cStart = c.startTime;
        const cEnd = c.startTime + c.duration;
        if (occupiedIntervals.length === 0) {
          occupiedIntervals.push({ start: cStart, end: cEnd });
        } else {
          const last = occupiedIntervals[occupiedIntervals.length - 1];
          // 0.005초(약 0.15프레임) 이내로 맞닿아 있거나 겹치면 연속 구간으로 병합
          if (cStart <= last.end + 0.005) {
            last.end = Math.max(last.end, cEnd);
          } else {
            occupiedIntervals.push({ start: cStart, end: cEnd });
          }
        }
      }

      // 3. 점유 구간과 점유 구간 사이의 "모든 트랙이 100% 동시에 비어있는 순수 빈 간격(Universal Gap)"만 추출
      const gaps: Array<{ start: number; end: number; duration: number }> = [];
      const minGapThreshold = 0.04; // 1프레임 미만의 극미세 오차는 무시하고, 0.04초 이상 빈 공간만 닫음

      // 타임라인 시작 지점(0초 ~ 첫 클립 시작)에 0.04초 이상 빈 공간이 있는 경우 닫기 대상에 포함
      if (occupiedIntervals.length > 0 && occupiedIntervals[0].start > minGapThreshold) {
        gaps.push({
          start: 0,
          end: occupiedIntervals[0].start,
          duration: occupiedIntervals[0].start,
        });
      }

      // 점유 구간과 점유 구간 사이의 빈 간격들 수집
      for (let i = 0; i < occupiedIntervals.length - 1; i++) {
        const gapStart = occupiedIntervals[i].end;
        const gapEnd = occupiedIntervals[i + 1].start;
        const gapDur = gapEnd - gapStart;
        if (gapDur > minGapThreshold) {
          gaps.push({
            start: gapStart,
            end: gapEnd,
            duration: gapDur,
          });
        }
      }

      if (gaps.length === 0) {
        set({
          statusMessage: '닫을 수 있는 타임라인 전체 빈 공간(간격)이 없습니다. (모든 트랙이 이미 이어져 있습니다)',
        });
        return;
      }

      pushHistory();

      // 4. 각 빈 간격을 차례대로 닫으면서, 그 뒤에 위치하는 모든 클립들을 앞당김
      // (모든 트랙의 클립이 동일하게 이동하므로 비디오-오디오 싱크가 100% 완벽 보존됨)
      let totalClosedSec = 0;
      const updatedClips = clips.map((c) => {
        if (!unlockedTrackIds.has(c.trackId)) return c;

        let shift = 0;
        for (const g of gaps) {
          if (c.startTime >= g.end - 0.005) {
            shift += g.duration;
          }
        }

        return shift > 0
          ? {
              ...c,
              startTime: Number(Math.max(0, c.startTime - shift).toFixed(4)),
            }
          : c;
      });

      for (const g of gaps) {
        totalClosedSec += g.duration;
      }

      set({
        clips: updatedClips,
        sequences: syncActiveSequenceData(tracks, updatedClips),
        statusMessage: `${gaps.length}개의 타임라인 전체 빈 간격(총 ${totalClosedSec.toFixed(2)}초)을 닫았습니다. (오디오/비디오 싱크 완벽 보존)`,
      });
    },

    replaceClipWithSegments: (clipId, segments, rippleCompact) => {
      const { clips, tracks, linkedSelection } = get();
      const target = clips.find((c) => c.id === clipId);
      if (!target || segments.length === 0) return;

      pushHistory();

      const targets = clips.filter(
        (c) =>
          c.id === clipId ||
          (linkedSelection && target.linkedGroupId && c.linkedGroupId === target.linkedGroupId)
      );
      const targetIds = new Set(targets.map((t) => t.id));

      const generatedClips: TimelineClip[] = [];
      const segmentGroupIds = segments.map(
        (_, idx) => `link_cut_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 5)}`
      );

      for (const tClip of targets) {
        let timelineCursor = tClip.startTime;
        segments.forEach((seg, idx) => {
          const segDur = Math.max(0.08, seg.end - seg.start);
          const startT = rippleCompact ? timelineCursor : tClip.startTime + seg.start;
          timelineCursor = startT + segDur;

          generatedClips.push({
            ...tClip,
            id: `clip_cut_${tClip.type}_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 5)}`,
            name: `${tClip.name.replace(/\s*#\d+$/, '')} #${idx + 1}`,
            startTime: Number(startT.toFixed(4)),
            duration: Number(segDur.toFixed(4)),
            sourceStart: Number((tClip.sourceStart + seg.start).toFixed(4)),
            linkedGroupId: tClip.linkedGroupId ? segmentGroupIds[idx] : undefined,
          });
        });
      }

      const remainingClips = clips.filter((c) => !targetIds.has(c.id));
      const nextClips = [...remainingClips, ...generatedClips];
      set({
        clips: nextClips,
        sequences: syncActiveSequenceData(tracks, nextClips),
        selectedClipId: generatedClips[0]?.id || null,
        statusMessage: `무음 구간이 제거되어 영상(V) 및 음성(A) 클립이 ${segments.length}개의 유음 컷으로 동시에 분할되었습니다!`,
      });
    },

    applyAlignedSubtitles: (items, autoSnapToCuts) => {
      const { clips, tracks, snapThresholdFrames, fps } = get();
      if (items.length === 0) return;

      pushHistory();

      const textTrack = tracks.find((t) => t.type === 'text' && !t.locked) || tracks[0];
      const nonTextClips = clips.filter((c) => c.trackId !== textTrack.id);

      const newSubClips: TimelineClip[] = items.map((item, idx) => ({
        id: `sub_aligned_${Date.now()}_${idx}`,
        trackId: textTrack.id,
        type: 'text',
        name: item.scriptText.slice(0, 18),
        startTime: Number(item.startTime.toFixed(4)),
        duration: Number(Math.max(0.15, item.endTime - item.startTime).toFixed(4)),
        sourceStart: 0,
        volume: 1,
        muted: false,
        text: item.scriptText,
        originalSttText: item.sttText,
        fontSize: 40,
        fontColor: '#ffffff',
        backgroundColor: '#000000',
        backgroundOpacity: 0.65,
        strokeColor: '#000000',
        positionY: 86,
        snappedToClip: item.snappedStart || item.snappedEnd,
      }));

      let combinedClips = [...nonTextClips, ...newSubClips];
      let snapSummary: SnapResultSummary | null = null;

      if (autoSnapToCuts) {
        const res = snapSubtitleClipsToMediaCuts(combinedClips, {
          thresholdFrames: snapThresholdFrames,
          fps,
          closeMicroGaps: true,
          alignClipdominantSubtitles: true,
        });
        combinedClips = res.updatedClips;
        snapSummary = res.summary;
      }

      set({
        clips: combinedClips,
        sequences: syncActiveSequenceData(tracks, combinedClips),
        selectedClipId: newSubClips[0]?.id || null,
        lastSnapSummary: snapSummary,
        statusMessage: autoSnapToCuts
          ? `대본 기반 자막 ${newSubClips.length}개가 ${textTrack.code} 트랙에 생성되었으며, 클립 경계(±${snapThresholdFrames}프레임)에 자동 칼맞춤되었습니다!`
          : `대본 기반 자막 ${newSubClips.length}개가 ${textTrack.code} 트랙에 생성되었습니다.`,
      });
    },

    // [STEP 1] 선택된 오디오에서 AI가 인식한 초벌 캡션들을 타임라인 C1 트랙에 생성
    addRawAiCaptions: (segments) => {
      const {
        clips,
        tracks,
        fps,
        captionLineMode,
        captionMaxCharsPerLine,
        autoSplitOnCaptionGenerate,
      } = get();
      if (segments.length === 0) return;

      pushHistory();

      const textTrack = tracks.find((t) => t.type === 'text' && !t.locked) || tracks[0];
      const newSubClips: TimelineClip[] = segments.map((seg, idx) => ({
        id: `sub_ai_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 5)}`,
        trackId: textTrack.id,
        type: 'text',
        name: seg.text.slice(0, 18),
        startTime: Number(Math.max(0, seg.start).toFixed(4)),
        duration: Number(Math.max(0.2, seg.end - seg.start).toFixed(4)),
        sourceStart: 0,
        volume: 1,
        muted: false,
        text: seg.text,
        originalSttText: seg.text,
        fontSize: 40,
        fontColor: '#ffffff',
        backgroundColor: '#000000',
        backgroundOpacity: 0.65,
        strokeColor: '#000000',
        positionY: 86,
      }));

      // 해당 시간 구간과 겹치지 않는 기존 자막은 유지하거나 새로 추가
      const minStart = Math.min(...newSubClips.map((c) => c.startTime));
      const maxEnd = Math.max(...newSubClips.map((c) => c.startTime + c.duration));
      const keptClips = clips.filter(
        (c) =>
          c.trackId !== textTrack.id ||
          c.startTime + c.duration <= minStart + 0.05 ||
          c.startTime >= maxEnd - 0.05
      );

      let nextClips = [...keptClips, ...newSubClips];
      if (autoSplitOnCaptionGenerate) {
        nextClips = reformatSubtitleClipsByLineMode(nextClips, {
          mode: captionLineMode,
          maxCharsPerLine: captionMaxCharsPerLine,
          fps,
        }).updatedClips;
      }

      const finalTextCount = nextClips.filter((c) => c.type === 'text').length;
      set({
        clips: nextClips,
        sequences: syncActiveSequenceData(tracks, nextClips),
        selectedClipId: newSubClips[0]?.id || null,
        selectedClipIds: [newSubClips[0]?.id].filter(Boolean),
        statusMessage: `[STEP 1 완료] 선택된 오디오에서 AI 캡션 ${finalTextCount}개가 (${
          captionLineMode === 'single-line' ? '한 줄씩' : '두 줄 이내'
        } 기준) 생성되었습니다! 언제든 줄 구성을 다시 변경할 수 있습니다.`,
      });
    },

    // [STEP 2] 기존 AI 캡션들과 내 대본을 비교한 결과를 타임라인 캡션에 일괄 반영
    applyScriptCorrectionsToCaptions: (diffs) => {
      const {
        clips,
        tracks,
        fps,
        captionLineMode,
        captionMaxCharsPerLine,
        autoSplitOnCaptionGenerate,
      } = get();
      if (diffs.length === 0) return;

      pushHistory();
      const diffMap = new Map(diffs.map((d) => [d.clipId, d]));
      let changedCount = 0;

      let nextClips = clips.map((c) => {
        const match = diffMap.get(c.id);
        if (!match) return c;
        if (c.text !== match.afterText) changedCount++;
        return {
          ...c,
          text: match.afterText,
          name: match.afterText.slice(0, 18),
          originalSttText: c.originalSttText || match.beforeText,
        };
      });

      if (autoSplitOnCaptionGenerate) {
        nextClips = reformatSubtitleClipsByLineMode(nextClips, {
          mode: captionLineMode,
          maxCharsPerLine: captionMaxCharsPerLine,
          fps,
        }).updatedClips;
      }

      set({
        clips: nextClips,
        sequences: syncActiveSequenceData(tracks, nextClips),
        statusMessage: `[STEP 2 대본 오타 변환 완료] 총 ${diffs.length}개 캡션 중 ${changedCount}개의 오타/띄어쓰기가 내 대본 글자 그대로 변환되었습니다!`,
      });
    },

    snapAllSubtitlesToClips: (customThresholdFrames) => {
      const { clips, tracks, snapThresholdFrames, fps } = get();
      const threshold = customThresholdFrames ?? snapThresholdFrames;
      pushHistory();

      const { updatedClips, summary } = snapSubtitleClipsToMediaCuts(clips, {
        thresholdFrames: threshold,
        fps,
        closeMicroGaps: true,
        alignClipdominantSubtitles: true,
      });

      set({
        clips: updatedClips,
        sequences: syncActiveSequenceData(tracks, updatedClips),
        lastSnapSummary: summary,
        statusMessage:
          summary.snappedCount > 0 || summary.gapClosedCount > 0
            ? `[클립에 자막 맞추기 완료] 시작점 ${summary.snappedStartCount}개 · 끝점 ${summary.snappedEndCount}개 · 미세 틈새 ${summary.gapClosedCount}개가 ±${threshold}프레임 기준으로 칼같이 맞춰졌습니다!`
            : `±${threshold}프레임 범위 내에서 조정이 필요한 자막이 없거나 이미 모든 자막이 클립 경계에 정확히 맞춰져 있습니다.`,
      });

      return summary;
    },

    undo: () => {
      const { past, future, tracks, clips } = get();
      if (past.length === 0) return;
      const previous = past[past.length - 1];
      const currentSnapshot: HistorySnapshot = {
        tracks: JSON.parse(JSON.stringify(tracks)),
        clips: JSON.parse(JSON.stringify(clips)),
      };
      set({
        tracks: previous.tracks,
        clips: previous.clips,
        sequences: syncActiveSequenceData(previous.tracks, previous.clips),
        past: past.slice(0, -1),
        future: [currentSnapshot, ...future.slice(0, 29)],
        statusMessage: '실행 취소(Undo) 완료',
      });
    },

    redo: () => {
      const { past, future, tracks, clips } = get();
      if (future.length === 0) return;
      const next = future[0];
      const currentSnapshot: HistorySnapshot = {
        tracks: JSON.parse(JSON.stringify(tracks)),
        clips: JSON.parse(JSON.stringify(clips)),
      };
      set({
        tracks: next.tracks,
        clips: next.clips,
        sequences: syncActiveSequenceData(next.tracks, next.clips),
        past: [...past, currentSnapshot],
        future: future.slice(1),
        statusMessage: '다시 실행(Redo) 완료',
      });
    },

    getTotalDuration: () => {
      const { clips } = get();
      if (clips.length === 0) return 15;
      return Math.max(8, ...clips.map((c) => c.startTime + c.duration));
    },

    setIsDirty: (isDirty: boolean) => set({ isDirty }),

    getProjectExportData: (): ProjectFileData => {
      const {
        projectName,
        fps,
        sequence,
        sequences,
        activeSequenceId,
        openSequenceIds,
        tracks,
        clips,
        assets,
        currentTime,
        zoomPxPerSec,
        snapEnabled,
        linkedSelection,
        scriptText,
        captionLineMode,
        captionMaxCharsPerLine,
        autoSplitOnCaptionGenerate,
        isQuickSplitMergeMode,
        autoSyncSubtitleStyle,
        aiEngine,
        localWhisperModel,
      } = get();

      const currentSequences = syncActiveSequenceData(tracks, clips, sequence, currentTime);

      return {
        version: 1,
        savedAt: new Date().toISOString(),
        projectName,
        fps,
        sequence,
        sequences: currentSequences,
        activeSequenceId,
        openSequenceIds,
        tracks,
        clips,
        assets,
        currentTime,
        zoomPxPerSec,
        snapEnabled,
        linkedSelection,
        scriptText,
        captionLineMode,
        captionMaxCharsPerLine,
        autoSplitOnCaptionGenerate,
        isQuickSplitMergeMode,
        autoSyncSubtitleStyle,
        aiEngine,
        localWhisperModel,
      };
    },

    saveProject: async (saveAs = false) => {
      const state = get();
      let targetPath = state.projectFilePath;

      // 1. 다른 이름으로 저장(saveAs=true)이거나, 아직 파일 경로가 없는 첫 저장인 경우:
      // 무조건 '어디에 저장할지' 묻는 파일 탐색기 저장 대화상자를 띄웁니다.
      if (saveAs || !targetPath) {
        let chosenPath: string | null = null;
        const defaultName = `${state.projectName || '프로젝트'}.agproj`;

        if (window.electronAPI?.saveProjectDialog) {
          chosenPath = await window.electronAPI.saveProjectDialog(defaultName);
        } else if ('showSaveFilePicker' in window) {
          try {
            const handle = await (window as any).showSaveFilePicker({
              suggestedName: defaultName,
              types: [
                {
                  description: 'Antigravity Studio 프로젝트 (*.agproj)',
                  accept: { 'application/json': ['.agproj'] },
                },
              ],
            });
            if (handle) {
              const projectData = get().getProjectExportData();
              const writable = await handle.createWritable();
              await writable.write(JSON.stringify(projectData, null, 2));
              await writable.close();
              const baseName =
                handle.name?.replace(/\.(agproj|json)$/i, '') || state.projectName;
              set({
                projectFilePath: handle.name,
                projectName: baseName,
                isDirty: false,
                statusMessage: `프로젝트가 저장되었습니다: ${handle.name}`,
              });
              return true;
            }
          } catch (e: any) {
            if (e.name === 'AbortError') return false;
            console.warn('showSaveFilePicker fallback error:', e);
          }
        }

        // 사용자가 취소(Cancel)를 눌렀으면 저장 중단
        if (!chosenPath) {
          return false;
        }
        targetPath = chosenPath;
      }

      // 2. 이미 기존 파일 경로가 있거나 방금 경로를 지정받은 경우:
      // 기존 위치에 덮어쓰기 저장 (기존 파일이라면 해당 위치에 다시 저장)
      const projectData = get().getProjectExportData();
      const content = JSON.stringify(projectData, null, 2);

      if (window.electronAPI?.writeProjectFile) {
        const res = await window.electronAPI.writeProjectFile(targetPath, content);
        if (!res.success) {
          set({ statusMessage: `프로젝트 저장 실패: ${res.error}` });
          return false;
        }
      }

      const baseName =
        targetPath.split(/[/\\]/).pop()?.replace(/\.(agproj|json)$/i, '') || state.projectName;

      set({
        projectFilePath: targetPath,
        projectName: baseName,
        isDirty: false,
        statusMessage: `프로젝트가 저장되었습니다: ${baseName}.agproj`,
      });
      return true;
    },

    openProject: async () => {
      if (window.electronAPI?.openProjectDialog) {
        const res = await window.electronAPI.openProjectDialog();
        if (!res) return false;
        try {
          const data = JSON.parse(res.content);
          await get().loadProjectData(data, res.filePath);
          return true;
        } catch (err: any) {
          set({
            statusMessage: `프로젝트 열기 실패: 올바른 프로젝트 파일이 아닙니다. (${err.message})`,
          });
          return false;
        }
      } else {
        // 브라우저 환경 fallback: input[type="file"]
        return new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.agproj,.json';
          input.onchange = async (e: any) => {
            const file = e.target.files?.[0];
            if (!file) {
              resolve(false);
              return;
            }
            try {
              const text = await file.text();
              const data = JSON.parse(text);
              await get().loadProjectData(data, file.name);
              resolve(true);
            } catch (err: any) {
              set({ statusMessage: `프로젝트 열기 실패: ${err.message}` });
              resolve(false);
            }
          };
          input.click();
        });
      }
    },

    loadProjectData: async (data: any, filePath?: string) => {
      if (!data || typeof data !== 'object') {
        throw new Error('유효하지 않은 프로젝트 데이터입니다.');
      }

      // 1. 에셋 파일 유효성 검사 (로컬 디스크 상에 존재하는지 확인)
      const assets: MediaAsset[] = Array.isArray(data.assets) ? data.assets : [];
      let missingIds: string[] = [];
      if (window.electronAPI?.checkProjectAssets && assets.length > 0) {
        const paths = assets.map((a) => a.path).filter(Boolean);
        try {
          const check = await window.electronAPI.checkProjectAssets(paths);
          if (check.missing && check.missing.length > 0) {
            const missingPathSet = new Set(check.missing);
            missingIds = assets.filter((a) => missingPathSet.has(a.path)).map((a) => a.id);
          }
        } catch {
          // ignore
        }
      }

      const tracks: TimelineTrack[] =
        Array.isArray(data.tracks) && data.tracks.length > 0
          ? data.tracks
          : createDefaultTracks();
      const clips: TimelineClip[] = Array.isArray(data.clips) ? data.clips : [];

      const baseName = filePath
        ? filePath.split(/[/\\]/).pop()?.replace(/\.(agproj|json)$/i, '')
        : data.projectName;

      set({
        projectName: baseName || data.projectName || '불러온 프로젝트',
        projectFilePath: filePath || null,
        isDirty: false,
        fps: data.fps || 30,
        sequence: data.sequence || {
          name: '시퀀스 01',
          width: 1920,
          height: 1080,
          fps: 30,
          fitMode: 'contain',
          isCustom: false,
        },
        sequences: Array.isArray(data.sequences) ? data.sequences : [],
        activeSequenceId: data.activeSequenceId || null,
        openSequenceIds: Array.isArray(data.openSequenceIds) ? data.openSequenceIds : [],
        tracks,
        clips,
        assets,
        missingAssetIds: missingIds,
        isRelinkModalOpen: missingIds.length > 0,
        currentTime: typeof data.currentTime === 'number' ? data.currentTime : 0,
        isPlaying: false,
        zoomPxPerSec: data.zoomPxPerSec || 55,
        snapEnabled: data.snapEnabled !== false,
        linkedSelection: data.linkedSelection !== false,
        selectedClipId: null,
        selectedClipIds: [],
        selectedTrackId: null,
        selectedBinItem: null,
        scriptText: data.scriptText || '',
        captionLineMode: data.captionLineMode || 'preserve',
        captionMaxCharsPerLine: data.captionMaxCharsPerLine || 18,
        autoSplitOnCaptionGenerate: data.autoSplitOnCaptionGenerate ?? true,
        isQuickSplitMergeMode: data.isQuickSplitMergeMode ?? false,
        autoSyncSubtitleStyle: data.autoSyncSubtitleStyle ?? false,
        aiEngine: data.aiEngine || 'local',
        localWhisperModel: data.localWhisperModel || 'Xenova/whisper-small',
        past: [],
        future: [],
        statusMessage:
          missingIds.length > 0
            ? `주의: ${missingIds.length}개의 미디어 파일이 오프라인 상태입니다. 미디어 재연결 창을 확인하세요.`
            : `프로젝트를 성공적으로 불러왔습니다: ${baseName || data.projectName || ''}.agproj`,
      });
    },

    newProject: () => {
      set({
        projectName: '새 프로젝트',
        projectFilePath: null,
        isDirty: false,
        fps: 30,
        sequence: {
          name: '시퀀스 01',
          width: 1920,
          height: 1080,
          fps: 30,
          fitMode: 'contain',
          isCustom: false,
        },
        sequences: [],
        activeSequenceId: null,
        openSequenceIds: [],
        editingSequenceId: null,
        isSequenceModalOpen: false,
        assets: [],
        missingAssetIds: [],
        isRelinkModalOpen: false,
        tracks: createDefaultTracks(),
        clips: [],
        selectedClipId: null,
        selectedClipIds: [],
        selectedTrackId: null,
        selectedBinItem: null,
        currentTime: 0,
        isPlaying: false,
        past: [],
        future: [],
        scriptText: '',
        statusMessage: '새 프로젝트가 생성되었습니다.',
      });
    },

    setIsRelinkModalOpen: (open: boolean) => set({ isRelinkModalOpen: open }),

    relinkAsset: async (assetId: string, newPath: string) => {
      const { assets, clips, sequences } = get();
      const asset = assets.find((a) => a.id === assetId);
      if (!asset) return false;

      let probeInfo: any = null;
      if (window.electronAPI?.probeMedia) {
        try {
          probeInfo = await window.electronAPI.probeMedia(newPath);
        } catch (err) {
          console.warn('Probe relinked media failed:', err);
        }
      }

      const updatedAssets = assets.map((a) =>
        a.id === assetId
          ? {
              ...a,
              path: newPath,
              name: probeInfo?.name || newPath.split(/[/\\]/).pop() || a.name,
              duration: probeInfo?.duration || a.duration,
              width: probeInfo?.width || a.width,
              height: probeInfo?.height || a.height,
            }
          : a
      );

      // 타임라인 내 해당 에셋의 클립들 경로 업데이트
      const updatedClips = clips.map((c) =>
        c.assetId === assetId || c.sourcePath === asset.path
          ? { ...c, sourcePath: newPath, assetId }
          : c
      );

      // 전체 시퀀스 내 해당 에셋의 클립들 경로 업데이트
      const updatedSequences = sequences.map((seq) => ({
        ...seq,
        clips: seq.clips.map((c) =>
          c.assetId === assetId || c.sourcePath === asset.path
            ? { ...c, sourcePath: newPath, assetId }
            : c
        ),
      }));

      const nextMissing = get().missingAssetIds.filter((id) => id !== assetId);

      set({
        assets: updatedAssets,
        clips: updatedClips,
        sequences: updatedSequences,
        missingAssetIds: nextMissing,
        isRelinkModalOpen: nextMissing.length > 0,
        isDirty: true,
        statusMessage: `미디어 파일이 성공적으로 재연결되었습니다: ${asset.name}`,
      });
      return true;
    },

    relinkAssetsInBatch: async (relinkMap: Record<string, string>) => {
      let count = 0;
      for (const [assetId, newPath] of Object.entries(relinkMap)) {
        const ok = await get().relinkAsset(assetId, newPath);
        if (ok) count++;
      }
      return count;
    },
  };
});
