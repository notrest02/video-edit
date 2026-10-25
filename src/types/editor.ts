export type TrackType = 'video' | 'audio' | 'text';
export type EditorTool = 'select' | 'razor' | 'ripple' | 'text' | 'hand';

export interface SequenceSettings {
  name: string;
  width: number;
  height: number;
  fps: number;
  fitMode: 'contain' | 'cover'; // 'contain': 프레임에 맞추기(여백 유지), 'cover': 프레임 채우기
  isCustom: boolean;            // 사용자가 직접 시퀀스를 생성/설정했는지 여부
}

export interface SequenceItem {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  fitMode: 'contain' | 'cover';
  isCustom: boolean;
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  currentTime: number;
}

export interface MediaAsset {
  id: string;
  name: string;
  path: string;
  type: 'video' | 'audio';
  hasAudio?: boolean;
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
}

export interface TimelineTrack {
  id: string;
  code: string;          // 예: 'V3', 'V2', 'V1', 'A1', 'A2', 'A3', 'C1'
  name: string;
  type: TrackType;
  muted: boolean;        // 오디오 M (Mute)
  solo: boolean;         // 오디오 S (Solo)
  visible: boolean;      // 비디오/자막 👁️ (Eye toggle)
  locked: boolean;       // 트랙 잠금 🔒
}

export interface TimelineClip {
  id: string;
  trackId: string;
  type: TrackType;
  name: string;
  startTime: number;     // 타임라인 상에서의 시작 시간 (초)
  duration: number;      // 타임라인 상에서의 재생 길이 (초)
  sourceStart: number;   // 원본 미디어 내부 시작 오프셋 (초)
  sourcePath?: string;   // 로컬 원본 경로
  assetId?: string;      // 원본 MediaAsset ID
  linkedGroupId?: string;// 비디오(V)와 분리된 오디오(A)를 묶어주는 링크 ID
  volume: number;        // 0 ~ 2 (1 = 100%)
  muted: boolean;
  scale?: number;        // 비디오 클립 크기 비율 (기본 100%)

  // 자막/텍스트 클립 전용 속성
  text?: string;
  originalSttText?: string; // 대본 교체 전 AI STT 원문 (비교 확인용)
  sentenceGroupId?: string; // 한줄/두줄 재구성 시 원본 문장 그룹 식별용 ID

  // 기본 폰트 및 텍스트 모양
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: 'normal' | 'bold' | '900';
  fontItalic?: boolean;
  letterSpacing?: number;     // 자간 (px)
  fontColor?: string;
  fontOpacity?: number;       // 글자 자체 불투명도 (0 ~ 1)

  // 글자 외곽선 (Stroke)
  strokeEnabled?: boolean;
  strokeColor?: string;
  strokeWidth?: number;       // 외곽선 두께 (0 ~ 12px)
  strokeOpacity?: number;     // 외곽선 불투명도 (0 ~ 1)

  // 글자 그림자 (Shadow)
  shadowEnabled?: boolean;
  shadowColor?: string;
  shadowOpacity?: number;     // 그림자 불투명도 (0 ~ 1)
  shadowBlur?: number;        // 그림자 블러 퍼짐 (0 ~ 30px)
  shadowOffsetX?: number;     // 그림자 가로 오프셋 (-20 ~ 20px)
  shadowOffsetY?: number;     // 그림자 세로 오프셋 (-20 ~ 20px)

  // 배경 박스 및 전체 레이어 불투명도 / 위치
  opacity?: number;           // 자막 클립 전체 불투명도 (0 ~ 1)
  backgroundEnabled?: boolean;
  backgroundColor?: string;
  backgroundOpacity?: number; // 배경 불투명도 (0 ~ 1)
  backgroundRadius?: number;  // 배경 모서리 둥글기 (0 ~ 24px)
  backgroundPaddingX?: number;// 배경 좌우 패딩 (px)
  backgroundPaddingY?: number;// 배경 상하 패딩 (px)
  positionX?: number;         // 수평 위치 5 ~ 95 (%)
  positionY?: number;         // 수직 위치 5 ~ 95 (%)
  snappedToClip?: boolean;    // 클립 경계에 스냅되었는지 표시
}

