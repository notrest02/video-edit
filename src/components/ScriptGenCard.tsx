/**
 * STEP 0 '대본 만들기' 카드: 제품 정보 + 미디어 영상 + 말투 예시(고객 대본 txt) → Claude(Haiku)가 광고 대본 여러 버전
 * 버전마다 후킹 유형·이야기·중심 장점을 지정(자동 가능). 결과는 고쳐 쓸 수 있고, 복사/저장/STEP 2 대본 칸으로 보내기.
 * 앱을 켤 때마다 빈 칸으로 시작한다 (탭을 옮기는 동안은 유지). 말투 예시 파일 목록만 기억한다.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Copy, FileText, FolderOpen, Loader2, PenLine, Save, Send, X } from 'lucide-react';
import { useEditorStore } from '../store/useEditorStore';
import { ClaudeKeyBox, useClaudeKey } from './ClaudeKeyBox';
import type { MediaAsset } from '../types/editor';
import {
  HAIKU_PRICE,
  HOOK_AUTO,
  HOOK_TYPES,
  KRW_PER_USD,
  checkVersion,
  cleanLine,
  estimateSeconds,
  scriptToText,
  targetChars,
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

type VersionSpec = { hookType: string; story: string; focus: string };
type Form = {
  product: string;
  facts: string;
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
  media: Array<{ no: number; duration: number }>;
  seconds: number;
};

const emptySpec = (): VersionSpec => ({ hookType: HOOK_AUTO, story: '', focus: '' });
const defaultForm = (): Form => ({
  product: '',
  facts: '',
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

/** 대본의 'n번' 번호 — AI 자동 배치와 같은 규칙: 이름이 숫자로 시작하면 그 숫자, 아니면 미디어 영상 순서 */
function videoNumbers(videos: MediaAsset[]): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  videos.forEach((v) => {
    const m = v.name.match(/^(\d+)(\D|$)/);
    if (m && !used.has(Number(m[1]))) {
      out.set(v.id, Number(m[1]));
      used.add(Number(m[1]));
    }
  });
  videos.forEach((v, i) => {
    if (out.has(v.id)) return;
    let n = i + 1;
    while (used.has(n)) n++;
    out.set(v.id, n);
    used.add(n);
  });
  return out;
}

const won = (u: { input: number; output: number }) =>
  Math.max(1, Math.round(((u.input * HAIKU_PRICE.input + u.output * HAIKU_PRICE.output) / 1e6) * KRW_PER_USD));

