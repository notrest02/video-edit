import React, { useState } from 'react';
import {
  Subtitles,
  Magnet,
  Scissors,
  Upload,
  Loader2,
  Sparkles,
  FileText,
  CheckCircle2,
  Cpu,
  KeyRound,
  Mic,
  ArrowRight,
  RefreshCw,
} from 'lucide-react';
import { useEditorStore } from '../store/useEditorStore';
import {
  CaptionDiffItem,
  CaptionLineMode,
  compareAndCorrectCaptionsWithScript,
  splitSentenceIntoNaturalChunks,
} from '../utils/scriptAligner';
import { transcribeWithLocalWhisper } from '../utils/localWhisper';
import { WordTimestamp } from '../types/editor';
import { formatFullTimecode } from '../utils/subtitleSnapper';

export const LeftSidebar: React.FC = () => {
  const [subTab, setSubTab] = useState<'step1-ai' | 'step2-script' | 'step3-manage'>('step1-ai');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [progressText, setProgressText] = useState<string>('');
  const [diffReport, setDiffReport] = useState<CaptionDiffItem[]>([]);
  const [followMonitor, setFollowMonitor] = useState<boolean>(true);

  // Silence detection parameters
  const [noiseDb, setNoiseDb] = useState<number>(-32);
  const [minSilenceDur, setMinSilenceDur] = useState<number>(0.4);
  const [paddingMs, setPaddingMs] = useState<number>(70);
  const [rippleAfterSilence, setRippleAfterSilence] = useState<boolean>(true);

  const {
    clips,
    fps,
    currentTime,
    selectedClipId,
    selectedClipIds,
    aiEngine,
    localWhisperModel,
    openAiApiKey,
    scriptText,
    snapThresholdFrames,
    captionLineMode,
    captionMaxCharsPerLine,
    autoSplitOnCaptionGenerate,
    isQuickSplitMergeMode,
    setCurrentTime,
    setSelectedClipId,
    setAiEngine,
    setLocalWhisperModel,
    setOpenAiApiKey,
    setScriptText,
    setSnapThresholdFrames,
    setCaptionLineMode,
    setCaptionMaxCharsPerLine,
    setAutoSplitOnCaptionGenerate,
    setIsQuickSplitMergeMode,
    reformatAllCaptionsLineLayout,
    applyScriptLinesDirectly,
    replaceClipWithSegments,
    addRawAiCaptions,
    applyScriptCorrectionsToCaptions,
    snapAllSubtitlesToClips,
    updateClip,
    setStatusMessage,
  } = useEditorStore();

  // 현재 타임라인의 자막(캡션) 클립들
  const subtitleClips = clips
    .filter((c) => c.type === 'text')
    .sort((a, b) => a.startTime - b.startTime);

  // STEP 1 대상이 될 선택된 오디오(또는 비디오) 클립 찾기
  const selectedMediaClips = clips
    .filter(
      (c) =>
        (selectedClipIds.includes(c.id) || c.id === selectedClipId) &&
        (c.type === 'audio' || c.type === 'video') &&
        c.sourcePath
    )
    .sort((a, b) => a.startTime - b.startTime);

  // 만약 사용자가 오디오가 아닌 V클립을 선택했더라도 연결된 A클립이나 해당 클립을 대상으로 잡음, 아무것도 선택 안 했으면 전체 오디오 클립 대상
  const allAudioOrVideoClips =
    clips.filter((c) => c.type === 'audio' && c.sourcePath).length > 0
      ? clips
          .filter((c) => c.type === 'audio' && c.sourcePath)
          .sort((a, b) => a.startTime - b.startTime)
      : clips
          .filter((c) => c.type === 'video' && c.sourcePath)
          .sort((a, b) => a.startTime - b.startTime);

  const targetAudioClips =
    selectedMediaClips.length > 0 ? selectedMediaClips : allAudioOrVideoClips;

  // [STEP 1] 선택되어 있는 오디오 파일을 대상으로 AI 자동 자막(캡션) 생성 진행!
  const handleRunStep1AiCaption = async () => {
    if (!window.electronAPI) return;
    if (targetAudioClips.length === 0) {
      setStatusMessage('먼저 시퀀스 타임라인에 오디오 또는 비디오 클립을 넣어주세요.');
      return;
    }

    setIsProcessing(true);
    try {
      const generatedSegments: WordTimestamp[] = [];

      for (let i = 0; i < targetAudioClips.length; i++) {
        const clip = targetAudioClips[i];
        if (!clip.sourcePath) continue;

        if (aiEngine === 'openai') {
          if (!openAiApiKey.trim()) {
            setStatusMessage('OpenAI API 키를 입력하거나 로컬 무료 AI 모드를 선택해 주세요.');
            setIsProcessing(false);
            return;
          }
          setProgressText(
            `[${i + 1}/${targetAudioClips.length}] '${clip.name}' OpenAI Whisper 음성 인식 중...`
          );
          const resp = await window.electronAPI.transcribeOpenAI({
            filePath: clip.sourcePath,
            sourceStart: clip.sourceStart,
            duration: clip.duration,
            apiKey: openAiApiKey.trim(),
            language: 'ko',
          });

          if (resp.segments && resp.segments.length > 0) {
            for (const seg of resp.segments) {
              generatedSegments.push({
                text: String(seg.text || '').trim(),
                start: clip.startTime + seg.start,
                end: clip.startTime + seg.end,
              });
            }
            continue;
          } else if (resp.text) {
            generatedSegments.push({
              text: resp.text.trim(),
              start: clip.startTime,
              end: clip.startTime + clip.duration,
            });
            continue;
          }
        }

        // 로컬 Whisper AI 음성 인식
        setProgressText(
          `[${i + 1}/${targetAudioClips.length}] '${clip.name}'에서 16kHz 음성 파형 추출 중...`
        );
        const pcmFloat32 = await window.electronAPI.extractAudioFloat32({
          filePath: clip.sourcePath,
          sourceStart: clip.sourceStart,
          duration: clip.duration,
        });

        const segments = await transcribeWithLocalWhisper(pcmFloat32, clip.startTime, {
          modelId: localWhisperModel,
          language: 'korean',
          onProgress: (msg) => setProgressText(msg),
        });
        generatedSegments.push(...segments);
      }

      if (generatedSegments.length === 0) {
        setStatusMessage('인식된 음성이 없습니다.');
        return;
      }

      addRawAiCaptions(generatedSegments);
    } catch (err: any) {
      setStatusMessage(`AI 캡션 생성 오류: ${err.message}`);
    } finally {
      setIsProcessing(false);
      setProgressText('');
    }
  };

  // 대본 텍스트 파일 불러오기
  const handleLoadScriptFile = async () => {
    if (!window.electronAPI) return;
    const res = await window.electronAPI.openScriptFileDialog();
    if (res) {
      setScriptText(res.content);
      setStatusMessage(`'${res.name}' 대본을 불러왔습니다.`);
    }
  };

  // [STEP 2 - 방안 1] 내 대본의 줄바꿈(Enter) 한 줄 한 줄을 그대로 자막 클립 1개씩으로 매칭 및 오타 변환 실행!
  const handleRunStep2ApplyScriptLinesDirectly = () => {
    if (subtitleClips.length === 0) {
      setStatusMessage(
        '먼저 [1. AI 캡션 생성]에서 오디오 파일로 AI 초벌 자막을 생성해 주세요!'
      );
      setSubTab('step1-ai');
      return;
    }
    if (!scriptText.trim()) {
      setStatusMessage('비교할 내 대본을 입력해 주세요.');
      return;
    }

    const diffs = applyScriptLinesDirectly(scriptText);
    setDiffReport(diffs);
  };

  // [STEP 2 - 보조] 통짜 대본을 붙여넣었을 때 대본 텍스트창 자체에 먼저 자동 줄바꿈을 넣어주어 사용자가 Enter로 다듬을 수 있게 함
  const handlePreformatScriptTextLines = () => {
    if (!scriptText.trim()) return;
    const chunks = splitSentenceIntoNaturalChunks(scriptText, captionMaxCharsPerLine);
    if (chunks.length > 0) {
      setScriptText(chunks.join('\n'));
      setStatusMessage(
        `대본 텍스트가 ${chunks.length}줄로 자동 줄바꿈되었습니다. 대본 창에서 원하는 대로 Enter/Backspace로 다듬은 뒤 [내 대본 줄바꿈 그대로 적용]을 눌러보세요!`
      );
    }
  };

  // [STEP 2 - 기존] 생성된 AI 캡션 구간은 유지한 채 내 대본과 비교해 오타만 변환 실행!
  const handleRunStep2CompareAndConvert = () => {
    if (subtitleClips.length === 0) {
      setStatusMessage(
        '먼저 [1. AI 캡션 생성]에서 오디오 파일로 AI 초벌 자막을 생성해 주세요!'
      );
      setSubTab('step1-ai');
      return;
    }
    if (!scriptText.trim()) {
      setStatusMessage('비교할 내 대본을 입력해 주세요.');
      return;
    }

    const diffs = compareAndCorrectCaptionsWithScript(subtitleClips, scriptText);
    setDiffReport(diffs);
    applyScriptCorrectionsToCaptions(
      diffs.map((d) => ({
        clipId: d.clipId,
        beforeText: d.beforeText,
        afterText: d.afterText,
      }))
    );
  };

  // 무음 구간 자동 컷 편집
  const handleAutoSilenceCut = async () => {
    if (!window.electronAPI) return;
    const targetClip = targetAudioClips[0];
    if (!targetClip || !targetClip.sourcePath) {
      setStatusMessage('무음 구간을 분석할 오디오/비디오 클립을 먼저 시퀀스에 배치해 주세요.');
      return;
    }

    setIsProcessing(true);
    setProgressText(`'${targetClip.name}' 무음 구간 감지 및 컷 편집 중...`);

    try {
      const result = await window.electronAPI.detectSilence({
        filePath: targetClip.sourcePath,
        sourceStart: targetClip.sourceStart,
        duration: targetClip.duration,
        noiseDb,
        minSilenceDuration: minSilenceDur,
        paddingMs,
      });

      if (result.speechSegments.length <= 1 && result.silences.length === 0) {
        setStatusMessage(`감지된 무음 구간이 없습니다. 기준 데시벨(${noiseDb}dB)을 높여보세요.`);
      } else {
        replaceClipWithSegments(targetClip.id, result.speechSegments, rippleAfterSilence);
      }
    } catch (err: any) {
      setStatusMessage(`무음 분석 실패: ${err.message}`);
    } finally {
      setIsProcessing(false);
      setProgressText('');
    }
  };

  // 예시 문장("아직도 셔츠 단추 사이 벌어질까 봐 옷핀으로 가리고 계세요?") 실시간 한줄/두줄 분할 미리보기
  const samplePreviewChunks = splitSentenceIntoNaturalChunks(
    '아직도 셔츠 단추 사이 벌어질까 봐 옷핀으로 가리고 계세요?',
    captionMaxCharsPerLine
  );
  const sampleDoubleLineGroups: string[] = [];
  for (let i = 0; i < samplePreviewChunks.length; i += 2) {
    sampleDoubleLineGroups.push(
      i + 1 < samplePreviewChunks.length
        ? `${samplePreviewChunks[i]}\n${samplePreviewChunks[i + 1]}`
        : samplePreviewChunks[i]
    );
  }

  // 캡션 한줄 / 두줄 이내 변환 시스템 카드 (1·2·3단계 어디서나 분류 후 다시 구성 가능)
  const renderCaptionLineSystemCard = () => (
    <div className="bg-[#1b222c] border border-[#388bfd]/45 rounded-lg p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-white flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-[#58a6ff]" />
          캡션 한줄 / 두줄 이내 변환 시스템 (다시 구성)
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#388bfd]/20 text-[#79b8ff] font-semibold">
          {captionLineMode === 'single-line' ? '한 줄씩 분할' : '화면 2줄 이내'}
        </span>
      </div>

      <p className="text-[11px] text-[#a8b3c5] leading-relaxed">
        문장·호흡 연결어미(<strong>~까 봐, ~해서, ~는데</strong> 등)와 <strong>띄어쓰기</strong> 기준으로 잘라{' '}
        <strong>무조건 한 줄씩</strong> 나뉘게 하거나 <strong>화면 두 줄 이내</strong>로 언제든 다시 구성합니다.
      </p>

      {/* 한 줄로 vs 화면에서 두 줄 이내로 선택 버튼 */}
      <div className="grid grid-cols-2 gap-1.5">
        <button
          onClick={() => {
            setCaptionLineMode('single-line');
            if (subtitleClips.length > 0) {
              reformatAllCaptionsLineLayout('single-line', captionMaxCharsPerLine);
            }
          }}
          className={`py-2 px-2 rounded text-[11px] font-bold border transition flex flex-col items-center gap-0.5 ${
            captionLineMode === 'single-line'
              ? 'bg-[#2d8ceb] border-[#58a6ff] text-white shadow'
              : 'bg-[#12161c] border-[#2e3746] text-[#999999] hover:text-white'
          }`}
        >
          <span>한 줄로 나뉘게 (1줄 고정)</span>
          <span className="text-[9px] font-normal opacity-85">
            호흡·띄어쓰기 기준 1줄씩 분할
          </span>
        </button>

        <button
          onClick={() => {
            setCaptionLineMode('double-line');
            if (subtitleClips.length > 0) {
              reformatAllCaptionsLineLayout('double-line', captionMaxCharsPerLine);
            }
          }}
          className={`py-2 px-2 rounded text-[11px] font-bold border transition flex flex-col items-center gap-0.5 ${
            captionLineMode === 'double-line'
              ? 'bg-[#2d8ceb] border-[#58a6ff] text-white shadow'
              : 'bg-[#12161c] border-[#2e3746] text-[#999999] hover:text-white'
          }`}
        >
          <span>화면 두 줄 이내로 (최대 2줄)</span>
          <span className="text-[9px] font-normal opacity-85">
            한 화면에 2줄까지 줄바꿈 표시
          </span>
        </button>
      </div>

      {/* 한 줄 기준 글자 수 슬라이더 */}
      <div className="space-y-1 bg-[#12161d] border border-[#28303d] rounded p-2">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[#bbbbbb]">한 줄 기준 글자 수 (호흡·띄어쓰기 단위 자르기)</span>
          <span className="font-mono font-bold text-[#79b8ff]">
            최대 {captionMaxCharsPerLine}자
          </span>
        </div>
        <input
          type="range"
          min={7}
          max={24}
          value={captionMaxCharsPerLine}
          onChange={(e) => setCaptionMaxCharsPerLine(Number(e.target.value))}
          onMouseUp={() => {
            if (subtitleClips.length > 0) {
              reformatAllCaptionsLineLayout(captionLineMode, captionMaxCharsPerLine);
            }
          }}
          className="w-full accent-[#2d8ceb]"
        />

        {/* 실시간 분할 예시 프리뷰 */}
        <div className="pt-1 text-[10px] text-[#99a3b3] space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[#888888] truncate">
              예시: "아직도 셔츠 단추 사이 벌어질까 봐 옷핀으로 가리고 계세요?"
            </span>
            <span className="text-[#7ee787] font-mono shrink-0 ml-1">
              {captionLineMode === 'single-line'
                ? `→ 1줄 캡션 ${samplePreviewChunks.length}개`
                : `→ ${sampleDoubleLineGroups.length}개 캡션 (최대 2줄)`}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {captionLineMode === 'single-line' ? (
              samplePreviewChunks.map((chunk, i) => (
                <React.Fragment key={i}>
                  <span className="px-1.5 py-0.5 rounded bg-[#1f2937] border border-[#3b82f6]/40 text-white font-medium">
                    {chunk}
                  </span>
                  {i < samplePreviewChunks.length - 1 && (
                    <span className="text-[#58a6ff] font-bold">/</span>
                  )}
                </React.Fragment>
              ))
            ) : (
              <div className="w-full space-y-1">
                {sampleDoubleLineGroups.map((groupText, gIdx) => (
                  <div
                    key={gIdx}
                    className="w-full px-2 py-1 rounded bg-[#1f2937] border border-[#3b82f6]/40 text-white font-medium whitespace-pre-line text-center leading-snug"
                  >
                    {groupText}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 생성/변환 시 자동 적용 체크박스 & 기존 캡션 즉시 다시 구성 버튼 */}
      <div className="flex items-center justify-between gap-2 pt-0.5">
        <label className="flex items-center gap-1.5 text-[11px] text-[#cccccc] cursor-pointer">
          <input
            type="checkbox"
            checked={autoSplitOnCaptionGenerate}
            onChange={(e) => setAutoSplitOnCaptionGenerate(e.target.checked)}
            className="accent-[#2d8ceb]"
          />
          <span>캡션 생성/대본 변환 시 자동 적용</span>
        </label>

        <button
          onClick={() =>
            reformatAllCaptionsLineLayout(captionLineMode, captionMaxCharsPerLine)
          }
          disabled={subtitleClips.length === 0}
          className="px-2.5 py-1.5 rounded bg-[#2d8ceb] hover:bg-[#1e78d6] disabled:opacity-40 text-white font-bold text-[11px] flex items-center gap-1 shadow transition shrink-0"
        >
          <RefreshCw className="w-3 h-3" />
          <span>현재 캡션 다시 구성 ({subtitleClips.length}개)</span>
        </button>
      </div>

      {/* [방안 2] 실제 렌더링되는 프리뷰 화면 위에서 Enter(나누기) / Backspace(합치기) 단축키 토글 */}
      <div className="pt-1 border-t border-[#283242] flex items-center justify-between gap-2">
        <div className="text-[10px] text-[#a8b3c5] leading-tight">
          <strong className="text-[#7ee787]">프리뷰 화면 직접 분할/합치기:</strong> 중앙 영상 화면의 자막 글자 사이를 클릭 후{' '}
          <kbd className="px-1 py-0.2 bg-black/50 border border-[#444] rounded text-white">Enter</kbd> 나누기 ·{' '}
          <kbd className="px-1 py-0.2 bg-black/50 border border-[#444] rounded text-white">Backspace</kbd> 합치기
        </div>
        <button
          onClick={() => setIsQuickSplitMergeMode(!isQuickSplitMergeMode)}
          className={`px-2 py-1 rounded text-[10px] font-bold shrink-0 border transition ${
            isQuickSplitMergeMode
              ? 'bg-[#2ea043] border-[#3fb950] text-white'
              : 'bg-[#161920] border-[#333] text-[#888]'
          }`}
        >
          {isQuickSplitMergeMode ? '단축키 ON' : '단축키 OFF'}
        </button>
      </div>
    </div>
  );

  return (
    <aside className="w-[430px] shrink-0 bg-[#1d1d1d] border-r border-[#111111] flex flex-col h-full select-none text-[#cccccc]">
      {/* 상단 1 -> 2 -> 3 단계 탭 헤더 */}
      <div className="h-9 bg-[#161616] border-b border-[#2b2b2b] px-2 flex items-center gap-1 text-[11px]">
        <button
          onClick={() => setSubTab('step1-ai')}
          className={`flex-1 h-7 rounded px-2 flex items-center justify-center gap-1 font-semibold transition ${
            subTab === 'step1-ai'
              ? 'bg-[#2d8ceb] text-white shadow'
              : 'text-[#999999] hover:text-white hover:bg-[#222222]'
          }`}
        >
          <span>1. AI 캡션 생성</span>
        </button>

        <button
          onClick={() => setSubTab('step2-script')}
          className={`flex-1 h-7 rounded px-2 flex items-center justify-center gap-1 font-semibold transition ${
            subTab === 'step2-script'
              ? 'bg-[#2d8ceb] text-white shadow'
              : 'text-[#999999] hover:text-white hover:bg-[#222222]'
          }`}
        >
          <span>2. 대본 오타 변환</span>
          {subtitleClips.length > 0 && (
            <span className="px-1 rounded-full bg-black/30 text-[10px]">
              {subtitleClips.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setSubTab('step3-manage')}
          className={`flex-1 h-7 rounded px-2 flex items-center justify-center gap-1 font-semibold transition ${
            subTab === 'step3-manage'
              ? 'bg-[#2d8ceb] text-white shadow'
              : 'text-[#999999] hover:text-white hover:bg-[#222222]'
          }`}
        >
          <span>3. 컷/클립 정리</span>
        </button>
      </div>

      {/* 진행 중 알림 바 */}
      {isProcessing && (
        <div className="bg-[#16283e] border-b border-[#2d8ceb]/40 px-3 py-2 flex items-center gap-2 text-xs text-[#79b8ff]">
          <Loader2 className="w-4 h-4 animate-spin shrink-0" />
          <span className="truncate">{progressText || 'AI 음성 분석 진행 중...'}</span>
        </div>
      )}

      {/* 본문 영역 */}
      <div className="flex-1 overflow-y-auto p-3.5 bg-[#181818] space-y-3.5">
        {/* =====================================================================
            STEP 1: 선택되어 있는 오디오 파일을 대상으로 AI 자막 캡션 생성 (최우선 화면!)
           ===================================================================== */}
        {subTab === 'step1-ai' && (
          <div className="space-y-3.5">
            {/* 1. 현재 선택된 오디오 클립 상태 표시 박스 */}
            <div className="bg-[#21252d] border border-[#2d8ceb]/50 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white flex items-center gap-1.5">
                  <Mic className="w-4 h-4 text-[#2d8ceb]" />
                  STEP 1. 선택된 오디오로 AI 자막(캡션) 생성
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#2d8ceb]/20 text-[#79b8ff] font-semibold">
                  {selectedMediaClips.length > 0 ? '선택된 클립 대상' : '시퀀스 오디오 전체'}
                </span>
              </div>

              {targetAudioClips.length === 0 ? (
                <div className="bg-[#14161a] border border-dashed border-[#383e4c] rounded p-2.5 text-[11px] text-[#999999]">
                  ⚠️ 현재 시퀀스에 오디오 파일이 없습니다. 왼쪽 하단에서 오디오/비디오를 타임라인 트랙(`A1` 등)에 드래그해 넣어주세요.
                </div>
              ) : (
                <div className="bg-[#14161a] border border-[#2e3440] rounded p-2 space-y-1">
                  <div className="text-[11px] text-[#aaaaaa]">분석 대상 오디오 클립 ({targetAudioClips.length}개):</div>
                  <div className="max-h-20 overflow-y-auto space-y-1">
                    {targetAudioClips.map((tc, idx) => (
                      <div
                        key={tc.id}
                        className="flex items-center justify-between text-xs font-medium text-[#7ee787] bg-[#1a2220] px-2 py-1 rounded"
                      >
                        <span className="truncate">
                          🎵 {idx + 1}. {tc.name}
                        </span>
                        <span className="font-mono text-[10px] text-[#aaaaaa] shrink-0 ml-2">
                          {formatFullTimecode(tc.startTime, fps).slice(3)} ~{' '}
                          {formatFullTimecode(tc.startTime + tc.duration, fps).slice(3)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* AI 엔진 선택 (로컬 무료 Whisper vs OpenAI Whisper) */}
              <div className="pt-1 space-y-2">
                <div className="text-[11px] text-[#bbbbbb] font-medium">AI 음성인식 엔진 선택</div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    onClick={() => setAiEngine('local')}
                    className={`py-1.5 px-2 rounded text-[11px] font-medium flex items-center justify-center gap-1 border transition ${
                      aiEngine === 'local'
                        ? 'bg-[#2d8ceb]/20 border-[#2d8ceb] text-white'
                        : 'bg-[#141414] border-[#333333] text-[#888888]'
                    }`}
                  >
                    <Cpu className="w-3.5 h-3.5" /> 로컬 AI (무료·내장)
                  </button>
                  <button
                    onClick={() => setAiEngine('openai')}
                    className={`py-1.5 px-2 rounded text-[11px] font-medium flex items-center justify-center gap-1 border transition ${
                      aiEngine === 'openai'
                        ? 'bg-[#2d8ceb]/20 border-[#2d8ceb] text-white'
                        : 'bg-[#141414] border-[#333333] text-[#888888]'
                    }`}
                  >
                    <KeyRound className="w-3.5 h-3.5" /> OpenAI Whisper API
                  </button>
                </div>

                {aiEngine === 'local' ? (
                  <div className="flex items-center justify-between text-[11px] text-[#999999] bg-[#16181d] px-2.5 py-1.5 rounded border border-[#2c313c]">
                    <span>로컬 모델 정확도:</span>
                    <select
                      value={localWhisperModel}
                      onChange={(e) => setLocalWhisperModel(e.target.value)}
                      className="bg-[#0e1014] border border-[#383e4c] rounded px-1.5 py-0.5 text-white text-[11px] focus:outline-none"
                    >
                      <option value="Xenova/whisper-tiny">Whisper Tiny (초고속)</option>
                      <option value="Xenova/whisper-base">Whisper Base (한국어 추천)</option>
                      <option value="Xenova/whisper-small">Whisper Small (고정밀)</option>
                    </select>
                  </div>
                ) : (
                  <input
                    type="password"
                    value={openAiApiKey}
                    onChange={(e) => setOpenAiApiKey(e.target.value)}
                    placeholder="sk-... (OpenAI API Key 입력)"
                    className="w-full bg-[#121212] border border-[#333333] rounded px-2.5 py-1.5 text-xs text-white focus:outline-none select-text"
                  />
                )}
              </div>

              {/* STEP 1 메인 실행 버튼 */}
              <button
                onClick={handleRunStep1AiCaption}
                disabled={isProcessing || targetAudioClips.length === 0}
                className="w-full py-2.5 px-3 bg-[#2d8ceb] hover:bg-[#1e78d6] disabled:opacity-45 text-white font-bold text-xs rounded-md shadow-lg flex items-center justify-center gap-2 transition"
              >
                {isProcessing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Subtitles className="w-4 h-4" />
                )}
                선택된 오디오로 AI 자막 캡션 생성 시작
              </button>
            </div>

            {/* 캡션 한줄 / 두줄 이내 변환 시스템 */}
            {renderCaptionLineSystemCard()}

            {/* 생성된 AI 초벌 캡션 결과 리스트 및 2단계 이동 안내 */}
            <div className="bg-[#1f1f1f] border border-[#2e2e2e] rounded-lg p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white">
                  생성된 AI 캡션 ({subtitleClips.length}개)
                </span>
                {subtitleClips.length > 0 && (
                  <button
                    onClick={() => setSubTab('step2-script')}
                    className="px-2.5 py-1 rounded bg-[#2ea043] hover:bg-[#268c39] text-white text-[11px] font-bold flex items-center gap-1 transition"
                  >
                    <span>2단계: 대본으로 오타 검수/변환하기</span>
                    <ArrowRight className="w-3 h-3" />
                  </button>
                )}
              </div>

              {subtitleClips.length === 0 ? (
                <div className="py-6 text-center text-[11px] text-[#777777]">
                  위의 <strong>[선택된 오디오로 AI 자막 캡션 생성 시작]</strong> 버튼을 누르면
                  <br />
                  오디오 음성을 분석해 이곳과 타임라인 `C1` 트랙에 캡션이 생성됩니다.
                </div>
              ) : (
                <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
                  {subtitleClips.map((sub, idx) => {
                    const isCurrent =
                      currentTime >= sub.startTime && currentTime < sub.startTime + sub.duration;
                    const lineCount = (sub.text || '').split(/\r?\n/).length;
                    return (
                      <div
                        key={sub.id}
                        onClick={() => {
                          setSelectedClipId(sub.id);
                          if (followMonitor) setCurrentTime(sub.startTime);
                        }}
                        className={`p-2 rounded border text-xs cursor-pointer transition ${
                          isCurrent || selectedClipId === sub.id
                            ? 'bg-[#253040] border-[#2d8ceb]'
                            : 'bg-[#161616] border-[#2b2b2b] hover:border-[#444444]'
                        }`}
                      >
                        <div className="flex items-center justify-between text-[10px] font-mono text-[#888888] mb-0.5">
                          <span>
                            #{idx + 1} · {formatFullTimecode(sub.startTime, fps).slice(3)} ~{' '}
                            {formatFullTimecode(sub.startTime + sub.duration, fps).slice(3)}
                          </span>
                          <span className="px-1 rounded bg-black/40 text-[#79b8ff]">
                            {lineCount}줄
                          </span>
                        </div>
                        <textarea
                          rows={Math.min(2, Math.max(1, lineCount))}
                          value={sub.text || ''}
                          onChange={(e) => updateClip(sub.id, { text: e.target.value })}
                          className="w-full bg-transparent text-xs text-white focus:outline-none select-text resize-none leading-snug"
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* =====================================================================
            STEP 2: AI 생성 캡션들에 내 대본을 제공하여 오타 검수 및 변환 + 비교 리포트 표시!
           ===================================================================== */}
        {subTab === 'step2-script' && (
          <div className="space-y-3.5">
            <div className="bg-[#21252d] border border-[#2ea043]/50 rounded-lg p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white flex items-center gap-1.5">
                  <FileText className="w-4 h-4 text-[#3fb950]" />
                  STEP 2. AI 생성 캡션 ↔ 내 대본 비교 및 오타 변환
                </span>
                <button
                  onClick={handleLoadScriptFile}
                  className="px-2 py-0.5 rounded bg-[#2b2b2b] hover:bg-[#3a3a3a] border border-[#444444] text-[10px] text-[#dddddd] flex items-center gap-1"
                >
                  <Upload className="w-3 h-3" /> .txt 대본 열기
                </button>
              </div>

              <div className="flex items-center justify-between gap-1">
                <p className="text-[11px] text-[#aaaaaa] leading-relaxed">
                  대본 입력창에서 <strong>내가 줄바꿈(Enter)한 한 줄 = 캡션 1개</strong>로 100% 똑같이 나누거나, 기존 캡션 오타만 교정할 수 있습니다.
                </p>
                <button
                  onClick={handlePreformatScriptTextLines}
                  className="px-2 py-1 rounded bg-[#1f2937] hover:bg-[#2d3748] border border-[#3b82f6]/40 text-[10px] text-[#79b8ff] font-semibold shrink-0"
                  title="통짜 대본을 먼저 호흡 단위로 자동 줄바꿈해 줍니다. 이후 대본창에서 자유롭게 Enter/Backspace로 수정하세요."
                >
                  대본 자동 줄바꿈 정리
                </button>
              </div>

              <textarea
                rows={6}
                value={scriptText}
                onChange={(e) => setScriptText(e.target.value)}
                placeholder="여기에 정확한 원본 대본을 붙여넣으세요. 원하는 호흡 위치에서 Enter로 줄바꿈해 두면 아래 버튼으로 그 줄바꿈 그대로 자막이 생성됩니다!"
                className="w-full bg-[#111318] border border-[#333947] focus:border-[#2ea043] rounded p-2.5 text-xs text-white placeholder-[#666666] focus:outline-none leading-relaxed select-text"
              />

              <div className="space-y-1.5">
                <button
                  onClick={handleRunStep2ApplyScriptLinesDirectly}
                  className="w-full py-2.5 px-3 bg-[#2ea043] hover:bg-[#268c39] text-white font-bold text-xs rounded-md shadow flex items-center justify-center gap-1.5 transition"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  [방안 1] 내 대본의 줄바꿈(Enter) 그대로 캡션 나누기 & 오타 변환
                </button>

                <button
                  onClick={handleRunStep2CompareAndConvert}
                  className="w-full py-1.5 px-3 bg-[#242933] hover:bg-[#2e3542] border border-[#3b4454] text-[#cccccc] hover:text-white font-medium text-[11px] rounded flex items-center justify-center gap-1.5 transition"
                >
                  <RefreshCw className="w-3 h-3" />
                  기존 AI 캡션 구간 유지하며 오타만 비교/변환
                </button>
              </div>
            </div>

            {/* 대본 변환 후에도 언제든 한줄/두줄로 다시 구성 가능 */}
            {renderCaptionLineSystemCard()}

            {/* 비교 검수 결과물 리포트 (기존 AI 캡션 vs 내 대본 변환 결과) */}
            <div className="bg-[#1f1f1f] border border-[#2e2e2e] rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold text-white">
                <span>AI 캡션 ↔ 대본 비교 변환 결과물</span>
                {diffReport.length > 0 && (
                  <span className="text-[10px] text-[#7ee787] flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    총 {diffReport.length}개 중 {diffReport.filter((d) => d.isChanged).length}개 오타 교정됨
                  </span>
                )}
              </div>

              {diffReport.length === 0 ? (
                <div className="py-6 text-center text-[11px] text-[#777777]">
                  위의 <strong>[기존 AI 캡션과 내 대본 비교 검수 & 오타 변환 실행]</strong>을 누르면
                  <br />
                  각 캡션별로 <strong>AI가 들은 원문 → 대본으로 고쳐진 결과</strong>가 여기에 표시됩니다.
                </div>
              ) : (
                <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
                  {diffReport.map((item) => (
                    <div
                      key={item.clipId}
                      onClick={() => {
                        setSelectedClipId(item.clipId);
                        if (followMonitor) setCurrentTime(item.startTime);
                      }}
                      className="p-2.5 rounded bg-[#151515] border border-[#2c2c2c] hover:border-[#2d8ceb] cursor-pointer space-y-1 text-xs"
                    >
                      <div className="flex items-center justify-between text-[10px] font-mono text-[#888888]">
                        <span>
                          캡션 #{item.index} ({formatFullTimecode(item.startTime, fps).slice(3)} ~{' '}
                          {formatFullTimecode(item.endTime, fps).slice(3)})
                        </span>
                        <span
                          className={`px-1.5 py-0.2 rounded font-sans font-semibold ${
                            item.isChanged
                              ? 'bg-amber-500/20 text-amber-300'
                              : 'bg-emerald-500/20 text-emerald-300'
                          }`}
                        >
                          {item.isChanged ? '✨ 대본으로 오타 수정됨' : '✓ 원문 일치'}
                        </span>
                      </div>

                      {item.isChanged && (
                        <div className="text-[11px] text-rose-400/90 line-through">
                          기존 AI 캡션: {item.beforeText}
                        </div>
                      )}
                      <div className="text-xs font-semibold text-[#7ee787]">
                        변환 결과: {item.afterText}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* =====================================================================
            STEP 3: (후순위) 컷 편집 진행 후 클립과 자막 시작/끝을 맞추는 정리 기능 & 무음 컷
           ===================================================================== */}
        {subTab === 'step3-manage' && (
          <div className="space-y-3.5">
            {/* 캡션 한줄 / 두줄 이내 변환 시스템 */}
            {renderCaptionLineSystemCard()}

            {/* 후순위 정리 1: 컷 편집된 클립과 자막 시작/끝 맞추기 */}
            <div className="bg-[#202020] border border-[#f5a623]/40 rounded-lg p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#f5a623] flex items-center gap-1.5">
                  <Magnet className="w-4 h-4" />
                  컷 편집 후 클립과 자막 시작/끝 맞추기 (정리)
                </span>
                <span className="text-[11px] font-mono text-[#aaaaaa]">
                  ±{snapThresholdFrames} 프레임
                </span>
              </div>
              <p className="text-[11px] text-[#999999] leading-relaxed">
                음성/영상 파일을 컷 편집한 뒤, 자막 캡션의 시작점·끝점이 컷 편집된 클립과 1~{snapThresholdFrames}프레임 미세하게 차이 날 때 클릭 한 번으로 클립 경계에 딱 맞춰 정리합니다.
              </p>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-[#aaaaaa] shrink-0">허용 오차:</span>
                <input
                  type="range"
                  min={1}
                  max={15}
                  value={snapThresholdFrames}
                  onChange={(e) => setSnapThresholdFrames(Number(e.target.value))}
                  className="flex-1 accent-[#f5a623]"
                />
                <span className="text-xs font-mono text-[#f5a623] w-14 text-right">
                  ±{snapThresholdFrames}F
                </span>
              </div>
              <button
                onClick={() => snapAllSubtitlesToClips()}
                className="w-full py-2 bg-[#f5a623] hover:bg-[#e09612] text-black font-bold text-xs rounded flex items-center justify-center gap-1.5 transition"
              >
                <Magnet className="w-3.5 h-3.5" />
                클립 경계에 자막 시작/끝 일괄 맞추기
              </button>
            </div>

            {/* 후순위 정리 2: 무음 구간 자동 컷 편집 */}
            <div className="bg-[#202020] border border-[#2e2e2e] rounded-lg p-3 space-y-2.5 text-xs">
              <div className="font-semibold text-white flex items-center gap-1.5">
                <Scissors className="w-4 h-4 text-[#2d8ceb]" />
                AI 무음 구간 자동 컷 편집
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-[11px]">
                  <span className="text-[#aaaaaa]">무음 기준 데시벨</span>
                  <span className="font-mono text-[#6cb6ff]">{noiseDb} dB</span>
                </div>
                <input
                  type="range"
                  min={-50}
                  max={-15}
                  value={noiseDb}
                  onChange={(e) => setNoiseDb(Number(e.target.value))}
                  className="w-full accent-[#2d8ceb]"
                />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-[11px]">
                  <span className="text-[#aaaaaa]">최소 무음 길이</span>
                  <span className="font-mono text-[#6cb6ff]">{minSilenceDur.toFixed(2)} 초</span>
                </div>
                <input
                  type="range"
                  min={0.15}
                  max={2.0}
                  step={0.05}
                  value={minSilenceDur}
                  onChange={(e) => setMinSilenceDur(Number(e.target.value))}
                  className="w-full accent-[#2d8ceb]"
                />
              </div>
              <label className="flex items-center gap-2 text-[11px] text-[#cccccc] cursor-pointer">
                <input
                  type="checkbox"
                  checked={rippleAfterSilence}
                  onChange={(e) => setRippleAfterSilence(e.target.checked)}
                  className="accent-[#2d8ceb]"
                />
                <span>무음 제거 후 빈 공간 자동 당겨 붙이기</span>
              </label>
              <button
                onClick={handleAutoSilenceCut}
                disabled={isProcessing}
                className="w-full py-2 bg-[#2d8ceb] hover:bg-[#1e78d6] text-white font-semibold rounded flex items-center justify-center gap-1.5 transition"
              >
                <Scissors className="w-3.5 h-3.5" />
                무음 구간 자동 제거 실행
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 하단 바 */}
      <div className="h-7 bg-[#1d1d1d] border-t border-[#2b2b2b] px-3 flex items-center justify-between text-[11px] text-[#999999]">
        <label className="flex items-center gap-1.5 cursor-pointer text-[#cccccc]">
          <input
            type="checkbox"
            checked={followMonitor}
            onChange={(e) => setFollowMonitor(e.target.checked)}
            className="accent-[#2d8ceb]"
          />
          <span>캡션 클릭 시 해당 위치로 재생헤드 이동</span>
        </label>
        <Sparkles className="w-3.5 h-3.5 text-[#2d8ceb]" />
      </div>
    </aside>
  );
};
