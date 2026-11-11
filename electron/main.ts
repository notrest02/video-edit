import { app, BrowserWindow, ipcMain, dialog, protocol, session, net } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { pathToFileURL } from 'url';
import { Readable } from 'stream';
import { spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { GdiGlyphService } from './gdiGlyphHelper';
import { clearClaudeKey, hasClaudeKey, saveClaudeKey, testClaudeKey } from './claudeService';
import { analyzeMedia, sceneCuts } from './sceneAnalyzer';
import { assignShots } from './autoEditAssign';
import { factsFromVideos, generateScripts, parseOrder, planVersions, type ScriptGenParams } from './scriptGenerator';
import { docxToText } from './docxText';
import {
  adjustedPreview,
  clearTypecastKey,
  getSubscription,
  hasTypecastKey,
  listVoices,
  synthesize,
  testAndSaveKey,
} from './typecastService';
import {
  clearElevenKey,
  getElevenSubscription,
  hasElevenKey,
  listElevenVoices,
  synthesizeEleven,
  testAndSaveElevenKey,
} from './elevenlabsService';
import { analyzeText, cancelTextAnalyze } from './textDetector';
import { checkExportedVideo, type CheckResult } from './exportChecker';
import { ffExpr, type KeyframeMap } from '../src/utils/keyframes';
import { ModelDownloader, type ModelFileSpec, type ModelStatus } from './modelDownloader';
import {
  computeEmission,
  createSyllableTokenizer,
  wordSpansInRange,
  type AlignTokenizer,
  type Emission,
} from '../src/utils/forcedAligner';

// 이름을 바꿔도 예전 저장 폴더(API 키·모델·분석 캐시)를 계속 쓴다
app.setPath('userData', path.join(app.getPath('appData'), 'antigravity-video-editor'));

const resolvedFfmpegPath = ffmpegStatic ? ffmpegStatic.replace('app.asar', 'app.asar.unpacked') : '';
const resolvedFfprobePath = ffprobeStatic?.path ? ffprobeStatic.path.replace('app.asar', 'app.asar.unpacked') : '';

if (resolvedFfmpegPath) {
  ffmpeg.setFfmpegPath(resolvedFfmpegPath);
}
if (resolvedFfprobePath) {
  ffmpeg.setFfprobePath(resolvedFfprobePath);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;
let rendererIsDirty = false;
let allowWindowClose = false;

ipcMain.on('app:setDirty', (_event, dirty: boolean) => {
  rendererIsDirty = Boolean(dirty);
});

// 렌더러에서 '저장' 처리 결과: 저장 성공 시에만 창을 닫는다 (저장 대화상자에서 취소하면 그대로 유지)
ipcMain.on('app:saveBeforeCloseResult', (_event, saved: boolean) => {
  if (saved && mainWindow) {
    allowWindowClose = true;
    mainWindow.close();
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 1180,
    minHeight: 740,
    backgroundColor: '#0f1117',
    title: 'ShortCut - 숏폼 광고 편집기 (by syeong)',
    // 창·작업표시줄 아이콘 (서명 안 한 배포본은 실행 파일 아이콘이 기본값이라 여기서 직접 지정)
    icon: [path.join(__dirname, '..', 'dist', 'icon.png'), path.join(__dirname, '..', 'build', 'icon.png')].find((p) => fs.existsSync(p)),
    // autoHideMenuBar 를 쓰면 Alt 키(Alt+휠 줌 등)를 뗄 때마다 메뉴바가 튀어나오므로 끄고 숨김 처리만 한다
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  // 창 닫기 전 저장 확인 (저장 안 된 변경이 있을 때만)
  allowWindowClose = false;
  mainWindow.on('close', (e) => {
    if (allowWindowClose || !rendererIsDirty || !mainWindow) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['저장', '저장 안 함', '취소'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: '저장 확인',
      message: '저장되지 않은 변경 사항이 있습니다.',
      detail: '창을 닫기 전에 프로젝트를 저장할까요?',
    });
    if (choice === 1) {
      allowWindowClose = true;
      mainWindow.close();
    } else if (choice === 0) {
      mainWindow.webContents.send('app:requestSaveBeforeClose');
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const distIndex = path.join(__dirname, '../dist/index.html');

  if (devUrl) {
    mainWindow.loadURL(devUrl).catch((err) => {
      console.warn('[Electron] Dev server load failed, falling back to dist/index.html:', err);
      if (mainWindow && fs.existsSync(distIndex)) {
        mainWindow.loadFile(distIndex);
      }
    });
  } else {
    mainWindow.loadFile(distIndex);
  }
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mov': return 'video/quicktime';
    case '.mkv': return 'video/x-matroska';
    case '.avi': return 'video/x-msvideo';
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.ogg': return 'audio/ogg';
    case '.m4a': return 'audio/mp4';
    case '.aac': return 'audio/aac';
    case '.png': return 'image/png';
    case '.jpg': return 'image/jpeg';
    default: return 'application/octet-stream';
  }
}

function probeMediaFile(filePath: string): Promise<{
  path: string;
  name: string;
  type: 'video' | 'audio';
  hasAudio: boolean;
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
}> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        return reject(err);
      }
      const videoStream = metadata.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
      const audioStream = metadata.streams.find((s) => s.codec_type === 'audio');
      const duration = Number(metadata.format.duration || videoStream?.duration || audioStream?.duration || 5);
      let fps = 30;
      if (videoStream?.r_frame_rate) {
        const parts = videoStream.r_frame_rate.split('/');
        if (parts.length === 2 && Number(parts[1]) > 0) {
          fps = Math.round((Number(parts[0]) / Number(parts[1])) * 100) / 100;
        }
      }
      resolve({
        path: filePath,
        name: path.basename(filePath),
        type: videoStream ? 'video' : 'audio',
        hasAudio: Boolean(audioStream),
        duration: Math.max(0.1, duration),
        width: videoStream?.width,
        height: videoStream?.height,
        fps: fps || 30,
      });
    });
  });
}

