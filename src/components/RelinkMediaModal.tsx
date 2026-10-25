import React, { useState } from 'react';
import { AlertTriangle, FolderSearch, X, CheckCircle2, FileQuestion, FolderOpen } from 'lucide-react';
import { useEditorStore } from '../store/useEditorStore';

export const RelinkMediaModal: React.FC = () => {
  const {
    assets,
    missingAssetIds,
    isRelinkModalOpen,
    setIsRelinkModalOpen,
    relinkAsset,
    relinkAssetsInBatch,
    setStatusMessage,
  } = useEditorStore();

  const [isLocating, setIsLocating] = useState(false);
  const [autoBatchNotice, setAutoBatchNotice] = useState<string | null>(null);

  if (!isRelinkModalOpen || missingAssetIds.length === 0) {
    return null;
  }

  const missingAssets = assets.filter((a) => missingAssetIds.includes(a.id));

  const handleLocateSingle = async (assetId: string, currentPath: string, fileName: string) => {
    if (!window.electronAPI?.locateMediaDialog) return;

    try {
      setIsLocating(true);
      setAutoBatchNotice(null);

      const chosenPath = await window.electronAPI.locateMediaDialog(fileName);
      if (!chosenPath) return;

      // 1. 선택한 파일 재연결
      await relinkAsset(assetId, chosenPath);

      // 2. 같은 폴더 내 다른 누락 파일 자동 탐색 및 일괄 재연결 (프리미어 프로 자동 스마트 재연결)
      const folderPath = chosenPath.replace(/[/\\][^/\\]+$/, '');
      const remainingMissing = assets.filter(
        (a) => a.id !== assetId && missingAssetIds.includes(a.id)
      );

      if (remainingMissing.length > 0 && window.electronAPI.scanFolderForMatches) {
        const fileNames = remainingMissing.map((a) => a.name);
        const matches = await window.electronAPI.scanFolderForMatches(folderPath, fileNames);

        const relinkMap: Record<string, string> = {};
        for (const rem of remainingMissing) {
          if (matches[rem.name]) {
            relinkMap[rem.id] = matches[rem.name];
          }
        }

        const autoLinkedCount = Object.keys(relinkMap).length;
        if (autoLinkedCount > 0) {
          await relinkAssetsInBatch(relinkMap);
          setAutoBatchNotice(
            `동일한 폴더에서 ${autoLinkedCount}개의 누락 파일이 추가로 자동 감지되어 한 번에 연결되었습니다!`
          );
        }
      }
    } catch (err: any) {
      setStatusMessage(`미디어 재연결 실패: ${err.message}`);
    } finally {
      setIsLocating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 select-none">
      <div className="bg-[#1c1c1c] border border-[#333333] rounded-lg shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* 모달 헤더 */}
        <div className="px-5 py-3.5 bg-[#242424] border-b border-[#333333] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-full bg-[#f85149]/20 text-[#f85149]">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                누락된 미디어 파일 재연결 (Link Missing Media)
                <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-[#f85149]/30 text-[#ff7b72]">
                  {missingAssets.length}개 누락
                </span>
              </h2>
              <p className="text-[11px] text-[#aaaaaa]">
                미디어 파일의 위치가 바뀌었거나 파일명이 변경되었습니다. 새 파일 경로를 지정하세요.
              </p>
            </div>
          </div>
          <button
            onClick={() => setIsRelinkModalOpen(false)}
            className="p-1 rounded text-[#888888] hover:text-white hover:bg-[#333333] transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 자동 일괄 감지 알림 배너 */}
        {autoBatchNotice && (
          <div className="px-5 py-2.5 bg-[#1b2838] border-b border-[#2d8ceb]/40 text-[#79b8ff] text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-[#3fb950] shrink-0" />
            <span>{autoBatchNotice}</span>
          </div>
        )}

        {/* 본문 안내문 */}
        <div className="px-5 py-3 bg-[#181818] border-b border-[#2a2a2a] text-xs text-[#999999] flex items-center justify-between">
          <span>
            💡 <strong>스마트 자동 재연결:</strong> 1개의 파일 위치를 찾아주면 같은 폴더 내에 있는 나머지 누락 파일도 자동으로 찾아 연결합니다.
          </span>
        </div>

        {/* 누락 파일 목록 */}
        <div className="max-h-[340px] overflow-y-auto divide-y divide-[#2a2a2a] p-2">
          {missingAssets.map((asset) => (
            <div
              key={asset.id}
              className="p-3 hover:bg-[#222222] rounded flex items-center justify-between gap-4 transition"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <FileQuestion className="w-4 h-4 text-[#ff7b72] shrink-0" />
                  <span className="text-xs font-semibold text-[#eeeeee] truncate">
                    {asset.name}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-[#ff7b72]/20 text-[#ff7b72] font-mono">
                    오프라인
                  </span>
                </div>
                <div
                  title={asset.path}
                  className="text-[11px] text-[#777777] font-mono truncate mt-1"
                >
                  이전 경로: {asset.path}
                </div>
              </div>

              <button
                onClick={() => handleLocateSingle(asset.id, asset.path, asset.name)}
                disabled={isLocating}
                className="px-3 py-1.5 rounded bg-[#2ea043] hover:bg-[#2c974b] text-white text-xs font-semibold flex items-center gap-1.5 shrink-0 transition shadow-sm disabled:opacity-50"
              >
                <FolderSearch className="w-3.5 h-3.5" />
                <span>찾아보기...</span>
              </button>
            </div>
          ))}
        </div>

        {/* 모달 하단 버튼 바 */}
        <div className="px-5 py-3 bg-[#202020] border-t border-[#333333] flex items-center justify-between">
          <span className="text-[11px] text-[#888888]">
            미디어를 나중에 연결하려면 오프라인으로 열고 작업을 계속할 수 있습니다.
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsRelinkModalOpen(false)}
              className="px-3.5 py-1.5 rounded bg-[#2e2e2e] hover:bg-[#383838] text-[#cccccc] hover:text-white text-xs font-medium transition"
            >
              오프라인으로 유지 (나중에 연결)
            </button>
            {missingAssets.length === 0 && (
              <button
                onClick={() => setIsRelinkModalOpen(false)}
                className="px-4 py-1.5 rounded bg-[#2d8ceb] hover:bg-[#1e78d6] text-white text-xs font-semibold transition"
              >
                완료
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
