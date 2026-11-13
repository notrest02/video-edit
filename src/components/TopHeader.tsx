import React, { useEffect, useState } from 'react';
import { Undo2, Redo2, Download, Loader2, Save, FolderOpen, FilePlus, Keyboard } from 'lucide-react';
import { ShortcutSettingsModal } from './ShortcutSettingsModal';
import { useEditorStore } from '../store/useEditorStore';
import type { ExportCheckResult } from '../types/editor';
import { exportRange } from '../utils/exportRange';

type CheckReport = { file: string; check: ExportCheckResult };

/** 내보낸 영상 컷 검사 결과 창: 의심 자리마다 앞뒤 5프레임 사진 (가운데가 문제 프레임) */
const ExportCheckModal: React.FC<{ reports: CheckReport[]; onClose: () => void }> = ({ reports, onClose }) => {
  const fileName = (p: string) => p.split(/[\\/]/).pop();
  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-[#1d1d1d] border border-[#3a3a3a] rounded-lg w-[1320px] max-w-[95vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 border-b border-[#2d2d2d] flex items-center justify-between">
          <div className="text-[13px] font-semibold text-[#e6e6e6]">컷 검사: 확인이 필요한 자리 (가운데 사진이 문제 프레임)</div>
          <button onClick={onClose} className="px-2 py-0.5 rounded bg-[#2a2a2a] hover:bg-[#3a3a3a] text-[12px]">
            닫기
          </button>
        </div>
        <div className="overflow-y-auto p-4 space-y-4 text-[12px]">
          <div className="text-[#999999]">
            영상 프레임을 숫자로 비교해 찾은 '의심' 자리예요. 사진을 보고 정상이면 무시하세요. 못 잡는 것: 한국어 자막 아래로 살짝 비치는 원본 글자.
          </div>
          {reports.map((r) => (
            <div key={r.file} className="space-y-2">
              <div className="text-[#79b8ff] font-medium">
                {fileName(r.file)} — 컷 {r.check.cuts}개 중 의심 {r.check.problems.length}곳
              </div>
              {r.check.problems.map((p) => (
                <div key={p.frame} className="bg-[#161616] border border-[#2d2d2d] rounded p-2 space-y-1.5">
                  <div>
                    <span className="text-[#f5a623] font-semibold">⚠️ {p.time.toFixed(2)}초</span>{' '}
                    <span className="text-[#dddddd]">{p.kind}</span> <span className="text-[#888888]">— {p.msg}</span>
                  </div>
                  {p.image && <img src={`media://local?path=${encodeURIComponent(p.image)}`} className="w-full rounded" />}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export const TopHeader: React.FC = () => {
  const [isExporting, setIsExporting] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  // 렌더 범위: 전체 시퀀스 / 인~아웃 구간
  const [renderRange, setRenderRange] = useState<'all' | 'inout' | 'segments'>('inout');
  const [exportProgress, setExportProgress] = useState(0);
  // 내보낸 영상 컷 검사 결과 (내보내기 직후 자동, 비용 없음). 의심 자리가 있으면 창으로 보여 줌
  const [checkReports, setCheckReports] = useState<CheckReport[]>([]);

  const {
    projectName,
    projectFilePath,
    isDirty,
    clips,
    tracks,
    fps,
    sequence,
    past,
    future,
    statusMessage,
    setProjectName,
    saveProject,
    openProject,
    newProject,
    undo,
    redo,
    getTotalDuration,
    setStatusMessage,
    inPoint,
    outPoint,
  } = useEditorStore();
  const hasInOut = inPoint !== null || outPoint !== null;
  const adSegments = useEditorStore((s) => s.sequences.find((q) => q.id === s.activeSequenceId)?.adSegments) || [];
  const hasSegments = adSegments.length > 1;
  const useInOutRange = hasInOut && renderRange === 'inout';
  const rangeValue = renderRange === 'segments' ? (hasSegments ? 'segments' : 'all') : hasInOut ? renderRange : 'all';

  useEffect(() => {
    if (!window.electronAPI) return;
    const unsubscribe = window.electronAPI.onExportProgress((prog) => {
      setExportProgress(prog);
    });
    return () => unsubscribe();
  }, []);

  /** [rangeStart, rangeEnd] 구간을 MP4 로. outputPath 를 주면 저장 창 없이 그 경로로 (광고 구간별 내보내기) */
  const renderRangeTo = (rangeStart: number, rangeEnd: number, outputPath?: string) => exportRange(rangeStart, rangeEnd, outputPath);

  /** 광고 구간마다 파일 하나씩: 저장 폴더 한 번 고르고 <구간 이름>.mp4 로 */
  const handleExportSegments = async () => {
    if (!window.electronAPI?.chooseFolderDialog || !hasSegments) return;
    if (clips.length === 0) {
      setStatusMessage('내보낼 클립이 타임라인에 없습니다.');
      return;
    }
    const folder = await window.electronAPI.chooseFolderDialog('광고 구간별 MP4 저장 폴더');
    if (!folder) return;
    setIsExporting(true);
    const done: string[] = [];
    const reports: CheckReport[] = [];
    try {
      for (let i = 0; i < adSegments.length; i++) {
        const g = adSegments[i];
        setExportProgress(1);
        setStatusMessage(`광고 ${i + 1}/${adSegments.length} (${g.name}) 내보내는 중...`);
        const res = await renderRangeTo(g.start, g.end, `${folder}\\${g.name}.mp4`);
        if (res.outputPath) done.push(res.outputPath);
        if (res.outputPath && res.check) reports.push({ file: res.outputPath, check: res.check });
      }
      const bad = reports.reduce((n, r) => n + r.check.problems.length, 0);
      setStatusMessage(
        `광고 ${done.length}개 내보내기 완료: ${folder}${reports.length ? (bad ? ` — 컷 검사 의심 ${bad}곳` : ' — 컷 검사 문제 없음') : ''}`
      );
      if (bad) setCheckReports(reports);
    } catch (err: any) {
      setStatusMessage(`광고 구간별 내보내기 실패 (${done.length}개 완료): ${err.message}`);
    } finally {
      setIsExporting(false);
      setExportProgress(0);
    }
  };

  const handleExportMp4 = async () => {
    if (!window.electronAPI) return;
    if (renderRange === 'segments' && hasSegments) {
      await handleExportSegments();
      return;
    }
    if (clips.length === 0) {
      setStatusMessage('내보낼 클립이 타임라인에 없습니다.');
      return;
    }

    const fullDuration = getTotalDuration();
    const rangeStart = useInOutRange ? Math.max(0, inPoint ?? 0) : 0;
    const rangeEnd = useInOutRange ? Math.min(fullDuration, outPoint ?? fullDuration) : fullDuration;
    if (rangeEnd - rangeStart < 0.05) {
      setStatusMessage('인/아웃 구간이 너무 짧거나 클립이 없는 위치입니다.');
      return;
    }
    setIsExporting(true);
    setExportProgress(1);
    setStatusMessage('MP4 렌더링 준비 중...');

    try {
      const res = await exportRange(rangeStart, rangeEnd);

      if (res.canceled) {
        setStatusMessage('내보내기가 취소되었습니다.');
      } else {
        const n = res.check?.problems.length ?? 0;
        setStatusMessage(
          `MP4 내보내기 완료${useInOutRange ? ' (인~아웃 구간)' : ''}: ${res.outputPath}${res.check ? (n ? ` — 컷 검사 의심 ${n}곳` : ' — 컷 검사 문제 없음') : ''}`
        );
        if (n && res.outputPath && res.check) setCheckReports([{ file: res.outputPath, check: res.check }]);
      }
    } catch (err: any) {
      setStatusMessage(`MP4 내보내기 실패: ${err.message}`);
    } finally {
      setIsExporting(false);
      setExportProgress(0);
    }
  };

  return (
    <header className="h-9 shrink-0 bg-[#161616] border-b border-[#111111] px-3 flex items-center justify-between select-none text-xs text-[#cccccc]">
      {/* 좌측: 프로젝트(새로만들기/열기/저장) | 가져오기 | 시퀀스 | 내보내기 */}
      <div className="flex items-center gap-2.5 h-full">

        {/* 프로젝트 관리 그룹 (새 프로젝트, 열기, 저장) */}
        <div className="flex items-center gap-1 bg-[#202020] px-1 py-0.5 rounded border border-[#2d2d2d]">
          <button
            onClick={() => newProject()}
            title="새 프로젝트 (Ctrl+N)"
            className="px-1.5 py-0.5 rounded hover:bg-[#2e2e2e] text-[#aaaaaa] hover:text-white transition flex items-center gap-1 text-[11px]"
          >
            <FilePlus className="w-3.5 h-3.5 text-[#888888]" />
            <span className="hidden sm:inline">새로만들기</span>
          </button>

          <button
            onClick={() => openProject()}
            title="프로젝트 열기 (Ctrl+O)"
            className="px-1.5 py-0.5 rounded hover:bg-[#2e2e2e] text-[#aaaaaa] hover:text-white transition flex items-center gap-1 text-[11px]"
          >
            <FolderOpen className="w-3.5 h-3.5 text-[#e5a038]" />
            <span>열기</span>
          </button>

          <button
            onClick={() => saveProject(false)}
            title="프로젝트 저장 (Ctrl+S)"
            className="px-2 py-0.5 rounded hover:bg-[#2e2e2e] text-[#aaaaaa] hover:text-white transition flex items-center gap-1 text-[11px]"
          >
            <Save className={`w-3.5 h-3.5 ${isDirty ? 'text-[#e5a038]' : 'text-[#3fb950]'}`} />
            <span className={isDirty ? 'text-[#e5a038] font-bold' : ''}>
              저장{isDirty ? '*' : ''}
            </span>
          </button>

          <button
            onClick={() => saveProject(true)}
            title="다른 이름으로 저장 (Ctrl+Shift+S)"
            className="px-1.5 py-0.5 rounded hover:bg-[#2e2e2e] text-[#888888] hover:text-[#eeeeee] transition text-[11px]"
          >
            다른이름저장
          </button>
        </div>

        <div className="h-3.5 w-[1px] bg-[#333333] mx-0.5" />

        <div className="flex items-center gap-1">
          <button
            onClick={undo}
            disabled={past.length === 0}
            title="실행 취소 (Ctrl+Z)"
            className="p-1 rounded hover:bg-[#2a2a2a] disabled:opacity-30 text-[#cccccc]"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={redo}
            disabled={future.length === 0}
            title="다시 실행 (Ctrl+Y)"
            className="p-1 rounded hover:bg-[#2a2a2a] disabled:opacity-30 text-[#cccccc]"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="h-3.5 w-[1px] bg-[#333333] mx-0.5" />
        <button
          onClick={() => setShowShortcuts(true)}
          title="키보드 단축키 보기 / 바꾸기"
          className="px-1.5 py-0.5 rounded hover:bg-[#2e2e2e] text-[#aaaaaa] hover:text-white transition flex items-center gap-1 text-[11px]"
        >
          <Keyboard className="w-3.5 h-3.5" />
          <span>단축키</span>
        </button>
      </div>

      {/* 중앙: 프로젝트 이름 & 상태 표시 */}
      <div className="flex items-center gap-2 max-w-xl truncate">
        <div
          title={projectFilePath || '저장되지 않은 프로젝트 (Ctrl+S로 저장)'}
          className="flex items-center gap-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-0.5"
        >
          {isDirty && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-[#f5a623]"
              title="저장되지 않은 변경사항 있음"
            />
          )}
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            className="bg-transparent text-center font-medium text-[#dddddd] focus:outline-none focus:bg-[#222222] rounded px-1 w-32 text-xs"
          />
          <span className="text-[10px] text-[#666666]">.agproj</span>
        </div>
        {statusMessage && (
          <span className="text-[11px] text-[#79b8ff] bg-[#1b2838] border border-[#2d8ceb]/40 px-2.5 py-0.5 rounded truncate max-w-[340px]">
            {statusMessage}
          </span>
        )}
      </div>

      {/* 우측: 빠른 클립-자막 맞춤 & 워크스페이스/내보내기 */}
      <div className="flex items-center gap-2.5">
        <select
          value={rangeValue}
          onChange={(e) => setRenderRange(e.target.value as 'all' | 'inout' | 'segments')}
          disabled={isExporting}
          title="렌더 범위 (타임라인에서 I / O 키로 인·아웃 지점 지정)"
          className="bg-[#262626] border border-[#3a3a3a] rounded px-1.5 py-1 text-[11px] text-[#dddddd] focus:outline-none"
        >
          <option value="all">전체</option>
          <option value="inout" disabled={!hasInOut}>
            인~아웃{hasInOut ? '' : ' (없음)'}
          </option>
          <option value="segments" disabled={!hasSegments}>
            광고 구간별{hasSegments ? ` (${adSegments.length}개)` : ' (없음)'}
          </option>
        </select>

        <button
          onClick={handleExportMp4}
          disabled={isExporting}
          className="px-2.5 py-1 rounded bg-[#2d8ceb] hover:bg-[#1e78d6] text-white text-[11px] font-semibold flex items-center gap-1 transition"
        >
          {isExporting ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Download className="w-3 h-3" />
          )}
          {isExporting ? `내보내는 중 ${exportProgress}%` : 'MP4 출력'}
        </button>

      </div>
      {showShortcuts && <ShortcutSettingsModal onClose={() => setShowShortcuts(false)} />}
      {checkReports.length > 0 && <ExportCheckModal reports={checkReports} onClose={() => setCheckReports([])} />}
    </header>
  );
};
