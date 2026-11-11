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
  inPoint?: number | null;  // 시퀀스 인 지점 (초)
  outPoint?: number | null; // 시퀀스 아웃 지점 (초)
  /** 대본의 후킹 지정 ("3초: 2번 0~3초" → 첫 3초를 2번 영상 0~3초로). AI 자동 배치에 미리 채움 */
  autoEditHook?: { sec: number; fileNo: number; from: number; to: number; note: string; path?: string } | null;
  /** 한 시퀀스에 광고 여러 개를 이어 만들 때의 광고 구간 (없으면 시퀀스 전체 = 광고 1개) */
  adSegments?: AdSegment[];
  /** STEP 0 대본 만들기로 생긴 시퀀스: 그 버전 대본 (후킹 줄 포함). 시퀀스를 열면 STEP 2 대본 칸에 들어감 */
  script?: string;
}

/** 광고 구간: 한 시퀀스 안의 광고 하나 (오타 변환이 찾은 대본 버전 구간, 손으로 옮길 수 있음) */
export type AdSegment = {
  id: string;
  name: string; // 내보낼 파일 이름 (예: 자동차햇빛차단_01)
  start: number; // 타임라인 초
  end: number;
  hook: { sec: number; fileNo: number; from: number; to: number; note: string; /** 영상 파일 경로 (있으면 번호 대신 이걸로 찾음) */ path?: string } | null;
};

/**
 * 자동 편집 계획 (format 'auto-edit-plan/v1'): 음성 기준 타임라인 위에 원본 영상 구간을 어디에 놓을지.
 * 지금은 tools/premiere/slot_plan.py 가 만들고, 이후 앱 안 API 자동 배치가 같은 형식을 만든다.
 */
/** Typecast 구독·크레딧 (electron/typecastService.ts 와 같은 모양) */
export type TypecastSubscription = { plan: string; planCredits: number; usedCredits: number; remaining: number; concurrency: number };
/** Typecast 목소리 (electron/typecastService.ts 와 같은 모양) */
export type TypecastVoice = {
  id: string;
  name: string;
  nameEng: string;
  gender: string | null;
  age: string | null;
  useCases: string[];
  emotions: string[];
  previewUrl: string | null;
  isKorean?: boolean;
};

/** ElevenLabs 구독·크레딧 (electron/elevenlabsService.ts 와 같은 모양) */
export type ElevenSubscription = { plan: string; planCredits: number; usedCredits: number; remaining: number };
/** ElevenLabs 목소리 (electron/elevenlabsService.ts 와 같은 모양) */
export type ElevenVoice = {
  id: string;
  name: string;
  category: string;
  gender: string | null;
  age: string | null;
  useCase: string | null;
  accent: string | null;
  previewUrl: string | null;
  isKorean?: boolean;
  requiresPaid?: boolean;
};

/** STEP 0 대본 만들기 요청 (electron/scriptGenerator.ts ScriptGenParams 와 같은 모양) */
export type ScriptGenRequest = {
  product: string;
  facts: string;
  sellingPoints: string[];
  mustInclude: string[];
  tone: '' | '존댓말' | '반말';
  mode: 'auto' | 'distribute' | 'story' | 'samebody';
  space: string;
  target: string;
  seconds: number;
  versions: Array<{ hookType: string; story: string; focus: string; points: number[] }>;
  media: Array<{ no: number; path: string; duration: number; name: string }>;
  examplePaths: string[];
};

/** 내보낸 영상 컷 검사 결과 (electron/exportChecker.ts) */
export type ExportCheckResult = {
  frames: number;
  fps: number;
  cuts: number;
  problems: Array<{ kind: '짧은 장면' | '마스크 풀림' | '번쩍임'; frame: number; time: number; msg: string; image?: string }>;
};