app.whenReady().then(() => {
  // 내 PC 로컬 글꼴(queryLocalFonts) 접근 권한 항상 허용
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(true);
  });

  // Handle media://local?path=<encodedPath> with Range support for instant video scrubbing
  protocol.handle('media', async (request) => {
    try {
      const url = new URL(request.url);
      let filePath = url.searchParams.get('path') || '';
      if (!filePath) {
        filePath = decodeURIComponent(url.pathname.replace(/^\//, ''));
      }
      if (!fs.existsSync(filePath)) {
        return new Response('File not found', { status: 404 });
      }

      const stat = await fs.promises.stat(filePath);
      const fileSize = stat.size;
      const mimeType = getMimeType(filePath);
      const rangeHeader = request.headers.get('range');

      if (rangeHeader) {
        const parts = rangeHeader.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (start >= fileSize) {
          return new Response(null, {
            status: 416,
            headers: {
              'Content-Range': `bytes */${fileSize}`,
            },
          });
        }

        const safeEnd = Math.min(end, fileSize - 1);
        const chunkSize = safeEnd - start + 1;
        const fileStream = fs.createReadStream(filePath, { start, end: safeEnd });

        return new Response(Readable.toWeb(fileStream) as unknown as ReadableStream, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${safeEnd}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(chunkSize),
            'Content-Type': mimeType,
          },
        });
      }

      const fileStream = fs.createReadStream(filePath);
      return new Response(Readable.toWeb(fileStream) as unknown as ReadableStream, {
        status: 200,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Length': String(fileSize),
          'Content-Type': mimeType,
        },
      });
    } catch (error) {
      console.error('[media:// protocol error]', error);
      return new Response('File not found', { status: 404 });
    }
  });

  createWindow();
  // 정렬 모델이 없으면 앱을 켜자마자 백그라운드로 받기 시작
  mainWindow?.webContents.once('did-finish-load', () => {
    const dl = getModelDownloader();
    mainWindow?.webContents.send('model:status', dl.getStatus());
    if (!dl.isInstalled()) dl.ensure();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 1. Open Media Files Dialog
ipcMain.handle('dialog:openMedia', async () => {
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '비디오 또는 오디오 파일 가져오기',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '미디어 파일', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'mp3', 'wav', 'm4a', 'aac', 'ogg'] },
      { name: '비디오', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'] },
      { name: '오디오', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) return [];

  const assets = [];
  for (const filePath of result.filePaths) {
    try {
      const info = await probeMediaFile(filePath);
      assets.push(info);
    } catch (err) {
      console.error('Failed to probe file:', filePath, err);
    }
  }
  return assets;
});

// 2. Open Script Text File Dialog
ipcMain.handle('dialog:openScriptFile', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '대본 텍스트 파일(.txt, .srt) 불러오기',
    properties: ['openFile'],
    filters: [{ name: '대본/자막 파일', extensions: ['txt', 'srt', 'md'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const content = await fs.promises.readFile(result.filePaths[0], 'utf-8');
  return {
    name: path.basename(result.filePaths[0]),
    content,
  };
});

// ---------- Claude API 키 (암호화 저장, 화면 쪽으로는 키를 보내지 않음) ----------
ipcMain.handle('claude:keyStatus', () => ({ hasKey: hasClaudeKey() }));
ipcMain.handle('claude:saveKey', async (_e, key: string) => {
  const t = await testClaudeKey(key);
  if (t.ok) saveClaudeKey(key);
  return t;
});
ipcMain.handle('claude:testKey', () => testClaudeKey());
ipcMain.handle('claude:clearKey', () => {
  clearClaudeKey();
  return { hasKey: false };
});

// ---------- AI 자동 배치 ----------
ipcMain.handle(
  'autoEdit:analyze',
  async (e, params: { media: Array<{ path: string; duration: number }>; product: string }) =>
    analyzeMedia(resolvedFfmpegPath, params.media, params.product, (msg) => e.sender.send('autoEdit:progress', msg))
);
// 손으로 편집할 때 쓰는 원본 장면 구간 (비용 없음) — R36
ipcMain.handle('scene:cuts', async (_e, p: { path: string; duration: number }) => sceneCuts(resolvedFfmpegPath, p.path, p.duration));
ipcMain.handle('autoEdit:assign', async (_e, params: Parameters<typeof assignShots>[0]) => assignShots(params));

// ---------- STEP 0 대본 만들기 (Claude) ----------
ipcMain.handle('scriptGen:generate', async (e, params: ScriptGenParams) =>
  generateScripts(resolvedFfmpegPath, params, (msg) => e.sender.send('scriptGen:progress', msg))
);
ipcMain.handle('scriptGen:parseOrder', async (_e, order: string) => parseOrder(order));
ipcMain.handle('scriptGen:fromVideos', async (e, params: Parameters<typeof factsFromVideos>[1]) =>
  factsFromVideos(resolvedFfmpegPath, params, (msg) => e.sender.send('scriptGen:progress', msg))
);
ipcMain.handle('scriptGen:plan', async (_e, params: Parameters<typeof planVersions>[0]) => planVersions(params));

// ---------- Typecast 음성 만들기 (키는 메인 프로세스에만) ----------
ipcMain.handle('typecast:keyStatus', () => ({ hasKey: hasTypecastKey() }));
ipcMain.handle('typecast:saveKey', async (_e, key: string) => testAndSaveKey(key));
ipcMain.handle('typecast:clearKey', () => {
  clearTypecastKey();
  return { hasKey: false };
});
ipcMain.handle('typecast:subscription', () => getSubscription());
ipcMain.handle('typecast:voices', async (_e, filter: { gender?: string; age?: string }) => listVoices(filter));
ipcMain.handle('typecast:preview', async (_e, p: { url: string; tempo: number; pitch: number }) => adjustedPreview(resolvedFfmpegPath, p));
function readVoiceTimestampsHelper(audioOrJsonPath?: string): {
  found: boolean;
  text: string;
  duration: number;
  words: Array<{ text: string; start: number; end: number }>;
} {
  if (!audioOrJsonPath) return { found: false, text: '', duration: 0, words: [] };
  const candidates = audioOrJsonPath.endsWith('.timestamps.json')
    ? [audioOrJsonPath]
    : [audioOrJsonPath.replace(/\.[^.\\/]+$/, '.timestamps.json'), `${audioOrJsonPath}.timestamps.json`];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (Array.isArray(d.words) && d.words.length > 0) {
          return {
            found: true,
            text: typeof d.text === 'string' ? d.text : '',
            duration: typeof d.duration === 'number' ? d.duration : 0,
            words: d.words,
          };
        }
      }
    } catch {
      // ignore parse errors
    }
  }
  return { found: false, text: '', duration: 0, words: [] };
}

ipcMain.handle('ai:readVoiceTimestamps', async (_e, audioPath: string) => readVoiceTimestampsHelper(audioPath));

ipcMain.handle('typecast:synthesize', async (e, params: Parameters<typeof synthesize>[0]) => {
  const results = await synthesize(params, (msg) => e.sender.send('typecast:progress', msg));
  // 만든 파일을 바로 미디어로 쓸 수 있게 길이와 단어 시간표(.timestamps.json)를 읽어 같이 돌려준다
  const withAssets = [];
  for (const r of results) {
    let asset = null;
    let words: Array<{ text: string; start: number; end: number }> = [];
    if (r.ok && r.audioPath) {
      try {
        asset = await probeMediaFile(r.audioPath);
      } catch {
        asset = null;
      }
      words = readVoiceTimestampsHelper(r.timestampsPath || r.audioPath).words;
    }
    withAssets.push({ ...r, asset, words });
  }
  return withAssets;
});

// ---------- ElevenLabs 음성 만들기 (키는 메인 프로세스에만) ----------
ipcMain.handle('eleven:keyStatus', () => ({ hasKey: hasElevenKey() }));
ipcMain.handle('eleven:saveKey', async (_e, key: string) => testAndSaveElevenKey(key));
ipcMain.handle('eleven:clearKey', () => {
  clearElevenKey();
  return { hasKey: false };
});
ipcMain.handle('eleven:subscription', () => getElevenSubscription());
ipcMain.handle('eleven:voices', async (_e, filter: { gender?: string; age?: string }) => listElevenVoices(filter));
ipcMain.handle('eleven:synthesize', async (e, params: Parameters<typeof synthesizeEleven>[1]) => {
  const results = await synthesizeEleven(resolvedFfmpegPath, params, (msg) => e.sender.send('typecast:progress', msg));
  const withAssets = [];
  for (const r of results) {
    let asset = null;
    let words: Array<{ text: string; start: number; end: number }> = [];
    if (r.ok && r.audioPath) {
      try {
        asset = await probeMediaFile(r.audioPath);
      } catch {
        asset = null;
      }
      words = readVoiceTimestampsHelper(r.timestampsPath || r.audioPath).words;
    }
    withAssets.push({ ...r, asset, words });
  }
  return withAssets;
});
// 음성 저장 폴더 기본값용: 폴더가 있는지
ipcMain.handle('fs:exists', (_e, p: string) => fs.existsSync(p));
// 클라이언트 오더 파일(.txt/.docx) 열어서 글자만
ipcMain.handle('dialog:openOrderFile', async () => {
  if (!mainWindow) return null;
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '클라이언트 오더 파일 열기',
    properties: ['openFile'],
    filters: [{ name: '오더 (txt, docx)', extensions: ['txt', 'docx', 'md'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const f = r.filePaths[0];
  const text = /\.docx$/i.test(f) ? docxToText(f) : (await fs.promises.readFile(f, 'utf-8')).replace(/^﻿/, '');
  return { name: path.basename(f), text };
});
// 말투 예시로 쓸 고객 대본 txt 고르기 (여러 개)
ipcMain.handle('dialog:openScriptExamples', async () => {
  if (!mainWindow) return [];
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '말투 예시로 쓸 대본 파일(.txt) 고르기 — 여러 개 선택 가능',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '대본 텍스트', extensions: ['txt'] }],
  });
  return r.canceled ? [] : r.filePaths;
});
// 만든 대본을 txt 로 저장
ipcMain.handle('scriptGen:saveTxt', async (_e, p: { defaultName: string; content: string }) => {
  if (!mainWindow) return null;
  const r = await dialog.showSaveDialog(mainWindow, {
    title: '대본 저장',
    defaultPath: p.defaultName,
    filters: [{ name: '대본 텍스트', extensions: ['txt'] }],
  });
  if (r.canceled || !r.filePath) return null;
  await fs.promises.writeFile(r.filePath, p.content, 'utf-8');
  return r.filePath;
});

