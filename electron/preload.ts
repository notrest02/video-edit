import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  openMediaDialog: () => ipcRenderer.invoke('dialog:openMedia'),
  openScriptFileDialog: () => ipcRenderer.invoke('dialog:openScriptFile'),
  getSystemFonts: (forceRefresh?: boolean) => ipcRenderer.invoke('system:getFonts', forceRefresh),
  openFontFileDialog: () => ipcRenderer.invoke('dialog:openFontFile'),
  probeMedia: (filePath: string) => ipcRenderer.invoke('media:probe', filePath),
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
  extractKeyframesForAi: (params: {
    filePath: string;
    intervalSec?: number;
    maxFrames?: number;
  }) => ipcRenderer.invoke('ai:extractKeyframesForAi', params),
  testAiApiKey: (params: {
    engine: 'gemini' | 'openai' | 'claude';
    apiKey: string;
    model?: string;
  }) => ipcRenderer.invoke('ai:testApiKey', params),
});
