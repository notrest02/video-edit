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
  openAutoEditPlanDialog: () => ipcRenderer.invoke('dialog:openAutoEditPlan'),
  openMediaFolderDialog: () => ipcRenderer.invoke('dialog:openMediaFolder'),
  chooseFolderDialog: (title?: string) => ipcRenderer.invoke('dialog:chooseFolder', title),
  claudeKeyStatus: () => ipcRenderer.invoke('claude:keyStatus'),
  claudeSaveKey: (key: string) => ipcRenderer.invoke('claude:saveKey', key),
  claudeTestKey: () => ipcRenderer.invoke('claude:testKey'),
  claudeClearKey: () => ipcRenderer.invoke('claude:clearKey'),
  autoEditAnalyze: (params: unknown) => ipcRenderer.invoke('autoEdit:analyze', params),
  autoEditAssign: (params: unknown) => ipcRenderer.invoke('autoEdit:assign', params),
  scriptGenGenerate: (params: unknown) => ipcRenderer.invoke('scriptGen:generate', params),
  scriptGenParseOrder: (order: string) => ipcRenderer.invoke('scriptGen:parseOrder', order),
  scriptGenFromVideos: (params: unknown) => ipcRenderer.invoke('scriptGen:fromVideos', params),
  typecastKeyStatus: () => ipcRenderer.invoke('typecast:keyStatus'),
  typecastSaveKey: (key: string) => ipcRenderer.invoke('typecast:saveKey', key),
  typecastClearKey: () => ipcRenderer.invoke('typecast:clearKey'),
  typecastSubscription: () => ipcRenderer.invoke('typecast:subscription'),
  typecastVoices: (filter: unknown) => ipcRenderer.invoke('typecast:voices', filter),
  typecastPreview: (p: { url: string; tempo: number; pitch: number }) => ipcRenderer.invoke('typecast:preview', p),
  typecastSynthesize: (params: unknown) => ipcRenderer.invoke('typecast:synthesize', params),
  elevenKeyStatus: () => ipcRenderer.invoke('eleven:keyStatus'),
  elevenSaveKey: (key: string) => ipcRenderer.invoke('eleven:saveKey', key),
  elevenClearKey: () => ipcRenderer.invoke('eleven:clearKey'),
  elevenSubscription: () => ipcRenderer.invoke('eleven:subscription'),
  elevenVoices: (filter: unknown) => ipcRenderer.invoke('eleven:voices', filter),
  elevenSynthesize: (params: unknown) => ipcRenderer.invoke('eleven:synthesize', params),
  onTypecastProgress: (callback: (msg: string) => void) => {
    const handler = (_event: unknown, msg: string) => callback(msg);
    ipcRenderer.on('typecast:progress', handler);
    return () => ipcRenderer.removeListener('typecast:progress', handler);
  },
  fileExists: (p: string) => ipcRenderer.invoke('fs:exists', p),
  scriptGenPlan: (params: unknown) => ipcRenderer.invoke('scriptGen:plan', params),
  openOrderFileDialog: () => ipcRenderer.invoke('dialog:openOrderFile'),
  scriptGenSaveTxt: (params: { defaultName: string; content: string }) => ipcRenderer.invoke('scriptGen:saveTxt', params),
  openScriptExamplesDialog: () => ipcRenderer.invoke('dialog:openScriptExamples'),
  onScriptGenProgress: (callback: (msg: string) => void) => {
    const handler = (_event: unknown, msg: string) => callback(msg);
    ipcRenderer.on('scriptGen:progress', handler);
    return () => ipcRenderer.removeListener('scriptGen:progress', handler);
  },
  textMaskAnalyze: (params: unknown) => ipcRenderer.invoke('textMask:analyze', params),
  textMaskCancel: () => ipcRenderer.invoke('textMask:cancel'),
  onTextMaskProgress: (callback: (msg: string) => void) => {
    const handler = (_event: unknown, msg: string) => callback(msg);
    ipcRenderer.on('textMask:progress', handler);
    return () => ipcRenderer.removeListener('textMask:progress', handler);
  },
  onAutoEditProgress: (callback: (msg: string) => void) => {
    const handler = (_event: unknown, msg: string) => callback(msg);
    ipcRenderer.on('autoEdit:progress', handler);
    return () => ipcRenderer.removeListener('autoEdit:progress', handler);
  },
  getSystemFonts: (forceRefresh?: boolean) => ipcRenderer.invoke('system:getFonts', forceRefresh),
  openFontFileDialog: () => ipcRenderer.invoke('dialog:openFontFile'),
  gdiCheckFonts: (families: string[]) => ipcRenderer.invoke('font:gdiCheck', families),
  gdiGlyphs: (params: { family: string; style: number; chars: string }) =>
    ipcRenderer.invoke('font:gdiGlyphs', params),
  probeMedia: (filePath: string) => ipcRenderer.invoke('media:probe', filePath),
  modelGetStatus: () => ipcRenderer.invoke('model:getStatus'),
  modelEnsure: () => ipcRenderer.invoke('model:ensure'),
  modelImportDialog: () => ipcRenderer.invoke('model:importDialog'),
  onModelStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: unknown, status: unknown) => callback(status);
    ipcRenderer.on('model:status', handler);
    return () => ipcRenderer.removeListener('model:status', handler);
  },
  alignWordSpans: (params: {
    key: string;
    pcm: Float32Array;
    ranges: Array<{ start: number; end: number; words: string[] }>;
  }) => ipcRenderer.invoke('align:wordSpans', params),
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