// 자동 마스크: 원본에 박힌 글자 찾기 (로컬 모델, 원본별 저장)
ipcMain.handle('textMask:cancel', () => cancelTextAnalyze());
ipcMain.handle('textMask:analyze', async (e, p: { path: string; width: number; height: number }) =>
  analyzeText(resolvedFfmpegPath, p.path, p.width, p.height, (msg) => e.sender.send('textMask:progress', msg))
);

// 폴더 고르기 (광고 구간별 내보내기 저장 위치 등)
ipcMain.handle('dialog:chooseFolder', async (_e, title?: string) => {
  if (!mainWindow) return null;
  const r = await dialog.showOpenDialog(mainWindow, { title: title || '폴더 선택', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

// 폴더에서 영상 가져오기: 폴더를 고르면 영상 파일 경로 목록
ipcMain.handle('dialog:openMediaFolder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, { title: '원본 영상 폴더 선택', properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  const dir = result.filePaths[0];
  const files = (await fs.promises.readdir(dir))
    .filter((f) => /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(f))
    .map((f) => path.join(dir, f));
  return { dir, folderName: path.basename(dir), files };
});

// 자동 편집 계획 파일(.json) 열기 — tools/premiere/slot_plan.py 가 만든 <시퀀스>_app.json
ipcMain.handle('dialog:openAutoEditPlan', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '자동 편집 계획 파일 불러오기',
    properties: ['openFile'],
    filters: [{ name: '자동 편집 계획', extensions: ['json'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const content = await fs.promises.readFile(result.filePaths[0], 'utf-8');
  return { name: path.basename(result.filePaths[0]), content };
});

// 2-1. Get Installed PC Fonts (Windows System.Drawing.Text.InstalledFontCollection)
let cachedSystemFonts: Array<{ label: string; value: string; familyKo: string; familyEn: string }> | null = null;

ipcMain.handle('system:getFonts', async (_event, forceRefresh?: boolean) => {
  if (cachedSystemFonts && !forceRefresh) {
    return cachedSystemFonts;
  }

  return new Promise((resolve) => {
    const psScript = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '[System.Reflection.Assembly]::LoadWithPartialName("System.Drawing") | Out-Null',
      '$col = New-Object System.Drawing.Text.InstalledFontCollection',
      'foreach ($f in $col.Families) {',
      '  $ko = $f.Name',
      '  $en = $f.GetName(1033)',
      '  Write-Output ($ko + "|||" + $en)',
      '}',
    ].join('; ');

    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
    const chunks: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.on('close', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const lines = text.split(/\r?\n/);
        const seen = new Set<string>();
        const fonts: Array<{ label: string; value: string; familyKo: string; familyEn: string }> = [];

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || !line.includes('|||')) continue;
          const [koRaw, enRaw] = line.split('|||');
          const familyKo = (koRaw || '').trim();
          const familyEn = (enRaw || familyKo).trim();
          if (!familyKo || familyKo.startsWith('?')) continue;

          const key = `${familyKo.toLowerCase()}__${familyEn.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const cssValue =
            familyKo !== familyEn
              ? `"${familyKo}", "${familyEn}", sans-serif`
              : `"${familyKo}", sans-serif`;
          const label =
            familyKo !== familyEn ? `${familyKo} (${familyEn})` : familyKo;

          fonts.push({
            label,
            value: cssValue,
            familyKo,
            familyEn,
          });
        }

        // 한글 이름 글꼴이 먼저 오도록 정렬 (가독성 및 편의성)
        fonts.sort((a, b) => {
          const aHasKo = /[가-힣]/.test(a.familyKo);
          const bHasKo = /[가-힣]/.test(b.familyKo);
          if (aHasKo !== bHasKo) return aHasKo ? -1 : 1;
          return a.familyKo.localeCompare(b.familyKo, 'ko');
        });

        if (fonts.length > 0) {
          cachedSystemFonts = fonts;
        }
        resolve(fonts);
      } catch (err) {
        console.warn('[system:getFonts] Failed to parse PC fonts:', err);
        resolve([]);
      }
    });

    proc.on('error', () => resolve([]));
  });
});

// 2-1. Chromium 이 읽지 못하는 옛 글꼴용: Windows GDI+ 로 글자 윤곽선 추출
let gdiGlyphService: GdiGlyphService | null = null;
function getGdiGlyphService() {
  if (!gdiGlyphService) {
    gdiGlyphService = new GdiGlyphService(path.join(app.getPath('userData'), 'gdi-glyph-helper'));
  }
  return gdiGlyphService;
}
app.on('will-quit', () => gdiGlyphService?.dispose());

ipcMain.handle('font:gdiCheck', async (_event, families: string[]) => {
  const svc = getGdiGlyphService();
  const result: boolean[] = [];
  for (const f of families) result.push(await svc.check(f));
  return result;
});

ipcMain.handle(
  'font:gdiGlyphs',
  async (_event, params: { family: string; style: number; chars: string }) => {
    try {
      return await getGdiGlyphService().glyphs(params.family, params.style, params.chars);
    } catch (err) {
      console.warn('[font:gdiGlyphs] failed', err);
      return null;
    }
  }
);

// 2-2. Open Custom Font File (.ttf, .otf, .woff, .woff2) from PC
ipcMain.handle('dialog:openFontFile', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '내 PC 글꼴 파일(.ttf, .otf, .woff, .woff2) 불러오기',
    properties: ['openFile'],
    filters: [{ name: '글꼴 파일', extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const baseName = path.basename(filePath, path.extname(filePath));
  const buffer = await fs.promises.readFile(filePath);
  return {
    familyName: baseName,
    dataBase64: buffer.toString('base64'),
    ext,
  };
});

// 3. Probe Arbitrary File Path (e.g. Drag and Drop)
// 3-0. 강제 정렬: 자막 글자가 음성의 어디서 시작하는지 (자막 한 줄/두 줄 분할 시점 계산용)
// 모델: kresnik/wav2vec2-large-xlsr-korean (Apache-2.0, 한글 음절 CTC) → ONNX int8 (약 318MB)
//   userData/models/ko-wav2vec2/{model_int8.onnx, vocab.json}
// 모델이 없으면 available:false 를 돌려주고, 렌더러는 쉼·말 속도 기반 추정으로 대체한다.
const ALIGN_MODEL_DIR_NAME = path.join('models', 'ko-wav2vec2');
let alignModelPromise: Promise<{ session: any; tokenizer: AlignTokenizer } | null> | null = null;

// 첫 실행 다운로드 원본 (구글 드라이브 공유 폴더). 테스트용으로 VIDEO_EDIT_MODEL_BASE_URL 이 있으면 그 주소에서 받음
const MODEL_TEST_BASE = process.env.VIDEO_EDIT_MODEL_BASE_URL;
const ALIGN_MODEL_FILES: ModelFileSpec[] = [
  {
    name: 'vocab.json',
    size: 18163,
    sha256: '4db1411162e9603b3b555a7dbc08807256b885ea0beb60ab110b283c338cfc85',
    sources: MODEL_TEST_BASE ? [`${MODEL_TEST_BASE}/vocab.json`] : ['gdrive:1ZM_YU7bkkjvdKALSQ--BGiRTQtlSp7jG'],
  },
  {
    name: 'model_int8.onnx',
    size: 318483343,
    sha256: 'cca9fadaf78d582b60165b38074f7f8c6427c0d98893400f6252561bbb673fc9',
    sources: MODEL_TEST_BASE ? [`${MODEL_TEST_BASE}/model_int8.onnx`] : ['gdrive:1oHbcrtVLvj2ETFC4uS7UTMrZL6A6ARUl'],
  },
];
let modelDownloader: ModelDownloader | null = null;
function getModelDownloader(): ModelDownloader {
  if (!modelDownloader) {
    modelDownloader = new ModelDownloader(
      path.join(app.getPath('userData'), ALIGN_MODEL_DIR_NAME),
      ALIGN_MODEL_FILES,
      (st: ModelStatus) => {
        if (st.state === 'ready') alignModelPromise = null; // 새로 받은 모델을 다시 불러오도록
        mainWindow?.webContents.send('model:status', st);
      }
    );
  }
  return modelDownloader;
}

ipcMain.handle('model:getStatus', () => getModelDownloader().getStatus());
ipcMain.handle('model:ensure', () => getModelDownloader().ensure());
ipcMain.handle('model:importDialog', async () => {
  if (!mainWindow) return { ok: false, message: '창이 없습니다' };
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '정렬 모델 파일 선택 (model_int8.onnx, vocab.json)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '모델 파일', extensions: ['onnx', 'json'] }],
  });
  if (r.canceled || r.filePaths.length === 0) return { ok: false, message: '선택 취소' };
  const msgs: string[] = [];
  let ok = true;
  for (const f of r.filePaths) {
    const res = await getModelDownloader().importFile(f);
    ok = ok && res.ok;
    msgs.push(res.message);
  }
  return { ok, message: msgs.join(' / '), status: getModelDownloader().getStatus() };
});
function findAlignModelDir(): string | null {
  const candidates = [
    path.join(app.getPath('userData'), ALIGN_MODEL_DIR_NAME),
    path.join(app.getAppPath(), ALIGN_MODEL_DIR_NAME),
    path.join(process.resourcesPath || '', ALIGN_MODEL_DIR_NAME),
  ];
  return (
    candidates.find(
      (d) => d && fs.existsSync(path.join(d, 'model_int8.onnx')) && fs.existsSync(path.join(d, 'vocab.json'))
    ) || null
  );
}
function getAlignModel() {
  if (alignModelPromise) return alignModelPromise;
  if (!getModelDownloader().isInstalled()) return null;
  const dir = findAlignModelDir();
  if (!dir) return null;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ort = require('onnxruntime-node');
  alignModelPromise = (async () => {
    const vocab = JSON.parse(await fs.promises.readFile(path.join(dir, 'vocab.json'), 'utf8'));
    const session = await ort.InferenceSession.create(path.join(dir, 'model_int8.onnx'));
    return { session, tokenizer: createSyllableTokenizer(vocab, { useWordDelimiter: true }) };
  })().catch((err: unknown) => {
    console.warn('[align] model load failed', err);
    alignModelPromise = null;
    return null;
  });
  return alignModelPromise;
}

// 음성 클립별 emission 캐시: 같은 클립은 모델을 한 번만 돌리고, 자막 구간마다 필요한 프레임만 잘라 정렬
// (자막 만들기 → 바로 이어서 한 줄/두 줄 나누기를 하면 모델 계산 없이 끝남)
const emissionCache = new Map<string, Promise<Emission | null>>();
const EMISSION_CACHE_MAX = 4;

ipcMain.handle(
  'align:wordSpans',
  async (
    _event,
    params: { key: string; pcm: Float32Array; ranges: Array<{ start: number; end: number; words: string[] }> }
  ) => {
    // 모델이 없으면 먼저 받음 (진행 상황은 'model:status' 로 화면에 표시)
    await getModelDownloader().ensure();
    const modelPromise = getAlignModel();
    const model = modelPromise ? await modelPromise : null;
    if (!model) return { available: false, results: params.ranges.map(() => null) };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ort = require('onnxruntime-node');

    let emPromise = emissionCache.get(params.key);
    if (!emPromise) {
      const pcm =
        params.pcm instanceof Float32Array ? params.pcm : new Float32Array(params.pcm as ArrayLike<number>);
      emPromise = computeEmission(async (chunk) => {
        const out = await model.session.run({ audio: new ort.Tensor('float32', chunk, [1, chunk.length]) });
        const [, frames, labels] = out.emission.dims as number[];
        return { data: out.emission.data as Float32Array, frames, labels };
      }, pcm).catch((err) => {
        console.warn('[align] emission failed', err);
        return null;
      });
      emissionCache.set(params.key, emPromise);
      while (emissionCache.size > EMISSION_CACHE_MAX) {
        emissionCache.delete(emissionCache.keys().next().value as string);
      }
    }
    const em = await emPromise;
    if (!em) {
      emissionCache.delete(params.key);
      return { available: true, results: params.ranges.map(() => null) };
    }
    const results = params.ranges.map((r) => {
      try {
        return wordSpansInRange(em, Math.max(0, r.start), r.end, r.words, model.tokenizer);
      } catch (err) {
        console.warn('[align] range failed', err);
        return null;
      }
    });
    return { available: true, results };
  }
);

// 3-1. 미리보기 전용 프록시 생성
// 원본(긴 GOP H.264/HEVC)은 임의 위치 시크마다 디코딩 비용이 커서 인디케이터를 끌면 프레임이 몇 장만 보인다
// (측정: 1080x1920 원본 천천히 2초 끌기 → 5프레임 / 프록시 → 120프레임).
// 짧은 GOP(6) + B프레임 없음 + 긴 변 960px 로 다시 인코딩해 미리보기에만 사용한다. 렌더는 항상 원본 사용.
const proxyJobs = new Map<string, Promise<string | null>>();
let proxyQueue: Promise<unknown> = Promise.resolve();

function proxyPathFor(filePath: string, stat: fs.Stats): string {
  const key = `${filePath}|${stat.size}|${stat.mtimeMs}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  const base = path.basename(filePath, path.extname(filePath)).replace(/[^\w가-힣-]+/g, '_').slice(0, 40);
  return path.join(app.getPath('userData'), 'preview-proxies', `${base}_${(h >>> 0).toString(36)}.mp4`);
}

ipcMain.handle('media:ensurePreviewProxy', async (_event, filePath: string) => {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return null;
  }
  const out = proxyPathFor(filePath, stat);
  if (fs.existsSync(out)) return out;
  const existing = proxyJobs.get(out);
  if (existing) return existing;

  // 한 번에 하나씩 순서대로 생성 (편집 중 CPU 를 다 잡아먹지 않도록)
  const job = proxyQueue.then(
    () =>
      new Promise<string | null>((resolve) => {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const tmp = out.replace(/\.mp4$/, '.part.mp4');
        const args = [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', filePath,
          '-map', '0:v:0', '-map', '0:a:0?',
          '-vf', "scale='if(gt(iw,ih),min(960,iw),-2)':'if(gt(iw,ih),-2,min(960,ih))'",
          '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'fastdecode',
          '-g', '6', '-bf', '0', '-crf', '24', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '96k',
          '-movflags', '+faststart',
          tmp,
        ];
        const proc = spawn(resolvedFfmpegPath, args, { windowsHide: true });
        let errLog = '';
        proc.stderr.on('data', (d) => (errLog += d.toString()));
        proc.on('close', (code) => {
          if (code === 0 && fs.existsSync(tmp)) {
            try {
              fs.renameSync(tmp, out);
              resolve(out);
              return;
            } catch (err) {
              console.warn('[proxy] rename failed', err);
            }
          } else {
            console.warn('[proxy] ffmpeg failed', code, errLog.slice(0, 500));
          }
          try { fs.unlinkSync(tmp); } catch { /* ignore */ }
          resolve(null);
        });
        proc.on('error', () => resolve(null));
      })
  );
  proxyQueue = job.catch(() => null);
  proxyJobs.set(out, job);
  const result = await job;
  proxyJobs.delete(out);
  return result;
});

ipcMain.handle('media:probe', async (_event, filePath: string) => {
  return await probeMediaFile(filePath);
});

// 4. AI Silence Detection (타임라인 파형과 동일한 20ms 정규화 엔벨로프 + 미세 숨소리 브릿징 기반)
ipcMain.handle(
  'ai:detectSilence',
  async (
    _event,
    params: {
      filePath: string;
      sourceStart: number;
      duration: number;
      noiseDb: number;
      minSilenceDuration: number;
      paddingMs: number;
    }
  ) => {
    const { filePath, sourceStart, duration, noiseDb, minSilenceDuration, paddingMs } = params;

    return new Promise((resolve, reject) => {
      const samplesPerSec = 50; // 20ms per bucket (타임라인 파형 렌더러와 동일)
      const sampleRate = 8000;
      const samplesPerBucket = Math.floor(sampleRate / samplesPerSec); // 160 samples

      const args = [
        '-ss', String(Math.max(0, sourceStart || 0)),
        '-t', String(Math.max(0.05, duration)),
        '-i', filePath,
        '-vn',
        '-ac', '1',
        '-ar', String(sampleRate),
        '-f', 's16le',
        'pipe:1',
      ];

      const proc = spawn(resolvedFfmpegPath, args);
      const chunks: Buffer[] = [];

      proc.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      proc.on('close', () => {
        const buffer = Buffer.concat(chunks);
        const totalSamples = Math.floor(buffer.byteLength / 2);
        if (totalSamples === 0) {
          resolve({ silences: [], speechSegments: [{ start: 0, end: duration }] });
          return;
        }

        const bucketCount = Math.ceil(totalSamples / samplesPerBucket);
        const rawPeaks = new Float32Array(bucketCount);
        const rawRms = new Float32Array(bucketCount);

        for (let b = 0; b < bucketCount; b++) {
          const startSample = b * samplesPerBucket;
          const endSample = Math.min(totalSamples, startSample + samplesPerBucket);
          let maxAbs = 0;
          let sumSq = 0;
          const count = endSample - startSample;

          for (let s = startSample; s < endSample; s++) {
            const val = Math.abs(buffer.readInt16LE(s * 2)) / 32768;
            if (val > maxAbs) maxAbs = val;
            sumSq += val * val;
          }

          rawPeaks[b] = maxAbs;
          rawRms[b] = count > 0 ? Math.sqrt(sumSq / count) : 0;
        }

        // 타임라인 초록 파형(media:getAudioWaveform)과 동일한 98 퍼센타일 정규화 스케일
        const sortedPeaks = Float32Array.from(rawPeaks).sort();
        const p98 = sortedPeaks[Math.floor(sortedPeaks.length * 0.98)] || 0.5;
        const normScale = Math.max(0.04, Math.min(1, p98));

        // 기본값 -32dB 일 때 타임라인 파형상 바닥(0 근처)으로 보이는 구간과 일치하도록 게이트 설정
        const gate = 0.048 * Math.pow(10, (noiseDb + 32) / 20);
        const absThresh = Math.pow(10, noiseDb / 20);

        const isSilent = new Uint8Array(bucketCount);
        for (let b = 0; b < bucketCount; b++) {
          const normPeak = rawPeaks[b] / normScale;
          const normRms = (rawRms[b] / normScale) * 1.45;
          if (Math.min(normPeak, normRms) <= gate || rawRms[b] <= absThresh) {
            isSilent[b] = 1;
          }
        }

        // 무음 골짜기 한가운데 낀 짧은 AI 숨소리/입소리(<= 4버킷 = 80ms)는 발화가 아닌 무음으로 이어줌
        for (let b = 1; b < bucketCount - 1; b++) {
          if (!isSilent[b] && isSilent[b - 1]) {
            let endB = b;
            while (
              endB < bucketCount &&
              !isSilent[endB] &&
              endB - b <= 4 &&
              rawRms[endB] / normScale <= gate * 1.6 &&
              rawPeaks[endB] / normScale < 0.22
            ) {
              endB++;
            }
            if (endB < bucketCount && isSilent[endB]) {
              for (let k = b; k < endB; k++) isSilent[k] = 1;
            }
          }
        }

        const silences: Array<{ start: number; end: number }> = [];
        let sStart = -1;
        for (let b = 0; b <= bucketCount; b++) {
          if (b < bucketCount && isSilent[b]) {
            if (sStart < 0) sStart = b;
          } else if (sStart >= 0) {
            const s = sStart / samplesPerSec;
            const e = Math.min(duration, b / samplesPerSec);
            if (e - s >= minSilenceDuration - 1e-4) {
              silences.push({ start: Number(s.toFixed(4)), end: Number(e.toFixed(4)) });
            }
            sStart = -1;
          }
        }

        // 무음 구간을 유음(발화) 구간으로 변환 (짧은 무음이 패딩 때문에 다시 합쳐지지 않도록 상한 제한)
        const rawPadSec = (paddingMs ?? 70) / 1000;
        const speechSegments: Array<{ start: number; end: number }> = [];
        let cursor = 0;

        for (const sil of silences) {
          const silDur = sil.end - sil.start;
          const padSec = Math.min(rawPadSec, Math.max(0.015, silDur * 0.22));
          const segStart = Math.max(0, cursor);
          const segEnd = Math.min(duration, sil.start + padSec);
          if (segEnd - segStart >= 0.08) {
            speechSegments.push({ start: Number(segStart.toFixed(4)), end: Number(segEnd.toFixed(4)) });
          }
          cursor = Math.max(cursor, sil.end - padSec);
        }

        if (duration - cursor >= 0.08) {
          speechSegments.push({ start: Number(cursor.toFixed(4)), end: Number(duration.toFixed(4)) });
        }

        // 패딩으로 겹친 경우만 병합 (감지된 무음 구간이 도로 합쳐지지 않도록 15ms 이하만 병합)
        const merged: Array<{ start: number; end: number }> = [];
        for (const seg of speechSegments) {
          if (merged.length === 0) {
            merged.push({ ...seg });
          } else {
            const prev = merged[merged.length - 1];
            if (seg.start <= prev.end + 0.015) {
              prev.end = Math.max(prev.end, seg.end);
            } else {
              merged.push({ ...seg });
            }
          }
        }

        resolve({
          silences,
          speechSegments: merged.length > 0 ? merged : [{ start: 0, end: duration }],
        });
      });

      proc.on('error', (err) => reject(err));
    });
  }
);

// 5. Extract 16kHz Mono Float32 PCM Audio for Local Whisper STT
ipcMain.handle(
  'ai:extractAudioFloat32',
  async (_event, params: { filePath: string; sourceStart: number; duration: number }) => {
    const { filePath, sourceStart, duration } = params;
    return new Promise<Float32Array>((resolve, reject) => {
      const args = [
        '-ss', String(sourceStart),
        '-t', String(duration),
        '-i', filePath,
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-f', 'f32le',
        'pipe:1',
      ];

      const proc = spawn(resolvedFfmpegPath, args);
      const chunks: Buffer[] = [];

      proc.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      proc.on('close', (code) => {
        if (code !== 0 && chunks.length === 0) {
          return reject(new Error(`FFmpeg audio extraction failed with code ${code}`));
        }
        const buffer = Buffer.concat(chunks);
        const floatCount = Math.floor(buffer.byteLength / 4);
        const floatArray = new Float32Array(floatCount);
        for (let i = 0; i < floatCount; i++) {
          floatArray[i] = buffer.readFloatLE(i * 4);
        }
        resolve(floatArray);
      });

      proc.on('error', (err) => reject(err));
    });
  }
);

// 5-1. Extract High-Resolution Audio Waveform Peaks (200 peaks/sec = 5ms resolution) for Premiere-style Timeline Waveform
const waveformPeaksCache = new Map<string, { peaks: number[]; rms: number[]; samplesPerSec: number }>();

ipcMain.handle(
  'media:getWaveformPeaks',
  async (_event, params: { filePath: string; samplesPerSec?: number }) => {
    const { filePath, samplesPerSec = 200 } = params;
    const cacheKey = `${filePath}__${samplesPerSec}`;
    if (waveformPeaksCache.has(cacheKey)) {
      return waveformPeaksCache.get(cacheKey)!;
    }

    return new Promise((resolve) => {
      const sampleRate = 8000;
      const samplesPerBucket = Math.max(1, Math.floor(sampleRate / samplesPerSec));
      const args = [
        '-nostats',
        '-loglevel',
        'error',
        '-i',
        filePath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(sampleRate),
        '-f',
        's16le',
        'pipe:1',
      ];

      const proc = spawn(resolvedFfmpegPath, args);
      const chunks: Buffer[] = [];

      proc.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      // stderr를 반드시 소비해야 Windows 파이프 버퍼링으로 인한 데드락이 발생하지 않음!
      proc.stderr.on('data', () => {});

      proc.on('close', (code) => {
        try {
          if (code !== 0 && chunks.length === 0) {
            console.warn(`[media:getWaveformPeaks] ffmpeg failed with code ${code}`);
            resolve({ peaks: [], rms: [], samplesPerSec });
            return;
          }

          const buffer = Buffer.concat(chunks);
          const totalSamples = Math.floor(buffer.byteLength / 2);
          if (totalSamples === 0) {
            resolve({ peaks: [], rms: [], samplesPerSec });
            return;
          }

          const bucketCount = Math.ceil(totalSamples / samplesPerBucket);
          const rawPeaks = new Float32Array(bucketCount);
          const rawRms = new Float32Array(bucketCount);

          for (let b = 0; b < bucketCount; b++) {
            const startSample = b * samplesPerBucket;
            const endSample = Math.min(totalSamples, startSample + samplesPerBucket);
            let maxAbs = 0;
            let sumSq = 0;
            const count = endSample - startSample;

            for (let s = startSample; s < endSample; s++) {
              const val = Math.abs(buffer.readInt16LE(s * 2)) / 32768;
              if (val > maxAbs) maxAbs = val;
              sumSq += val * val;
            }

            rawPeaks[b] = maxAbs;
            rawRms[b] = count > 0 ? Math.sqrt(sumSq / count) : 0;
          }

          // 98 퍼센타일 최대값 기준으로 정규화하여 조용한 음성도 파형 높낮이와 무음 구간이 선명히 구분되도록 처리
          const sortedPeaks = Float32Array.from(rawPeaks).sort();
          const p98 = sortedPeaks[Math.floor(sortedPeaks.length * 0.98)] || 0.01;
          const normScale = Math.max(0.04, Math.min(1, p98));

          const peaks: number[] = new Array(bucketCount);
          const rms: number[] = new Array(bucketCount);

          // 노이즈 게이트 임계값: 발화 전 숨소리/배경 히스 노이즈가 먼저 솟아오르는 현상 방지
          const noiseGate = 0.038;

          for (let b = 0; b < bucketCount; b++) {
            const normP = Math.min(1.0, rawPeaks[b] / normScale);
            const normR = Math.min(1.0, rawRms[b] / normScale);

            // 미세 배경 잡음/무음 구간은 0으로 완벽히 떨어뜨려 발화 직전에 미리 솟는 현상 방지
            const shapedP =
              normP <= noiseGate ? 0 : Math.pow((normP - noiseGate) / (1 - noiseGate), 0.8);
            const shapedR =
              normR <= noiseGate ? 0 : Math.pow((normR - noiseGate) / (1 - noiseGate), 0.8);

            peaks[b] = Number(shapedP.toFixed(3));
            rms[b] = Number(shapedR.toFixed(3));
          }

          const result = { peaks, rms, samplesPerSec };
          waveformPeaksCache.set(cacheKey, result);
          resolve(result);
        } catch (err) {
          console.warn('[media:getWaveformPeaks] error:', err);
          resolve({ peaks: [], rms: [], samplesPerSec });
        }
      });

      proc.on('error', (err) => {
        console.warn('[media:getWaveformPeaks] spawn error:', err);
        resolve({ peaks: [], rms: [], samplesPerSec });
      });
    });
  }
);



// 7. Create a Demo Sample Video (with Korean TTS or synthetic voice pulses) for instant testing
ipcMain.handle('demo:createSampleVideo', async () => {
  const sampleDir = path.join(os.tmpdir(), 'antigravity-video-samples');
  await fs.promises.mkdir(sampleDir, { recursive: true });
  const outputPath = path.join(sampleDir, 'sample_interview_clip.mp4');

  // Generate a 12-second 1280x720 30fps video with 4 distinct spoken/audio intervals and silence gaps
  // Speech intervals: 0.4s~2.8s, 3.6s~6.2s, 7.0s~9.4s, 10.1s~11.7s
  return new Promise((resolve, reject) => {
    const filterComplex = [
      `color=c=#1e293b:s=1280x720:r=30:d=12[bg]`,
      `testsrc2=s=1280x720:r=30:d=12,format=yuv420p[vid]`,
      `[bg][vid]blend=all_mode=overlay:all_opacity=0.65[vout]`,
      `aevalsrc='0.35*sin(2*PI*240*t)*(between(t,0.4,2.8)+between(t,3.6,6.2)+between(t,7.0,9.4)+between(t,10.1,11.7))+0.15*sin(2*PI*480*t)*(between(t,0.4,2.8)+between(t,3.6,6.2)+between(t,7.0,9.4)+between(t,10.1,11.7))':s=44100:d=12[aout]`,
    ].join(';');

    const args = [
      '-y',
      '-filter_complex', filterComplex,
      '-map', '[vout]',
      '-map', '[aout]',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      outputPath,
    ];

    const proc = spawn(resolvedFfmpegPath, args);
    proc.on('close', async (code) => {
      if (code !== 0) {
        return reject(new Error(`Failed to generate sample video (${code})`));
      }
      const info = await probeMediaFile(outputPath);
      resolve(info);
    });
    proc.on('error', reject);
  });
});

// 8. Export Final Multi-track MP4 Video
ipcMain.handle(
  'editor:exportVideo',
  async (
    event,
    payload: {
      videoClips: Array<{
        id: string;
        sourcePath: string;
        startTime: number;
        duration: number;
        sourceStart: number;
        speed?: number;
        volume: number;
        muted: boolean;
        /** 블러 마스크: 흑백 PNG(흰색=흐리게, 출력 크기) + 블러 강도 */
        masks?: Array<{ png: string; blur: number; frames?: string[]; from?: number; to?: number }>;
        /** 모션: 위치(px), 크기(%), 회전(도), 불투명도(0~1), 키프레임 */
        scale?: number;
        posX?: number;
        posY?: number;
        rotation?: number;
        opacity?: number;
        keyframes?: KeyframeMap;
      }>;
      audioClips: Array<{
        id: string;
        sourcePath: string;
        startTime: number;
        duration: number;
        sourceStart: number;
        speed?: number;
        volume: number;
        muted: boolean;
      }>;
      subtitleOverlays: Array<{
        id: string;
        startTime: number;
        endTime: number;
        pngDataUrl: string;
        /** 모션 키프레임 자막: 프레임마다 그린 PNG (fps 간격) */
        frames?: string[];
      }>;
      totalDuration: number;
      fps: number;
      width: number;
      height: number;
      /** 지정하면 저장 창 없이 이 경로로 (광고 구간별 내보내기) */
      outputPath?: string;
    }
  ) => {
    if (!mainWindow) return { canceled: true };

    let outputPath = payload.outputPath;
    if (!outputPath) {
      const saveRes = await dialog.showSaveDialog(mainWindow, {
        title: '편집된 동영상 내보내기 (MP4)',
        defaultPath: `shortcut_edit_${Date.now()}.mp4`,
        filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
      });
      if (saveRes.canceled || !saveRes.filePath) {
        return { canceled: true };
      }
      outputPath = saveRes.filePath;
    }
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agy_export_'));

    try {
      const { videoClips, audioClips, subtitleOverlays, totalDuration, fps = 30, width = 1280, height = 720 } = payload;
      const safeDuration = Math.max(0.5, totalDuration);

      const inputArgs: string[] = [];
      const filterParts: string[] = [];

      // Input 0: Black base canvas for the entire timeline duration
      inputArgs.push(
        '-f', 'lavfi',
        '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${safeDuration.toFixed(3)}`
      );
      // Input 1: Silent base audio for the entire timeline duration
      inputArgs.push(
        '-f', 'lavfi',
        '-i', `anullsrc=channel_layout=stereo:sample_rate=44100:d=${safeDuration.toFixed(3)}`
      );

      // 속도 조절: 원본에서 읽을 길이 = 타임라인 길이 × 속도, 소리는 atempo(음 높이 유지)로 늘이고 줄임
      const speedOf = (c: { speed?: number }) => (c.speed && c.speed > 0 ? c.speed : 1);
      const atempoChain = (sp: number) => {
        if (Math.abs(sp - 1) < 1e-4) return '';
        const parts: string[] = [];
        let r = sp;
        while (r < 0.5) {
          parts.push('atempo=0.5');
          r /= 0.5;
        }
        while (r > 2) {
          parts.push('atempo=2.0');
          r /= 2;
        }
        parts.push(`atempo=${r.toFixed(5)}`);
        return ',' + parts.join(',');
      };

      // 프레임 단위로 맞춘 켜짐/꺼짐 시각. 앞 클립 끝(예: 22.4166)과 다음 클립 시작(22.4167)을 소수로 따로 반올림하면
      // 그 사이 프레임(22.41667)이 어느 쪽에도 안 들어가 검은 화면 1프레임이 생겼다 (2026-11-04).
      // → 시작·끝을 가장 가까운 프레임 번호로 바꾸고, 반 프레임 앞을 경계로 쓴다: 프레임 n 은 [n-0.5, n+0.5) 안에 딱 하나
      const frameOf = (t: number) => Math.round(t * fps);
      const edge = (f: number) => ((f - 0.5) / fps).toFixed(5);
      const enableFrames = (start: number, end: number) => `between(t,${edge(frameOf(start))},${edge(frameOf(end))})`;
      const startAt = (t: number) => (frameOf(t) / fps).toFixed(5);

      let inputIdx = 2;
      let currentVideoLabel = '[0:v]';
      const audioMixLabels: string[] = ['[1:a]'];

      // Process Video Clips
      const sortedVideos = [...videoClips].sort((a, b) => a.startTime - b.startTime);
      for (let i = 0; i < sortedVideos.length; i++) {
        const clip = sortedVideos[i];
        if (!clip.sourcePath) continue;
        const vSpeed = speedOf(clip);
        inputArgs.push(
          '-ss', clip.sourceStart.toFixed(4),
          '-t', (clip.duration * vSpeed).toFixed(4),
          '-i', clip.sourcePath
        );
        const vIdx = inputIdx++;
        const vScaled = `[vclip_${i}]`;
        const vOut = `[vbase_${i}]`;

        // tpad: 30fps 로 맞출 때 클립 마지막 1프레임이 빠지면 그 자리에 검은 바탕이 비쳐 번쩍임
        //  (클립 시작이 프레임 경계와 미세하게 어긋날 때, AI 자동 배치에서 자주) → 마지막 프레임을 2프레임 복제해 메움.
        //  보이는 구간은 아래 overlay enable 이 정하므로 다음 장면이 비치지는 않음 (2026-11-02)
        filterParts.push(
          `[${vIdx}:v]setpts=(PTS-STARTPTS)/${vSpeed.toFixed(5)},scale=${width}:${height}:force_original_aspect_ratio=decrease,format=rgba,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0,fps=${fps},tpad=stop_mode=clone:stop_duration=${(2 / fps).toFixed(4)},setpts=PTS-STARTPTS+${startAt(clip.startTime)}/TB${vScaled}`
        );
        // 블러 마스크: 클립 화면을 흐리게 한 복사본을 마스크 모양(흰 곳)만 원래 화면 위에 덮음
        let clipLabel = vScaled;
        for (let j = 0; j < (clip.masks || []).length; j++) {
          const mk = clip.masks![j];
          const b64 = mk.png.replace(/^data:image\/png;base64,/, '');
          const tag = `${i}_${j}`;
          let maskSrc: string;
          if (mk.frames && mk.frames.length > 1) {
            // 움직이는 마스크(키프레임): 프레임마다 그린 마스크 PNG 묶음 → 클립 시작 시각에 맞춤
            const dir = path.join(tempDir, `maskseq_${tag}`);
            await fs.promises.mkdir(dir, { recursive: true });
            for (let f = 0; f < mk.frames.length; f++) {
              const fb = mk.frames[f].replace(/^data:image\/png;base64,/, '');
              await fs.promises.writeFile(path.join(dir, `m_${String(f).padStart(5, '0')}.png`), Buffer.from(fb, 'base64'));
            }
            inputArgs.push('-framerate', String(fps), '-start_number', '0', '-i', path.join(dir, 'm_%05d.png'));
            const mIdx = inputIdx++;
            filterParts.push(
              `[${mIdx}:v]format=gray,scale=${width}:${height},tpad=stop_mode=clone:stop_duration=${(2 / fps).toFixed(4)},setpts=PTS-STARTPTS+${startAt(clip.startTime)}/TB[mk_${tag}]`
            );
            maskSrc = `[mk_${tag}]`;
          } else {
            const maskPath = path.join(tempDir, `mask_${i}_${j}.png`);
            await fs.promises.writeFile(maskPath, Buffer.from(b64, 'base64'));
            inputArgs.push('-loop', '1', '-framerate', String(fps), '-t', (clip.startTime + clip.duration + 1).toFixed(3), '-i', maskPath);
            const mIdx = inputIdx++;
            filterParts.push(`[${mIdx}:v]format=gray,scale=${width}:${height}[mk_${tag}]`);
            maskSrc = `[mk_${tag}]`;
          }
          filterParts.push(`${clipLabel}split=2[mo_${tag}][mb_${tag}]`);
          filterParts.push(`[mb_${tag}]gblur=sigma=${Math.max(0.5, mk.blur).toFixed(2)}[mbb_${tag}]`);
          filterParts.push(`[mbb_${tag}]${maskSrc}alphamerge[ma_${tag}]`);
          // 보이는 구간이 있으면 그 동안만 (장면마다 바뀌는 자막)
          const en =
            mk.from !== undefined || mk.to !== undefined
              ? `:enable='${enableFrames(clip.startTime + (mk.from ?? 0), clip.startTime + (mk.to ?? clip.duration))}'`
              : '';
          filterParts.push(`[mo_${tag}][ma_${tag}]overlay=format=auto${en}[mm_${tag}]`);
          clipLabel = `[mm_${tag}]`;
        }
        // 모션 (위치/크기/회전/불투명도, 키프레임 포함). 미리보기와 같은 계산식(ffExpr)
        //  크기: 프레임마다 다시 계산 → 고정 크기 투명 바탕에 가운데 → (회전) → (불투명도) → 위치만큼 옮겨 얹음
        const kf = clip.keyframes || {};
        const has = (k: string) => (kf[k]?.length ?? 0) > 0;
        const sBase = clip.scale ?? 100;
        const rBase = clip.rotation ?? 0;
        const oBase = (clip.opacity ?? 1) * 100;
        const motion =
          ['posX', 'posY', 'scale', 'rotation', 'opacity'].some(has) ||
          Math.abs(clip.posX ?? 0) > 1e-6 ||
          Math.abs(clip.posY ?? 0) > 1e-6 ||
          Math.abs(sBase - 100) > 1e-6 ||
          Math.abs(rBase) > 1e-6 ||
          oBase < 100 - 1e-6;
        let ox = '0';
        let oy = '0';
        if (motion) {
          const T = `(t-${clip.startTime.toFixed(4)})`;
          const S = ffExpr(kf.scale, sBase, T);
          const maxS = Math.max(100, sBase, ...(kf.scale || []).map((k) => k.v));
          const even = (x: number) => Math.ceil(x / 2) * 2;
          const rotUsed = has('rotation') || Math.abs(rBase) > 1e-6;
          const PW = rotUsed ? even(Math.hypot(width, height) * maxS / 100) : even(width * maxS / 100);
          const PH = rotUsed ? PW : even(height * maxS / 100);
          let chain = `${clipLabel}scale=w='max(2,trunc(iw*(${S})/200)*2)':h='max(2,trunc(ih*(${S})/200)*2)':eval=frame,pad=${PW}:${PH}:'(ow-iw)/2':'(oh-ih)/2':color=black@0:eval=frame`;
          if (rotUsed) chain += `,rotate=a='(${ffExpr(kf.rotation, rBase, T)})*PI/180':c=none:ow=${PW}:oh=${PH}`;
          if (has('opacity')) {
            const O = ffExpr(kf.opacity, oBase, `(T-${clip.startTime.toFixed(4)})`);
            chain += `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*max(0,min(100,${O}))/100'`;
          } else if (oBase < 100 - 1e-6) {
            chain += `,colorchannelmixer=aa=${Math.max(0, oBase / 100).toFixed(4)}`;
          }
          filterParts.push(`${chain}[mot_${i}]`);
          clipLabel = `[mot_${i}]`;
          ox = `(W-w)/2+(${ffExpr(kf.posX, clip.posX ?? 0, T)})`;
          oy = `(H-h)/2+(${ffExpr(kf.posY, clip.posY ?? 0, T)})`;
        }
        filterParts.push(
          `${currentVideoLabel}${clipLabel}overlay=x='${ox}':y='${oy}':eval=frame:enable='${enableFrames(clip.startTime, clip.startTime + clip.duration)}':eof_action=pass${vOut}`
        );
        currentVideoLabel = vOut;

        if (!clip.muted && clip.volume > 0) {
          const delayMs = Math.round(clip.startTime * 1000);
          const aLabel = `[vaud_${i}]`;
          filterParts.push(
            `[${vIdx}:a]aresample=44100${atempoChain(vSpeed)},volume=${clip.volume.toFixed(2)},adelay=${delayMs}|${delayMs}${aLabel}`
          );
          audioMixLabels.push(aLabel);
        }
      }

      // Process Dedicated Audio Clips
      for (let i = 0; i < audioClips.length; i++) {
        const clip = audioClips[i];
        if (!clip.sourcePath || clip.muted || clip.volume <= 0) continue;
        const aSpeed = speedOf(clip);
        inputArgs.push(
          '-ss', clip.sourceStart.toFixed(4),
          '-t', (clip.duration * aSpeed).toFixed(4),
          '-i', clip.sourcePath
        );
        const aIdx = inputIdx++;
        const delayMs = Math.round(clip.startTime * 1000);
        const aLabel = `[aaud_${i}]`;
        filterParts.push(
          `[${aIdx}:a]aresample=44100${atempoChain(aSpeed)},volume=${clip.volume.toFixed(2)},adelay=${delayMs}|${delayMs}${aLabel}`
        );
        audioMixLabels.push(aLabel);
      }

      // Process Subtitle PNG Overlays (pixel-accurate Korean typography)
      for (let i = 0; i < subtitleOverlays.length; i++) {
        const sub = subtitleOverlays[i];
        const sOut = `[vsub_${i}]`;
        if (sub.frames && sub.frames.length > 1) {
          // 움직이는 자막: PNG 묶음 → 자막 시작 시각부터 fps 간격으로
          const dir = path.join(tempDir, `subseq_${i}`);
          await fs.promises.mkdir(dir, { recursive: true });
          for (let f = 0; f < sub.frames.length; f++) {
            const b = sub.frames[f].replace(/^data:image\/png;base64,/, '');
            await fs.promises.writeFile(path.join(dir, `f_${String(f).padStart(5, '0')}.png`), Buffer.from(b, 'base64'));
          }
          inputArgs.push('-framerate', String(fps), '-start_number', '0', '-i', path.join(dir, 'f_%05d.png'));
          const sIdx = inputIdx++;
          filterParts.push(`[${sIdx}:v]format=rgba,tpad=stop_mode=clone:stop_duration=${(2 / fps).toFixed(4)},setpts=PTS-STARTPTS+${startAt(sub.startTime)}/TB[vsubsrc_${i}]`);
          filterParts.push(
            `${currentVideoLabel}[vsubsrc_${i}]overlay=0:0:enable='${enableFrames(sub.startTime, sub.endTime)}':eof_action=pass${sOut}`
          );
        } else {
          const base64Data = sub.pngDataUrl.replace(/^data:image\/png;base64,/, '');
          const pngPath = path.join(tempDir, `sub_${i}.png`);
          await fs.promises.writeFile(pngPath, Buffer.from(base64Data, 'base64'));
          inputArgs.push('-i', pngPath);
          const sIdx = inputIdx++;
          filterParts.push(
            `${currentVideoLabel}[${sIdx}:v]overlay=0:0:enable='${enableFrames(sub.startTime, sub.endTime)}'${sOut}`
          );
        }
        currentVideoLabel = sOut;
      }

      // Mix Audio
      const finalAudioLabel = '[afinal]';
      if (audioMixLabels.length === 1) {
        filterParts.push(`[1:a]asetpts=PTS-STARTPTS${finalAudioLabel}`);
      } else {
        filterParts.push(
          `${audioMixLabels.join('')}amix=inputs=${audioMixLabels.length}:duration=first:dropout_transition=0,volume=${audioMixLabels.length}${finalAudioLabel}`
        );
      }

      const filterScriptPath = path.join(tempDir, 'filter_complex.txt');
      await fs.promises.writeFile(filterScriptPath, filterParts.join(';\n'), 'utf-8');

      const finalArgs = [
        '-y',
        ...inputArgs,
        '-filter_complex_script', filterScriptPath,
        '-map', currentVideoLabel,
        '-map', finalAudioLabel,
        '-t', safeDuration.toFixed(3),
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        outputPath,
      ];

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(resolvedFfmpegPath, finalArgs);
        let stderrLog = '';

        proc.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          stderrLog += text;
          const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
          if (timeMatch) {
            const sec =
              parseInt(timeMatch[1], 10) * 3600 +
              parseInt(timeMatch[2], 10) * 60 +
              parseFloat(timeMatch[3]);
            const progress = Math.min(99, Math.round((sec / safeDuration) * 100));
            event.sender.send('editor:exportProgress', progress);
          }
        });

        proc.on('close', (code) => {
          if (code === 0) {
            event.sender.send('editor:exportProgress', 100);
            resolve();
          } else {
            // If a video clip had no audio stream and caused [vIdx:a] error, fallback retry without video-embedded audio if needed
            reject(new Error(`FFmpeg 렌더링 오류 (코드 ${code}): ${stderrLog.slice(-400)}`));
          }
        });

        proc.on('error', reject);
      });

      // 내보낸 영상 컷 검사 (비용 없음, 몇 초): 짧은 장면·마스크 풀림·1프레임 번쩍임 → 의심 자리 사진
      let check: CheckResult | undefined;
      try {
        event.sender.send('editor:exportProgress', 100);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const imageDir = path.join(app.getPath('userData'), 'export-check', `${path.basename(outputPath, '.mp4')}_${stamp}`);
        check = await checkExportedVideo(resolvedFfmpegPath, outputPath, imageDir, fps);
      } catch (err) {
        console.warn('[export-check] 검사 실패', err);
      }
      return { canceled: false, outputPath, check };
    } finally {
      fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
);

// 9. Project File Save / Open Handlers (.agproj)
ipcMain.handle('project:saveDialog', async (_event, defaultFileName?: string) => {
  const win = mainWindow || BrowserWindow.getFocusedWindow();
  const cleanName = defaultFileName
    ? defaultFileName.endsWith('.agproj')
      ? defaultFileName
      : `${defaultFileName}.agproj`
    : '프로젝트.agproj';

  const options = {
    title: '프로젝트 파일 저장 위치 선택',
    defaultPath: cleanName,
    filters: [
      { name: 'ShortCut 프로젝트 (*.agproj)', extensions: ['agproj'] },
      { name: 'JSON 프로젝트 (*.json)', extensions: ['json'] },
      { name: '모든 파일 (*.*)', extensions: ['*'] },
    ],
  };

  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);

  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle('project:write', async (_event, filePath: string, content: string) => {
  try {
    await fs.promises.writeFile(filePath, content, 'utf-8');
    return { success: true };
  } catch (err: any) {
    console.error('Failed to write project file:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('project:openDialog', async () => {
  const win = mainWindow || BrowserWindow.getFocusedWindow();
  const options = {
    title: '프로젝트 파일 열기',
    properties: ['openFile' as const],
    filters: [
      { name: 'ShortCut 프로젝트 (*.agproj, *.json)', extensions: ['agproj', 'json'] },
      { name: '모든 파일 (*.*)', extensions: ['*'] },
    ],
  };

  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return { filePath, content };
  } catch (err: any) {
    console.error('Failed to read project file:', err);
    throw new Error(`프로젝트 파일 읽기 실패: ${err.message}`);
  }
});

ipcMain.handle('project:checkAssets', async (_event, filePaths: string[]) => {
  const missing: string[] = [];
  if (Array.isArray(filePaths)) {
    for (const fp of filePaths) {
      if (typeof fp === 'string' && fp.trim().length > 0) {
        if (!fs.existsSync(fp)) {
          missing.push(fp);
        }
      }
    }
  }
  return { missing };
});

ipcMain.handle('dialog:locateMedia', async (_event, targetFileName?: string) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: targetFileName ? `"${targetFileName}" 파일 다시 찾기 (재연결)` : '미디어 파일 다시 찾기',
    properties: ['openFile'],
    filters: [
      { name: '미디어 파일', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'mp3', 'wav', 'm4a', 'aac', 'ogg'] },
      { name: '모든 파일 (*.*)', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('media:scanFolderForMatches', async (_event, folderPath: string, fileNames: string[]) => {
  const matches: Record<string, string> = {};
  try {
    if (!fs.existsSync(folderPath)) return matches;
    const entries = await fs.promises.readdir(folderPath);
    const entryMap = new Map<string, string>();
    for (const e of entries) {
      entryMap.set(e.toLowerCase(), e);
    }

    for (const fileName of fileNames) {
      const lower = fileName.toLowerCase();
      if (entryMap.has(lower)) {
        matches[fileName] = path.join(folderPath, entryMap.get(lower)!);
      }
    }
  } catch (err) {
    console.error('Scan folder matches failed:', err);
  }
  return matches;
});