export const ScriptGenCard: React.FC<{ onSendToScript: (text: string) => void }> = ({ onSendToScript }) => {
  const { assets, addAssets, setStatusMessage } = useEditorStore();
  const api = window.electronAPI;
  const [form, setForm] = useState<Form>(defaultForm);
  const [result, setResult] = useState<Result | null>(null);
  const hasKey = useClaudeKey();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');

  useEffect(() => localStorage.setItem(EXAMPLES_KEY, JSON.stringify(form.examplePaths)), [form.examplePaths]);
  useEffect(() => {
    return api?.onScriptGenProgress?.((msg) => setProgress(msg));
  }, [api]);

  const videos = assets.filter((a) => a.type === 'video');
  const numbers = useMemo(() => videoNumbers(videos), [videos]);
  const excluded = new Set(form.excludedVideoPaths.map(pathKey));
  const chosenVideos = videos.filter((v) => !excluded.has(pathKey(v.path)));

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setSpec = (i: number, patch: Partial<VersionSpec>) =>
    setForm((f) => ({ ...f, versions: f.versions.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const setCount = (n: number) =>
    setForm((f) => ({ ...f, versions: Array.from({ length: n }, (_, i) => f.versions[i] || emptySpec()) }));
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

  // 진행 중 사용자가 고친 대본도 같은 검사를 다시 한다
  const recheck = (v: ScriptVersion, r: Result): ScriptVersion => {
    const auto = v.warnings.filter((w) => w.startsWith('ㅋㅋ'));
    return { ...v, warnings: [...auto, ...checkVersion(v, r.media, r.seconds)] };
  };
  const editVersion = (i: number, patch: Partial<ScriptVersion>) =>
    setResult((r) => (r ? { ...r, versions: r.versions.map((v, j) => (j === i ? recheck({ ...v, ...patch }, r) : v)) } : r));

  const missing = [
    !(form.product.trim() || form.facts.trim()) && '제품 이름이나 사실',
    !form.seconds && '길이',
    !form.versions.length && '버전 수',
    hasKey === false && 'Claude API 키',
  ].filter(Boolean) as string[];
  const canRun = !!api?.scriptGenGenerate && hasKey && !busy && missing.length === 0;

  const run = async () => {
    if (!api?.scriptGenGenerate) return;
    setBusy(true);
    setProgress('시작...');
    try {
      const media = chosenVideos.map((v) => ({ no: numbers.get(v.id) ?? 0, path: v.path, duration: v.duration, name: v.name }));
      const r = await api.scriptGenGenerate({
        product: form.product.trim(),
        facts: form.facts.trim(),
        space: form.space,
        target: form.target.trim(),
        seconds: form.seconds,
        versions: form.versions,
        media,
        examplePaths: form.examplePaths,
      });
      setResult({ ...r, media: media.map((m) => ({ no: m.no, duration: m.duration })), seconds: form.seconds });
      setProgress(`완료 — 대본 ${r.versions.length}개, 검수에서 ${r.fixes.length}곳 고침 · 비용 약 ${won(r.usage)}원`);
    } catch (e) {
      setProgress(`실패: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
    } finally {
      setBusy(false);
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
          제품 정보와 원본 영상을 보고 AI(Haiku)가 <strong>이야기가 서로 다른</strong> 광고 대본을 씁니다. 다 쓴 뒤 AI가 한 번 더
          검수하고, 길이와 금지 글자(ㅋㅋ·이모지)도 검사합니다.
        </p>
        <ClaudeKeyBox usedFor="AI 대본 만들기" />

        <div className="space-y-1">
          <div className={label}>제품 이름</div>
          <input value={form.product} onChange={(e) => set('product', e.target.value)} placeholder="예: 캐릭터 흡착 수납함" className={input} />
        </div>
        <div className="space-y-1">
          <div className={label}>제품 사실 (한 줄에 하나, 영상·상세페이지에서 확인된 것만)</div>
          <textarea
            value={form.facts}
            onChange={(e) => set('facts', e.target.value)}
            rows={6}
            placeholder={
              '예:\n- 매력: 얼굴·팔·장화 다리가 달린 귀여운 캐릭터 디자인\n- 설치: 흡착판을 벽에 꾹 누르면 붙음, 드릴 필요 없음\n- 벽 손상·끈적임 없음\n- 칫솔·빗·화장품 수납, 쓴 세안 티슈 넣는 휴지통\n- 통만 떼서 물로 헹굼'
            }
            className={`${input} resize-y leading-relaxed`}
          />
          <div className="text-[10px] text-[#777777]">가장 큰 매력은 "매력:"으로 적어 두면 그걸 중심으로 한 버전이 꼭 들어갑니다.</div>
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
            <select value={form.versions.length || ''} onChange={(e) => setCount(Number(e.target.value))} className={input}>
              <option value="" disabled>
                선택하세요
              </option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}개
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="space-y-1">
          <div className={label}>타겟 (선택)</div>
          <input value={form.target} onChange={(e) => set('target', e.target.value)} placeholder="예: 전월세 사는 20~30대, 아이 있는 집" className={input} />
        </div>

        {/* 버전별 지정 */}
        {form.versions.length > 0 && (
        <div className="space-y-1.5 border-t border-[#2e2e2e] pt-2">
          <div className={label}>버전별 지정 (비워 두면 AI가 겹치지 않게 정함)</div>
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
              <input value={s.story} onChange={(e) => setSpec(i, { story: e.target.value })} placeholder="이야기 (예: 전세라 벽에 못을 못 박는다)" className={input} />
              <input value={s.focus} onChange={(e) => setSpec(i, { focus: e.target.value })} placeholder="중심 장점 (예: 구멍 없는 설치, 2단으로 붙이기)" className={input} />
            </div>
          ))}
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
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PenLine className="w-3.5 h-3.5" />}
          {form.versions.length ? `대본 ${form.versions.length}개 만들기` : '대본 만들기'}
        </button>
        {missing.length > 0 && <div className="text-[10px] text-[#e3b341]">{missing.join(', ')}을(를) 먼저 넣어 주세요.</div>}
        <div className="text-[10px] text-[#777777]">AI를 2번 부릅니다 (쓰기 + 검수). 영상 3~4개 기준 1회 약 10원.</div>
        {progress && <div className="text-[11px] text-[#79b8ff]">{progress}</div>}
      </div>

      {/* 결과 */}
      {result && (
        <div className={box}>
          <div className="flex items-center justify-between">
            <span className="font-semibold text-white">만든 대본 {result.versions.length}개</span>
            <button onClick={() => setResult(null)} className="text-[10px] text-[#888888] hover:text-white">
              지우기
            </button>
          </div>
          <div className="flex gap-1">
            <button onClick={() => onSendToScript(fullText)} className={`${btn} flex-1 bg-[#2d8ceb] text-white flex items-center justify-center gap-1`}>
              <Send className="w-3 h-3" /> STEP 2 대본 칸으로
            </button>
            <button onClick={() => copy(fullText, '전체 대본')} className={`${btn} bg-[#2b2b2b] text-[#dddddd] flex items-center gap-1`}>
              <Copy className="w-3 h-3" /> 전체 복사
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
