import React, { useEffect } from 'react';
import { TopHeader } from './components/TopHeader';
import { ModelStatusBar } from './components/ModelStatusBar';
import { LeftSidebar } from './components/LeftSidebar';
import { PreviewPlayer } from './components/PreviewPlayer';
import { RightInspector } from './components/RightInspector';
import { ProjectMediaBin } from './components/ProjectMediaBin';
import { TimelinePanel } from './components/TimelinePanel';
import { SequenceSettingsModal } from './components/SequenceSettingsModal';
import { RelinkMediaModal } from './components/RelinkMediaModal';
import { useEditorStore } from './store/useEditorStore';
import { ensureFontsForValues } from './utils/pcFonts';
import { importDroppedFiles } from './utils/dropImport';

export const App: React.FC = () => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      const state = useEditorStore.getState();
      const isCtrl = e.ctrlKey || e.metaKey;

      // 1. [Ctrl / Cmd 복합 단축키 우선 처리]
      // - Ctrl+S / Ctrl+Shift+S (저장 / 다른 이름으로 저장)
      // - Ctrl+O (열기), Ctrl+N (새로만들기), Ctrl+Z / Ctrl+Y (실행취소/다시실행)
      // - 중요: Ctrl이 눌렸을 때는 일반 단일키 's'(클립 분할) 등이 절대 실행되지 않고 즉시 return!
      if (isCtrl) {
        if (e.code === 'KeyS' || e.key.toLowerCase() === 's' || e.key === 'ㄴ') {
          e.preventDefault();
          e.stopPropagation();
          state.saveProject(e.shiftKey);
          return;
        }

        if (e.code === 'KeyO' || e.key.toLowerCase() === 'o' || e.key === 'ㅐ') {
          e.preventDefault();
          e.stopPropagation();
          state.openProject();
          return;
        }

        if (e.code === 'KeyN' || e.key.toLowerCase() === 'n' || e.key === 'ㅜ') {
          e.preventDefault();
          e.stopPropagation();
          state.newProject();
          return;
        }

        if (e.code === 'KeyZ' || e.key.toLowerCase() === 'z' || e.key === 'ㅋ') {
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) {
            state.redo();
          } else {
            state.undo();
          }
          return;
        }

        if (e.code === 'KeyY' || e.key.toLowerCase() === 'y' || e.key === 'ㅛ') {
          e.preventDefault();
          e.stopPropagation();
          state.redo();
          return;
        }

        // Ctrl+Shift+X: 인/아웃 지점 지우기 (프리미어와 동일)
        if (e.shiftKey && (e.code === 'KeyX' || e.key.toLowerCase() === 'x' || e.key === 'ㅌ')) {
          e.preventDefault();
          state.clearInOut();
          state.setStatusMessage('인/아웃 지점을 지웠습니다.');
          return;
        }

        return; // 기타 Ctrl 조합 시 하단의 단일 문자 단축키 실행 방지
      }

      // 2. [단일 키 단축키 - Ctrl/Cmd 미입력 시에만 실행]
      if (e.code === 'Space') {
        e.preventDefault();
        state.setIsPlaying(!state.isPlaying);
      } else if (e.code === 'KeyI' && !e.altKey) {
        // I: 인 지점 표시
        e.preventDefault();
        state.setInPoint(state.currentTime);
      } else if (e.code === 'KeyO' && !e.altKey) {
        // O: 아웃 지점 표시
        e.preventDefault();
        state.setOutPoint(state.currentTime);
      } else if (e.code === 'KeyV' || e.key === 'v' || e.key === 'V' || e.key === 'ㅍ') {
        state.setActiveTool('select');
      } else if (e.code === 'KeyC' || e.key === 'c' || e.key === 'C' || e.key === 'ㅊ') {
        state.setActiveTool('razor');
      } else if (e.code === 'KeyS' || e.key === 's' || e.key === 'S' || e.key === 'ㄴ') {
        // 순수 'S' 키만 눌렸을 때만 인디케이터 클립 분할!
        e.preventDefault();
        state.splitClipAtPlayhead();
      } else if (e.key === 'Enter' && state.isQuickSplitMergeMode) {
        // 단축키 분할/합치기 모드가 켜져 있을 때 Enter를 누르면 현재 선택/표시 중인 자막 클립을 즉시 분할
        const activeSub =
          state.clips.find((c) => c.id === state.selectedClipId && c.type === 'text') ||
          state.clips.find(
            (c) =>
              c.type === 'text' &&
              state.currentTime >= c.startTime &&
              state.currentTime < c.startTime + c.duration
          );
        if (activeSub) {
          e.preventDefault();
          state.splitSubtitleClipAtTextCursor(activeSub.id);
        }
      } else if (e.key === 'Backspace' && state.isQuickSplitMergeMode) {
        // 단축키 분할/합치기 모드가 켜져 있을 때 Backspace를 누르면 현재 선택/표시 중인 자막을 앞 자막과 병합
        const activeSub =
          state.clips.find((c) => c.id === state.selectedClipId && c.type === 'text') ||
          state.clips.find(
            (c) =>
              c.type === 'text' &&
              state.currentTime >= c.startTime &&
              state.currentTime < c.startTime + c.duration
          );
        if (activeSub) {
          e.preventDefault();
          state.mergeSubtitleClipWithAdjacent(activeSub.id, e.shiftKey ? 'next' : 'prev');
        } else {
          e.preventDefault();
          state.deleteSelectedLayers();
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        state.deleteSelectedLayers();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        state.setIsPlaying(false);
        state.setCurrentTime(Math.max(0, state.currentTime - 1 / state.fps));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        state.setIsPlaying(false);
        state.setCurrentTime(state.currentTime + 1 / state.fps);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 저장 안 된 변경 여부를 메인 프로세스에 알려서, 창을 닫을 때 저장 여부를 묻게 한다
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.setDirtyState) return;
    api.setDirtyState(useEditorStore.getState().isDirty);
    const unsubDirty = useEditorStore.subscribe((st, prev) => {
      if (st.isDirty !== prev.isDirty) api.setDirtyState?.(st.isDirty);
    });
    const unsubClose = api.onRequestSaveBeforeClose?.(async () => {
      const saved = await useEditorStore.getState().saveProject(false);
      api.reportSaveBeforeClose?.(saved);
    });
    return () => {
      unsubDirty();
      unsubClose?.();
    };
  }, []);

  // 창 아무 곳에나 파일을 끌어다 놓으면 프로젝트 미디어로 가져오기
  // (트랙/미디어 패널 위에 놓은 경우는 각 패널이 먼저 처리하고 preventDefault 한다)
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.files?.length) return;
      const alreadyHandled = e.defaultPrevented;
      e.preventDefault(); // 파일을 창에 놓았을 때 앱 화면이 그 파일로 바뀌어 버리는 기본 동작 차단
      if (alreadyHandled) return;
      importDroppedFiles(Array.from(e.dataTransfer.files));
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  // 영상 미디어마다 미리보기용 프록시를 백그라운드에서 생성 (인디케이터를 끌 때 프레임이 부드럽게 보이도록)
  const assets = useEditorStore((st) => st.assets);
  const requestedProxyRef = React.useRef<Set<string>>(new Set());
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.ensurePreviewProxy) return;
    const todo = assets.filter(
      (a) => a.type === 'video' && a.path && !requestedProxyRef.current.has(a.path)
    );
    for (const a of todo) {
      requestedProxyRef.current.add(a.path);
      api
        .ensurePreviewProxy(a.path)
        .then((proxy) => {
          if (proxy) useEditorStore.getState().setPreviewProxy(a.path, proxy);
        })
        .catch(() => {
          // 프록시 생성 실패 시 원본으로 계속 미리보기
        });
    }
  }, [assets]);

  // 자막에 쓰인 내 PC 글꼴을 실제 글꼴 파일로 등록 (프로젝트를 다시 열었을 때도 동일하게 보이도록)
  const clips = useEditorStore((st) => st.clips);
  const fontKey = Array.from(new Set(clips.map((c) => c.fontFamily || ''))).sort().join('|');
  useEffect(() => {
    if (fontKey) ensureFontsForValues(fontKey.split('|'));
  }, [fontKey]);

  return (
    <div className="h-screen w-screen flex flex-col bg-[#111111] text-[#cccccc] overflow-hidden">
      {/* 최상단 프리미어 스타일 메뉴 바 */}
      <TopHeader />
      <ModelStatusBar />

      {/* 상단 영역 (54% 높이): [좌: 텍스트/대본/캡션] | [중: 프로그램 모니터] | [우: 속성] */}
      <div className="h-[54%] flex min-h-0 border-b-[3px] border-[#0a0a0a] overflow-hidden">
        <LeftSidebar />
        <PreviewPlayer />
        <RightInspector />
      </div>

      {/* 하단 영역 (46% 높이): [좌: 프로젝트 미디어 보관함] | [중: 세로 툴바 + V3/V2/V1 & A1/A2/A3 타임라인] | [우: dB 오디오 미터] */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <ProjectMediaBin />
        <TimelinePanel />
      </div>

      {/* 새 시퀀스 만들기 / 시퀀스 규격 커스텀 모달 */}
      <SequenceSettingsModal />

      {/* 누락 미디어 재연결 모달 (Premiere Pro Link Media) */}
      <RelinkMediaModal />
    </div>
  );
};

export default App;