export type AutoEditShot ={ id: string; file: string; path: string; start: number; end: number; dur: number; /** 샷 안 약한 화면 전환 의심 시각(원본 초) */ soft?: number[] };
type AutoEditShotView = { subject?: string; talk?: boolean; stage?: string };
export type AutoEditShotDesc = AutoEditShotView & {
  id: string;
  desc: string;
  place: string;
  motion: 'high' | 'low';
  parts: Array<AutoEditShotView & { from: number; to: number; desc: string }>;
  note: string;
  mood?: string;
  framing?: string;
  key?: number;
  group?: string;
  firstFrame?: string;
  issues?: string;
};
export type AutoEditSlot = {
  slot: number; start: number; end: number; dur: number; text: string; hook: boolean; captionStart: number;
  /** 이 컷이 들어 있는 문장 전체 (AI가 문장 뜻을 보고 고르게) */
  sentence?: string;
  /** 앞 컷과 같은 문장이 이어짐 (문장 중간에서 시작) */
  cont?: boolean;
  /** 다음 컷 대사 (장소 말이 다음에 나오는지 보려고) */
  next?: string;
  /** 대본을 쓸 때 이 문장의 근거로 본 장면 id (지금 미디어 기준). 있으면 1순위 후보 */
  basis?: string[];
};

export interface AutoEditPlan {
  format: 'auto-edit-plan/v1';
  sequence?: string;
  duration: number;
  /** 계획 시각의 기준 음성 (없으면 이미 타임라인에 있는 음성을 기준으로 만든 계획) */
  voice?: { path: string; start: number };
  clips: Array<{
    path: string;
    file?: string;
    start: number; // 타임라인 시작 (초)
    end: number; // 타임라인 끝 (초)
    srcIn: number; // 원본 시작 (초)
    speed: number; // 재생 속도 (원본 사용 길이 = (end - start) × speed)
    shot?: string | null;
    text?: string;
    hook?: boolean;
  }>;
}

