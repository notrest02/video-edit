import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Electron 32+ 에서는 드롭된 File 객체에 .path 가 없으므로 webUtils 로 실제 경로를 얻는다
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  // 창 닫기 전 저장 확인용: 저장 안 된 변경 여부를 메인 프로세스에 알림
  setDirtyState: (dirty: boolean) => ipcRenderer.send('app:setDirty', dirty),
  onRequestSaveBeforeClose: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('app:requestSaveBeforeClose', handler);
    return () => ipcRenderer.removeListener('app:requestSaveBeforeClose', handler);
  },
  reportSaveBeforeClose: (saved: boolean) => ipcRenderer.send('app:saveBeforeCloseResult', saved),
  openMediaDialog: () => ipcRenderer.invoke('dialog:openMedia'),
  openScriptFileDialog: () => ipcRenderer.invoke('dialog:openScriptFile'),
  getSystemFonts: (forceRefresh?: boolean) => ipcRenderer.invoke('system:getFonts', forceRefresh),
  openFontFileDialog: () => ipcRenderer.invoke('dialog:openFontFile'),
  gdiCheckFonts: (families: string[]) => ipcRenderer.invoke('font:gdiCheck', families),
  gdiGlyphs: (params: { family: string; style: number; chars: string }) =>
    ipcRenderer.invoke('font:gdiGlyphs', params),
  probeMedia: (filePath: string) => ipcRenderer.invoke('media:probe', filePath),
  mmsWordStarts: (segments: Array<{ pcm: Float32Array; words: string[] }>) =>
    ipcRenderer.invoke('align:mmsWordStarts', segments),
  ensurePreviewProxy: (filePath: string) => ipcRenderer.invoke('media:ensurePreviewProxy', filePath),
  detectSilence: (params: {
    filePath: string;
    sourceStart: number;
    duration: number;
    noiseDb: number;
    minSilenceDuration: number;
    paddingMs: number;
  }) => ipcRenderer.invoke('ai:detectSilence', params),
  extractAudioFloat32: (params: {
    filePath: string;
    sourceStart: number;
    duration: number;
  }) => ipcRenderer.invoke('ai:extractAudioFloat32', params),
  getWaveformPeaks: (params: {
    filePath: string;
    samplesPerSec?: number;
  }) => ipcRenderer.invoke('media:getWaveformPeaks', params),
  transcribeOpenAI: (params: {
    filePath: string;
    sourceStart: number;
    duration: number;
    apiKey: string;
    language?: string;
    scriptHint?: string;
  }) => ipcRenderer.invoke('ai:transcribeOpenAI', params),
  analyzeWithGemini: (params: {
    filePath: string;
    sourceStart: number;
    duration: number;
    apiKey: string;
    model?: string;
    scriptText?: string;
    captionMaxChars?: number;
  }) => ipcRenderer.invoke('ai:analyzeWithGemini', params),
  createSampleVideo: () => ipcRenderer.invoke('demo:createSampleVideo'),
  exportVideo: (payload: unknown) => ipcRenderer.invoke('editor:exportVideo', payload),
  onExportProgress: (callback: (progress: number) => void) => {
    const handler = (_event: unknown, progress: number) => callback(progress);
    ipcRenderer.on('editor:exportProgress', handler);
    return () => ipcRenderer.removeListener('editor:exportProgress', handler);
  },
  saveProjectDialog: (defaultFileName?: string) =>
    ipcRenderer.invoke('project:saveDialog', defaultFileName),
  writeProjectFile: (filePath: string, content: string) =>
    ipcRenderer.invoke('project:write', filePath, content),
  openProjectDialog: () => ipcRenderer.invoke('project:openDialog'),
  checkProjectAssets: (filePaths: string[]) =>
    ipcRenderer.invoke('project:checkAssets', filePaths),
  locateMediaDialog: (targetFileName?: string) =>
    ipcRenderer.invoke('dialog:locateMedia', targetFileName),
  scanFolderForMatches: (folderPath: string, fileNames: string[]) =>
    ipcRenderer.invoke('media:scanFolderForMatches', folderPath, fileNames),
});
