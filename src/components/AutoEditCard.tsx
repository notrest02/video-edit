/**
 * STEP 3 'AI 자동 배치' 카드: Claude API 키, 폴더에서 영상 가져오기, 후킹 지정(선택), 실행
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Clapperboard, FolderOpen, Loader2, Wand2 } from 'lucide-react';
import { ClaudeKeyBox, useClaudeKey } from './ClaudeKeyBox';
import { useEditorStore } from '../store/useEditorStore';
import type { AdSegment, MediaAsset } from '../types/editor';
import { videoNumbers } from '../utils/scriptGen';

const box = 'bg-[#202020] border border-[#2e2e2e] rounded-lg p-3 space-y-2 text-xs';
const input =
  'w-full bg-[#111318] border border-[#333947] focus:border-[#2d8ceb] rounded px-2 py-1.5 text-xs text-white placeholder-[#666666] focus:outline-none';
const btn = 'py-1.5 px-2.5 rounded text-[11px] font-semibold transition disabled:opacity-45';

/** 폴더 안 파일 중 완성본(렌더)으로 보이는 것: 폴더 이름이 들어가거나 _01/_02, 수정/최종/final */
function looksLikeRender(file: string, folderName: string) {
  const base = file.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  return norm(base).includes(norm(folderName)) || /(^|[_\s-])0\d$|_?수정|최종|final/i.test(base);
}

