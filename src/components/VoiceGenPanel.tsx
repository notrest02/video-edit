/**
 * STEP 0 결과 아래 'AI 음성 만들기 (Typecast / ElevenLabs)': 버전마다 음성 파일 + 단어 시간 정보 → 미디어 + 버전별 시퀀스(<제품>_01 …)
 *  - API 키는 메인 프로세스에만 저장 (화면에는 연결 여부·남은 크레딧만)
 *  - 목소리는 모든 버전 같게(기본) 또는 버전마다 다르게. 미리듣기는 샘플 주소에 속도·음높이를 대략 적용
 *  - Typecast: 감정(smart 추천 / 프리셋 + 세기), 속도, 음높이, 쉼 줄이기
 *  - ElevenLabs: 모델(다국어 v2 추천 / Flash / Turbo), 안정성, 유사도, 스타일 과장, 속도, 음높이, 쉼 줄이기
 */
import React, { useEffect, useRef, useState } from 'react';
import { AudioLines, FolderOpen, Loader2, Play, RefreshCw, Square } from 'lucide-react';
import { useEditorStore } from '../store/useEditorStore';
import { useElevenKey, useTypecastKey } from './TypecastKeyBox';
import type { ElevenVoice, MediaAsset, TypecastVoice } from '../types/editor';
import { HOOK_SPEC, videoNumbers, type ScriptVersion } from '../utils/scriptGen';

const input =
  'w-full bg-[#111318] border border-[#333947] focus:border-[#2d8ceb] rounded px-2 py-1.5 text-xs text-white placeholder-[#666666] focus:outline-none';
const btn = 'py-1.5 px-2.5 rounded text-[11px] font-semibold transition disabled:opacity-45';
const label = 'text-[11px] text-[#cccccc]';

const EMOTIONS: Array<{ id: string; label: string }> = [
  { id: 'smart', label: '자동 (문맥 보고, 추천)' },
  { id: 'normal', label: '보통' },
  { id: 'happy', label: '기쁨' },
  { id: 'toneup', label: '톤 업 (밝게)' },
  { id: 'tonedown', label: '톤 다운 (차분하게)' },
  { id: 'sad', label: '슬픔' },
  { id: 'angry', label: '화남' },
  { id: 'whisper', label: '속삭임' },
];
const ELEVEN_MODELS: Array<{ id: string; label: string }> = [
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2 (한국어 자연스러움, 추천)' },
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 (빠르고 크레딧 절약)' },
  { id: 'eleven_turbo_v2_5', label: 'Turbo v2.5 (균형형)' },
];
const SILENCE = [
  { v: -1, label: '쉼 그대로' },
  { v: 100, label: '쉼 최대 0.1초' },
  { v: 150, label: '쉼 최대 0.15초 (추천)' },
  { v: 200, label: '쉼 최대 0.2초' },
  { v: 300, label: '쉼 최대 0.3초' },
];
const AGE_LABEL: Record<string, string> = {
  child: '어린이',
  teenager: '10대',
  young: '청년',
  young_adult: '청년',
  middle_aged: '중년',
  middle_age: '중년',
  old: '노년',
  elder: '노년',
};
const GENDER_LABEL: Record<string, string> = { male: '남', female: '여' };
const CATEGORY_LABEL: Record<string, string> = {
  premade: '기본(무료 가능)',
  cloned: '내 복제',
  generated: '생성됨',
  professional: '프로',
  shared_ko: '한국인 성우(유료 전용)',
};
const FOLDER_KEY = 'voiceGen.lastFolder.v1';
const VOICE_KEY_TC = 'voiceGen.lastVoice.v1';
const VOICE_KEY_EL = 'voiceGen.lastVoice.eleven.v1';
const PROVIDER_KEY = 'voiceGen.provider.v1';

export type VoiceProvider = 'typecast' | 'elevenlabs';

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '').trim() || '대본';
const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
const errText = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const tcVoiceLabel = (v: TypecastVoice) =>
  `${v.isKorean ? '🇰🇷 ' : ''}${v.name}${v.gender ? ` · ${GENDER_LABEL[v.gender] || v.gender}` : ''}${v.age ? ` · ${AGE_LABEL[v.age] || v.age}` : ''}${
    v.useCases.length ? ` · ${v.useCases.slice(0, 2).join(', ')}` : ''
  }`;