/** 마스크 꼭짓점 (출력 화면 기준 0~1) */
export type MaskPoint = [number, number];
/** 블러 마스크: 네 꼭짓점 사각형, 블러 강도(출력 px), 가장자리 부드럽게(px), 키프레임(클립 안 시각 → 꼭짓점) */
export type BlurMask = {
  id: string;
  points: MaskPoint[];
  blur: number;
  feather: number;
  /** 블러 범위: 가장자리를 바깥(+)/안쪽(-)으로 옮기는 거리 (출력 px). 손잡이(꼭짓점)는 그대로 */
  expand?: number;
  keyframes?: Array<{ t: number; points: MaskPoint[]; ease?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold' }>;
  /** 보이는 구간 (클립 안 초). 없으면 클립 전체 — 장면마다 바뀌는 자막 가리기 */
  from?: number;
  to?: number;
  /** 자동 마스크로 만든 것 (찾은 글자 덩어리 id). 다시 적용하면 바뀜 */
  auto?: string;
};

/** 자동 마스크: 원본에서 찾은 글자 덩어리 (원본 좌표 0~1, 원본 초) */
export type AutoTextTrack = {
  id: string;
  text: string;
  conf: number;
  hasHan: boolean;
  start: number;
  end: number;
  samples: Array<{ t: number; box: [number, number, number, number] }>;
};

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
  height?: number;       // 트랙별 높이(px) - 없으면 기본값(오디오 84 / 그 외 44)
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
  speed?: number;        // 재생 속도 (1 = 100%). 타임라인 길이 = 원본 사용 길이 ÷ 속도
  blurMasks?: BlurMask[]; // 영상 클립: 원본에 박힌 글자 등을 흐리게 가리는 마스크
  posX?: number;         // 모션: 위치 X (출력 화면 px, 0 = 가운데)
  posY?: number;         // 모션: 위치 Y
  rotation?: number;     // 모션: 회전 (도) — 영상/자막 공통
  textScale?: number;    // 자막 모션: 크기 (%)
  /** 키프레임: 속성 이름(posX/posY/scale/rotation/opacity …) → [{t: 클립 안 초, v, ease}] */
  keyframes?: Record<string, Array<{ t: number; v: number; ease?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold' }>>;

  // 자막/텍스트 클립 전용 속성
  text?: string;
  originalSttText?: string; // 대본 교체 전 AI STT 원문 (비교 확인용)
  sentenceGroupId?: string; // 한줄/두줄 재구성 시 원본 문장 그룹 식별용 ID
  voiceEndTime?: number;    // 무음 연장 전 실제 음성 발화가 끝나는 타임라인 절대 시간 (초)
  /** 자막을 영상 컷에 맞추느라 시작을 앞(+)으로 당긴 양(초). 실제 목소리 시작 = startTime + snapLead.
   *  자동 배치는 이 값으로 목소리 시작을 기준 삼아 컷 자리를 계산 → 몇 번을 돌려도 컷·자막이 밀리지 않음 (2026-11-08) */
  snapLead?: number;

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
  /** 세로 기준점: positionY 가 자막 상자의 위쪽 끝/가운데/아래쪽 끝 (기본 가운데). 위쪽이면 두 줄이 아래로, 아래쪽이면 위로 늘어남 */
  anchorY?: 'top' | 'center' | 'bottom';
  snappedToClip?: boolean;    // 클립 경계에 스냅되었는지 표시
  needsReview?: boolean;      // 대본+파형 정렬기가 확신하지 못한 자막 (타임라인에 검토 표시)
  alignConfidence?: number;   // 0~1, 해당 구간 Whisper 텍스트와 대본 일치도
}

export interface WordTimestamp {
  text: string;
  start: number; // 타임라인 절대 시간 (초)
  end: number;   // 타임라인 절대 시간 (초)
  voiceEnd?: number; // 무음 연장 전 실제 음성 발화가 끝나는 타임라인 절대 시간 (초)
  sentenceGroupId?: string;
  needsReview?: boolean;
  alignConfidence?: number;
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

export type AlignModelStatus =
  | { state: 'ready' }
  | { state: 'missing' }
  | { state: 'downloading'; attempt: number; maxAttempts: number; file: string; received: number; total: number }
  | { state: 'verifying'; file: string }
  | { state: 'failed'; message: string };

/** 대본 문장 하나 + 그 문장을 쓸 때 본 원본 장면들 (경로 + 원본 초) */
export type ScriptBasisEntry = { text: string; scenes: Array<{ path: string; from: number; to: number }> };

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
  /** 대본 만들기(STEP 0)가 저장한 문장별 근거 장면 — 자동 배치가 1순위로 씀 */
  scriptBasis?: ScriptBasisEntry[];
  captionLineMode?: string;
  captionMaxCharsPerLine?: number;
  autoSplitOnCaptionGenerate?: boolean;
  isQuickSplitMergeMode?: boolean;
  autoSyncSubtitleStyle?: boolean;
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
      getPathForFile?: (file: File) => string;
      setDirtyState?: (dirty: boolean) => void;
      onRequestSaveBeforeClose?: (callback: () => void) => () => void;
      reportSaveBeforeClose?: (saved: boolean) => void;
      openMediaDialog: () => Promise<Array<Omit<MediaAsset, 'id'>>>;
      openScriptFileDialog: () => Promise<{ name: string; content: string } | null>;
      openAutoEditPlanDialog?: () => Promise<{ name: string; content: string } | null>;
      openMediaFolderDialog?: () => Promise<{ dir: string; folderName: string; files: string[] } | null>;
      claudeKeyStatus?: () => Promise<{ hasKey: boolean }>;
      claudeSaveKey?: (key: string) => Promise<{ ok: boolean; message: string }>;
      claudeTestKey?: () => Promise<{ ok: boolean; message: string }>;
      claudeClearKey?: () => Promise<{ hasKey: boolean }>;
      autoEditAnalyze?: (params: {
        media: Array<{ path: string; duration: number }>;
        product: string;
      }) => Promise<{ shots: AutoEditShot[]; descs: AutoEditShotDesc[]; usage: { input: number; output: number }; analyzedFiles: number }>;
      autoEditAssign?: (params: {
        product: string;
        shots: AutoEditShot[];
        descs: AutoEditShotDesc[];
        slots: AutoEditSlot[];
        hookUsed: Array<{ shot: string; from: number; to: number }>;
        usedElsewhere: Array<{ shot: string; from: number; to: number }>;
      }) => Promise<{ assign: Array<{ slot: number; shot: string; in: number; alt?: string; focus?: string; fit?: string; why: string }>; usage: { input: number; output: number } }>;
      onAutoEditProgress?: (callback: (msg: string) => void) => () => void;
      /** STEP 0 대본 만들기 (Claude Haiku: 생성 + 검수) */
      scriptGenGenerate?: (params: ScriptGenRequest) => Promise<{
        versions: Array<{ hookType: string; angle: string; hookSpec: string; lines: string[]; warnings: string[]; basis?: Array<Array<{ path: string; from: number; to: number }>> }>;
        fixes: Array<{ version: number; before: string; after: string; reason: string }>;
        usage: { input: number; output: number };
        exampleCount: number;
        mode: 'distribute' | 'story' | 'samebody';
        shots: Array<{ no: number; start: number; end: number }>;
      }>;
      /** 클라이언트 오더 글 → 제품·소구점·꼭 넣을 문장·말투·버전 방식 */
      scriptGenParseOrder?: (order: string) => Promise<{
        product: string;
        facts: string;
        sellingPoints: string[];
        target: string;
        mustInclude: string[];
        tone: '' | '존댓말' | '반말';
        mode: 'distribute' | 'story' | 'samebody';
        modeReason: string;
        versionCount: number;
        seconds: number;
        notes: string;
        usage: { input: number; output: number };
      }>;
      /** 버전 기획표: 버전마다 후킹 유형·콘셉트·중심 장점·맡을 소구점 */
      scriptGenPlan?: (params: Omit<ScriptGenRequest, 'seconds' | 'media' | 'examplePaths'>) => Promise<{
        mode: 'distribute' | 'story' | 'samebody';
        versions: Array<{ hookType: string; story: string; focus: string; points: number[] }>;
        usage: { input: number; output: number };
      }>;
      openOrderFileDialog?: () => Promise<{ name: string; text: string } | null>;
      /** Typecast 음성 (키는 메인 프로세스에만) */
      typecastKeyStatus?: () => Promise<{ hasKey: boolean }>;
      typecastSaveKey?: (key: string) => Promise<{ ok: boolean; message: string; sub?: TypecastSubscription }>;
      typecastClearKey?: () => Promise<{ hasKey: boolean }>;
      typecastSubscription?: () => Promise<TypecastSubscription>;
      typecastVoices?: (filter: { gender?: string; age?: string }) => Promise<TypecastVoice[]>;
      /** 바로 듣기: 미리듣기 샘플에 속도·음높이를 대략 적용한 소리 (data URL) */
      typecastPreview?: (p: { url: string; tempo: number; pitch: number }) => Promise<string>;
      typecastSynthesize?: (params: {
        folder: string;
        items: Array<{ name: string; text: string; voiceId: string; emotion: string; intensity: number; tempo: number; pitch: number }>;
        removeSilenceMs: number | null;
        format: 'mp3' | 'wav';
      }) => Promise<
        Array<{
          name: string;
          ok: boolean;
          error?: string;
          audioPath?: string;
          timestampsPath?: string;
          duration?: number;
          credits?: number;
          asset: Omit<MediaAsset, 'id'> | null;
          words?: Array<{ text: string; start: number; end: number }>;
        }>
      >;
      onTypecastProgress?: (callback: (msg: string) => void) => () => void;
      /** ElevenLabs 음성 (키는 메인 프로세스에만) */
      elevenKeyStatus?: () => Promise<{ hasKey: boolean }>;
      elevenSaveKey?: (key: string) => Promise<{ ok: boolean; message: string; sub?: ElevenSubscription }>;
      elevenClearKey?: () => Promise<{ hasKey: boolean }>;
      elevenSubscription?: () => Promise<ElevenSubscription>;
      elevenVoices?: (filter: { gender?: string; age?: string; koreanOnly?: boolean }) => Promise<ElevenVoice[]>;
      elevenSynthesize?: (params: {
        folder: string;
        items: Array<{
          name: string;
          text: string;
          voiceId: string;
          modelId: string;
          stability: number;
          similarityBoost: number;
          style: number;
          speed: number;
          pitch: number;
        }>;
        removeSilenceMs: number | null;
        format: 'mp3' | 'wav';
      }) => Promise<
        Array<{
          name: string;
          ok: boolean;
          error?: string;
          audioPath?: string;
          timestampsPath?: string;
          duration?: number;
          credits?: number;
          asset: Omit<MediaAsset, 'id'> | null;
          words?: Array<{ text: string; start: number; end: number }>;
        }>
      >;
      fileExists?: (p: string) => Promise<boolean>;
      /** 오더가 없을 때: 영상 장면과 파일 이름을 보고 제품 이름·사실·소구점 후보 */
      scriptGenFromVideos?: (params: {
        product: string;
        media: Array<{ no: number; path: string; duration: number; name: string }>;
      }) => Promise<{ product: string; facts: string; sellingPoints: string[]; target: string; notes: string; usage: { input: number; output: number } }>;
      scriptGenSaveTxt?: (params: { defaultName: string; content: string }) => Promise<string | null>;
      openScriptExamplesDialog?: () => Promise<string[]>;
      onScriptGenProgress?: (callback: (msg: string) => void) => () => void;
      textMaskCancel?: () => Promise<void>;
      textMaskAnalyze?: (params: { path: string; width: number; height: number }) => Promise<{ tracks: AutoTextTrack[]; cached: boolean }>;
      onTextMaskProgress?: (callback: (msg: string) => void) => () => void;
      getSystemFonts: (forceRefresh?: boolean) => Promise<SystemFontItem[]>;
      openFontFileDialog: () => Promise<{
        familyName: string;
        dataBase64: string;
        ext: string;
      } | null>;
      probeMedia: (filePath: string) => Promise<Omit<MediaAsset, 'id'>>;
      modelGetStatus?: () => Promise<AlignModelStatus>;
      modelEnsure?: () => Promise<AlignModelStatus>;
      modelImportDialog?: () => Promise<{ ok: boolean; message: string; status?: AlignModelStatus }>;
      onModelStatus?: (callback: (status: AlignModelStatus) => void) => () => void;
      /** 음성 클립(key)의 [start,end] 구간들에 단어를 강제 정렬 → 구간별 단어 [시작, 끝] 초 (클립 기준) */
      alignWordSpans?: (params: {
        key: string;
        pcm: Float32Array;
        ranges: Array<{ start: number; end: number; words: string[] }>;
      }) => Promise<{ available: boolean; results: Array<Array<[number, number] | null> | null> }>;
      gdiCheckFonts?: (families: string[]) => Promise<boolean[]>;
      gdiGlyphs?: (params: { family: string; style: number; chars: string }) => Promise<{
        asc: number;
        desc: number;
        synthBold: boolean;
        glyphs: Array<{ cp: number; adv: number; d: string }>;
      } | null>;
      ensurePreviewProxy?: (filePath: string) => Promise<string | null>;
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
      readVoiceTimestamps?: (audioPath: string) => Promise<{
        found: boolean;
        text: string;
        duration: number;
        words: Array<{ text: string; start: number; end: number }>;
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
      createSampleVideo: () => Promise<Omit<MediaAsset, 'id'>>;
      exportVideo: (payload: unknown) => Promise<{ canceled: boolean; outputPath?: string; check?: ExportCheckResult }>;
      chooseFolderDialog?: (title?: string) => Promise<string | null>;
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
