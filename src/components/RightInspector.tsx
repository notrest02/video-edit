import React, { useEffect, useState, useMemo } from 'react';
import {
  Type,
  Volume2,
  VolumeX,
  Trash2,
  Magnet,
  Clock,
  Unlink,
  PlusSquare,
  Sparkles,
  CopyCheck,
  Palette,
  Layers,
  SunDim,
  RefreshCw,
  FolderOpen,
  Search,
} from 'lucide-react';
import { useEditorStore } from '../store/useEditorStore';
import { SystemFontItem } from '../types/editor';
import { formatFullTimecode } from '../utils/subtitleSnapper';

let globalCachedFonts: SystemFontItem[] = [];

const DEFAULT_PRESET_FONTS: SystemFontItem[] = [
  {
    label: '기본 고딕 (Pretendard / 맑은 고딕)',
    value: '"Pretendard", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
    familyKo: '맑은 고딕',
    familyEn: 'Malgun Gothic',
  },
  {
    label: '임팩트 헤드라인 (Impact / 두꺼운 강조)',
    value: '"Impact", "Arial Black", "Malgun Gothic", sans-serif',
    familyKo: 'Impact',
    familyEn: 'Impact',
  },
  {
    label: '나눔고딕 / 깔끔 자막체',
    value: '"NanumGothic", "Malgun Gothic", sans-serif',
    familyKo: '나눔고딕',
    familyEn: 'NanumGothic',
  },
  {
    label: '감성 명조체 (바탕 / Serif)',
    value: '"Batang", "Georgia", serif',
    familyKo: '바탕',
    familyEn: 'Batang',
  },
  {
    label: '타자기 고정폭 (Monospace)',
    value: '"Consolas", "Courier New", monospace',
    familyKo: 'Consolas',
    familyEn: 'Consolas',
  },
];

