/**
 * 탐색기에서 끌어다 놓은 파일 → 프로젝트 미디어로 가져오기
 * Electron 32+ 는 File.path 를 제공하지 않으므로 preload 의 webUtils.getPathForFile 을 사용한다.
 */
import { useEditorStore } from '../store/useEditorStore';
import type { MediaAsset } from '../types/editor';

const MEDIA_EXT = /\.(mp4|mov|mkv|webm|avi|m4v|mp3|wav|m4a|aac|ogg|flac)$/i;

export function getDroppedFilePath(file: File): string {
  const viaApi = window.electronAPI?.getPathForFile?.(file);
  if (viaApi) return viaApi;
  return ((file as any).path as string | undefined) || '';
}

/** 드롭한 파일 중 미디어만 분석해서 보관함에 추가하고, 추가된 자산 목록을 돌려준다 */
export async function importDroppedFiles(files: File[]): Promise<MediaAsset[]> {
  const api = window.electronAPI;
  const store = useEditorStore.getState();
  if (!api) return [];

  const paths = files.map(getDroppedFilePath).filter(Boolean);
  const mediaPaths = paths.filter((p) => MEDIA_EXT.test(p));
  const skipped = paths.length - mediaPaths.length;

  if (mediaPaths.length === 0) {
    store.setStatusMessage(
      paths.length === 0
        ? '끌어다 놓은 파일의 경로를 읽지 못했습니다.'
        : '가져올 수 있는 미디어 파일(mp4, mov, mp3, wav 등)이 없습니다.'
    );
    return [];
  }

  store.setStatusMessage(`미디어 ${mediaPaths.length}개 분석 중...`);
  const probed: Array<Omit<MediaAsset, 'id'>> = [];
  for (const p of mediaPaths) {
    try {
      probed.push(await api.probeMedia(p));
    } catch (err) {
      console.error('Probe failed:', p, err);
    }
  }
  if (probed.length === 0) {
    store.setStatusMessage('미디어 파일을 분석하지 못했습니다.');
    return [];
  }
  const created = useEditorStore.getState().addAssets(probed);
  useEditorStore
    .getState()
    .setStatusMessage(
      `${created.length}개의 미디어를 프로젝트에 추가했습니다.` +
        (skipped > 0 ? ` (미디어가 아닌 파일 ${skipped}개 제외)` : '')
    );
  return created;
}