export interface WordTimestamp {
  text: string;
  start: number; // 타임라인 절대 시간 (초)
  end: number;   // 타임라인 절대 시간 (초)
}

export interface AlignedSubtitleItem {
  id: string;
  scriptText: string;      // 최종 적용될 자막 텍스트 (대본 글자 그대로)
  sttText: string;         // AI가 인식했던 초벌 텍스트 (비교용)
  startTime: number;       // 타임라인 시작 시간 (초)
  endTime: number;         // 타임라인 종료 시간 (초)
  confidence: number;      // 매칭 유사도 (0 ~ 1)
  snappedStart?: boolean;
  snappedEnd?: boolean;
}

export interface SnapResultSummary {
  snappedCount: number;
  snappedStartCount: number;
  snappedEndCount: number;
  gapClosedCount: number;
  thresholdFrames: number;
  fps: number;
}

export interface SystemFontItem {
  label: string;
  value: string;
  familyKo: string;
  familyEn: string;
}

export interface ProjectFileData {
  version: number;
  savedAt: string;
  projectName: string;
  fps: number;
  sequence: SequenceSettings;
  sequences: SequenceItem[];
  activeSequenceId: string | null;
  openSequenceIds: string[];
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  assets: MediaAsset[];
  currentTime?: number;
  zoomPxPerSec?: number;
  snapEnabled?: boolean;
  linkedSelection?: boolean;
  scriptText?: string;
  captionLineMode?: string;
  captionMaxCharsPerLine?: number;
  autoSplitOnCaptionGenerate?: boolean;
  isQuickSplitMergeMode?: boolean;
  autoSyncSubtitleStyle?: boolean;
  aiEngine?: 'local' | 'openai';
  localWhisperModel?: string;
}

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<
      Array<{
        family: string;
        fullName: string;
        postscriptName: string;
        style: string;
      }>
    >;
    electronAPI?: {
      openMediaDialog: () => Promise<Array<Omit<MediaAsset, 'id'>>>;
      openScriptFileDialog: () => Promise<{ name: string; content: string } | null>;
      getSystemFonts: (forceRefresh?: boolean) => Promise<SystemFontItem[]>;
      openFontFileDialog: () => Promise<{
        familyName: string;
        dataBase64: string;
        ext: string;
      } | null>;
      probeMedia: (filePath: string) => Promise<Omit<MediaAsset, 'id'>>;
      detectSilence: (params: {
        filePath: string;
        sourceStart: number;
        duration: number;
        noiseDb: number;
        minSilenceDuration: number;
        paddingMs: number;
      }) => Promise<{
        silences: Array<{ start: number; end: number }>;
        speechSegments: Array<{ start: number; end: number }>;
      }>;
      extractAudioFloat32: (params: {
        filePath: string;
        sourceStart: number;
        duration: number;
      }) => Promise<Float32Array>;
      getWaveformPeaks: (params: {
        filePath: string;
        samplesPerSec?: number;
      }) => Promise<{
        peaks: number[];
        rms: number[];
        samplesPerSec: number;
      }>;
      transcribeOpenAI: (params: {
        filePath: string;
        sourceStart: number;
        duration: number;
        apiKey: string;
        language?: string;
        scriptHint?: string;
      }) => Promise<{
        text: string;
        words?: Array<{ word: string; start: number; end: number }>;
        segments?: Array<{ text: string; start: number; end: number }>;
      }>;
      createSampleVideo: () => Promise<Omit<MediaAsset, 'id'>>;
      exportVideo: (payload: unknown) => Promise<{ canceled: boolean; outputPath?: string }>;
      onExportProgress: (callback: (progress: number) => void) => () => void;
      saveProjectDialog: (defaultFileName?: string) => Promise<string | null>;
      writeProjectFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>;
      openProjectDialog: () => Promise<{ filePath: string; content: string } | null>;
      checkProjectAssets?: (filePaths: string[]) => Promise<{ missing: string[] }>;
      locateMediaDialog?: (targetFileName?: string) => Promise<string | null>;
      scanFolderForMatches?: (
        folderPath: string,
        fileNames: string[]
      ) => Promise<Record<string, string>>;
    };
  }
}
