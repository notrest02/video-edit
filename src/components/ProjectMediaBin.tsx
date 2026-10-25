import React, { useState } from 'react';
import {
  Search,
  FolderPlus,
  Wand2,
  Film,
  Music,
  List,
  Grid,
  Trash2,
  Layers,
  PlusSquare,
  Settings,
  AlertTriangle,
  FolderSearch,
} from 'lucide-react';
import { useEditorStore } from '../store/useEditorStore';
import { formatFullTimecode } from '../utils/subtitleSnapper';

export const ProjectMediaBin: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [isCreatingSample, setIsCreatingSample] = useState(false);

  const {
    projectName,
    assets,
    missingAssetIds,
    isRelinkModalOpen,
    setIsRelinkModalOpen,
    sequences,
    activeSequenceId,
    selectedBinItem,
    fps,
    addAssets,
    addAssetToTimeline,
    openNewSequenceModal,
    openEditSequenceModal,
    selectSequence,
    deleteSequence,
    duplicateSequence,
    removeAsset,
    setSelectedBinItem,
    deleteSelectedLayers,
    setStatusMessage,
  } = useEditorStore();

  const handleOpenMedia = async () => {
    if (!window.electronAPI) return;
    const files = await window.electronAPI.openMediaDialog();
    if (files && files.length > 0) {
      addAssets(files);
      setStatusMessage(
        `${files.length}개의 미디어 파일을 가져왔습니다. 타임라인으로 드래그하거나 [+ 새 시퀀스]를 만드세요!`
      );
    }
  };

  const handleCreateSampleVideo = async () => {
    if (!window.electronAPI) return;
    try {
      setIsCreatingSample(true);
      setStatusMessage('테스트용 12초 샘플 영상(음성 4구간 포함) 생성 중...');
      const sample = await window.electronAPI.createSampleVideo();
      const created = addAssets([sample]);
      if (created[0]) {
        addAssetToTimeline(created[0].id);
      }
    } catch (err: any) {
      setStatusMessage(`샘플 생성 오류: ${err.message}`);
    } finally {
      setIsCreatingSample(false);
    }
  };

  const handleExternalDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (!window.electronAPI) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    const probedList = [];
    for (const f of files) {
      const filePath = (f as any).path;
      if (filePath) {
        try {
          const info = await window.electronAPI.probeMedia(filePath);
          probedList.push(info);
        } catch (err) {
          console.error('Probe failed:', err);
        }
      }
    }
    if (probedList.length > 0) {
      addAssets(probedList);
      setStatusMessage(`${probedList.length}개의 미디어가 프로젝트 보관함에 추가되었습니다.`);
    }
  };

  const filteredSequences = sequences.filter((s) =>
    s.name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const filteredAssets = assets.filter((a) =>
    a.name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const totalCount = filteredSequences.length + filteredAssets.length;

  return (
    <section
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleExternalDrop}
      className="w-[430px] shrink-0 bg-[#1d1d1d] border-r border-[#111111] flex flex-col h-full select-none text-[#cccccc]"
    >
      {/* 프로젝트 상단 액션 바 (+ 새 시퀀스 / 미디어 가져오기 / 샘플 영상) */}
      <div className="p-2 space-y-1.5 border-b border-[#2b2b2b] bg-[#1d1d1d]">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[#aaaaaa] font-mono truncate">🎬 {projectName}.prproj</span>
          <div className="flex items-center gap-1">
            <button
              onClick={openNewSequenceModal}
              title="원하는 해상도/비율로 새 시퀀스 생성"
              className="px-2 py-0.5 bg-[#2ea043] hover:bg-[#268c39] text-white rounded text-[11px] font-semibold flex items-center gap-1 transition"
            >
              <PlusSquare className="w-3 h-3" /> 새 시퀀스
            </button>
            <button
              onClick={handleOpenMedia}
              className="px-2 py-0.5 bg-[#2d8ceb] hover:bg-[#1e78d6] text-white rounded text-[11px] font-medium flex items-center gap-1 transition"
            >
              <FolderPlus className="w-3 h-3" /> 가져오기
            </button>
            <button
              onClick={handleCreateSampleVideo}
              disabled={isCreatingSample}
              className="px-2 py-0.5 bg-[#2b2b2b] hover:bg-[#383838] text-[#dddddd] border border-[#3d3d3d] rounded text-[11px] flex items-center gap-1 transition"
            >
              <Wand2 className="w-3 h-3 text-[#2d8ceb]" />
              {isCreatingSample ? '생성 중' : '샘플'}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="relative flex-1">
            <Search className="w-3 h-3 text-[#777777] absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="시퀀스 및 미디어 검색"
              className="w-full bg-[#121212] border border-[#333333] focus:border-[#2d8ceb] rounded pl-6 pr-2 py-0.5 text-[11px] text-white placeholder-[#666666] focus:outline-none"
            />
          </div>
          <span className="text-[11px] text-[#888888] shrink-0">{totalCount} 항목</span>
        </div>

        {/* 누락(오프라인) 미디어 경고 배너 */}
        {missingAssetIds.length > 0 && (
          <div className="bg-[#f85149]/15 border border-[#f85149]/30 rounded px-2.5 py-1.5 flex items-center justify-between text-[11px] text-[#ff7b72]">
            <span className="flex items-center gap-1.5 font-semibold truncate">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              {missingAssetIds.length}개의 미디어가 오프라인 상태입니다
            </span>
            <button
              onClick={() => setIsRelinkModalOpen(true)}
              className="px-2 py-0.5 rounded bg-[#f85149] hover:bg-[#da3633] text-white text-[10px] font-bold shrink-0 transition flex items-center gap-1 shadow-xs"
            >
              <FolderSearch className="w-3 h-3" />
              미디어 재연결
            </button>
          </div>
        )}
      </div>

      {/* 테이블 컬럼 헤더 (이름 | 프레임 속도 / 규격 | 미디어 시작 | 미디어 끝) */}
      <div className="grid grid-cols-12 bg-[#232323] border-b border-[#2e2e2e] px-2 py-1 text-[11px] text-[#999999] font-medium">
        <div className="col-span-5 flex items-center gap-1">이름 ↑</div>
        <div className="col-span-3 border-l border-[#333333] pl-1.5">규격 / FPS</div>
        <div className="col-span-2 border-l border-[#333333] pl-1.5">시작</div>
        <div className="col-span-2 border-l border-[#333333] pl-1.5">끝 / 관리</div>
      </div>

      {/* 시퀀스 목록 + 미디어 에셋 목록 */}
      <div className="flex-1 overflow-y-auto divide-y divide-[#242424] bg-[#181818]">
        {totalCount === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-4 text-[#777777] space-y-2.5">
            <Layers className="w-7 h-7 text-[#444444]" />
            <div className="text-xs text-[#aaaaaa] leading-relaxed">
              <strong>[+ 새 시퀀스]</strong>로 원하는 규격의 시퀀스를 만들거나,
              <br />
              미디어를 가져와 타임라인에 바로 드래그하면 영상 사이즈에 맞는 시퀀스가 자동 생성됩니다.
            </div>
            <div className="flex gap-2">
              <button
                onClick={openNewSequenceModal}
                className="px-2.5 py-1 bg-[#2ea043]/25 hover:bg-[#2ea043]/40 text-[#7ee787] rounded text-xs border border-[#2ea043]/50 font-semibold"
              >
                + 새 시퀀스 만들기
              </button>
              <button
                onClick={handleOpenMedia}
                className="px-2.5 py-1 bg-[#2b2b2b] hover:bg-[#383838] text-white rounded text-xs border border-[#444444]"
              >
                파일 열기
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* 1. 생성된 시퀀스(Sequence) 그룹 아이템들 */}
            {filteredSequences.map((seq) => {
              const isActive = seq.id === activeSequenceId;
              const isBinSelected =
                selectedBinItem?.type === 'sequence' && selectedBinItem.id === seq.id;
              const seqDur =
                seq.clips.length > 0
                  ? Math.max(...seq.clips.map((c) => c.startTime + c.duration))
                  : 0;

              return (
                <div
                  key={seq.id}
                  onClick={() => {
                    selectSequence(seq.id);
                    setSelectedBinItem({ type: 'sequence', id: seq.id });
                  }}
                  onDoubleClick={() => openEditSequenceModal(seq.id)}
                  title="클릭 시 시퀀스 진입 · 더블클릭 또는 [편집] 클릭 시 시퀀스 규격/이름 편집 · Delete 키로 삭제"
                  className={`grid grid-cols-12 items-center px-2 py-1.5 text-[11px] cursor-pointer group transition-colors ${
                    isActive || isBinSelected
                      ? 'bg-[#1f3247] border-l-2 border-l-[#2d8ceb] text-white'
                      : 'hover:bg-[#252a32] text-[#dddddd]'
                  }`}
                >
                  <div className="col-span-5 flex items-center gap-1.5 min-w-0 pr-1">
                    <span className="w-3.5 h-3.5 rounded-xs bg-[#2ea043] flex items-center justify-center text-white shrink-0">
                      <Layers className="w-2.5 h-2.5" />
                    </span>
                    <span className="px-1 py-0.2 rounded bg-[#2ea043]/25 text-[#7ee787] text-[9px] font-bold shrink-0">
                      시퀀스
                    </span>
                    <span className="truncate font-semibold">{seq.name}</span>
                  </div>
                  <div className="col-span-3 pl-1.5 font-mono text-[10px] text-[#9ecbff] truncate">
                    {seq.width}×{seq.height} · {seq.fps}f
                  </div>
                  <div className="col-span-1 pl-1 font-mono text-[#aaaaaa] text-[10px]">
                    {seq.clips.length}컷
                  </div>
                  <div className="col-span-3 pl-1 flex items-center justify-end gap-1 font-mono text-[#aaaaaa] text-[10px]">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openEditSequenceModal(seq.id);
                      }}
                      title="시퀀스 이름/해상도/FPS 편집"
                      className="px-1.5 py-0.5 rounded bg-[#2d8ceb]/25 hover:bg-[#2d8ceb] text-[#79b8ff] hover:text-white text-[10px] font-sans font-semibold flex items-center gap-0.5 transition"
                    >
                      <Settings className="w-2.5 h-2.5" />
                      편집
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        duplicateSequence(seq.id);
                      }}
                      title="시퀀스 복제"
                      className="px-1 py-0.5 rounded bg-[#2b2b2b] hover:bg-[#3a3a3a] text-[#cccccc] text-[10px] font-sans"
                    >
                      복제
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSequence(seq.id);
                      }}
                      title="시퀀스 삭제 (Delete)"
                      className="p-0.5 rounded hover:bg-rose-500/25 text-[#999999] hover:text-rose-400"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })}

            {/* 2. 원본 미디어 파일 아이템들 (열린 시퀀스 안으로 드래그 앤 드롭) */}
            {filteredAssets.map((asset) => {
              const isAssetSelected =
                selectedBinItem?.type === 'asset' && selectedBinItem.id === asset.id;
              const isMissing = missingAssetIds.includes(asset.id);

              return (
                <div
                  key={asset.id}
                  draggable
                  onClick={() => setSelectedBinItem({ type: 'asset', id: asset.id })}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-agy-asset-id', asset.id);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onDoubleClick={() => {
                    if (isMissing) {
                      setIsRelinkModalOpen(true);
                    } else {
                      addAssetToTimeline(asset.id);
                    }
                  }}
                  title={
                    isMissing
                      ? '⚠️ 오프라인 미디어입니다. 더블클릭하여 새 파일 경로를 연결하세요.'
                      : '타임라인으로 드래그 앤 드롭 · 클릭 후 Delete 키로 보관함에서 삭제'
                  }
                  className={`grid grid-cols-12 items-center px-2 py-1.5 text-[11px] cursor-grab active:cursor-grabbing group transition-colors ${
                    isMissing
                      ? 'bg-[#2b1919]/60 hover:bg-[#3d1e1e] text-[#ff7b72]'
                      : isAssetSelected
                      ? 'bg-[#26354a] text-white'
                      : 'hover:bg-[#262d38] text-[#dddddd]'
                  }`}
                >
                  <div className="col-span-5 flex items-center gap-1.5 min-w-0 pr-1">
                    <span
                      className={`w-3 h-3 rounded-xs shrink-0 inline-block ${
                        isMissing ? 'bg-[#f85149]' : 'bg-[#2d8ceb]'
                      }`}
                    />
                    {asset.type === 'video' ? (
                      <span className="flex items-center shrink-0 text-[#a882ff]">
                        <Film className="w-3.5 h-3.5" />
                      </span>
                    ) : (
                      <span className="flex items-center shrink-0 text-[#3fb950]">
                        <Music className="w-3.5 h-3.5" />
                      </span>
                    )}
                    {isMissing && (
                      <span className="px-1 py-0.2 rounded bg-[#ff7b72]/20 text-[#ff7b72] text-[9px] font-bold shrink-0 font-mono">
                        오프라인
                      </span>
                    )}
                    <span className="truncate group-hover:text-white">{asset.name}</span>
                  </div>
                  <div className="col-span-3 pl-1.5 font-mono text-[10px] text-[#aaaaaa] truncate">
                    {asset.width ? `${asset.width}×${asset.height} · ` : ''}
                    {(asset.fps || fps).toFixed(0)}f
                  </div>
                  <div className="col-span-2 pl-1.5 font-mono text-[#aaaaaa] text-[10px]">
                    00:00:00:00
                  </div>
                  <div className="col-span-2 pl-1.5 flex items-center justify-between font-mono text-[#aaaaaa] text-[10px]">
                    <span className="truncate">
                      {formatFullTimecode(asset.duration, asset.fps || fps).slice(3)}
                    </span>
                    <div className="flex items-center gap-1">
                      {isMissing && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setIsRelinkModalOpen(true);
                          }}
                          title="미디어 다시 연결 (찾아보기)"
                          className="p-0.5 rounded hover:bg-[#2ea043]/30 text-[#aaaaaa] hover:text-[#3fb950]"
                        >
                          <FolderSearch className="w-3 h-3" />
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeAsset(asset.id);
                        }}
                        title="미디어 삭제 (Delete)"
                        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-rose-500/25 text-[#999999] hover:text-rose-400"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* 하단 상태 아이콘 바 */}
      <div className="h-6 bg-[#1d1d1d] border-t border-[#2b2b2b] px-2 flex items-center justify-between text-[#888888]">
        <div className="flex items-center gap-2">
          <List className="w-3.5 h-3.5 text-white cursor-pointer" />
          <Grid className="w-3.5 h-3.5 hover:text-white cursor-pointer" />
          <span className="text-[10px] text-[#777777]">
            시퀀스 클릭 시 진입 · 미디어 드래그 시 배치
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openNewSequenceModal}
            title="새 시퀀스 만들기"
            className="hover:text-white"
          >
            <PlusSquare className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={deleteSelectedLayers}
            title="선택한 시퀀스/미디어/레이어 삭제 (Delete)"
            className="hover:text-rose-400 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </section>
  );
};
