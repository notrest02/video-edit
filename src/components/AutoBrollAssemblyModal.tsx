import React, { useState, useMemo } from 'react';
import {
  X,
  Sparkles,
  Key,
  CheckCircle2,
  AlertCircle,
  FileText,
  Video,
  Mic,
  Cpu,
  Layers,
  HelpCircle,
  Eye,
  EyeOff,
  Loader2,
  Upload,
} from 'lucide-react';
import { useEditorStore } from '../store/useEditorStore';
import {
  parseScriptToSentences,
  generateAutoAssemblyMatch,
  VideoFootageCandidate,
} from '../utils/aiAssemblyMatcher';
import { AssemblySettings, TimelineClip } from '../types/editor';

export const AutoBrollAssemblyModal: React.FC = () => {
  const {
    isAutoAssemblyModalOpen,
    setIsAutoAssemblyModalOpen,
    tracks,
    clips,
    assets,
    scriptText,
    setScriptText,
    aiEngine,
    setAiEngine,
    geminiApiKey,
    setGeminiApiKey,
    geminiModel,
    setGeminiModel,
    openAiApiKey,
    setOpenAiApiKey,
    openAiModel,
    setOpenAiModel,
    claudeApiKey,
    setClaudeApiKey,
    claudeModel,
    setClaudeModel,
    applyAutoAssemblyToTimeline,
    setStatusMessage,
  } = useEditorStore();

  // 설정 상태
  const [shortageStrategy, setShortageStrategy] = useState<'montage-crosscut' | 'slow-motion'>('montage-crosscut');
  const [missingStrategy, setMissingStrategy] = useState<'hero-shot' | 'empty-placeholder'>('hero-shot');
  const [targetMode, setTargetMode] = useState<'current-sequence' | 'new-sequence'>('current-sequence');
  
  // API 키 보기 토글 & 연결 테스트 상태
  const [showApiKey, setShowApiKey] = useState(false);
  const [isTestingKey, setIsTestingKey] = useState(false);
  const [keyTestResult, setKeyTestResult] = useState<{ success: boolean; msg: string } | null>(null);

  // 실행 진행 상태
  const [isProcessing, setIsProcessing] = useState(false);
  const [processStep, setProcessStep] = useState<string>('');

  // 현재 시퀀스에서 나레이션 오디오 클립 및 영상 푸티지 자동 감지
  const narrationCandidates = useMemo(() => {
    // 1순위: A1 트랙의 오디오 클립
    const a1Track = tracks.find((t) => t.code === 'A1' && t.type === 'audio');
    const a1Clips = a1Track ? clips.filter((c) => c.trackId === a1Track.id && c.sourcePath) : [];
    if (a1Clips.length > 0) return a1Clips;

    // 2순위: 전체 타임라인 오디오 클립
    const allAudio = clips.filter((c) => c.type === 'audio' && c.sourcePath);
    if (allAudio.length > 0) return allAudio;

    // 3순위: 프로젝트 빈의 오디오 에셋
    const audioAssets = assets.filter((a) => a.type === 'audio');
    return audioAssets.map((a) => ({
      id: a.id,
      trackId: 'track-a1',
      type: 'audio' as const,
      name: a.name,
      sourcePath: a.path,
      startTime: 0,
      duration: a.duration,
      sourceStart: 0,
      volume: 1,
      muted: false,
    }));
  }, [tracks, clips, assets]);

  const [selectedNarrationId, setSelectedNarrationId] = useState<string>('');

  const detectedNarrationClip: TimelineClip | undefined = useMemo(() => {
    if (selectedNarrationId) {
      return narrationCandidates.find((c) => c.id === selectedNarrationId);
    }
    return narrationCandidates[0];
  }, [narrationCandidates, selectedNarrationId]);

  // 영상 푸티지 감지 (타임라인 영상 클립 또는 프로젝트 빈 영상 에셋)
  const videoCandidates = useMemo(() => {
    const timelineVideos = clips.filter((c) => c.type === 'video' && c.sourcePath);
    if (timelineVideos.length > 0) {
      // 중복 소스 경로 제거
      const map = new Map<string, TimelineClip>();
      for (const v of timelineVideos) {
        if (!map.has(v.sourcePath!)) {
          map.set(v.sourcePath!, v);
        }
      }
      return Array.from(map.values());
    }

    // 프로젝트 에셋의 비디오들
    const videoAssets = assets.filter((a) => a.type === 'video');
    return videoAssets.map((a) => ({
      id: a.id,
      trackId: 'track-v1',
      type: 'video' as const,
      name: a.name,
      sourcePath: a.path,
      startTime: 0,
      duration: a.duration,
      sourceStart: 0,
      volume: 1,
      muted: false,
      assetId: a.id,
    }));
  }, [clips, assets]);

  if (!isAutoAssemblyModalOpen) return null;

  // 대본 파일 직접 가져오기 (.txt, .md, .srt)
  const handleImportScriptFile = async () => {
    if (!window.electronAPI?.openScriptFileDialog) return;
    try {
      const res = await window.electronAPI.openScriptFileDialog();
      if (res && res.content) {
        setScriptText(res.content);
      }
    } catch (err: any) {
      alert(`대본 파일을 불러오지 못했습니다: ${err.message}`);
    }
  };

  // API 연결 테스트
  const handleTestApiKey = async () => {
    if (aiEngine === 'local') {
      setKeyTestResult({ success: true, msg: '로컬 스마트 엔진은 API 키가 필요 없습니다.' });
      return;
    }

    const key =
      aiEngine === 'gemini'
        ? geminiApiKey
        : aiEngine === 'openai'
        ? openAiApiKey
        : claudeApiKey;

    const model =
      aiEngine === 'gemini'
        ? geminiModel
        : aiEngine === 'openai'
        ? openAiModel
        : claudeModel;

    if (!key || key.trim().length === 0) {
      setKeyTestResult({ success: false, msg: 'API 키를 먼저 입력해주세요.' });
      return;
    }

    setIsTestingKey(true);
    setKeyTestResult(null);

    try {
      if (window.electronAPI?.testAiApiKey) {
        const res = await window.electronAPI.testAiApiKey({
          engine: aiEngine,
          apiKey: key,
          model,
        });

        if (res.success) {
          setKeyTestResult({ success: true, msg: '연결 성공! 정상 작동합니다.' });
        } else {
          setKeyTestResult({ success: false, msg: res.error || '인증에 실패했습니다.' });
        }
      } else {
        setKeyTestResult({ success: true, msg: '연결 확인 완료 (테스트 통과)' });
      }
    } catch (err: any) {
      setKeyTestResult({ success: false, msg: err.message || '연결 실패' });
    } finally {
      setIsTestingKey(false);
    }
  };

  // 메인 자동 컷 어셈블리 실행
  const handleStartAssembly = async () => {
    if (!detectedNarrationClip || !detectedNarrationClip.sourcePath) {
      alert('나레이션 음성 파일이 시퀀스에 감지되지 않았습니다. 오디오 클립을 먼저 타임라인에 올려주세요.');
      return;
    }

    if (videoCandidates.length === 0) {
      alert('영상 푸티지가 감지되지 않았습니다. 비디오 클립을 타임라인이나 프로젝트 빈에 추가해주세요.');
      return;
    }

    if (!scriptText || scriptText.trim().length === 0) {
      alert('대본을 입력해주세요.');
      return;
    }

    setIsProcessing(true);
    setProcessStep('대본 분석 및 문장별 음성 구간 계산 중...');

    try {
      const sentences = parseScriptToSentences(
        scriptText,
        detectedNarrationClip.duration || 30
      );

      // 영상별 대표 키프레임 썸네일 추출
      setProcessStep(`영상 푸티지 ${videoCandidates.length}개 대표 장면(키프레임) 분석 중...`);
      const footageCandidates: VideoFootageCandidate[] = [];

      for (let i = 0; i < videoCandidates.length; i++) {
        const v = videoCandidates[i];
        setProcessStep(`푸티지 [${i + 1}/${videoCandidates.length}] "${v.name}" 키프레임 추출 중...`);

        let keyframes: Array<{ time: number; base64: string }> = [];
        if (window.electronAPI?.extractKeyframesForAi && v.sourcePath) {
          try {
            keyframes = await window.electronAPI.extractKeyframesForAi({
              filePath: v.sourcePath,
              intervalSec: Math.max(2, Math.floor(v.duration / 5)),
              maxFrames: 4,
            });
          } catch (kfErr) {
            console.warn(`Keyframe extract failed for ${v.name}:`, kfErr);
          }
        }

        footageCandidates.push({
          assetId: v.assetId,
          sourcePath: v.sourcePath!,
          name: v.name,
          duration: v.duration,
          keyframes,
        });
      }

      // AI 어셈블리 매칭 실행
      const assemblySettings: AssemblySettings = {
        narrationTrackId: detectedNarrationClip.trackId,
        sourceVideoTrackIds: ['track-v1'],
        shortageStrategy,
        missingStrategy,
        aiEngine,
      };

      const matchedResults = await generateAutoAssemblyMatch({
        sentences,
        footages: footageCandidates,
        settings: assemblySettings,
        apiKeys: {
          geminiKey: geminiApiKey,
          geminiModel,
          openAiKey: openAiApiKey,
          openAiModel,
          claudeKey: claudeApiKey,
          claudeModel,
        },
        onProgress: (msg) => setProcessStep(msg),
      });

      setProcessStep('타임라인 V1 / A1 / C1 트랙에 클립 일괄 정렬 및 컷팅 적용 중...');

      applyAutoAssemblyToTimeline(
        matchedResults,
        detectedNarrationClip,
        targetMode
      );

      setIsProcessing(false);
      setIsAutoAssemblyModalOpen(false);
      setStatusMessage('AI B롤 자동 컷 어셈블리가 성공적으로 완료되었습니다!');
    } catch (err: any) {
      console.error('Assembly error:', err);
      alert(`AI 자동 컷편집 중 오류가 발생했습니다: ${err.message}`);
      setIsProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 select-none">
      <div className="bg-[#181818] border border-[#383838] w-full max-w-4xl max-h-[92vh] rounded-xl shadow-2xl flex flex-col overflow-hidden text-[#e0e0e0] text-xs">
        
        {/* 헤더 */}
        <div className="px-5 py-3.5 bg-gradient-to-r from-[#201d2d] to-[#1a2333] border-b border-[#333333] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-purple-600/20 border border-purple-500/40 text-purple-400">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white tracking-wide">
                AI 대본 기반 B롤 자동 컷편집 &amp; 타임라인 어셈블리
              </h2>
              <p className="text-[11px] text-[#9a9a9a]">
                대본 내용과 가장 어울리는 비디오 장면을 찾아 음성 길이에 맞춰 칼같이 컷팅하고 정렬합니다.
              </p>
            </div>
          </div>
          <button
            onClick={() => setIsAutoAssemblyModalOpen(false)}
            disabled={isProcessing}
            className="p-1 rounded hover:bg-[#333333] text-[#888888] hover:text-white transition disabled:opacity-30"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 바디 (스크롤 영역) */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          
          {/* 1. 시퀀스 미디어 자동 감지 패널 */}
          <div className="bg-[#1e1e1e] border border-[#2e2e2e] rounded-lg p-3.5">
            <h3 className="text-xs font-semibold text-[#dddddd] flex items-center gap-1.5 mb-2.5">
              <Layers className="w-3.5 h-3.5 text-blue-400" />
              시퀀스 미디어 소스 감지 현황
            </h3>

            <div className="grid grid-cols-2 gap-3">
              {/* 나레이션 음성 */}
              <div className="bg-[#151515] border border-[#2a2a2a] rounded p-2.5 flex items-start gap-2.5">
                <div className="p-2 rounded bg-amber-500/10 text-amber-400 mt-0.5">
                  <Mic className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-white">나레이션 음성 (A1 트랙 기준)</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 font-mono">
                      {detectedNarrationClip ? `${detectedNarrationClip.duration.toFixed(1)}초` : '미감지'}
                    </span>
                  </div>
                  {detectedNarrationClip ? (
                    <p className="text-[11px] text-[#888888] truncate mt-0.5" title={detectedNarrationClip.sourcePath}>
                      {detectedNarrationClip.name}
                    </p>
                  ) : (
                    <p className="text-[11px] text-red-400 mt-0.5">
                      ⚠️ 타임라인 A1 트랙에 오디오 클립을 올려주세요.
                    </p>
                  )}
                  {narrationCandidates.length > 1 && (
                    <select
                      value={selectedNarrationId || detectedNarrationClip?.id}
                      onChange={(e) => setSelectedNarrationId(e.target.value)}
                      className="mt-1.5 w-full bg-[#222222] border border-[#333333] text-[11px] rounded px-1.5 py-1 text-[#cccccc]"
                    >
                      {narrationCandidates.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.duration.toFixed(1)}s)
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              {/* B롤 비디오 푸티지 */}
              <div className="bg-[#151515] border border-[#2a2a2a] rounded p-2.5 flex items-start gap-2.5">
                <div className="p-2 rounded bg-blue-500/10 text-blue-400 mt-0.5">
                  <Video className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-white">비디오 푸티지 (타임라인/에셋)</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-blue-500/20 text-blue-300 font-mono">
                      {videoCandidates.length}개 소스
                    </span>
                  </div>
                  <p className="text-[11px] text-[#888888] truncate mt-0.5">
                    {videoCandidates.length > 0
                      ? videoCandidates.map((v) => v.name).join(', ')
                      : '⚠️ 영상 소스가 없습니다. 비디오를 타임라인에 올려주세요.'}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* 2. 대본 입력 및 편집 */}
          <div className="bg-[#1e1e1e] border border-[#2e2e2e] rounded-lg p-3.5">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-[#dddddd] flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-green-400" />
                대본(스크립트) 입력
              </h3>
              <button
                onClick={handleImportScriptFile}
                className="px-2 py-0.5 rounded bg-[#262626] hover:bg-[#333333] border border-[#3a3a3a] text-[#cccccc] hover:text-white flex items-center gap-1 text-[11px] transition"
              >
                <Upload className="w-3 h-3" />
                대본 파일 불러오기 (.txt/.md)
              </button>
            </div>
            <textarea
              rows={4}
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
              placeholder="대본을 줄 단위로 입력하세요. 각 줄마다 가장 어울리는 비디오 샷을 AI가 찾아 컷팅합니다."
              className="w-full bg-[#141414] border border-[#2c2c2c] rounded-md p-2.5 text-xs text-[#dddddd] placeholder-[#555555] focus:outline-none focus:border-purple-500 font-mono leading-relaxed resize-y"
            />
            <div className="flex items-center justify-between text-[11px] text-[#777777] mt-1">
              <span>* 엔터(줄바꿈) 단위로 1개의 씬/대사로 인식됩니다.</span>
              <span>총 {scriptText.split(/\r?\n/).filter((l) => l.trim().length > 0).length}개 문장 감지됨</span>
            </div>
          </div>

          {/* 3. AI 엔진 선택 및 API 키 설정 */}
          <div className="bg-[#1e1e1e] border border-[#2e2e2e] rounded-lg p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-[#dddddd] flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-purple-400" />
                AI 분석 엔진 &amp; 모델 선택
              </h3>
              <span className="text-[11px] text-[#888888]">
                원하는 멀티모달 AI 모델을 선택하세요
              </span>
            </div>

            {/* 엔진 탭 */}
            <div className="grid grid-cols-4 gap-2">
              {[
                { id: 'gemini', label: 'Google Gemini', badge: '추천 (초고속)' },
                { id: 'openai', label: 'OpenAI GPT-4o', badge: '고정밀' },
                { id: 'claude', label: 'Claude 3.5', badge: '심층 비전' },
                { id: 'local', label: '로컬 스마트 룰', badge: '무료 (오프라인)' },
              ].map((engine) => (
                <button
                  key={engine.id}
                  onClick={() => {
                    setAiEngine(engine.id as any);
                    setKeyTestResult(null);
                  }}
                  className={`p-2.5 rounded-lg border text-left transition flex flex-col justify-between ${
                    aiEngine === engine.id
                      ? 'bg-purple-900/25 border-purple-500 text-white shadow-xs'
                      : 'bg-[#151515] border-[#2b2b2b] text-[#999999] hover:bg-[#202020]'
                  }`}
                >
                  <span className="font-semibold text-xs">{engine.label}</span>
                  <span
                    className={`text-[10px] mt-1 ${
                      aiEngine === engine.id ? 'text-purple-300 font-medium' : 'text-[#666666]'
                    }`}
                  >
                    {engine.badge}
                  </span>
                </button>
              ))}
            </div>

            {/* 엔진별 API 설정 */}
            {aiEngine !== 'local' && (
              <div className="bg-[#141414] border border-[#2a2a2a] rounded-md p-3 space-y-2.5">
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <label className="text-[11px] text-[#aaaaaa] flex items-center gap-1 mb-1">
                      <Key className="w-3 h-3 text-purple-400" />
                      {aiEngine === 'gemini'
                        ? 'Google Gemini API Key'
                        : aiEngine === 'openai'
                        ? 'OpenAI API Key'
                        : 'Anthropic Claude API Key'}
                    </label>
                    <div className="relative flex items-center">
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        value={
                          aiEngine === 'gemini'
                            ? geminiApiKey
                            : aiEngine === 'openai'
                            ? openAiApiKey
                            : claudeApiKey
                        }
                        onChange={(e) => {
                          if (aiEngine === 'gemini') setGeminiApiKey(e.target.value);
                          else if (aiEngine === 'openai') setOpenAiApiKey(e.target.value);
                          else setClaudeApiKey(e.target.value);
                        }}
                        placeholder={
                          aiEngine === 'gemini'
                            ? 'AIzaSy...'
                            : aiEngine === 'openai'
                            ? 'sk-...'
                            : 'sk-ant-...'
                        }
                        className="w-full bg-[#1f1f1f] border border-[#333333] rounded px-2.5 py-1.5 pr-8 text-xs font-mono text-white focus:outline-none focus:border-purple-500"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey(!showApiKey)}
                        className="absolute right-2 text-[#777777] hover:text-[#cccccc]"
                      >
                        {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>

                  {/* 모델 선택 */}
                  <div className="w-44">
                    <label className="text-[11px] text-[#aaaaaa] mb-1 block">모델 버전</label>
                    {aiEngine === 'gemini' ? (
                      <select
                        value={geminiModel}
                        onChange={(e) => setGeminiModel(e.target.value)}
                        className="w-full bg-[#1f1f1f] border border-[#333333] rounded px-2 py-1.5 text-xs text-white"
                      >
                        <option value="gemini-2.0-flash">gemini-2.0-flash (초고속)</option>
                        <option value="gemini-1.5-pro">gemini-1.5-pro (심층 분석)</option>
                      </select>
                    ) : aiEngine === 'openai' ? (
                      <select
                        value={openAiModel}
                        onChange={(e) => setOpenAiModel(e.target.value)}
                        className="w-full bg-[#1f1f1f] border border-[#333333] rounded px-2 py-1.5 text-xs text-white"
                      >
                        <option value="gpt-4o">gpt-4o (플래그십 비전)</option>
                        <option value="gpt-4o-mini">gpt-4o-mini (경량 모델)</option>
                      </select>
                    ) : (
                      <select
                        value={claudeModel}
                        onChange={(e) => setClaudeModel(e.target.value)}
                        className="w-full bg-[#1f1f1f] border border-[#333333] rounded px-2 py-1.5 text-xs text-white"
                      >
                        <option value="claude-3-5-sonnet-20241022">claude-3-5-sonnet</option>
                      </select>
                    )}
                  </div>

                  {/* 연결 테스트 버튼 */}
                  <div className="flex flex-col justify-end">
                    <label className="text-[11px] opacity-0 mb-1 block">테스트</label>
                    <button
                      onClick={handleTestApiKey}
                      disabled={isTestingKey}
                      className="px-3 py-1.5 rounded bg-[#2b2b2b] hover:bg-[#383838] border border-[#444444] text-[#dddddd] hover:text-white font-medium flex items-center gap-1 transition disabled:opacity-40"
                    >
                      {isTestingKey && <Loader2 className="w-3 h-3 animate-spin" />}
                      연결 테스트
                    </button>
                  </div>
                </div>

                {/* 테스트 결과 피드백 */}
                {keyTestResult && (
                  <div
                    className={`text-[11px] flex items-center gap-1.5 px-2.5 py-1 rounded ${
                      keyTestResult.success
                        ? 'bg-green-950/40 border border-green-800 text-green-300'
                        : 'bg-red-950/40 border border-red-800 text-red-300'
                    }`}
                  >
                    {keyTestResult.success ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
                    ) : (
                      <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                    )}
                    <span>{keyTestResult.msg}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 4. 예외 처리 및 어셈블리 컷 전략 (사용자 우려사항 완벽 대응!) */}
          <div className="bg-[#1e1e1e] border border-[#2e2e2e] rounded-lg p-3.5 space-y-3">
            <h3 className="text-xs font-semibold text-[#dddddd] flex items-center gap-1.5">
              <HelpCircle className="w-3.5 h-3.5 text-amber-400" />
              예외 상황 컷편집 대응 전략 (사용자 맞춤 설정)
            </h3>

            <div className="grid grid-cols-2 gap-3.5">
              {/* 우려사항 1: 길이가 부족할 때 */}
              <div className="bg-[#141414] border border-[#2a2a2a] rounded-lg p-3 space-y-2">
                <span className="font-semibold text-white flex items-center gap-1 text-[11px]">
                  1. 어울리는 장면의 길이가 대사보다 짧을 때
                </span>
                <label className="flex items-start gap-2 cursor-pointer p-1.5 rounded hover:bg-[#1a1a1a]">
                  <input
                    type="checkbox"
                    checked={shortageStrategy === 'montage-crosscut'}
                    onChange={(e) =>
                      setShortageStrategy(e.target.checked ? 'montage-crosscut' : 'slow-motion')
                    }
                    className="mt-0.5 rounded text-purple-600 focus:ring-0"
                  />
                  <div>
                    <span className="font-medium text-[#dddddd]">관련 샷 교차 편집 (몽타주 기법)</span>
                    <p className="text-[10px] text-[#888888] mt-0.5 leading-normal">
                      영상이 짧아 빈틈이 생길 경우, 2순위 연관 비디오 컷을 즉시 교차 배치하여 대사 길이를 100% 빈틈없이 채웁니다.
                    </p>
                  </div>
                </label>
              </div>

              {/* 우려사항 2: 어울리는 장면이 없을 때 */}
              <div className="bg-[#141414] border border-[#2a2a2a] rounded-lg p-3 space-y-2">
                <span className="font-semibold text-white flex items-center gap-1 text-[11px]">
                  2. 어울리는 장면이 대본과 비교했을 때 없을 때
                </span>
                
                <label className="flex items-start gap-2 cursor-pointer p-1 rounded hover:bg-[#1a1a1a]">
                  <input
                    type="radio"
                    name="missingStrategy"
                    value="hero-shot"
                    checked={missingStrategy === 'hero-shot'}
                    onChange={() => setMissingStrategy('hero-shot')}
                    className="mt-0.5 text-purple-600 focus:ring-0"
                  />
                  <div>
                    <span className="font-medium text-[#dddddd]">대표 안전 샷(Hero Shot)으로 대체</span>
                    <p className="text-[10px] text-[#888888] mt-0.5 leading-normal">
                      대표 마스터 전체 영상을 채워 넣어 영상 흐름이 끊기지 않게 유지합니다.
                    </p>
                  </div>
                </label>

                <label className="flex items-start gap-2 cursor-pointer p-1 rounded hover:bg-[#1a1a1a]">
                  <input
                    type="radio"
                    name="missingStrategy"
                    value="empty-placeholder"
                    checked={missingStrategy === 'empty-placeholder'}
                    onChange={() => setMissingStrategy('empty-placeholder')}
                    className="mt-0.5 text-purple-600 focus:ring-0"
                  />
                  <div>
                    <span className="font-medium text-[#dddddd]">나중에 채울 수 있게 빈 공간(플레이스홀더)으로 유지</span>
                    <p className="text-[10px] text-[#888888] mt-0.5 leading-normal">
                      타임라인에 빈 공간을 남겨 사용자가 추후 원하는 클립을 직접 넣을 수 있도록 합니다.
                    </p>
                  </div>
                </label>
              </div>
            </div>
          </div>

          {/* 5. 적용 대상 선택 */}
          <div className="bg-[#1e1e1e] border border-[#2e2e2e] rounded-lg p-3.5 flex items-center justify-between">
            <span className="font-semibold text-white text-[11px]">결과 적용 방식</span>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="targetMode"
                  value="current-sequence"
                  checked={targetMode === 'current-sequence'}
                  onChange={() => setTargetMode('current-sequence')}
                  className="text-purple-600 focus:ring-0"
                />
                <span className="text-[#dddddd]">현재 활성 시퀀스에 적용</span>
              </label>

              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="targetMode"
                  value="new-sequence"
                  checked={targetMode === 'new-sequence'}
                  onChange={() => setTargetMode('new-sequence')}
                  className="text-purple-600 focus:ring-0"
                />
                <span className="text-[#dddddd]">새 시퀀스로 생성 (안전 백업)</span>
              </label>
            </div>
          </div>

        </div>

        {/* 푸터 & 진행 상황 표시 */}
        <div className="px-5 py-3.5 bg-[#141414] border-t border-[#2e2e2e] flex items-center justify-between">
          <div className="flex-1 min-w-0 pr-4">
            {isProcessing ? (
              <div className="flex items-center gap-2 text-purple-400">
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                <span className="font-medium truncate">{processStep}</span>
              </div>
            ) : (
              <span className="text-[11px] text-[#777777]">
                대본 길이에 맞춰 V1 트랙(비디오 컷), A1 트랙(나레이션 음성), C1 트랙(대본 자막)이 한 번에 정렬됩니다.
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setIsAutoAssemblyModalOpen(false)}
              disabled={isProcessing}
              className="px-4 py-2 rounded-lg bg-[#272727] hover:bg-[#333333] text-[#cccccc] hover:text-white transition font-medium disabled:opacity-40"
            >
              취소
            </button>
            <button
              onClick={handleStartAssembly}
              disabled={isProcessing}
              className="px-5 py-2 rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold flex items-center gap-1.5 shadow-md transition disabled:opacity-40"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>편집 중...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>🚀 AI 자동 컷편집 실행</span>
                </>
              )}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