const elVoiceLabel = (v: ElevenVoice) =>
  `${v.isKorean ? '🇰🇷 ' : ''}${v.name}${v.category ? ` [${CATEGORY_LABEL[v.category] || v.category}]` : ''}${
    v.gender ? ` · ${GENDER_LABEL[v.gender] || v.gender}` : ''
  }${v.age ? ` · ${AGE_LABEL[v.age] || v.age}` : ''}${v.useCase ? ` · ${v.useCase}` : ''}`;

type Props = {
  versions: ScriptVersion[];
  product: string;
  videos: MediaAsset[];
};

export const VoiceGenPanel: React.FC<Props> = ({ versions, product, videos }) => {
  const api = window.electronAPI;
  const { createVoiceSequences, setStatusMessage } = useEditorStore();
  const tcKey = useTypecastKey();
  const elKey = useElevenKey();

  const [provider, setProvider] = useState<VoiceProvider>(() => {
    const saved = localStorage.getItem(PROVIDER_KEY);
    return saved === 'elevenlabs' ? 'elevenlabs' : 'typecast';
  });

  // 한쪽 키만 연결되어 있으면 자동으로 그 서비스 탭을 선택
  useEffect(() => {
    if (tcKey.hasKey === false && elKey.hasKey === true && provider === 'typecast') {
      setProvider('elevenlabs');
    } else if (elKey.hasKey === false && tcKey.hasKey === true && provider === 'elevenlabs') {
      setProvider('typecast');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tcKey.hasKey, elKey.hasKey]);

  const changeProvider = (p: VoiceProvider) => {
    audioRef.current?.pause();
    setPlaying('');
    setProvider(p);
    localStorage.setItem(PROVIDER_KEY, p);
    setProgress('');
    setErrors([]);
  };

  const hasKey = provider === 'typecast' ? tcKey.hasKey : elKey.hasKey;
  const sub = provider === 'typecast' ? tcKey.sub : elKey.sub;
  const refreshSub = provider === 'typecast' ? tcKey.refresh : elKey.refresh;

  const [tcVoices, setTcVoices] = useState<TypecastVoice[]>([]);
  const [elVoices, setElVoices] = useState<ElevenVoice[]>([]);
  const [gender, setGender] = useState('');
  const [age, setAge] = useState('');
  const [koreanOnly, setKoreanOnly] = useState(true);

  const [tcVoiceId, setTcVoiceId] = useState(() => localStorage.getItem(VOICE_KEY_TC) || '');
  const [elVoiceId, setElVoiceId] = useState(() => localStorage.getItem(VOICE_KEY_EL) || '');
  const voiceId = provider === 'typecast' ? tcVoiceId : elVoiceId;
  const setVoiceId = (id: string) => (provider === 'typecast' ? setTcVoiceId(id) : setElVoiceId(id));

  const [perVersion, setPerVersion] = useState(false);
  const [versionVoices, setVersionVoices] = useState<string[]>([]);

  // Typecast 전용 설정
  const [emotion, setEmotion] = useState('smart');
  const [intensity, setIntensity] = useState(1);

  // ElevenLabs 전용 설정
  const [elModel, setElModel] = useState('eleven_multilingual_v2');
  const [stability, setStability] = useState(0.5);
  const [similarity, setSimilarity] = useState(0.75);
  const [styleExag, setStyleExag] = useState(0.0);

  // 공통 설정
  const [tempo, setTempo] = useState(1);
  const [pitch, setPitch] = useState(0);
  const [silence, setSilence] = useState(150);
  const [folder, setFolder] = useState('');
  const [makeSeqs, setMakeSeqs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [playing, setPlaying] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const base = safeName(product);
  const credits = versions.reduce((n, v) => n + v.lines.join('\n').length, 0);

  useEffect(() => api?.onTypecastProgress?.((m) => setProgress(m)), [api]);
  useEffect(() => {
    if (!tcKey.hasKey) setTcVoices([]);
  }, [tcKey.hasKey]);
  useEffect(() => {
    if (!elKey.hasKey) setElVoices([]);
  }, [elKey.hasKey]);

  // 목소리 목록 불러오기
  const loadVoices = async () => {
    if (provider === 'typecast') {
      if (!api?.typecastVoices) return;
      setProgress('Typecast 목소리 목록을 불러오는 중...');
      try {
        const list = await api.typecastVoices({ gender: gender || undefined, age: age || undefined });
        setTcVoices(list);
        const koCnt = list.filter((v) => v.isKorean).length;
        setProgress(`Typecast 목소리 ${list.length}개 중 한국어 성우 ${koCnt}개를 찾았어요.`);
        const visible = koreanOnly ? list.filter((v) => v.isKorean) : list;
        if (!visible.some((v) => v.id === tcVoiceId) && visible[0]) setTcVoiceId(visible[0].id);
      } catch (e) {
        setProgress(`목소리 목록 실패: ${errText(e)}`);
      }
    } else {
      if (!api?.elevenVoices) return;
      setProgress('ElevenLabs 목소리 목록을 불러오는 중...');
      try {
        const list = await api.elevenVoices({ gender: gender || undefined, age: age || undefined });
        setElVoices(list);
        const koCnt = list.filter((v) => v.isKorean).length;
        const isFree = sub?.plan?.toLowerCase() === 'free';
        setProgress(
          isFree
            ? `한국인 성우 ${koCnt}개 + 기본 목소리 ${list.length - koCnt}개를 불러왔어요. (참고: ElevenLabs 무료 요금제는 ▶ 미리듣기만 한국인 성우가 가능하고, 실제 생성은 [기본(무료 가능)] 목소리만 허용돼요)`
            : `ElevenLabs 한국인 성우 ${koCnt}개를 포함해 총 ${list.length}개를 불러왔어요.`
        );
        const visible = koreanOnly ? list.filter((v) => v.isKorean) : list;
        const listToPick = visible.length ? visible : list;
        const firstUsable = listToPick.find((v) => !v.requiresPaid) || listToPick[0];
        if (!listToPick.some((v) => v.id === elVoiceId) && firstUsable) setElVoiceId(firstUsable.id);
      } catch (e) {
        setProgress(`목소리 목록 실패: ${errText(e)}`);
      }
    }
  };

  useEffect(() => {
    if (hasKey) loadVoices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, hasKey, gender, age]);

  useEffect(() => {
    if (tcVoiceId) localStorage.setItem(VOICE_KEY_TC, tcVoiceId);
  }, [tcVoiceId]);
  useEffect(() => {
    if (elVoiceId) localStorage.setItem(VOICE_KEY_EL, elVoiceId);
  }, [elVoiceId]);
  useEffect(() => setVersionVoices((vv) => versions.map((_, i) => vv[i] || voiceId)), [versions, voiceId]);

  // 저장 폴더 기본값: 원본 영상 폴더 안 '<제품>_음성' → 없으면 마지막에 쓴 폴더
  useEffect(() => {
    if (folder) return;
    const v = videos[0];
    if (v) setFolder(`${dirOf(v.path)}\\${base}_음성`);
    else setFolder(localStorage.getItem(FOLDER_KEY) || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos.length, base]);

  const previewUrlOf = (id: string): string | null => {
    if (provider === 'typecast') return tcVoices.find((v) => v.id === id)?.previewUrl ?? null;
    return elVoices.find((v) => v.id === id)?.previewUrl ?? null;
  };

  // 바로 듣기 (무료, 대략): 미리듣기 샘플에 지금 속도·음높이를 적용해서 (메인 프로세스 ffmpeg). 감정·스타일은 반영 안 됨
  const preview = async (id: string) => {
    const url = previewUrlOf(id);
    if (!url) {
      setProgress('이 목소리는 미리듣기 샘플이 없어요.');
      return;
    }
    audioRef.current?.pause();
    if (playing === id) {
      setPlaying('');
      return;
    }
    try {
      const src = (tempo !== 1 || pitch !== 0) && api?.typecastPreview ? await api.typecastPreview({ url, tempo, pitch }) : url;
      const a = new Audio(src);
      audioRef.current = a;
      a.onended = () => setPlaying('');
      await a.play();
      setPlaying(id);
    } catch (e) {
      setProgress(`미리듣기를 재생하지 못했어요: ${errText(e)}`);
    }
  };

  const pickFolder = async () => {
    const f = await api?.chooseFolderDialog?.('음성 파일을 저장할 폴더');
    if (f) setFolder(f);
  };

  const run = async () => {
    if (!folder) return;
    if (sub && sub.planCredits > 0 && credits > sub.remaining) {
      setProgress(`크레딧이 모자라요: 필요 약 ${credits.toLocaleString()} / 남은 ${sub.remaining.toLocaleString()}`);
      return;
    }
    setBusy(true);
    setErrors([]);
    setProgress('시작...');
    localStorage.setItem(FOLDER_KEY, folder);
    try {
      const res =
        provider === 'typecast'
          ? await api!.typecastSynthesize!({
              folder,
              items: versions.map((v, i) => ({
                name: `${base}_${String(i + 1).padStart(2, '0')}`,
                text: v.lines.map((l) => l.trim()).filter(Boolean).join('\n'),
                voiceId: perVersion ? versionVoices[i] || voiceId : voiceId,
                emotion,
                intensity,
                tempo,
                pitch,
              })),
              removeSilenceMs: silence < 0 ? null : silence,
              format: 'mp3',
            })
          : await api!.elevenSynthesize!({
              folder,
              items: versions.map((v, i) => ({
                name: `${base}_${String(i + 1).padStart(2, '0')}`,
                text: v.lines.map((l) => l.trim()).filter(Boolean).join('\n'),
                voiceId: perVersion ? versionVoices[i] || voiceId : voiceId,
                modelId: elModel,
                stability,
                similarityBoost: similarity,
                style: styleExag,
                speed: tempo,
                pitch,
              })),
              removeSilenceMs: silence < 0 ? null : silence,
              format: 'mp3',
            });

      const ok = res.filter((r) => r.ok && r.asset);
      setErrors(res.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`));
      if (ok.length && makeSeqs) {
        const v0 = videos[0];
        const size = { width: v0?.width || 1080, height: v0?.height || 1920, fps: v0?.fps || 30 };
        // 대본의 'n번' = 대본 만들기 화면과 같은 번호 → 영상 경로까지 같이 저장 (자동 배치가 번호를 헷갈리지 않게)
        const nums = videoNumbers(videos);
        const seqItems = ok.map((r) => {
          const i = res.indexOf(r);
          const ver = versions[i];
          const m = ver.hookSpec.match(HOOK_SPEC);
          const fileNo = m ? Number(m[2]) : 0;
          const vid = videos.find((v) => nums.get(v.id) === fileNo);
          return {
            name: r.name,
            audio: r.asset!,
            script: [ver.hookSpec.trim(), ...ver.lines.map((l) => l.trim()).filter(Boolean)].join('\n'),
            hook: m && vid ? { sec: Number(m[1]), fileNo, from: Number(m[3]), to: Number(m[4]), note: m[5].trim(), path: vid.path } : null,
          };
        });
        createVoiceSequences(seqItems, size, base);
      } else if (ok.length) {
        useEditorStore.getState().addAssets(ok.map((r) => r.asset!));
      }
      const used = ok.reduce((n, r) => n + (r.credits || 0), 0);
      const provLabel = provider === 'typecast' ? 'Typecast' : 'ElevenLabs';
      setProgress(
        `${provLabel} 음성 ${ok.length}/${res.length}개를 만들었어요${
          makeSeqs && ok.length ? ` · 시퀀스 '${base}' 하나에 순서대로 놓고 광고 구간을 표시했어요` : ' · 미디어에 올렸어요'
        } · 약 ${used.toLocaleString()}자. 저장 위치: ${folder}`
      );
      setStatusMessage(`${provLabel} 음성 ${ok.length}개 완료`);
      refreshSub();
    } catch (e) {
      setProgress(`실패: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const filteredTc = koreanOnly ? tcVoices.filter((v) => v.isKorean) : tcVoices;
  const filteredEl = koreanOnly ? elVoices.filter((v) => v.isKorean) : elVoices;

  const voiceOptions =
    provider === 'typecast'
      ? (filteredTc.length ? filteredTc : tcVoices).map((v) => ({ id: v.id, label: tcVoiceLabel(v), requiresPaid: false }))
      : (filteredEl.length ? filteredEl : elVoices).map((v) => ({ id: v.id, label: elVoiceLabel(v), requiresPaid: Boolean(v.requiresPaid) }));

  // koreanOnly 토글 시 현재 선택된 목소리가 목록에 없으면 첫 번째 항목으로 자동 변경
  useEffect(() => {
    if (voiceOptions.length && !voiceOptions.some((v) => v.id === voiceId)) {
      const preferred = voiceOptions.find((v) => !v.requiresPaid) || voiceOptions[0];
      setVoiceId(preferred.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [koreanOnly, provider, tcVoices.length, elVoices.length]);

  const selectedElVoice = provider === 'elevenlabs' ? elVoices.find((v) => v.id === voiceId) : undefined;

  return (
    <div className="bg-[#14161a] border border-[#2e3440] rounded p-2 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-white flex items-center gap-1.5 text-[12px]">
          <AudioLines className="w-4 h-4 text-[#2d8ceb]" />
          AI 음성 만들기
        </div>
        {/* 서비스 선택 탭 */}
        <div className="flex rounded bg-[#0e1014] p-0.5 border border-[#2e3440] text-[10px]">
          <button
            onClick={() => changeProvider('typecast')}
            className={`px-2 py-0.5 rounded font-semibold transition ${
              provider === 'typecast' ? 'bg-[#2d8ceb] text-white' : 'text-[#999999] hover:text-white'
            }`}
          >
            Typecast
          </button>
          <button
            onClick={() => changeProvider('elevenlabs')}
            className={`px-2 py-0.5 rounded font-semibold transition ${
              provider === 'elevenlabs' ? 'bg-[#2d8ceb] text-white' : 'text-[#999999] hover:text-white'
            }`}
          >
            ElevenLabs
          </button>
        </div>
      </div>

      {/* 키는 STEP 0 위쪽 API 키 칸에서 (여기는 상태만) */}
      {hasKey === false && (
        <div className="text-[11px] text-[#ffb4b4] leading-relaxed">
          {provider === 'typecast' ? 'Typecast' : 'ElevenLabs'} API 키가 없어요. 이 탭 맨 위의 '{provider === 'typecast' ? 'Typecast' : 'ElevenLabs'} API 키' 칸에서 먼저 연결해 주세요.
        </div>
      )}
      {hasKey && sub && (
        <div className="text-[10px] text-[#7ee787]">
          {provider === 'typecast' ? 'Typecast' : 'ElevenLabs'} 연결됨 · {sub.plan}
          {sub.planCredits > 0 ? ` · 남은 ${sub.remaining.toLocaleString()}${provider === 'typecast' ? '크레딧' : '자'}` : ''}
        </div>
      )}

      {hasKey && (
        <>
          {/* 목소리 */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className={label}>목소리</span>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-[10px] text-[#7ee787] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={koreanOnly}
                    onChange={(e) => setKoreanOnly(e.target.checked)}
                    className="accent-[#2d8ceb]"
                  />
                  🇰🇷 한국어 성우만 보기
                </label>
                <button onClick={loadVoices} className="text-[10px] text-[#888888] hover:text-white flex items-center gap-0.5">
                  <RefreshCw className="w-3 h-3" /> 다시 불러오기
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1">
              <select value={gender} onChange={(e) => setGender(e.target.value)} className={input}>
                <option value="">성별 전체</option>
                <option value="female">여성</option>
                <option value="male">남성</option>
              </select>
              <select value={age} onChange={(e) => setAge(e.target.value)} className={input}>
                <option value="">나이 전체</option>
                { provider === 'typecast' ? (
                  <>
                    <option value="child">어린이</option>
                    <option value="teenager">10대</option>
                    <option value="young_adult">청년</option>
                    <option value="middle_age">중년</option>
                    <option value="elder">노년</option>
                  </>
                ) : (
                  <>
                    <option value="young">청년</option>
                    <option value="middle_aged">중년</option>
                    <option value="old">노년</option>
                  </>
                )}
              </select>
            </div>
            <div className="flex gap-1">
              <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)} className={input}>
                {voiceOptions.length === 0 && <option value="">(목록 없음)</option>}
                {voiceOptions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
              <button
                onClick={() => preview(voiceId)}
                disabled={!voiceId}
                title="바로 듣기 — 지금 속도·음높이를 대략 적용 (무료, 감정·스타일은 반영 안 됨)"
                className={`${btn} bg-[#2b2b2b] text-white shrink-0 flex items-center`}
              >
                {playing === voiceId ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              </button>
            </div>
            {selectedElVoice?.requiresPaid && (
              <div className="text-[10px] text-[#ffcc80] bg-[#2a2115] border border-[#5c4523] rounded px-2 py-1 leading-relaxed">
                ⚠️ 지금 고른 <b>{selectedElVoice.name}</b> 목소리는 ElevenLabs 커뮤니티 한국인 성우예요. <b>▶ 바로 듣기</b>는 무료로 들을 수 있지만,
                ElevenLabs 정책상 <b>무료(Free) 요금제에서는 API로 실제 음성을 만들 때 차단(402)</b>돼요. 무료 요금제로 음성을 만들려면 위쪽{' '}
                <b>'🇰🇷 한국어 성우만 보기' 체크를 끄고 [기본(무료 가능)]</b> 목소리를 고르거나, ElevenLabs 유료 요금제(Starter 월 $5~) 또는{' '}
                <b>Typecast</b>를 써 주세요.
              </div>
            )}
            <label className="flex items-center gap-1.5 text-[11px] text-[#dddddd] cursor-pointer">
              <input type="checkbox" checked={perVersion} onChange={(e) => setPerVersion(e.target.checked)} className="accent-[#2d8ceb]" />
              버전마다 목소리 다르게
            </label>
            {perVersion &&
              versions.map((_, i) => (
                <div key={i} className="flex gap-1 items-center">
                  <span className="text-[10px] text-[#aaaaaa] w-12 shrink-0">버전 {i + 1}</span>
                  <select
                    value={versionVoices[i] || voiceId}
                    onChange={(e) => setVersionVoices((vv) => vv.map((x, j) => (j === i ? e.target.value : x)))}
                    className={input}
                  >
                    {voiceOptions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => preview(versionVoices[i] || voiceId)}
                    className={`${btn} bg-[#2b2b2b] text-white shrink-0 flex items-center`}
                  >
                    {playing === (versionVoices[i] || voiceId) ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                  </button>
                </div>
              ))}
          </div>

          {/* Typecast 감정 vs ElevenLabs 모델·안정성·유사도 */}
          {provider === 'typecast' ? (
            <>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="space-y-1">
                  <div className={label}>감정</div>
                  <select value={emotion} onChange={(e) => setEmotion(e.target.value)} className={input}>
                    {EMOTIONS.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <div className={label}>쉼 줄이기</div>
                  <select value={silence} onChange={(e) => setSilence(Number(e.target.value))} className={input}>
                    {SILENCE.map((x) => (
                      <option key={x.v} value={x.v}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {emotion !== 'smart' && (
                <div className="flex items-center gap-2 text-[11px] text-[#cccccc]">
                  <span className="w-14 shrink-0">감정 세기</span>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.1}
                    value={intensity}
                    onChange={(e) => setIntensity(Number(e.target.value))}
                    className="flex-1 accent-[#2d8ceb]"
                  />
                  <span className="w-8 text-right">{intensity.toFixed(1)}</span>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="space-y-1">
                  <div className={label}>모델</div>
                  <select value={elModel} onChange={(e) => setElModel(e.target.value)} className={input}>
                    {ELEVEN_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <div className={label}>쉼 줄이기</div>
                  <select value={silence} onChange={(e) => setSilence(Number(e.target.value))} className={input}>
                    {SILENCE.map((x) => (
                      <option key={x.v} value={x.v}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-[#cccccc]" title="낮을수록 감정 표현이 풍부하고, 높을수록 일관되고 차분해요">
                <span className="w-14 shrink-0">안정성</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={stability}
                  onChange={(e) => setStability(Number(e.target.value))}
                  className="flex-1 accent-[#2d8ceb]"
                />
                <span className="w-8 text-right">{Math.round(stability * 100)}%</span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-[#cccccc]" title="원래 목소리 특성과 얼마나 비슷하게 유지할지">
                <span className="w-14 shrink-0">유사도</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={similarity}
                  onChange={(e) => setSimilarity(Number(e.target.value))}
                  className="flex-1 accent-[#2d8ceb]"
                />
                <span className="w-8 text-right">{Math.round(similarity * 100)}%</span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-[#cccccc]" title="말투 스타일을 얼마나 강하게 살릴지 (0% 추천)">
                <span className="w-14 shrink-0">스타일</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={styleExag}
                  onChange={(e) => setStyleExag(Number(e.target.value))}
                  className="flex-1 accent-[#2d8ceb]"
                />
                <span className="w-8 text-right">{Math.round(styleExag * 100)}%</span>
              </div>
            </>
          )}

          {/* 공통: 속도·음높이 */}
          <div className="flex items-center gap-2 text-[11px] text-[#cccccc]">
            <span className="w-14 shrink-0">속도</span>
            <input
              type="range"
              min={0.8}
              max={1.5}
              step={0.05}
              value={tempo}
              onChange={(e) => setTempo(Number(e.target.value))}
              className="flex-1 accent-[#2d8ceb]"
            />
            <span className="w-8 text-right">{tempo.toFixed(2)}</span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-[#cccccc]">
            <span className="w-14 shrink-0">음높이</span>
            <input
              type="range"
              min={-6}
              max={6}
              step={1}
              value={pitch}
              onChange={(e) => setPitch(Number(e.target.value))}
              className="flex-1 accent-[#2d8ceb]"
            />
            <span className="w-8 text-right">{pitch > 0 ? `+${pitch}` : pitch}</span>
          </div>
          <div className="text-[10px] text-[#777777] leading-relaxed">
            ▶ 바로 듣기는 미리듣기 샘플에 속도·음높이를 대략 적용해 들려줘요 (무료). 실제 결과와 조금 다를 수 있고, 감정·스타일은 반영되지 않아요.
          </div>

          {/* 저장 위치 */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className={label}>저장 폴더</span>
              <button onClick={pickFolder} className={`${btn} bg-[#2b2b2b] text-[#dddddd] flex items-center gap-1`}>
                <FolderOpen className="w-3 h-3" /> 바꾸기
              </button>
            </div>
            <div className="text-[10px] text-[#aaaaaa] break-all">{folder || '(폴더를 골라 주세요)'}</div>
            <div className="text-[10px] text-[#777777]">
              파일: {base}_01.mp3 … + 단어 시간 정보({base}_01.timestamps.json). 같은 이름이 있으면 덮어써요.
            </div>
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-[#dddddd] cursor-pointer">
            <input type="checkbox" checked={makeSeqs} onChange={(e) => setMakeSeqs(e.target.checked)} className="accent-[#2d8ceb]" />
            시퀀스({base}) 하나에 음성을 순서대로 놓고 광고 구간({base}_01 …) 표시
          </label>

          <button
            onClick={run}
            disabled={busy || !voiceId || !folder || versions.length === 0}
            className={`${btn} w-full bg-[#2d8ceb] text-white flex items-center justify-center gap-1.5 py-2`}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <AudioLines className="w-3.5 h-3.5" />}
            {provider === 'typecast' ? 'Typecast' : 'ElevenLabs'} 음성 {versions.length}개 만들기 (약 {credits.toLocaleString()}
            {provider === 'typecast' ? '크레딧' : '자'})
          </button>
        </>
      )}
      {progress && <div className="text-[11px] text-[#79b8ff] leading-relaxed break-all">{progress}</div>}
      {errors.map((e) => (
        <div key={e} className="text-[10px] text-[#ff9b9b] leading-relaxed">
          {e}
        </div>
      ))}
    </div>
  );
};