export const RightInspector: React.FC = () => {
  const {
    clips,
    tracks,
    fps,
    selectedClipId,
    autoSyncSubtitleStyle,
    setAutoSyncSubtitleStyle,
    applySubtitleStyleToAll,
    updateClip,
    deleteClip,
    unlinkClip,
    addSubtitleClipAtCurrentTime,
    snapAllSubtitlesToClips,
    setStatusMessage,
  } = useEditorStore();

  const [systemFonts, setSystemFonts] = useState<SystemFontItem[]>(globalCachedFonts);
  const [isLoadingFonts, setIsLoadingFonts] = useState(false);
  const [fontSearchQuery, setFontSearchQuery] = useState('');

  const loadPcFonts = async (forceRefresh = false) => {
    if (!forceRefresh && globalCachedFonts.length > 0) {
      setSystemFonts(globalCachedFonts);
      return;
    }
    setIsLoadingFonts(true);
    try {
      const mergedMap = new Map<string, SystemFontItem>();

      // 1) Electron 메인 프로세스 (Windows InstalledFontCollection: 한글/영문 패밀리명 모두 수집)
      if (window.electronAPI?.getSystemFonts) {
        const ipcFonts = await window.electronAPI.getSystemFonts(forceRefresh);
        for (const f of ipcFonts) {
          mergedMap.set(f.familyKo.toLowerCase(), f);
        }
      }

      // 2) Chromium window.queryLocalFonts() 보조 수집
      if (typeof window.queryLocalFonts === 'function') {
        try {
          const localFonts = await window.queryLocalFonts();
          for (const lf of localFonts) {
            const fam = (lf.family || '').trim();
            if (!fam) continue;
            const key = fam.toLowerCase();
            if (!mergedMap.has(key)) {
              mergedMap.set(key, {
                label: lf.fullName && lf.fullName !== fam ? `${lf.fullName} (${fam})` : fam,
                value: `"${fam}", sans-serif`,
                familyKo: lf.fullName || fam,
                familyEn: fam,
              });
            }
          }
        } catch {
          // ignore if queryLocalFonts not supported
        }
      }

      const list = Array.from(mergedMap.values()).sort((a, b) => {
        const aKo = /[가-힣]/.test(a.label);
        const bKo = /[가-힣]/.test(b.label);
        if (aKo !== bKo) return aKo ? -1 : 1;
        return a.label.localeCompare(b.label, 'ko');
      });

      globalCachedFonts = list;
      setSystemFonts(list);
      if (forceRefresh) {
        setStatusMessage(`내 PC에 설치된 글꼴 ${list.length}개를 불러왔습니다.`);
      }
    } finally {
      setIsLoadingFonts(false);
    }
  };

  useEffect(() => {
    loadPcFonts(false);
  }, []);

  const handleImportCustomFontFile = async () => {
    if (!window.electronAPI?.openFontFileDialog || !selectedClip) return;
    try {
      const res = await window.electronAPI.openFontFileDialog();
      if (!res) return;

      const cleanFamily = res.familyName.replace(/['"]/g, '').trim() || 'CustomPCFont';
      const binaryStr = atob(res.dataBase64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const fontFace = new FontFace(cleanFamily, bytes.buffer);
      await fontFace.load();
      document.fonts.add(fontFace);

      const newFontItem: SystemFontItem = {
        label: `📂 [직접 추가] ${cleanFamily}`,
        value: `"${cleanFamily}", sans-serif`,
        familyKo: cleanFamily,
        familyEn: cleanFamily,
      };

      globalCachedFonts = [
        newFontItem,
        ...globalCachedFonts.filter((f) => f.value !== newFontItem.value),
      ];
      setSystemFonts(globalCachedFonts);
      updateClip(selectedClip.id, { fontFamily: newFontItem.value }, true);
      setStatusMessage(`글꼴 파일 '${cleanFamily}'을 불러와 자막에 적용했습니다.`);
    } catch (err: any) {
      setStatusMessage(`글꼴 파일 불러오기 실패: ${err.message}`);
    }
  };

  const filteredSystemFonts = useMemo(() => {
    const q = fontSearchQuery.trim().toLowerCase();
    if (!q) return systemFonts;
    return systemFonts.filter(
      (f) =>
        f.label.toLowerCase().includes(q) ||
        f.familyKo.toLowerCase().includes(q) ||
        f.familyEn.toLowerCase().includes(q)
    );
  }, [systemFonts, fontSearchQuery]);

  const selectedClip = clips.find((c) => c.id === selectedClipId) || null;
  const totalSubtitleCount = clips.filter((c) => c.type === 'text').length;
  const frameSec = 1 / fps;

  const sequenceName =
    clips.find((c) => c.type === 'video')?.name.replace(/\s*\[V\]$/, '') || '무제 시퀀스';

  const handleSnapSingleClipToNearestMedia = () => {
    if (!selectedClip) return;
    const mediaClips = clips.filter((c) => c.type === 'video' || c.type === 'audio');
    if (mediaClips.length === 0) {
      setStatusMessage('기준이 될 비디오/오디오 클립이 타임라인에 없습니다.');
      return;
    }

    const boundaries: number[] = [];
    for (const mc of mediaClips) {
      boundaries.push(mc.startTime, mc.startTime + mc.duration);
    }

    const currStart = selectedClip.startTime;
    const currEnd = selectedClip.startTime + selectedClip.duration;

    let bestStart = currStart;
    let minStartDiff = Infinity;
    for (const b of boundaries) {
      const d = Math.abs(currStart - b);
      if (d < minStartDiff) {
        minStartDiff = d;
        bestStart = b;
      }
    }

    let bestEnd = currEnd;
    let minEndDiff = Infinity;
    for (const b of boundaries) {
      const d = Math.abs(currEnd - b);
      if (d < minEndDiff && b > bestStart + frameSec) {
        minEndDiff = d;
        bestEnd = b;
      }
    }

    updateClip(
      selectedClip.id,
      {
        startTime: Number(bestStart.toFixed(5)),
        duration: Number(Math.max(frameSec * 2, bestEnd - bestStart).toFixed(5)),
        snappedToClip: true,
      },
      true
    );

    setStatusMessage('선택한 클립이 인접 미디어 컷 경계에 정확히 맞춰졌습니다.');
  };

  return (
    <aside className="w-[310px] shrink-0 bg-[#1d1d1d] border border-[#2d8ceb] flex flex-col justify-between h-full select-none text-[#cccccc]">
      {/* 1. 상단 속성 탭 헤더 */}
      <div>
        <div className="h-7 bg-[#161616] border-b border-[#2b2b2b] flex items-center px-3">
          <div className="h-full flex items-center border-b-2 border-[#2d8ceb] text-white text-[11px] font-semibold px-1">
            속성 ≡
          </div>
        </div>

        {/* 시퀀스/클립 요약 바 */}
        <div className="px-3 py-2 border-b border-[#2b2b2b] flex items-center justify-between text-xs bg-[#1d1d1d]">
          <div className="flex items-center gap-1.5 truncate">
            <span className="w-2 h-2 rounded-full bg-[#2d8ceb] shrink-0" />
            <span className="truncate font-mono text-[11px] text-[#dddddd]">
              {selectedClip ? selectedClip.name : sequenceName}
            </span>
          </div>
          {selectedClip && (
            <button
              onClick={() => deleteClip(selectedClip.id)}
              title="클립 삭제 (Delete)"
              className="p-1 rounded hover:bg-rose-500/20 text-rose-400 transition"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 2. 본문: 선택된 클립이 없을 때 vs 있을 때 */}
      {!selectedClip ? (
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <p className="text-xs text-[#999999]">속성을 보려면 타임라인에서 클립을 선택하세요.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3 space-y-3 bg-[#181818]">
          {/* 연결된 V+A 클립 표시 및 연결 해제(Unlink) 버튼 */}
          {selectedClip.linkedGroupId && (
            <div className="bg-[#222222] border border-[#333333] rounded p-2.5 flex items-center justify-between text-[11px]">
              <span className="text-[#79b8ff]">🔗 영상(V) + 음성(A) 연결됨</span>
              <button
                onClick={() => unlinkClip(selectedClip.id)}
                className="px-2 py-0.5 rounded bg-[#2d2d2d] hover:bg-[#3d3d3d] border border-[#444444] text-white flex items-center gap-1 transition"
              >
                <Unlink className="w-3 h-3" /> 연결 해제
              </button>
            </div>
          )}

          {/* 프레임 단위 정밀 타이밍 제어 */}
          <div className="bg-[#202020] border border-[#2e2e2e] rounded p-2.5 space-y-2">
            <div className="text-[11px] font-semibold text-white flex items-center justify-between">
              <span className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-[#2d8ceb]" />
                프레임 정밀 위치 ({fps}fps)
              </span>
              <span className="text-[10px] text-[#888888]">
                트랙: {tracks.find((t) => t.id === selectedClip.trackId)?.code}
              </span>
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-[#999999]">시작 지점</span>
                <span className="font-mono text-[#6cb6ff]">
                  {formatFullTimecode(selectedClip.startTime, fps)}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-1">
                {[-3, -1, 1, 3].map((df) => (
                  <button
                    key={df}
                    onClick={() =>
                      updateClip(
                        selectedClip.id,
                        {
                          startTime: Math.max(
                            0,
                            Number((selectedClip.startTime + df * frameSec).toFixed(5))
                          ),
                        },
                        true
                      )
                    }
                    className="py-1 bg-[#141414] hover:bg-[#2a2a2a] border border-[#333333] rounded text-[11px] font-mono text-[#dddddd]"
                  >
                    {df > 0 ? `+${df}F` : `${df}F`}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1 pt-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-[#999999]">종료 지점</span>
                <span className="font-mono text-[#6cb6ff]">
                  {formatFullTimecode(selectedClip.startTime + selectedClip.duration, fps)}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-1">
                {[-3, -1, 1, 3].map((df) => (
                  <button
                    key={df}
                    onClick={() =>
                      updateClip(
                        selectedClip.id,
                        {
                          duration: Math.max(
                            frameSec * 2,
                            Number((selectedClip.duration + df * frameSec).toFixed(5))
                          ),
                        },
                        true
                      )
                    }
                    className="py-1 bg-[#141414] hover:bg-[#2a2a2a] border border-[#333333] rounded text-[11px] font-mono text-[#dddddd]"
                  >
                    {df > 0 ? `+${df}F` : `${df}F`}
                  </button>
                ))}
              </div>
            </div>

            {selectedClip.type === 'text' && (
              <button
                onClick={handleSnapSingleClipToNearestMedia}
                className="w-full py-1.5 bg-[#2d8ceb]/20 hover:bg-[#2d8ceb]/30 border border-[#2d8ceb]/50 rounded text-[11px] font-semibold text-[#79b8ff] flex items-center justify-center gap-1"
              >
                <Magnet className="w-3 h-3" /> 이 자막을 인접 클립 경계에 즉시 맞춤
              </button>
            )}
          </div>

          {/* 자막 클립 전용 속성: 텍스트, 글꼴, 외곽선, 그림자, 투명도, 스타일 일괄 적용 */}
          {selectedClip.type === 'text' && (
            <div className="bg-[#202020] border border-[#2e2e2e] rounded p-2.5 space-y-3 text-[11px]">
              <div className="font-semibold text-white flex items-center justify-between">
                <span className="flex items-center gap-1">
                  <Type className="w-3.5 h-3.5 text-[#f5a623]" /> 자막 텍스트 및 스타일
                </span>
                <span className="text-[10px] text-[#999999]">
                  전체 자막 {totalSubtitleCount}개
                </span>
              </div>

              {/* 0. 스타일 일괄 적용 & 실시간 동기화 컨트롤 */}
              <div className="bg-[#161b22] border border-[#2d8ceb]/50 rounded p-2 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-[#79b8ff] flex items-center gap-1">
                    <Sparkles className="w-3.5 h-3.5 text-[#f5a623]" />
                    스타일 일괄 적용
                  </span>
                  <label className="flex items-center gap-1 cursor-pointer text-[10px] text-[#cccccc]">
                    <input
                      type="checkbox"
                      checked={autoSyncSubtitleStyle}
                      onChange={(e) => setAutoSyncSubtitleStyle(e.target.checked)}
                      className="accent-[#3fb950] rounded"
                    />
                    <span className={autoSyncSubtitleStyle ? 'text-[#3fb950] font-semibold' : ''}>
                      실시간 전체 동기화
                    </span>
                  </label>
                </div>

                <p className="text-[10px] text-[#999999] leading-relaxed">
                  현재 클립에서 설정한 글꼴·색상·외곽선·그림자·투명도·위치를 다른 모든 자막 클립에 똑같이 맞춰줍니다.
                </p>

                <div className="grid grid-cols-1 gap-1.5">
                  <button
                    onClick={() => applySubtitleStyleToAll(selectedClip.id, 'all')}
                    className="w-full py-1.5 px-2 rounded bg-[#2d8ceb] hover:bg-[#1f6feb] text-white font-bold text-[11px] flex items-center justify-center gap-1.5 shadow transition"
                  >
                    <CopyCheck className="w-3.5 h-3.5" />
                    현재 클립 스타일을 전체 자막({totalSubtitleCount}개)에 일괄 적용
                  </button>
                  <button
                    onClick={() => applySubtitleStyleToAll(selectedClip.id, 'same-track')}
                    className="w-full py-1 px-2 rounded bg-[#21262d] hover:bg-[#30363d] border border-[#3a3f47] text-[#cccccc] text-[10px] flex items-center justify-center gap-1 transition"
                  >
                    같은 트랙({tracks.find((t) => t.id === selectedClip.trackId)?.code}) 자막에만 일괄 적용
                  </button>
                </div>
              </div>

              {/* 1. 자막 텍스트 입력 */}
              <div className="space-y-1">
                <span className="text-[#bbbbbb] font-medium block">자막 내용</span>
                <textarea
                  rows={2}
                  value={selectedClip.text || ''}
                  onChange={(e) => updateClip(selectedClip.id, { text: e.target.value })}
                  className="w-full bg-[#121212] border border-[#333333] rounded p-2 text-xs text-white focus:outline-none focus:border-[#2d8ceb] select-text"
                />
              </div>

              {/* 2. 글꼴(내 PC 설치 글꼴 연동 + 검색 + 폰트파일 추가) / 크기 / 굵기 / 자간 / 글자색 & 글자 투명도 */}
              <div className="bg-[#181818] border border-[#2b2b2b] rounded p-2 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-[#dddddd] flex items-center gap-1 text-[11px]">
                    <Palette className="w-3.5 h-3.5 text-[#6cb6ff]" />
                    글꼴 (내 PC 연동) · 색상 · 투명도
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => loadPcFonts(true)}
                      disabled={isLoadingFonts}
                      title="내 PC에 설치된 글꼴 목록 새로고침"
                      className="px-1.5 py-0.5 rounded bg-[#222222] hover:bg-[#303030] border border-[#3a3a3a] text-[10px] text-[#cccccc] flex items-center gap-1 transition"
                    >
                      <RefreshCw className={`w-2.5 h-2.5 ${isLoadingFonts ? 'animate-spin' : ''}`} />
                      <span>PC 글꼴 ({systemFonts.length})</span>
                    </button>
                    <button
                      onClick={handleImportCustomFontFile}
                      title="내 PC 폴더에서 .ttf / .otf 글꼴 파일 직접 불러오기"
                      className="px-1.5 py-0.5 rounded bg-[#222222] hover:bg-[#303030] border border-[#3a3a3a] text-[10px] text-[#79b8ff] flex items-center gap-1 transition"
                    >
                      <FolderOpen className="w-2.5 h-2.5" />
                      <span>폰트파일</span>
                    </button>
                  </div>
                </div>

                {/* 내 PC 글꼴 빠른 검색 */}
                <div className="relative">
                  <Search className="w-3 h-3 text-[#777777] absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={fontSearchQuery}
                    onChange={(e) => setFontSearchQuery(e.target.value)}
                    placeholder={`내 PC 글꼴 검색 (${systemFonts.length}개 중 이름 검색: 나눔, 고딕, a개똥벌레...)`}
                    className="w-full bg-[#121212] border border-[#333333] rounded pl-6 pr-2 py-1 text-[10px] text-white placeholder-[#666666] focus:outline-none focus:border-[#2d8ceb] select-text"
                  />
                </div>

                {/* 글꼴 선택 드롭다운 & 굵기/기울임 */}
                <div className="grid grid-cols-3 gap-1.5">
                  <div className="col-span-2">
                    <span className="text-[10px] text-[#999999] block mb-0.5">
                      글꼴 선택 {fontSearchQuery.trim() ? `(검색결과 ${filteredSystemFonts.length}개)` : ''}
                    </span>
                    <select
                      value={
                        selectedClip.fontFamily ||
                        '"Pretendard", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif'
                      }
                      onChange={(e) =>
                        updateClip(selectedClip.id, { fontFamily: e.target.value }, true)
                      }
                      style={{
                        fontFamily:
                          selectedClip.fontFamily ||
                          '"Pretendard", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
                      }}
                      className="w-full bg-[#121212] border border-[#333333] rounded px-1.5 py-1 text-[11px] text-white focus:outline-none focus:border-[#2d8ceb]"
                    >
                      {/* 현재 선택된 글꼴이 필터링에 의해 숨겨져 있을 때 값 유지용 옵션 */}
                      {selectedClip.fontFamily &&
                        !DEFAULT_PRESET_FONTS.some((f) => f.value === selectedClip.fontFamily) &&
                        !filteredSystemFonts.some((f) => f.value === selectedClip.fontFamily) && (
                          <option value={selectedClip.fontFamily}>
                            현재 글꼴: {selectedClip.fontFamily.replace(/["']/g, '').split(',')[0]}
                          </option>
                        )}
                      {!fontSearchQuery.trim() && (
                        <optgroup label="⭐ 추천 기본 자막 글꼴">
                          {DEFAULT_PRESET_FONTS.map((f) => (
                            <option key={`preset_${f.value}`} value={f.value}>
                              {f.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      <optgroup
                        label={`💻 내 PC에 저장된 글꼴 (${filteredSystemFonts.length}개)`}
                      >
                        {filteredSystemFonts.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </div>

                  <div>
                    <span className="text-[10px] text-[#999999] block mb-0.5">스타일</span>
                    <div className="flex gap-1">
                      <select
                        value={selectedClip.fontWeight || 'bold'}
                        onChange={(e) =>
                          updateClip(
                            selectedClip.id,
                            {
                              fontWeight: e.target.value as 'normal' | 'bold' | '900',
                            },
                            true
                          )
                        }
                        className="flex-1 bg-[#121212] border border-[#333333] rounded px-1 py-1 text-[10px] text-white focus:outline-none"
                      >
                        <option value="normal">보통</option>
                        <option value="bold">굵게</option>
                        <option value="900">초굵게</option>
                      </select>
                      <button
                        onClick={() =>
                          updateClip(
                            selectedClip.id,
                            { fontItalic: !selectedClip.fontItalic },
                            true
                          )
                        }
                        title="기울임꼴 (Italic)"
                        className={`px-2 py-0.5 rounded border text-[11px] italic font-serif ${
                          selectedClip.fontItalic
                            ? 'bg-[#2d8ceb] border-[#2d8ceb] text-white'
                            : 'bg-[#121212] border-[#333333] text-[#aaaaaa]'
                        }`}
                      >
                        I
                      </button>
                    </div>
                  </div>
                </div>

                {/* 검색어 입력 시 바로 클릭해서 바꿀 수 있는 빠른 글꼴 목록 */}
                {fontSearchQuery.trim().length > 0 && (
                  <div className="max-h-28 overflow-y-auto bg-[#121212] border border-[#2d8ceb]/40 rounded p-1 space-y-0.5">
                    {filteredSystemFonts.length === 0 ? (
                      <div className="text-[10px] text-[#777777] py-1.5 text-center">
                        검색된 PC 글꼴이 없습니다.
                      </div>
                    ) : (
                      filteredSystemFonts.slice(0, 40).map((f) => {
                        const isCurr = selectedClip.fontFamily === f.value;
                        return (
                          <button
                            key={`quick_${f.value}`}
                            onClick={() =>
                              updateClip(selectedClip.id, { fontFamily: f.value }, true)
                            }
                            style={{ fontFamily: f.value }}
                            className={`w-full text-left px-2 py-1 rounded text-[11px] flex items-center justify-between transition ${
                              isCurr
                                ? 'bg-[#2d8ceb] text-white font-bold'
                                : 'hover:bg-[#222222] text-[#dddddd]'
                            }`}
                          >
                            <span className="truncate">{f.label}</span>
                            <span className="text-[10px] opacity-80 shrink-0 ml-2">가나다 ABC</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}

                {/* 글자 크기 */}
                <div className="space-y-0.5">
                  <div className="flex justify-between">
                    <span className="text-[#999999]">글자 크기</span>
                    <span className="font-mono text-[#6cb6ff]">
                      {selectedClip.fontSize || 40} px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={16}
                    max={96}
                    value={selectedClip.fontSize || 40}
                    onChange={(e) =>
                      updateClip(selectedClip.id, { fontSize: Number(e.target.value) })
                    }
                    className="w-full accent-[#2d8ceb]"
                  />
                </div>

                {/* 자간 */}
                <div className="space-y-0.5">
                  <div className="flex justify-between">
                    <span className="text-[#999999]">자간 (Letter Spacing)</span>
                    <span className="font-mono text-[#cccccc]">
                      {selectedClip.letterSpacing ?? 0} px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={-3}
                    max={12}
                    step={0.5}
                    value={selectedClip.letterSpacing ?? 0}
                    onChange={(e) =>
                      updateClip(selectedClip.id, { letterSpacing: Number(e.target.value) })
                    }
                    className="w-full accent-[#2d8ceb]"
                  />
                </div>

                {/* 글자색 & 글자 투명도 */}
                <div className="grid grid-cols-3 gap-2 items-center pt-1">
                  <div>
                    <span className="text-[#999999] block mb-0.5 text-[10px]">글자색</span>
                    <input
                      type="color"
                      value={selectedClip.fontColor || '#ffffff'}
                      onChange={(e) => updateClip(selectedClip.id, { fontColor: e.target.value })}
                      className="w-full h-7 rounded bg-[#121212] border border-[#333333] cursor-pointer"
                    />
                  </div>
                  <div className="col-span-2 space-y-0.5">
                    <div className="flex justify-between">
                      <span className="text-[#999999] text-[10px]">글자 투명도 (불투명도)</span>
                      <span className="font-mono text-[#6cb6ff]">
                        {Math.round((selectedClip.fontOpacity ?? 1) * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={selectedClip.fontOpacity ?? 1}
                      onChange={(e) =>
                        updateClip(selectedClip.id, { fontOpacity: Number(e.target.value) })
                      }
                      className="w-full accent-[#2d8ceb]"
                    />
                  </div>
                </div>
              </div>

              {/* 3. 글자 외곽선 (Stroke) 설정 */}
              <div className="bg-[#181818] border border-[#2b2b2b] rounded p-2 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="font-semibold text-[#dddddd] flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedClip.strokeEnabled ?? true}
                      onChange={(e) =>
                        updateClip(selectedClip.id, { strokeEnabled: e.target.checked }, true)
                      }
                      className="accent-[#2d8ceb]"
                    />
                    <span>글자 외곽선 (Stroke)</span>
                  </label>
                  <span className="text-[10px] font-mono text-[#999999]">
                    {selectedClip.strokeEnabled ?? true
                      ? `${selectedClip.strokeWidth ?? 3}px`
                      : '꺼짐'}
                  </span>
                </div>

                {(selectedClip.strokeEnabled ?? true) && (
                  <div className="space-y-2 pt-1 border-t border-[#252525]">
                    <div className="grid grid-cols-3 gap-2 items-center">
                      <div>
                        <span className="text-[#999999] block mb-0.5 text-[10px]">외곽선 색상</span>
                        <input
                          type="color"
                          value={selectedClip.strokeColor || '#000000'}
                          onChange={(e) =>
                            updateClip(selectedClip.id, { strokeColor: e.target.value })
                          }
                          className="w-full h-7 rounded bg-[#121212] border border-[#333333] cursor-pointer"
                        />
                      </div>
                      <div className="col-span-2 space-y-0.5">
                        <div className="flex justify-between">
                          <span className="text-[#999999] text-[10px]">외곽선 두께</span>
                          <span className="font-mono text-[#6cb6ff]">
                            {selectedClip.strokeWidth ?? 3} px
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={12}
                          step={0.5}
                          value={selectedClip.strokeWidth ?? 3}
                          onChange={(e) =>
                            updateClip(selectedClip.id, { strokeWidth: Number(e.target.value) })
                          }
                          className="w-full accent-[#2d8ceb]"
                        />
                      </div>
                    </div>

                    <div className="space-y-0.5">
                      <div className="flex justify-between">
                        <span className="text-[#999999] text-[10px]">외곽선 투명도 (불투명도)</span>
                        <span className="font-mono text-[#cccccc]">
                          {Math.round((selectedClip.strokeOpacity ?? 1) * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={selectedClip.strokeOpacity ?? 1}
                        onChange={(e) =>
                          updateClip(selectedClip.id, { strokeOpacity: Number(e.target.value) })
                        }
                        className="w-full accent-[#2d8ceb]"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* 4. 글자 그림자 (Shadow) 설정 */}
              <div className="bg-[#181818] border border-[#2b2b2b] rounded p-2 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="font-semibold text-[#dddddd] flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedClip.shadowEnabled ?? true}
                      onChange={(e) =>
                        updateClip(selectedClip.id, { shadowEnabled: e.target.checked }, true)
                      }
                      className="accent-[#2d8ceb]"
                    />
                    <span>글자 그림자 (Shadow)</span>
                  </label>
                  <span className="text-[10px] font-mono text-[#999999]">
                    {selectedClip.shadowEnabled ?? true
                      ? `Blur ${selectedClip.shadowBlur ?? 6}px`
                      : '꺼짐'}
                  </span>
                </div>

                {(selectedClip.shadowEnabled ?? true) && (
                  <div className="space-y-2 pt-1 border-t border-[#252525]">
                    <div className="grid grid-cols-3 gap-2 items-center">
                      <div>
                        <span className="text-[#999999] block mb-0.5 text-[10px]">그림자 색상</span>
                        <input
                          type="color"
                          value={selectedClip.shadowColor || '#000000'}
                          onChange={(e) =>
                            updateClip(selectedClip.id, { shadowColor: e.target.value })
                          }
                          className="w-full h-7 rounded bg-[#121212] border border-[#333333] cursor-pointer"
                        />
                      </div>
                      <div className="col-span-2 space-y-0.5">
                        <div className="flex justify-between">
                          <span className="text-[#999999] text-[10px]">그림자 투명도 (불투명도)</span>
                          <span className="font-mono text-[#6cb6ff]">
                            {Math.round((selectedClip.shadowOpacity ?? 0.85) * 100)}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={selectedClip.shadowOpacity ?? 0.85}
                          onChange={(e) =>
                            updateClip(selectedClip.id, { shadowOpacity: Number(e.target.value) })
                          }
                          className="w-full accent-[#2d8ceb]"
                        />
                      </div>
                    </div>

                    <div className="space-y-0.5">
                      <div className="flex justify-between">
                        <span className="text-[#999999] text-[10px]">그림자 번짐 (Blur)</span>
                        <span className="font-mono text-[#cccccc]">
                          {selectedClip.shadowBlur ?? 6} px
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={25}
                        step={1}
                        value={selectedClip.shadowBlur ?? 6}
                        onChange={(e) =>
                          updateClip(selectedClip.id, { shadowBlur: Number(e.target.value) })
                        }
                        className="w-full accent-[#2d8ceb]"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-0.5">
                        <div className="flex justify-between">
                          <span className="text-[#999999] text-[10px]">가로 거리 (X)</span>
                          <span className="font-mono text-[#cccccc]">
                            {selectedClip.shadowOffsetX ?? 0}px
                          </span>
                        </div>
                        <input
                          type="range"
                          min={-15}
                          max={15}
                          step={1}
                          value={selectedClip.shadowOffsetX ?? 0}
                          onChange={(e) =>
                            updateClip(selectedClip.id, { shadowOffsetX: Number(e.target.value) })
                          }
                          className="w-full accent-[#2d8ceb]"
                        />
                      </div>
                      <div className="space-y-0.5">
                        <div className="flex justify-between">
                          <span className="text-[#999999] text-[10px]">세로 거리 (Y)</span>
                          <span className="font-mono text-[#cccccc]">
                            {selectedClip.shadowOffsetY ?? 2}px
                          </span>
                        </div>
                        <input
                          type="range"
                          min={-15}
                          max={15}
                          step={1}
                          value={selectedClip.shadowOffsetY ?? 2}
                          onChange={(e) =>
                            updateClip(selectedClip.id, { shadowOffsetY: Number(e.target.value) })
                          }
                          className="w-full accent-[#2d8ceb]"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* 5. 배경 박스 & 전체 투명도 & 위치 설정 */}
              <div className="bg-[#181818] border border-[#2b2b2b] rounded p-2 space-y-2">
                <div className="font-semibold text-[#dddddd] flex items-center gap-1 text-[11px]">
                  <Layers className="w-3.5 h-3.5 text-[#3fb950]" />
                  배경 박스 · 투명도 · 위치
                </div>

                {/* 전체 클립 불투명도 */}
                <div className="space-y-0.5">
                  <div className="flex justify-between">
                    <span className="text-[#999999] flex items-center gap-1">
                      <SunDim className="w-3 h-3 text-[#f5a623]" /> 전체 자막 투명도 (Opacity)
                    </span>
                    <span className="font-mono text-[#6cb6ff]">
                      {Math.round((selectedClip.opacity ?? 1) * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={selectedClip.opacity ?? 1}
                    onChange={(e) =>
                      updateClip(selectedClip.id, { opacity: Number(e.target.value) })
                    }
                    className="w-full accent-[#2d8ceb]"
                  />
                </div>

                {/* 배경 박스 켜기/끄기 및 배경 투명도 */}
                <div className="pt-1 border-t border-[#252525] space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-1.5 cursor-pointer text-[#dddddd] font-medium">
                      <input
                        type="checkbox"
                        checked={
                          selectedClip.backgroundEnabled ??
                          (selectedClip.backgroundColor !== 'transparent' &&
                            (selectedClip.backgroundOpacity ?? 0.65) > 0)
                        }
                        onChange={(e) =>
                          updateClip(
                            selectedClip.id,
                            {
                              backgroundEnabled: e.target.checked,
                              backgroundOpacity:
                                e.target.checked && (selectedClip.backgroundOpacity ?? 0.65) === 0
                                  ? 0.65
                                  : selectedClip.backgroundOpacity ?? 0.65,
                            },
                            true
                          )
                        }
                        className="accent-[#2d8ceb]"
                      />
                      <span>배경 박스 표시</span>
                    </label>
                    <span className="text-[10px] font-mono text-[#999999]">
                      {(selectedClip.backgroundEnabled ?? true)
                        ? `${Math.round((selectedClip.backgroundOpacity ?? 0.65) * 100)}%`
                        : '투명'}
                    </span>
                  </div>

                  {(selectedClip.backgroundEnabled ?? true) && (
                    <div className="space-y-2">
                      <div className="grid grid-cols-3 gap-2 items-center">
                        <div>
                          <span className="text-[#999999] block mb-0.5 text-[10px]">배경색</span>
                          <input
                            type="color"
                            value={
                              selectedClip.backgroundColor &&
                              selectedClip.backgroundColor !== 'transparent'
                                ? selectedClip.backgroundColor
                                : '#000000'
                            }
                            onChange={(e) =>
                              updateClip(selectedClip.id, { backgroundColor: e.target.value })
                            }
                            className="w-full h-7 rounded bg-[#121212] border border-[#333333] cursor-pointer"
                          />
                        </div>
                        <div className="col-span-2 space-y-0.5">
                          <div className="flex justify-between">
                            <span className="text-[#999999] text-[10px]">배경 투명도 (불투명도)</span>
                            <span className="font-mono text-[#6cb6ff]">
                              {Math.round((selectedClip.backgroundOpacity ?? 0.65) * 100)}%
                            </span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={selectedClip.backgroundOpacity ?? 0.65}
                            onChange={(e) =>
                              updateClip(selectedClip.id, {
                                backgroundOpacity: Number(e.target.value),
                              })
                            }
                            className="w-full accent-[#2d8ceb]"
                          />
                        </div>
                      </div>

                      <div className="space-y-0.5">
                        <div className="flex justify-between">
                          <span className="text-[#999999] text-[10px]">배경 모서리 둥글기</span>
                          <span className="font-mono text-[#cccccc]">
                            {selectedClip.backgroundRadius ?? 6} px
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={24}
                          step={1}
                          value={selectedClip.backgroundRadius ?? 6}
                          onChange={(e) =>
                            updateClip(selectedClip.id, {
                              backgroundRadius: Number(e.target.value),
                            })
                          }
                          className="w-full accent-[#2d8ceb]"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* 수평 / 수직 위치 */}
                <div className="pt-1 border-t border-[#252525] grid grid-cols-2 gap-2">
                  <div className="space-y-0.5">
                    <div className="flex justify-between">
                      <span className="text-[#999999] text-[10px]">가로 위치 (X)</span>
                      <span className="font-mono text-[#cccccc]">
                        {selectedClip.positionX ?? 50}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={10}
                      max={90}
                      value={selectedClip.positionX ?? 50}
                      onChange={(e) =>
                        updateClip(selectedClip.id, { positionX: Number(e.target.value) })
                      }
                      className="w-full accent-[#2d8ceb]"
                    />
                  </div>
                  <div className="space-y-0.5">
                    <div className="flex justify-between">
                      <span className="text-[#999999] text-[10px]">세로 위치 (Y)</span>
                      <span className="font-mono text-[#cccccc]">
                        {selectedClip.positionY ?? 86}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={8}
                      max={92}
                      value={selectedClip.positionY ?? 86}
                      onChange={(e) =>
                        updateClip(selectedClip.id, { positionY: Number(e.target.value) })
                      }
                      className="w-full accent-[#2d8ceb]"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 비디오 클립 화면 비율(Scale) 제어 */}
          {selectedClip.type === 'video' && (
            <div className="bg-[#202020] border border-[#2e2e2e] rounded p-2.5 space-y-2 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">비디오 비율 (Scale)</span>
                <button
                  onClick={() => updateClip(selectedClip.id, { scale: 100 }, true)}
                  className="px-2 py-0.5 rounded bg-[#141414] border border-[#333333] text-[#cccccc] text-[10px]"
                >
                  시퀀스 프레임에 맞춤 (100%)
                </button>
              </div>
              <div className="flex justify-between">
                <span className="text-[#999999]">크기 조정</span>
                <span className="font-mono text-[#6cb6ff]">{selectedClip.scale ?? 100}%</span>
              </div>
              <input
                type="range"
                min={20}
                max={250}
                step={5}
                value={selectedClip.scale ?? 100}
                onChange={(e) => updateClip(selectedClip.id, { scale: Number(e.target.value) })}
                className="w-full accent-[#2d8ceb]"
              />
            </div>
          )}

          {/* 오디오 / 비디오 볼륨 제어 */}
          {(selectedClip.type === 'audio' || selectedClip.type === 'video') && (
            <div className="bg-[#202020] border border-[#2e2e2e] rounded p-2.5 space-y-2 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white flex items-center gap-1">
                  {selectedClip.muted ? (
                    <VolumeX className="w-3.5 h-3.5 text-rose-400" />
                  ) : (
                    <Volume2 className="w-3.5 h-3.5 text-[#3fb950]" />
                  )}
                  볼륨 레벨
                </span>
                <button
                  onClick={() =>
                    updateClip(selectedClip.id, { muted: !selectedClip.muted }, true)
                  }
                  className="px-2 py-0.5 rounded bg-[#141414] border border-[#333333] text-[#cccccc]"
                >
                  {selectedClip.muted ? '음소거 해제' : '음소거'}
                </button>
              </div>
              <div className="flex justify-between">
                <span className="text-[#999999]">게인 (Gain)</span>
                <span className="font-mono text-[#6cb6ff]">
                  {Math.round(selectedClip.volume * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={selectedClip.volume}
                onChange={(e) =>
                  updateClip(selectedClip.id, { volume: Number(e.target.value) })
                }
                className="w-full accent-[#2d8ceb]"
              />
            </div>
          )}
        </div>
      )}

      {/* 3. 하단 버튼 바 (새 그래픽 만들기 & 클립 자막 맞추기) */}
      <div className="p-2.5 bg-[#1d1d1d] border-t border-[#2b2b2b] flex items-center gap-2">
        <button
          onClick={() => addSubtitleClipAtCurrentTime()}
          className="flex-1 py-1.5 px-2.5 rounded-full bg-[#2a2a2a] hover:bg-[#363636] border border-[#444444] text-xs text-[#dddddd] flex items-center justify-center gap-1.5 transition"
        >
          <PlusSquare className="w-3.5 h-3.5" /> 새 그래픽 만들기
        </button>
        <button
          onClick={() => snapAllSubtitlesToClips()}
          title="모든 자막을 클립 시작/끝에 칼맞춤"
          className="p-1.5 rounded-full bg-[#2a2a2a] hover:bg-[#363636] border border-[#444444] text-[#f5a623]"
        >
          <Magnet className="w-3.5 h-3.5" />
        </button>
      </div>
    </aside>
  );
};
