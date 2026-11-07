import React, { useState } from 'react';
import {
  Subtitles,
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
import { useEditorStore, LOCAL_WHISPER_MODEL } from '../store/useEditorStore';
import { AutoEditCard } from './AutoEditCard';
import { ScriptGenCard } from './ScriptGenCard';
import {
  CaptionDiffItem,
  buildCaptionsFromWordTimestamps,
  compareAndCorrectCaptionsWithScript,
  parseScriptBlocks,
  splitSentenceIntoNaturalChunks,
} from '../utils/scriptAligner';
import {
  transcribeWithLocalWhisper,
  transcribeRawChunksWithLocalWhisper,
  computeVisualWaveformPeaks,
} from '../utils/localWhisper';
import { refineCaptionsByFullAlignment } from '../utils/captionBoundaryRefiner';
import { clipAudioKey } from '../utils/forcedAligner';
import {
  rendererWaveformCache,
  normalizeAudioPath,
} from './AudioWaveformCanvas';
import { WordTimestamp } from '../types/editor';
import { formatFullTimecode } from '../utils/subtitleSnapper';

export const LeftSidebar: React.FC = () => {
  const [subTab, setSubTab] = useState<'step0-script' | 'step1-ai' | 'step2-script' | 'step3-manage'>('step1-ai');
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
    localWhisperModel,
    scriptText,
    captionLineMode,
    captionMaxCharsPerLine,
    autoSplitOnCaptionGenerate,
    setCurrentTime,
    setSelectedClipId,
    setScriptText,
    setCaptionLineMode,
    setCaptionMaxCharsPerLine,
    setAutoSplitOnCaptionGenerate,
    reformatAllCaptionsLineLayout,
    splitVariantsIntoSequences,
    setAdSegments,
    replaceClipWithSegments,
    addRawAiCaptions,
    applyScriptCorrectionsToCaptions,
    updateClip,
    setStatusMessage,
  } = useEditorStore();

  // 초기 샘플 더미 대본이 남아있는 경우 자동으로 비워주어 오디오 단독 생성 시 혼선 방지
  React.useEffect(() => {
    if (scriptText.includes('안티그래비티 AI 비디오 편집기')) {
      setScriptText('');
    }
  }, [scriptText, setScriptText]);

  // 대본+파형 정렬기에 쓸 대본 (초기 샘플 문구는 무시)

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
          .filter((c) => c.type === 'video' && c.sourcePath && !c.muted)
          .sort((a, b) => a.startTime - b.startTime);

  const targetAudioClips =
    selectedMediaClips.length > 0 ? selectedMediaClips : allAudioOrVideoClips;

  // [STEP 1] 파형 무음 골짜기(Silence Valley) 직후 발화 시작점 스냅 + Gemini 문맥/대본 무밀림 교정
  // 자막 위치 정밀 맞춤 모델이 준비됐는지 확인 (없으면 먼저 받음). 받지 못하면 false
  const ensureAlignModel = async (): Promise<boolean> => {
    if (!window.electronAPI?.modelEnsure) return true;
    setStatusMessage('자막 위치 맞춤 모델 확인 중... (처음 한 번은 다운로드합니다)');
    const st = await window.electronAPI.modelEnsure();
    if (st.state !== 'ready') {
      setStatusMessage('자막 위치 맞춤 모델을 받지 못해 자막을 만들지 않았습니다. 상단 안내에서 [다시 시도]해 주세요.');
      return false;
    }
    return true;
  };

  // 음성 클립(pcm)의 자막들을 강제 정렬로 실제 발음 위치에 맞춤 (자막 시각은 클립 기준 초)
  const alignCaptionsToClip = (key: string) => async (p: Float32Array, words: string[]) => {
    const r = await window.electronAPI!.alignWordSpans!({
      key,
      pcm: p,
      ranges: [{ start: 0, end: p.length / 16000, words }],
    });
    return { available: r.available, spans: r.results[0] ?? null };
  };

  const handleRunStep1AiCaption = async () => {
    if (!window.electronAPI) return;
    if (targetAudioClips.length === 0) {
      setStatusMessage('먼저 시퀀스 타임라인에 오디오 또는 비디오 클립을 넣어주세요.');
      return;
    }

    // 무음 제거로 쪼개진 클립들(#1, #2...)을 같은 원본 파일(sourcePath) 단위로 묶어서
    // 1) .timestamps.json 이 있으면 Whisper 없이 0.1초 만에 매핑 생성 (방법 2)
    // 2) 일반 음성이면 잘린 조각들을 하나의 연속 버퍼로 이어 붙여 Whisper + 발음 정렬을 딱 1번만 실행 (방법 1)
    const groups: Array<{ sourcePath: string; clips: typeof targetAudioClips }> = [];
    for (const c of targetAudioClips) {
      if (!c.sourcePath) continue;
      const last = groups[groups.length - 1];
      if (last && last.sourcePath === c.sourcePath && last.clips[0].trackId === c.trackId) {
        last.clips.push(c);
      } else {
        groups.push({ sourcePath: c.sourcePath, clips: [c] });
      }
    }
    if (groups.length === 0) return;

    setIsProcessing(true);
    try {
      const generatedSegments: WordTimestamp[] = [];
      let usedTimestampsCount = 0;
      let alignModelChecked = false;

      for (let gIdx = 0; gIdx < groups.length; gIdx++) {
        const group = groups[gIdx];
        const gClips = [...group.clips].sort((a, b) => a.startTime - b.startTime);
        const firstClip = gClips[0];
        const cleanName = firstClip.name.replace(/\s*#\d+$/, '');

        // [방법 2] 음성 클립 옆에 .timestamps.json 이 있는지 먼저 확인 → 있으면 Whisper 건너뛰고 즉시 생성
        const tsInfo = await window.electronAPI.readVoiceTimestamps?.(group.sourcePath);
        if (tsInfo?.found && tsInfo.words.length > 0) {
          setProgressText(`[${gIdx + 1}/${groups.length}] '${cleanName}' 저장된 AI 음성 시간표(.timestamps.json)로 즉시 매핑 중...`);
          const mappedSegs = buildCaptionsFromWordTimestamps(tsInfo.words, gClips, {
            mode: captionLineMode,
            maxCharsPerLine: captionMaxCharsPerLine,
          });
          generatedSegments.push(...mappedSegs);
          usedTimestampsCount++;
          continue;
        }

        // [방법 1] 일반 녹음/외부 음성: 정렬 모델 확인 후, 여러 조각(#1, #2...)이어도 원본에서 1번만 추출해 이어 붙여 Whisper 1회 실행
        if (!alignModelChecked) {
          if (!(await ensureAlignModel())) return;
          alignModelChecked = true;
        }

        const minSrc = Math.max(0, Math.min(...gClips.map((c) => c.sourceStart)));
        const maxSrc = Math.max(...gClips.map((c) => c.sourceStart + c.duration * (c.speed && c.speed > 0 ? c.speed : 1)));
        const srcSpanDur = Math.max(0.05, maxSrc - minSrc);

        setProgressText(
          `[${gIdx + 1}/${groups.length}] '${cleanName}'${gClips.length > 1 ? ` (조각 ${gClips.length}개 통합)` : ''} 16kHz 오디오 파형 추출 중...`
        );
        const rawSourcePcm = await window.electronAPI.extractAudioFloat32({
          filePath: group.sourcePath,
          sourceStart: minSrc,
          duration: srcSpanDur,
        });

        const groupStart = gClips[0].startTime;
        const groupEnd = Math.max(...gClips.map((c) => c.startTime + c.duration));
        const groupDur = Math.max(0.05, groupEnd - groupStart);

        let pcmFloat32: Float32Array;
        if (gClips.length === 1) {
          pcmFloat32 = rawSourcePcm;
          if (firstClip.sourcePath && firstClip.sourceStart === 0) {
            const normKey = normalizeAudioPath(firstClip.sourcePath);
            if (!rendererWaveformCache.has(normKey)) {
              const { visualPeaks, samplesPerSec } = computeVisualWaveformPeaks(pcmFloat32, 16000, 200);
              const peaksArr = Array.from(visualPeaks);
              const wfObj = { peaks: peaksArr, rms: peaksArr, samplesPerSec };
              rendererWaveformCache.set(normKey, wfObj);
              rendererWaveformCache.set(firstClip.sourcePath, wfObj);
            }
          }
        } else {
          // 무음 제거로 나뉜 조각들을 타임라인 위치에 맞춰 하나의 연속 버퍼로 조립 (Whisper 1회 호출)
          pcmFloat32 = new Float32Array(Math.ceil(groupDur * 16000));
          for (const c of gClips) {
            const srcOff = Math.max(0, Math.round((c.sourceStart - minSrc) * 16000));
            const len = Math.min(Math.round(c.duration * 16000), rawSourcePcm.length - srcOff);
            const dstOff = Math.max(0, Math.round((c.startTime - groupStart) * 16000));
            if (len > 0 && dstOff + len <= pcmFloat32.length) {
              pcmFloat32.set(rawSourcePcm.subarray(srcOff, srcOff + len), dstOff);
            }
          }
        }

        // 1. 로컬 Whisper 로 받아쓰기 (조각 수와 무관하게 그룹당 딱 1회)
        let baseSegments: WordTimestamp[] = await transcribeWithLocalWhisper(pcmFloat32, groupStart, {
          modelId: localWhisperModel,
          language: 'korean',
          maxCharsPerLine: captionMaxCharsPerLine,
          onProgress: (msg) => setProgressText(msg),
        });

        // 2. 받아쓴 글자를 음성에 강제 정렬해 자막 시작/끝을 실제 발음 위치로 보정 (그룹당 딱 1회)
        if (window.electronAPI.alignWordSpans && baseSegments.length > 0) {
          setProgressText(`'${cleanName}' 자막 위치 정밀 보정 중...`);
          const rel = baseSegments.map((sg) => ({
            ...sg,
            start: sg.start - groupStart,
            end: sg.end - groupStart,
            voiceEnd: (sg.voiceEnd ?? sg.end) - groupStart,
            inBreath: false,
          }));
          const alignKey =
            gClips.length === 1
              ? clipAudioKey(firstClip.sourcePath!, firstClip.sourceStart, firstClip.duration)
              : `stitched_step1_${group.sourcePath}_${gClips.length}_${groupStart.toFixed(2)}_${groupDur.toFixed(2)}`;
          const r = await refineCaptionsByFullAlignment(
            pcmFloat32,
            16000,
            rel,
            alignCaptionsToClip(alignKey)
          );
          if (!r.available) {
            setStatusMessage('자막 위치 맞춤 모델을 사용할 수 없어 자막을 만들지 않았습니다.');
            return;
          }
          baseSegments = r.captions.map(({ inBreath: _ib, ...c }) => ({
            ...c,
            start: c.start + groupStart,
            end: c.end + groupStart,
            voiceEnd: c.voiceEnd + groupStart,
          }));
        }
        generatedSegments.push(...baseSegments);
      }

      if (generatedSegments.length === 0) {
        setStatusMessage('인식된 음성 구간이 없습니다.');
        return;
      }

      addRawAiCaptions(generatedSegments);
      setStatusMessage(
        usedTimestampsCount === groups.length
          ? `AI 음성 시간표(.timestamps.json)로 오타 없는 자막 ${generatedSegments.length}개를 즉시 생성했습니다! (STEP 2 오타 변환 생략 가능)`
          : `자막 ${generatedSegments.length}개를 만들고 실제 발음 위치에 맞췄습니다.`
      );
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

  const [variantRuns, setVariantRuns] = useState<
    Array<{ variant: number; start: number; end: number; hook: ReturnType<typeof parseScriptBlocks>[number]['hook'] }>
  >([]);

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
  const handleRunStep2CompareAndConvert = async () => {
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
    // 대본에 버전이 여러 개면, 음성 속 버전 구간(시간)을 기억 → [버전별 시퀀스 만들기]
    const blocks = parseScriptBlocks(scriptText);
    const runs: Array<{ variant: number; start: number; end: number; hook: (typeof blocks)[number]['hook'] }> = [];
    if (blocks.length > 1) {
      const audioEnd = Math.max(...clips.filter((c) => c.type === 'audio').map((c) => c.startTime + c.duration), 0);
      for (const d of [...diffs].sort((a, b) => a.startTime - b.startTime)) {
        if (d.variant === undefined) continue;
        const last = runs[runs.length - 1];
        if (last && last.variant === d.variant) continue;
        if (last) last.end = d.startTime;
        if (runs.some((r) => r.variant === d.variant)) continue; // 같은 버전이 다시 나오면(드묾) 첫 구간만
        runs.push({ variant: d.variant, start: runs.length ? d.startTime : 0, end: audioEnd, hook: blocks[d.variant]?.hook ?? null });
      }
    }
    // 오타 변환 적용 (자동 분할이 켜져 있으면 대본 글자로 다시 13자 나눔) — 경계를 정확히 잡으려고 먼저 적용
    await applyScriptCorrectionsToCaptions(
      diffs.map((d) => ({
        clipId: d.clipId,
        beforeText: d.beforeText,
        afterText: d.afterText,
      }))
    );
    // 받아쓰기가 두 광고를 한 문장으로 묶은 경우(예: '…난리예요 남편 얼굴 보고…') 경계가 늦게 잡히므로,
    // 다시 나눈 자막에서 각 대본 첫머리가 시작하는 자막을 찾아 경계로 씀
    if (runs.length > 1) {
      const norm = (t: string) => (t || '').replace(/[^가-힣0-9a-zA-Z]/g, '');
      const caps = useEditorStore
        .getState()
        .clips.filter((c) => c.type === 'text')
        .sort((a, b) => a.startTime - b.startTime);
      for (let i = 1; i < runs.length; i++) {
        const head = norm(blocks[runs[i].variant]?.text || '').slice(0, 6);
        if (head.length < 3) continue;
        const from = runs[i - 1].start + 0.5;
        const hit = caps.find((c) => c.startTime > from && norm(c.text || '').startsWith(head));
        if (hit && Math.abs(hit.startTime - runs[i].start) < 30) runs[i].start = hit.startTime;
      }
      for (let i = 0; i + 1 < runs.length; i++) runs[i].end = runs[i + 1].start;
    }
    setVariantRuns(runs.length > 1 ? runs : []);
    // 광고 구간으로 저장 (한 시퀀스에 광고 여러 개). 안쪽 경계는 자막보다 3프레임 앞 = 컷 위치 (편집자 방식)
    if (runs.length > 1) {
      const st = useEditorStore.getState();
      const seqName = st.sequence?.name || 'ad';
      const base = seqName.replace(/[_\s-]*0?\d+$/, '') || seqName;
      const lead = 3 / Math.max(1, fps);
      // 이미 있는 구간에 사람이 고른(또는 음성 만들기가 넣은) 후킹이 있으면 그대로 둔다 — 경계만 다시 잡는다
      const prevHooks = new Map(
        (st.sequences.find((q) => q.id === st.activeSequenceId)?.adSegments || []).filter((g) => g.hook).map((g) => [g.name, g.hook])
      );
      setAdSegments(
        runs.map((r, i) => {
          const name = `${base}_${String(r.variant + 1).padStart(2, '0')}`;
          return {
            id: `seg_${Date.now()}_${i}`,
            name,
            start: i === 0 ? 0 : Math.max(0, r.start - lead),
            end: i === runs.length - 1 ? r.end : Math.max(0, runs[i + 1].start - lead),
            hook: prevHooks.get(name) ?? r.hook,
          };
        })
      );
    }
  };

  // 무음 구간 자동 컷 편집 (여러 개를 다중 선택한 경우만 선택 클립 대상, 단일/미선택 시에는 트랙 전체 오디오 클립을 모두 처리해 #1만 잘리는 현상 방지)
  const handleAutoSilenceCut = async () => {
    if (!window.electronAPI) return;
    const pool = selectedMediaClips.length > 1 ? selectedMediaClips : allAudioOrVideoClips;
    const targets = pool.filter((c) => c.sourcePath);
    if (targets.length === 0) {
      setStatusMessage('무음 구간을 분석할 오디오/비디오 클립을 먼저 시퀀스에 배치해 주세요.');
      return;
    }

    setIsProcessing(true);
    let cutClipCount = 0;
    let totalSegments = 0;

    try {
      for (let i = 0; i < targets.length; i++) {
        // 앞 클립 무음 제거로 뒤 클립의 startTime 이 당겨졌을 수 있으므로 최신 스토어 상태에서 클립 조회
        const latestClip = useEditorStore.getState().clips.find((c) => c.id === targets[i].id) || targets[i];
        if (!latestClip.sourcePath) continue;
        setProgressText(`'${latestClip.name}' (${i + 1}/${targets.length}) 무음 구간 감지 및 컷 편집 중...`);

        const result = await window.electronAPI.detectSilence({
          filePath: latestClip.sourcePath,
          sourceStart: latestClip.sourceStart,
          duration: latestClip.duration * (latestClip.speed && latestClip.speed > 0 ? latestClip.speed : 1),
          noiseDb,
          minSilenceDuration: minSilenceDur,
          paddingMs,
        });

        if (result.speechSegments.length > 1) {
          replaceClipWithSegments(latestClip.id, result.speechSegments, rippleAfterSilence);
          cutClipCount++;
          totalSegments += result.speechSegments.length;
        }
      }

      if (cutClipCount === 0) {
        setStatusMessage(
          `감지된 무음 구간이 없습니다. (AI 음성에서 '쉼 최대 0.15초'로 생성한 경우 이미 0.15초 이하로 줄어 있으니 최소 무음 길이를 0.12~0.15초로 낮추거나 데시벨을 높여보세요.)`
        );
      } else if (targets.length > 1) {
        setStatusMessage(`오디오 클립 ${cutClipCount}개에서 무음 구간을 제거하여 총 ${totalSegments}개의 유음 컷으로 분할했습니다.`);
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

    </div>
  );

  return (
    <aside className="w-full bg-[#1d1d1d] border-r border-[#111111] flex flex-col h-full select-none text-[#cccccc]">
      {/* 상단 1 -> 2 -> 3 단계 탭 헤더 */}
      <div className="h-9 bg-[#161616] border-b border-[#2b2b2b] px-2 flex items-center gap-1 text-[11px]">
        <button
          onClick={() => setSubTab('step0-script')}
          title="AI 대본 만들기"
          className={`shrink-0 h-7 rounded px-2 flex items-center justify-center gap-1 font-semibold transition whitespace-nowrap ${
            subTab === 'step0-script'
              ? 'bg-[#2d8ceb] text-white shadow'
              : 'text-[#999999] hover:text-white hover:bg-[#222222]'
          }`}
        >
          <span>0. 대본</span>
        </button>

        <button
          onClick={() => setSubTab('step1-ai')}
          className={`flex-1 min-w-0 h-7 rounded px-1.5 flex items-center justify-center gap-1 font-semibold transition whitespace-nowrap ${
            subTab === 'step1-ai'
              ? 'bg-[#2d8ceb] text-white shadow'
              : 'text-[#999999] hover:text-white hover:bg-[#222222]'
          }`}
        >
          <span className="truncate">1. AI 캡션 생성</span>
        </button>

        <button
          onClick={() => setSubTab('step2-script')}
          className={`flex-1 min-w-0 h-7 rounded px-1.5 flex items-center justify-center gap-1 font-semibold transition whitespace-nowrap ${
            subTab === 'step2-script'
              ? 'bg-[#2d8ceb] text-white shadow'
              : 'text-[#999999] hover:text-white hover:bg-[#222222]'
          }`}
        >
          <span className="truncate">2. 대본 오타 변환</span>
          {subtitleClips.length > 0 && (
            <span className="px-1 rounded-full bg-black/30 text-[10px]">
              {subtitleClips.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setSubTab('step3-manage')}
          title="AI 자동 배치 · 음성 무음 제거"
          className={`flex-1 min-w-0 h-7 rounded px-1.5 flex items-center justify-center gap-1 font-semibold transition whitespace-nowrap ${
            subTab === 'step3-manage'
              ? 'bg-[#2d8ceb] text-white shadow'
              : 'text-[#999999] hover:text-white hover:bg-[#222222]'
          }`}
        >
          <span className="truncate">3. 자동배치·무음제거</span>
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
        {/* STEP 0: AI 대본 만들기 — 탭을 옮겨도 입력·결과가 남도록 늘 그려 두고 숨기기만 한다 */}
        <div className={subTab === 'step0-script' ? '' : 'hidden'}>
          <ScriptGenCard
            onSendToScript={(text) => {
              setScriptText(text);
              setSubTab('step2-script');
            }}
          />
        </div>

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

              <div className="flex items-center justify-between text-[11px] text-[#999999] bg-[#16181d] px-2.5 py-1.5 rounded border border-[#2c313c]">
                <span>받아쓰기 엔진:</span>
                <span className="text-white">로컬 Whisper Small (무료, 인터넷 불필요)</span>
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
                  STEP 1에서 음성으로 만든 캡션의 <strong>구간은 그대로 두고</strong>, 글자만 내 대본과 비교해 오타를 고칩니다.
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
                placeholder="여기에 정확한 원본 대본을 붙여넣으세요. 아래 버튼을 누르면 기존 캡션의 오타가 대본 글자로 바뀝니다."
                className="w-full bg-[#111318] border border-[#333947] focus:border-[#2ea043] rounded p-2.5 text-xs text-white placeholder-[#666666] focus:outline-none leading-relaxed select-text"
              />

              <button
                onClick={handleRunStep2CompareAndConvert}
                className="w-full py-2.5 px-3 bg-[#2ea043] hover:bg-[#268c39] text-white font-bold text-xs rounded-md shadow flex items-center justify-center gap-1.5 transition"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                기존 AI 캡션 구간 유지하며 오타만 비교/변환
              </button>
              {variantRuns.length > 1 && (
                <div className="bg-[#14161a] border border-[#2e3440] rounded p-2 space-y-1.5">
                  <div className="text-[11px] text-[#aaaaaa]">
                    음성에서 대본 {variantRuns.length}개를 찾아 <strong>광고 구간</strong>으로 저장했습니다 (타임라인 위 색 띠, 경계는
                    끌어서 옮길 수 있음). 음성 순서:{' '}
                    {variantRuns
                      .map((r) => `대본${r.variant + 1} ${formatFullTimecode(r.start, fps).slice(3)}~${formatFullTimecode(r.end, fps).slice(3)}${r.hook ? ` · 후킹 ${r.hook.fileNo}번 ${r.hook.from}~${r.hook.to}초` : ''}`)
                      .join(' / ')}
                  </div>
                  <button
                    onClick={() => {
                      const st = useEditorStore.getState();
                      const segs = st.sequences.find((q) => q.id === st.activeSequenceId)?.adSegments;
                      splitVariantsIntoSequences(
                        segs && segs.length > 1
                          ? segs.map((g, i) => ({ variant: i, start: g.start, end: g.end, hook: g.hook, name: g.name }))
                          : variantRuns
                      );
                    }}
                    className="w-full py-1.5 px-3 bg-[#2d8ceb] hover:bg-[#1e78d6] text-white font-semibold text-[11px] rounded transition"
                  >
                    (선택) 버전별 시퀀스로 나누기 ({variantRuns.length}개)
                  </button>
                </div>
              )}
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
            STEP 3: AI 자동 배치 + 음성 무음 제거
           ===================================================================== */}
        {subTab === 'step3-manage' && (
          <div className="space-y-3.5">
            <AutoEditCard />

            {/* 무음 구간 자동 컷 편집 */}
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
                  min={0.1}
                  max={2.0}
                  step={0.02}
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