export const AutoEditCard: React.FC = () => {
  const { assets, addAssets, runAutoEdit, setStatusMessage } = useEditorStore();
  const api = window.electronAPI;
  const hasKey = useClaudeKey();
  const [product, setProduct] = useState('');
  const [useHook, setUseHook] = useState(false);
  const [hookAssetId, setHookAssetId] = useState('');
  const [hookFrom, setHookFrom] = useState('0');
  const [hookTo, setHookTo] = useState('3');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [folder, setFolder] = useState<{ name: string; files: Array<{ path: string; checked: boolean }> } | null>(null);

  const videos = assets.filter((a: MediaAsset) => a.type === 'video');
  const activeSequenceId = useEditorStore((s) => s.activeSequenceId);
  const seqHook = useEditorStore((s) => s.sequences.find((q) => q.id === s.activeSequenceId)?.autoEditHook ?? null);
  const segs = useEditorStore((s) => s.sequences.find((q) => q.id === s.activeSequenceId)?.adSegments) || [];
  const setAdSegments = useEditorStore((s) => s.setAdSegments);
  const multi = segs.length > 1;
  // 구간별 후킹: 영상 번호는 대본 만들기와 같은 규칙, 저장은 경로까지 (번호가 헷갈리지 않게)
  const nums = useMemo(() => videoNumbers(videos), [videos]);
  const hookVideo = (h: NonNullable<AdSegment['hook']>) =>
    (h.path && videos.find((v) => v.path.replace(/\\/g, '/').toLowerCase() === h.path!.replace(/\\/g, '/').toLowerCase())) ||
    videos.find((v) => nums.get(v.id) === h.fileNo);
  const setSegHook = (id: string, hook: AdSegment['hook']) =>
    setAdSegments(segs.map((g) => (g.id === id ? { ...g, hook: hook ? { ...hook, sec: Math.max(1, hook.to - hook.from) } : null } : g)));

  // 재생헤드 위치에서 광고 구간 나누기 (구간이 없으면 시퀀스 전체를 둘로)
  const splitAtPlayhead = () => {
    const st = useEditorStore.getState();
    const t = st.currentTime;
    const total = st.getTotalDuration();
    const base = (st.sequence?.name || 'ad').replace(/[_\s-]*0?\d+$/, '') || 'ad';
    const cur = segs.length ? segs : [{ id: `seg_${Date.now()}`, name: `${base}_01`, start: 0, end: total, hook: null }];
    const k = cur.findIndex((g) => t > g.start + 0.5 && t < g.end - 0.5);
    if (k < 0) {
      setStatusMessage('재생헤드를 광고 구간 안쪽(경계에서 0.5초 이상 떨어진 곳)에 두고 누르세요.');
      return;
    }
    const next = [...cur.slice(0, k), { ...cur[k], end: t }, { ...cur[k], id: `seg_${Date.now()}_b`, start: t, hook: null }, ...cur.slice(k + 1)];
    setAdSegments(next.map((g, i) => ({ ...g, name: `${base}_${String(i + 1).padStart(2, '0')}` })));
  };

  // 시퀀스에 대본의 후킹 지정("3초: 2번 0~3초")이 있으면 미리 채움. 'n번' = 이름이 n으로 시작하는 영상(예: 2.mp4), 없으면 미디어 n번째
  useEffect(() => {
    if (!seqHook) return;
    const byName = videos.find((v) => new RegExp(`^${seqHook.fileNo}(\\D|$)`).test(v.name));
    const asset = byName || videos[seqHook.fileNo - 1];
    setUseHook(true);
    setHookAssetId(asset?.id ?? '');
    setHookFrom(String(seqHook.from));
    setHookTo(String(seqHook.to));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSequenceId, seqHook, videos.length]);

  const pickFolder = async () => {
    const r = await api?.openMediaFolderDialog?.();
    if (!r) return;
    const have = new Set(assets.map((a) => a.path.replace(/\\/g, '/').toLowerCase()));
    setFolder({
      name: r.folderName,
      files: r.files
        .filter((p) => !have.has(p.replace(/\\/g, '/').toLowerCase()))
        .map((p) => ({ path: p, checked: !looksLikeRender(p, r.folderName) })),
    });
  };

  const importFolder = async () => {
    if (!folder || !api?.probeMedia) return;
    const chosen = folder.files.filter((f) => f.checked);
    const probed = [];
    for (const f of chosen) {
      try {
        probed.push(await api.probeMedia(f.path));
      } catch {
        // 분석 못 하는 파일은 건너뜀
      }
    }
    if (probed.length) addAssets(probed);
    setStatusMessage(`폴더 '${folder.name}'에서 영상 ${probed.length}개를 미디어에 올렸습니다.`);
    setFolder(null);
  };

  // 장면 분석만 (자동 배치 없이): 새 영상·예전 항목으로 설명된 영상만 AI가 다시 보고 저장. 결과는 대본 만들기·자동 배치가 같이 씀
  const analyzeOnly = async () => {
    const api = window.electronAPI;
    if (!api?.autoEditAnalyze) return;
    setBusy(true);
    setProgress('장면 분석 시작...');
    const off = api.onAutoEditProgress?.((m) => setProgress(m));
    try {
      const an = await api.autoEditAnalyze({ media: videos.map((v) => ({ path: v.path, duration: v.duration })), product });
      // Haiku 5.5 단가: 입력 $0.10 / 출력 $0.50 (100만 토큰당)
      const cost = (an.usage.input * 0.1 + an.usage.output * 0.5) / 1e6;
      const msg =
        an.analyzedFiles > 0
          ? `장면 분석 완료: 영상 ${an.analyzedFiles}개를 새로 분석해 장면 ${an.shots.length}개 저장 (사용량 약 $${cost.toFixed(4)})`
          : `이미 최신 항목으로 분석된 영상입니다 (장면 ${an.shots.length}개, 비용 없음)`;
      setProgress(msg);
      setStatusMessage(msg);
    } catch (e) {
      setProgress(`장면 분석 실패: ${(e as Error).message}`);
    } finally {
      off?.();
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    setProgress('시작...');
    const hook =
      useHook && hookAssetId
        ? { assetId: hookAssetId, from: Number(hookFrom) || 0, to: Number(hookTo) || (Number(hookFrom) || 0) + 3 }
        : null;
    const msg = await runAutoEdit({ product, hook, onProgress: setProgress });
    setProgress(msg);
    setBusy(false);
  };

  return (
    <div className={box}>
      <div className="font-semibold text-white flex items-center gap-1.5">
        <Wand2 className="w-4 h-4 text-[#2d8ceb]" />
        AI 자동 배치 (원본 영상 → 컷)
      </div>
      <p className="text-[11px] text-[#aaaaaa] leading-relaxed">
        준비: 무음 제거한 음성을 타임라인에 두고 STEP 1 자막 생성 + STEP 2 오타 변환까지 마친 뒤 실행하세요. 미디어에 올린
        원본 영상으로 자막이 바뀌는 곳마다 장면을 골라 빈 영상 트랙에 놓고, 자막을 컷에 맞춥니다.
      </p>

      <ClaudeKeyBox usedFor="AI 자동 배치" />

      {/* 원본 영상 */}
      <div className="space-y-1 border-t border-[#2e2e2e] pt-2">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[#cccccc]">원본 영상 (미디어): {videos.length}개</span>
          <button onClick={pickFolder} className={`${btn} bg-[#2b2b2b] text-[#dddddd] flex items-center gap-1`}>
            <FolderOpen className="w-3 h-3" /> 폴더에서 가져오기
          </button>
        </div>
        {folder && (
          <div className="bg-[#14161a] border border-[#2e3440] rounded p-2 space-y-1">
            <div className="text-[10px] text-[#aaaaaa]">
              '{folder.name}' 영상 — 완성본으로 보이는 파일은 체크를 풀어 두었습니다
            </div>
            <div className="max-h-28 overflow-y-auto space-y-0.5">
              {folder.files.length === 0 && <div className="text-[10px] text-[#777777]">새로 올릴 영상이 없습니다.</div>}
              {folder.files.map((f, i) => (
                <label key={f.path} className="flex items-center gap-1.5 text-[11px] text-[#dddddd] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={f.checked}
                    onChange={(e) =>
                      setFolder({ ...folder, files: folder.files.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)) })
                    }
                    className="accent-[#2d8ceb]"
                  />
                  <span className="truncate">{f.path.replace(/^.*[\\/]/, '')}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-1">
              <button onClick={importFolder} className={`${btn} bg-[#2d8ceb] text-white flex-1`}>
                체크한 영상 미디어에 올리기
              </button>
              <button onClick={() => setFolder(null)} className={`${btn} bg-[#2b2b2b] text-[#dddddd]`}>
                취소
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 광고 구간 */}
      <div className="space-y-1 border-t border-[#2e2e2e] pt-2">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[#cccccc]">광고 구간: {multi ? `${segs.length}개` : '시퀀스 전체 = 광고 1개'}</span>
          <span className="flex gap-1">
            <button onClick={splitAtPlayhead} className={`${btn} bg-[#2b2b2b] text-[#dddddd]`} title="재생헤드 위치에서 광고를 나눔">
              재생헤드에서 나누기
            </button>
            {multi && (
              <button onClick={() => setAdSegments(null)} className={`${btn} bg-[#2b2b2b] text-[#dddddd]`}>
                구간 지우기
              </button>
            )}
          </span>
        </div>
        {multi && (
          <div className="bg-[#14161a] border border-[#2e3440] rounded p-1.5 space-y-1.5 max-h-72 overflow-y-auto">
            <div className="text-[10px] text-[#888888]">광고 구간마다 후킹 장면을 고를 수 있어요. 비워 두면 AI가 골라요.</div>
            {segs.map((g) => {
              const hv = g.hook ? hookVideo(g.hook) : undefined;
              return (
                <div key={g.id} className="space-y-1 border-t border-[#262b35] pt-1 first:border-t-0 first:pt-0">
                  <div className="text-[10px] text-[#cccccc] flex justify-between gap-2">
                    <span className="truncate font-semibold">{g.name}</span>
                    <span className="text-[#888888] shrink-0">
                      {g.start.toFixed(1)}~{g.end.toFixed(1)}초
                    </span>
                  </div>
                  <div className="flex gap-1 items-center">
                    <select
                      value={hv?.id || ''}
                      onChange={(e) => {
                        const v = videos.find((x) => x.id === e.target.value);
                        setSegHook(
                          g.id,
                          v
                            ? { sec: 3, fileNo: nums.get(v.id) ?? 0, from: g.hook?.from ?? 0, to: g.hook?.to ?? 3, note: '', path: v.path }
                            : null
                        );
                      }}
                      className={`${input} flex-1 min-w-0`}
                    >
                      <option value="">후킹: AI가 고름</option>
                      {videos.map((v) => (
                        <option key={v.id} value={v.id}>
                          {nums.get(v.id)}번 {v.name}
                        </option>
                      ))}
                    </select>
                    {g.hook && (
                      <>
                        <input
                          value={g.hook.from}
                          onChange={(e) => setSegHook(g.id, { ...g.hook!, from: Number(e.target.value) || 0 })}
                          className={`${input} !w-12 shrink-0 text-center`}
                          title="시작 초"
                        />
                        <span className="text-[#777777]">~</span>
                        <input
                          value={g.hook.to}
                          onChange={(e) => setSegHook(g.id, { ...g.hook!, to: Number(e.target.value) || 0 })}
                          className={`${input} !w-12 shrink-0 text-center`}
                          title="끝 초"
                        />
                        <span className="text-[10px] text-[#777777]">초</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 제품 / 후킹 */}
      <div className="space-y-1.5 border-t border-[#2e2e2e] pt-2">
        <input value={product} onChange={(e) => setProduct(e.target.value)} placeholder="제품 설명 (선택, 예: 욕실 흡착 슬리퍼 걸이)" className={input} />
        {!multi && (<>
        <label className="flex items-center gap-1.5 text-[11px] text-[#cccccc] cursor-pointer">
          <input type="checkbox" checked={useHook} onChange={(e) => setUseHook(e.target.checked)} className="accent-[#2d8ceb]" />
          후킹 장면 지정 (광고주 지정, 안 하면 AI가 고름)
        </label>
        {useHook && (
          <div className="flex gap-1 items-center">
            <select value={hookAssetId} onChange={(e) => setHookAssetId(e.target.value)} className={`${input} flex-1 min-w-0`}>
              <option value="">영상 선택</option>
              {videos.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <input value={hookFrom} onChange={(e) => setHookFrom(e.target.value)} className={`${input} !w-12 shrink-0 text-center`} title="시작 초" />
            <span className="text-[#777777]">~</span>
            <input value={hookTo} onChange={(e) => setHookTo(e.target.value)} className={`${input} !w-12 shrink-0 text-center`} title="끝 초" />
            <span className="text-[10px] text-[#777777]">초</span>
          </div>
        )}
        </>)}
      </div>

      <button
        onClick={run}
        disabled={busy || !hasKey || videos.length === 0}
        className="w-full py-2 bg-[#2d8ceb] hover:bg-[#1e78d6] disabled:opacity-45 text-white font-semibold rounded flex items-center justify-center gap-1.5 transition"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clapperboard className="w-3.5 h-3.5" />}
        AI 자동 배치 실행
      </button>
      <button
        onClick={analyzeOnly}
        disabled={busy || !hasKey || videos.length === 0}
        className={`${btn} w-full bg-[#2b2b2b] text-[#dddddd] disabled:opacity-45`}
        title="자동 배치 없이 원본 영상의 장면 설명만 만들거나 새 항목으로 다시 만듭니다 (한 번 하면 저장)"
      >
        장면 분석만 다시 하기 (새 영상·예전 항목만, 비용 아주 조금)
      </button>
      {progress && <div className="text-[10px] text-[#aaaaaa] leading-relaxed">{progress}</div>}
    </div>
  );
};
