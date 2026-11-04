/**
 * STEP 0 '대본 만들기' 카드 → Claude(Haiku)가 광고 대본 여러 버전
 *  - 클라이언트 오더(선택): 글을 붙여 넣거나 txt/docx 를 열고 [오더 읽기] → 제품·소구점·꼭 넣을 문장·말투·버전 방식 자동 채움
 *  - 버전 방식: 소구점 나눠 쓰기 / 이야기 다르게 / 본문 같게 후킹만 다르게 (자동이면 AI가 고름)
 *  - [버전 기획표 만들기](선택): 버전마다 후킹 유형·콘셉트·중심 장점·맡을 소구점 → 사람이 고친 뒤 [대본 만들기]
 *  - 결과는 고쳐 쓸 수 있고, 복사/저장/STEP 2 대본 칸으로 보내기
 * 앱을 켤 때마다 빈 칸으로 시작한다 (탭을 옮기는 동안은 유지). 말투 예시 파일 목록만 기억한다.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ClipboardList, Copy, Eye, FileText, FolderOpen, LayoutList, Loader2, PenLine, Save, Send, X } from 'lucide-react';
import { useEditorStore } from '../store/useEditorStore';
import { ClaudeKeyBox, useClaudeKey } from './ClaudeKeyBox';
import { VoiceGenPanel } from './VoiceGenPanel';
import { ElevenLabsKeyBox, TypecastKeyBox } from './TypecastKeyBox';
import type { MediaAsset } from '../types/editor';
import {
  HAIKU_PRICE,
  HOOK_AUTO,
  HOOK_TYPES,
  KRW_PER_USD,
  MAX_VERSIONS,
  SCRIPT_MODES,
  checkVersion,
  cleanLine,
  estimateSeconds,
  modeLabel,
  scriptToText,
  videoNumbers,
  splitList,
  targetChars,
  type ScriptMode,
  type ScriptTone,
  type ScriptVersion,
} from '../utils/scriptGen';

const box = 'bg-[#202020] border border-[#2e2e2e] rounded-lg p-3 space-y-2 text-xs';
const input =
  'w-full bg-[#111318] border border-[#333947] focus:border-[#2d8ceb] rounded px-2 py-1.5 text-xs text-white placeholder-[#666666] focus:outline-none';
const btn = 'py-1.5 px-2.5 rounded text-[11px] font-semibold transition disabled:opacity-45';
const label = 'text-[11px] text-[#cccccc]';

const EXAMPLES_KEY = 'scriptGen.examplePaths.v1';
// 예전 버전이 남긴 입력·결과 (지금은 앱을 켤 때 빈 칸으로 시작)
['scriptGen.form.v1', 'scriptGen.result.v1'].forEach((k) => localStorage.removeItem(k));
const SPACES = ['욕실', '주방', '방·수납', '세탁·청소', '기타'];
const LENGTHS = [20, 30, 40];

type VersionSpec = { hookType: string; story: string; focus: string; points: number[] };
type Form = {
  order: string;
  product: string;
  facts: string;
  sellingPoints: string; // 한 줄에 하나
  mustInclude: string; // 한 줄에 하나
  tone: ScriptTone;
  mode: ScriptMode;
  modeReason: string;
  orderNotes: string;
  space: string;
  target: string;
  seconds: number;
  versions: VersionSpec[];
  examplePaths: string[];
  excludedVideoPaths: string[];
};
type Result = {
  versions: ScriptVersion[];
  fixes: Array<{ version: number; before: string; after: string; reason: string }>;
  usage: { input: number; output: number };
  exampleCount: number;
  mode: Exclude<ScriptMode, 'auto'>;
  media: Array<{ no: number; duration: number }>;
  seconds: number;
  mustInclude: string[];
  points: string[][]; // 버전마다 맡은 소구점 원문 (검사용)
  shots: Array<{ no: number; start: number; end: number }>; // 장면 경계 (후킹 줄 검사용)
};

const emptySpec = (): VersionSpec => ({ hookType: HOOK_AUTO, story: '', focus: '', points: [] });
const defaultForm = (): Form => ({
  order: '',
  product: '',
  facts: '',
  sellingPoints: '',
  mustInclude: '',
  tone: '',
  mode: 'auto',
  modeReason: '',
  orderNotes: '',
  space: '',
  target: '',
  seconds: 0,
  versions: [],
  examplePaths: loadExamples(),
  excludedVideoPaths: [],
});

function loadExamples(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(EXAMPLES_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const baseName = (p: string) => p.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
const pathKey = (p: string) => p.replace(/\\/g, '/').toLowerCase();
const nearestLength = (s: number) => LENGTHS.reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a), LENGTHS[0]);
const errText = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');


const won = (u: { input: number; output: number }) =>
  Math.max(1, Math.round(((u.input * HAIKU_PRICE.input + u.output * HAIKU_PRICE.output) / 1e6) * KRW_PER_USD));

export const ScriptGenCard: React.FC<{ onSendToScript: (text: string) => void }> = ({ onSendToScript }) => {
  const { assets, addAssets, setStatusMessage } = useEditorStore();
  const api = window.electronAPI;
  const [form, setForm] = useState<Form>(defaultForm);
  const [result, setResult] = useState<Result | null>(null);
  const hasKey = useClaudeKey();
  const [busy, setBusy] = useState<'' | 'order' | 'video' | 'plan' | 'gen'>('');
  const [videoNotes, setVideoNotes] = useState('');
  const [progress, setProgress] = useState('');

  useEffect(() => localStorage.setItem(EXAMPLES_KEY, JSON.stringify(form.examplePaths)), [form.examplePaths]);
  useEffect(() => {
    return api?.onScriptGenProgress?.((msg) => setProgress(msg));
  }, [api]);

  const videos = assets.filter((a) => a.type === 'video');
  const numbers = useMemo(() => videoNumbers(videos), [videos]);
  const excluded = new Set(form.excludedVideoPaths.map(pathKey));
  const chosenVideos = videos.filter((v) => !excluded.has(pathKey(v.path)));
  const points = splitList(form.sellingPoints);
  const mustInclude = splitList(form.mustInclude);
  const effMode: Exclude<ScriptMode, 'auto'> = form.mode === 'auto' ? (points.length ? 'distribute' : 'story') : form.mode;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setSpec = (i: number, patch: Partial<VersionSpec>) =>
    setForm((f) => ({ ...f, versions: f.versions.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const setCount = (n: number) =>
    setForm((f) => ({ ...f, versions: Array.from({ length: n }, (_, i) => f.versions[i] || emptySpec()) }));
  const togglePoint = (i: number, k: number) =>
    setForm((f) => ({
      ...f,
      versions: f.versions.map((s, j) =>
        j === i ? { ...s, points: s.points.includes(k) ? s.points.filter((x) => x !== k) : [...s.points, k].sort((a, b) => a - b) } : s
      ),
    }));
  const toggleVideo = (v: MediaAsset, on: boolean) =>
    setForm((f) => ({
      ...f,
      excludedVideoPaths: on
        ? f.excludedVideoPaths.filter((p) => pathKey(p) !== pathKey(v.path))
        : [...f.excludedVideoPaths, v.path],
    }));

  const importVideos = async () => {
    const r = await api?.openMediaFolderDialog?.();
    if (!r || !api?.probeMedia) return;
    const have = new Set(assets.map((a) => pathKey(a.path)));
    const probed = [];
    for (const p of r.files.filter((x) => !have.has(pathKey(x)))) {
      try {
        probed.push(await api.probeMedia(p));
      } catch {
        // 분석 못 하는 파일은 건너뜀
      }
    }
    if (probed.length) addAssets(probed);
    setStatusMessage(`폴더 '${r.folderName}'에서 영상 ${probed.length}개를 미디어에 올렸습니다.`);
  };

  const pickExamples = async () => {
    const paths = await api?.openScriptExamplesDialog?.();
    if (!paths?.length) return;
    const have = new Set(form.examplePaths.map(pathKey));
    set('examplePaths', [...form.examplePaths, ...paths.filter((p) => !have.has(pathKey(p)))]);
  };

  // ---------- 오더 읽기
  const openOrderFile = async () => {
    try {
      const f = await api?.openOrderFileDialog?.();
      if (f) {
        set('order', f.text);
        setProgress(`'${f.name}'을(를) 불러왔어요. [오더 읽기]를 누르면 아래 칸이 채워져요.`);
      }
    } catch (e) {
      setProgress(`파일을 읽지 못했어요: ${errText(e)}`);
    }
  };
  const readOrder = async () => {
    if (!api?.scriptGenParseOrder || !form.order.trim()) return;
    setBusy('order');
    setProgress('AI가 오더를 읽는 중...');
    try {
      const r = await api.scriptGenParseOrder(form.order);
      setForm((f) => ({
        ...f,
        product: r.product || f.product,
        facts: r.facts || f.facts,
        sellingPoints: r.sellingPoints.length ? r.sellingPoints.join('\n') : f.sellingPoints,
        mustInclude: r.mustInclude.join('\n'),
        tone: r.tone,
        target: r.target || f.target,
        mode: r.mode,
        modeReason: r.modeReason,
        orderNotes: r.notes,
        seconds: r.seconds ? nearestLength(r.seconds) : f.seconds,
        versions: r.versionCount
          ? Array.from({ length: r.versionCount }, (_, i) => ({ ...(f.versions[i] || emptySpec()), points: [] }))
          : f.versions.map((s) => ({ ...s, points: [] })),
      }));
      setProgress(`오더를 읽었어요 — 소구점 ${r.sellingPoints.length}개 · 버전 방식 '${modeLabel(r.mode)}' · 약 ${won(r.usage)}원. 아래 내용을 확인해 주세요.`);
    } catch (e) {
      setProgress(`실패: ${errText(e)}`);
    } finally {
      setBusy('');
    }
  };

  // ---------- 영상 보고 제품 정보 채우기 (오더가 없을 때)
  const fillFromVideos = async () => {
    if (!api?.scriptGenFromVideos || !chosenVideos.length) return;
    setBusy('video');
    setProgress('시작...');
    try {
      const media = chosenVideos.map((v) => ({ no: numbers.get(v.id) ?? 0, path: v.path, duration: v.duration, name: v.name }));
      const r = await api.scriptGenFromVideos({ product: form.product, media });
      setForm((f) => ({
        ...f,
        product: f.product.trim() || r.product,
        facts: f.facts.trim() ? f.facts : r.facts,
        sellingPoints: f.sellingPoints.trim() ? f.sellingPoints : r.sellingPoints.join('\n'),
        target: f.target.trim() || r.target,
        versions: f.versions.map((x) => ({ ...x, points: [] })),
      }));
      setVideoNotes(r.notes);
      setProgress(`영상을 보고 채웠어요 — 소구점 후보 ${r.sellingPoints.length}개 · 약 ${won(r.usage)}원. "(확인 필요)"가 붙은 건 꼭 확인해 주세요. 이미 적어 둔 칸은 그대로 뒀어요.`);
    } catch (e) {
      setProgress(`실패: ${errText(e)}`);
    } finally {
      setBusy('');
    }
  };

  // ---------- 버전 기획표
  const makePlan = async () => {
    if (!api?.scriptGenPlan) return;
    setBusy('plan');
    setProgress('AI가 버전 기획표를 만드는 중...');
    try {
      const r = await api.scriptGenPlan({
        product: form.product.trim(),
        facts: form.facts.trim(),
        sellingPoints: points,
        mustInclude,
        tone: form.tone,
        mode: form.mode,
        space: form.space,
        target: form.target.trim(),
        versions: form.versions,
      });
      setForm((f) => ({ ...f, versions: r.versions }));
      setProgress(`기획표를 만들었어요 (${modeLabel(r.mode)}) · 약 ${won(r.usage)}원. 콘셉트와 맡은 소구점을 고친 뒤 [대본 만들기]를 누르세요.`);
    } catch (e) {
      setProgress(`실패: ${errText(e)}`);
    } finally {
      setBusy('');
    }
  };
  const unassigned =
    effMode === 'distribute' && points.length && form.versions.length
      ? points.map((_, k) => k + 1).filter((k) => !form.versions.some((s) => s.points.includes(k)))
      : [];
  const anyAssigned = form.versions.some((s) => s.points.length);

  // ---------- 결과 고치기: 같은 검사를 다시
  const recheck = (v: ScriptVersion, r: Result, i: number): ScriptVersion => {
    const auto = v.warnings.filter((w) => w.startsWith('ㅋㅋ'));
    return { ...v, warnings: [...auto, ...checkVersion(v, r.media, r.seconds, { mustInclude: r.mustInclude, points: r.points[i], shots: r.shots })] };
  };
  const editVersion = (i: number, patch: Partial<ScriptVersion>) =>
    setResult((r) => (r ? { ...r, versions: r.versions.map((v, j) => (j === i ? recheck({ ...v, ...patch }, r, i) : v)) } : r));

  const missing = [
    !(form.product.trim() || form.facts.trim() || points.length || chosenVideos.length) && '제품 이름·사실 또는 참고할 영상',
    !form.seconds && '길이',
    !form.versions.length && '버전 수',
    hasKey === false && 'Claude API 키',
  ].filter(Boolean) as string[];
  const canRun = !!api?.scriptGenGenerate && hasKey && !busy && missing.length === 0;
  const canPlan = !!api?.scriptGenPlan && hasKey && !busy && form.versions.length > 0 && !!(form.product.trim() || form.facts.trim() || points.length || chosenVideos.length);

  const run = async () => {
    if (!api?.scriptGenGenerate) return;
    setBusy('gen');
    setProgress('시작...');
    try {
      const media = chosenVideos.map((v) => ({ no: numbers.get(v.id) ?? 0, path: v.path, duration: v.duration, name: v.name }));
      const r = await api.scriptGenGenerate({
        product: form.product.trim(),
        facts: form.facts.trim(),
        sellingPoints: points,
        mustInclude,
        tone: form.tone,
        mode: form.mode,
        space: form.space,
        target: form.target.trim(),
        seconds: form.seconds,
        versions: form.versions,
        media,
        examplePaths: form.examplePaths,
      });
      const perVersion = form.versions.map((s) => (r.mode === 'samebody' ? points : s.points.map((k) => points[k - 1]).filter(Boolean)));
      setResult({
        ...r,
        media: media.map((m) => ({ no: m.no, duration: m.duration })),
        seconds: form.seconds,
        mustInclude,
        points: perVersion,
      });
      setProgress(`완료 — 대본 ${r.versions.length}개 (${modeLabel(r.mode)}), 검수에서 ${r.fixes.length}곳 고침 · 비용 약 ${won(r.usage)}원`);
    } catch (e) {
      setProgress(`실패: ${errText(e)}`);
    } finally {
      setBusy('');
    }
  };

  const fullText = result ? scriptToText(result.versions) : '';
  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text);
    setStatusMessage(`${what}을(를) 복사했습니다.`);
  };
  const saveTxt = async () => {
    if (!result || !api?.scriptGenSaveTxt) return;
    const p = await api.scriptGenSaveTxt({ defaultName: `${form.product.trim() || '대본'}_대본.txt`, content: fullText });
    if (p) setStatusMessage(`대본을 저장했습니다: ${p}`);
  };

  return (
    <div className="space-y-3.5">
      {/* 입력 */}
      <div className={box}>
        <div className="font-semibold text-white flex items-center gap-1.5">
          <PenLine className="w-4 h-4 text-[#2d8ceb]" />
          STEP 0. AI 대본 만들기
        </div>
        <p className="text-[11px] text-[#aaaaaa] leading-relaxed">
          제품 정보(또는 클라이언트 오더)와 원본 영상을 보고 AI(Haiku)가 광고 대본을 여러 버전 씁니다. 다 쓴 뒤 AI가 한 번 더
          검수하고, 길이·금지 글자(ㅋㅋ·이모지)·꼭 넣을 문장·숫자도 검사합니다.
        </p>
        <ClaudeKeyBox usedFor="AI 대본 만들기" />
        <TypecastKeyBox />
        <ElevenLabsKeyBox />

        {/* 클라이언트 오더 */}
        <div className="space-y-1 bg-[#14161a] border border-[#2e3440] rounded p-2">
          <div className="flex items-center justify-between">
            <span className={`${label} flex items-center gap-1`}>
              <ClipboardList className="w-3 h-3" /> 클라이언트 오더 (선택)
            </span>
            <button onClick={openOrderFile} className={`${btn} bg-[#2b2b2b] text-[#dddddd] flex items-center gap-1`}>
              <FileText className="w-3 h-3" /> 파일 열기 (txt·docx)
            </button>
          </div>
          <textarea
            value={form.order}
            onChange={(e) => set('order', e.target.value)}
            rows={form.order ? 6 : 2}
            placeholder="클라이언트가 보낸 오더 메시지를 그대로 붙여 넣으세요. 비워 두면 아래 칸에 직접 적으면 됩니다."
            className={`${input} resize-y leading-relaxed`}
          />
          <button
            onClick={readOrder}
            disabled={!form.order.trim() || !hasKey || !!busy}
            className={`${btn} w-full bg-[#2b2b2b] text-white border border-[#2d8ceb]/60 flex items-center justify-center gap-1`}
          >
            {busy === 'order' ? <Loader2 className="w-3 h-3 animate-spin" /> : <ClipboardList className="w-3 h-3" />} 오더 읽기 → 아래 칸 채우기
          </button>
          {form.orderNotes && <div className="text-[10px] text-[#aaaaaa] leading-relaxed">오더의 기타 요청: {form.orderNotes}</div>}
        </div>

        <div className="space-y-1">
          <div className={label}>제품 이름</div>
          <input value={form.product} onChange={(e) => set('product', e.target.value)} placeholder="예: 캐릭터 흡착 수납함" className={input} />
        </div>
        <div className="space-y-1">
          <div className={label}>공통 사실 (한 줄에 하나 — 브랜드·인증·가격·옵션 등)</div>
          <textarea
            value={form.facts}
            onChange={(e) => set('facts', e.target.value)}
            rows={4}
            placeholder={'예:\n- 매력: 얼굴·팔·장화 다리가 달린 귀여운 캐릭터 디자인\n- 설치: 흡착판을 벽에 꾹 누르면 붙음, 드릴 필요 없음\n- 통만 떼서 물로 헹굼'}
            className={`${input} resize-y leading-relaxed`}
          />
          <div className="text-[10px] text-[#777777]">가장 큰 매력은 "매력:"으로 적어 두면 그걸 중심으로 한 버전이 들어갑니다.</div>
        </div>
        <div className="space-y-1">
          <div className={label}>소구점 (한 줄에 하나, 선택)</div>
          <textarea
            value={form.sellingPoints}
            onChange={(e) => set('sellingPoints', e.target.value)}
            rows={points.length ? Math.min(10, points.length + 1) : 3}
            placeholder={'예:\n어깨뿔 방지 라운드 굴곡 설계\n360° 회전형 고리\n누적 판매량 100만 개'}
            className={`${input} resize-y leading-relaxed`}
          />
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <div className="space-y-1">
            <div className={label}>꼭 넣을 문장 (한 줄에 하나)</div>
            <textarea
              value={form.mustInclude}
              onChange={(e) => set('mustInclude', e.target.value)}
              rows={2}
              placeholder="모든 버전에 글자 그대로"
              className={`${input} resize-y leading-relaxed`}
            />
          </div>
          <div className="space-y-1">
            <div className={label}>말투</div>
            <select value={form.tone} onChange={(e) => set('tone', e.target.value as ScriptTone)} className={input}>
              <option value="">자동 (존댓말 경험담)</option>
              <option value="존댓말">존댓말</option>
              <option value="반말">반말</option>
            </select>
          </div>
        </div>
        <div className="space-y-1">
          <div className={label}>버전 방식</div>
          <select value={form.mode} onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value as ScriptMode, modeReason: '' }))} className={input}>
            {SCRIPT_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <div className="text-[10px] text-[#777777] leading-relaxed">
            {form.modeReason
              ? `AI가 고른 이유: ${form.modeReason}`
              : form.mode === 'auto'
                ? `지금은 '${modeLabel(effMode)}'로 씁니다 (소구점이 있으면 나눠 쓰기).`
                : effMode === 'distribute'
                  ? '소구점을 버전마다 나눠 맡깁니다. 모든 소구점이 최소 한 버전에는 들어가요.'
                  : effMode === 'samebody'
                    ? '모든 버전이 같은 본문을 쓰고, 앞부분(후킹)만 다릅니다.'
                    : '버전마다 이야기가 다르고, 핵심 장점 한 줄과 마무리는 공통입니다.'}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <div className="space-y-1">
            <div className={label}>공간 (선택)</div>
            <select value={form.space} onChange={(e) => set('space', e.target.value)} className={input}>
              <option value="">선택 안 함</option>
              {SPACES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <div className={label}>길이</div>
            <select value={form.seconds || ''} onChange={(e) => set('seconds', Number(e.target.value))} className={input}>
              <option value="" disabled>
                선택하세요
              </option>
              {LENGTHS.map((s) => (
                <option key={s} value={s}>
                  {s}초 (약 {targetChars(s)}자)
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <div className={label}>버전 수</div>
            <input
              type="number"
              min={1}
              max={MAX_VERSIONS}
              value={form.versions.length || ''}
              onChange={(e) => {
                const v = Math.floor(Number(e.target.value));
                setCount(Number.isFinite(v) && v > 0 ? Math.min(MAX_VERSIONS, v) : 0);
              }}
              placeholder="숫자 입력"
              className={input}
              title={`1~${MAX_VERSIONS}개. 8개가 넘으면 8개씩 나눠서 씁니다`}
            />
          </div>
        </div>
        <div className="space-y-1">
          <div className={label}>타겟 (선택)</div>
          <input value={form.target} onChange={(e) => set('target', e.target.value)} placeholder="예: 전월세 사는 20~30대, 아이 있는 집" className={input} />
        </div>

        {/* 버전별 지정 = 기획표 */}
        {form.versions.length > 0 && (
          <div className="space-y-1.5 border-t border-[#2e2e2e] pt-2">
            <div className="flex items-center justify-between">
              <span className={label}>버전 기획표 (비워 두면 AI가 겹치지 않게 정함)</span>
              <button onClick={makePlan} disabled={!canPlan} className={`${btn} bg-[#2b2b2b] text-white border border-[#2d8ceb]/60 flex items-center gap-1`}>
                {busy === 'plan' ? <Loader2 className="w-3 h-3 animate-spin" /> : <LayoutList className="w-3 h-3" />} 기획표 만들기
              </button>
            </div>
            {form.versions.map((s, i) => (
              <div key={i} className="bg-[#14161a] border border-[#2e3440] rounded p-2 space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-white shrink-0 w-10">버전 {i + 1}</span>
                  <select value={s.hookType} onChange={(e) => setSpec(i, { hookType: e.target.value })} className={input}>
                    <option value={HOOK_AUTO}>후킹: 자동</option>
                    {HOOK_TYPES.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.id} — "{h.example}"
                      </option>
                    ))}
                  </select>
                </div>
                <textarea
                  value={s.story}
                  onChange={(e) => setSpec(i, { story: e.target.value })}
                  rows={s.story.length > 40 ? 3 : 1}
                  placeholder="이야기·콘셉트 (예: 아끼는 니트에 어깨뿔이 생겼다)"
                  className={`${input} resize-y leading-relaxed`}
                />
                <textarea
                  value={s.focus}
                  onChange={(e) => setSpec(i, { focus: e.target.value })}
                  rows={s.focus.length > 40 ? 3 : 1}
                  placeholder="중심 장점 (예: 어깨 자국 없는 라운드 설계)"
                  className={`${input} resize-y leading-relaxed`}
                />
                {points.length > 0 && effMode !== 'samebody' && (
                  <div className="flex flex-wrap gap-1 items-center">
                    <span className="text-[10px] text-[#888888] mr-0.5">맡은 소구점</span>
                    {points.map((t, k) => {
                      const on = s.points.includes(k + 1);
                      return (
                        <button
                          key={k}
                          title={t}
                          onClick={() => togglePoint(i, k + 1)}
                          className={`min-w-[22px] h-[20px] px-1 rounded text-[10px] font-semibold border transition ${
                            on ? 'bg-[#2d8ceb] border-[#2d8ceb] text-white' : 'bg-[#1b1e24] border-[#3a4050] text-[#888888] hover:text-white'
                          }`}
                        >
                          {k + 1}
                        </button>
                      );
                    })}
                  </div>
                )}
                {s.points.length > 0 && effMode !== 'samebody' && (
                  <div className="text-[10px] text-[#aaaaaa] leading-relaxed">{s.points.map((k) => points[k - 1]).filter(Boolean).join(' · ')}</div>
                )}
              </div>
            ))}
            {anyAssigned && unassigned.length > 0 && (
              <div className="text-[10px] text-[#e3b341] flex items-start gap-1">
                <AlertTriangle className="w-3 h-3 shrink-0 mt-px" /> 어느 버전에도 안 들어간 소구점: {unassigned.join(', ')}번
              </div>
            )}
          </div>
        )}

        {/* 영상 */}
        <div className="space-y-1 border-t border-[#2e2e2e] pt-2">
          <div className="flex items-center justify-between">
            <span className={label}>
              참고할 원본 영상: {chosenVideos.length}/{videos.length}개
            </span>
            <button onClick={importVideos} className={`${btn} bg-[#2b2b2b] text-[#dddddd] flex items-center gap-1`}>
              <FolderOpen className="w-3 h-3" /> 폴더에서 가져오기
            </button>
          </div>
          {videos.length === 0 ? (
            <div className="text-[10px] text-[#777777]">미디어에 영상이 없습니다. 없어도 되지만, 있으면 장면을 보고 후킹 장면까지 골라 줍니다.</div>
          ) : (
            <div className="max-h-28 overflow-y-auto space-y-0.5">
              {videos.map((v) => (
                <label key={v.id} className="flex items-center gap-1.5 text-[11px] text-[#dddddd] cursor-pointer">
                  <input type="checkbox" checked={!excluded.has(pathKey(v.path))} onChange={(e) => toggleVideo(v, e.target.checked)} className="accent-[#2d8ceb]" />
                  <span className="text-[#79b8ff] shrink-0">{numbers.get(v.id)}번</span>
                  <span className="truncate">{v.name}</span>
                  <span className="text-[#777777] shrink-0">{v.duration.toFixed(0)}초</span>
                </label>
              ))}
            </div>
          )}
          {chosenVideos.length > 6 && <div className="text-[10px] text-[#e3b341]">영상이 많으면 비용이 늘어요. 6개 이하를 권장합니다.</div>}
          {chosenVideos.length > 0 && (
            <button
              onClick={fillFromVideos}
              disabled={!hasKey || !!busy}
              className={`${btn} w-full bg-[#2b2b2b] text-white border border-[#2d8ceb]/60 flex items-center justify-center gap-1`}
              title="오더나 소구점을 모를 때: 영상 장면과 파일 이름을 보고 제품 이름·사실·소구점 후보를 비어 있는 칸에 채웁니다"
            >
              {busy === 'video' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />} 영상 보고 제품 정보 채우기
            </button>
          )}
          {videoNotes && <div className="text-[10px] text-[#aaaaaa] leading-relaxed">영상 참고: {videoNotes}</div>}
        </div>

        {/* 말투 예시 */}
        <div className="space-y-1 border-t border-[#2e2e2e] pt-2">
          <div className="flex items-center justify-between">
            <span className={label}>말투 예시 대본: {form.examplePaths.length}개</span>
            <button onClick={pickExamples} className={`${btn} bg-[#2b2b2b] text-[#dddddd] flex items-center gap-1`}>
              <FileText className="w-3 h-3" /> 파일 고르기
            </button>
          </div>
          <div className="text-[10px] text-[#777777]">버전끼리 이야기가 확실히 다른 대본 2~3개를 고르면 좋아요. 내 PC에서만 읽습니다.</div>
          {form.examplePaths.map((p) => (
            <div key={p} className="flex items-center gap-1 text-[11px] text-[#dddddd]">
              <span className="truncate flex-1" title={p}>
                {baseName(p)}
              </span>
              <button onClick={() => set('examplePaths', form.examplePaths.filter((x) => x !== p))} className="text-[#888888] hover:text-white">
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>

        <button onClick={run} disabled={!canRun} className={`${btn} w-full bg-[#2d8ceb] text-white flex items-center justify-center gap-1.5 py-2`}>
          {busy === 'gen' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PenLine className="w-3.5 h-3.5" />}
          {form.versions.length ? `대본 ${form.versions.length}개 만들기` : '대본 만들기'}
        </button>
        {missing.length > 0 && <div className="text-[10px] text-[#e3b341]">{missing.join(', ')}을(를) 먼저 넣어 주세요.</div>}
        <div className="text-[10px] text-[#777777] leading-relaxed">
          AI를 2번 부릅니다 (쓰기 + 검수). 1회 약 10원. 오더 읽기·기획표는 각각 몇 원. 영상을 고르면 처음 한 번만 장면 분석을 하고 저장해서, 다시 만들
          때와 STEP 3 자동 배치 때는 영상을 다시 보지 않습니다.
        </div>
        {progress && <div className="text-[11px] text-[#79b8ff] leading-relaxed">{progress}</div>}
      </div>

      {/* 결과 */}
      {result && (
        <div className={box}>
          <div className="flex items-center justify-between">
            <span className="font-semibold text-white">
              만든 대본 {result.versions.length}개 <span className="text-[10px] text-[#79b8ff] font-normal">{modeLabel(result.mode)}</span>
            </span>
            <button onClick={() => setResult(null)} className="text-[10px] text-[#888888] hover:text-white">
              지우기
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            <button onClick={() => onSendToScript(fullText)} className={`${btn} flex-1 min-w-[140px] whitespace-nowrap bg-[#2d8ceb] text-white flex items-center justify-center gap-1`}>
              <Send className="w-3 h-3" /> STEP 2 대본 칸으로
            </button>
            <button
              onClick={() => copy(fullText, '전체 대본')}
              title="후킹 장면 줄(3초 : n번 a~b초)까지 포함해서 전체 복사"
              className={`${btn} bg-[#2b2b2b] text-[#dddddd] flex items-center gap-1`}
            >
              <Copy className="w-3 h-3" /> 전체 복사
            </button>
            <button
              onClick={() =>
                copy(
                  result.versions.map((v) => v.lines.map((l) => l.trim()).filter(Boolean).join('\n')).join('\n\n'),
                  '전체 대사'
                )
              }
              title="후킹 장면 줄은 빼고 모든 버전의 대사만 복사 (버전 사이 빈 줄)"
              className={`${btn} bg-[#2b2b2b] text-[#dddddd] flex items-center gap-1`}
            >
              <Copy className="w-3 h-3" /> 대사 전체 복사
            </button>
            <button onClick={saveTxt} className={`${btn} bg-[#2b2b2b] text-[#dddddd] flex items-center gap-1`}>
              <Save className="w-3 h-3" /> txt 저장
            </button>
          </div>

          {result.versions.map((v, i) => (
            <div key={i} className="bg-[#14161a] border border-[#2e3440] rounded p-2 space-y-1.5">
              <div className="flex items-center justify-between gap-1">
                <span className="text-[11px] font-semibold text-white">
                  버전 {i + 1} <span className="text-[#79b8ff] font-normal">[{v.hookType}]</span>
                </span>
                <span className="text-[10px] text-[#888888] shrink-0">
                  약 {Math.round(estimateSeconds(v.lines))}초 · {v.lines.join('').replace(/[^가-힣0-9a-zA-Z]/g, '').length}자
                </span>
              </div>
              {v.angle && <div className="text-[10px] text-[#aaaaaa] leading-relaxed">{v.angle}</div>}
              {result.mode !== 'samebody' && result.points[i]?.length > 0 && (
                <div className="text-[10px] text-[#888888] leading-relaxed">맡은 소구점: {result.points[i].join(' · ')}</div>
              )}
              <input value={v.hookSpec} onChange={(e) => editVersion(i, { hookSpec: e.target.value })} className={`${input} text-[#e3b341]`} title="후킹 장면 지정 (AI 자동 배치가 읽음)" />
              <textarea
                value={v.lines.join('\n')}
                onChange={(e) => editVersion(i, { lines: e.target.value.split('\n') })}
                onBlur={() => editVersion(i, { lines: v.lines.map((l) => cleanLine(l).line).filter(Boolean) })}
                rows={Math.min(14, Math.max(5, v.lines.length + 1))}
                className={`${input} resize-y leading-relaxed`}
              />
              {v.warnings.length > 0 && (
                <div className="space-y-0.5">
                  {v.warnings.map((w) => (
                    <div key={w} className="text-[10px] text-[#e3b341] flex items-start gap-1">
                      <AlertTriangle className="w-3 h-3 shrink-0 mt-px" /> {w}
                    </div>
                  ))}
                </div>
              )}
              <button onClick={() => copy(v.lines.join('\n'), `버전 ${i + 1} 대사`)} className={`${btn} bg-[#2b2b2b] text-[#dddddd] flex items-center gap-1`}>
                <Copy className="w-3 h-3" /> 대사만 복사
              </button>
            </div>
          ))}

          <VoiceGenPanel versions={result.versions} product={form.product} videos={videos} />

          {result.fixes.length > 0 && (
            <details className="text-[10px] text-[#aaaaaa]">
              <summary className="cursor-pointer text-[11px] text-[#cccccc]">AI 검수가 고친 곳 {result.fixes.length}개</summary>
              <div className="space-y-1 mt-1">
                {result.fixes.map((f, k) => (
                  <div key={k} className="leading-relaxed">
                    <span className="text-[#79b8ff]">버전 {f.version}</span> {f.before} → <span className="text-white">{f.after}</span>
                    <div className="text-[#777777]">{f.reason}</div>
                  </div>
                ))}
              </div>
            </details>
          )}
          <div className="text-[10px] text-[#777777]">
            사용량: 입력 {result.usage.input.toLocaleString()} · 출력 {result.usage.output.toLocaleString()} 토큰 (약 {won(result.usage)}원)
            {result.exampleCount ? ` · 말투 예시 ${result.exampleCount}개 사용` : ''}
          </div>
        </div>
      )}
    </div>
  );
};
