import { app, BrowserWindow, ipcMain, dialog, protocol, session } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 1180,
    minHeight: 740,
    backgroundColor: '#0f1117',
    title: 'Antigravity Studio - AI 비디오 편집기',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
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
      const stat = await fs.promises.stat(filePath);
      const fileSize = stat.size;
      const mimeType = getMimeType(filePath);
      const rangeHeader = request.headers.get('range');

      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : Math.min(start + 4 * 1024 * 1024, fileSize - 1);
          const chunkSize = end - start + 1;
          const fileStream = fs.createReadStream(filePath, { start, end });
          return new Response(fileStream as unknown as ReadableStream, {
            status: 206,
            headers: {
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(chunkSize),
              'Content-Type': mimeType,
            },
          });
        }
      }

      const fileStream = fs.createReadStream(filePath);
      return new Response(fileStream as unknown as ReadableStream, {
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
ipcMain.handle('media:probe', async (_event, filePath: string) => {
  return await probeMediaFile(filePath);
});

// 4. AI Silence Detection (FFmpeg silencedetect)
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
      const args = [
        '-ss', String(sourceStart),
        '-t', String(duration),
        '-i', filePath,
        '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilenceDuration}`,
        '-f', 'null',
        '-',
      ];

      const proc = spawn(resolvedFfmpegPath, args);
      let stderrLog = '';

      proc.stderr.on('data', (chunk) => {
        stderrLog += chunk.toString();
      });

      proc.on('close', () => {
        const silences: Array<{ start: number; end: number }> = [];
        const startRegex = /silence_start:\s*([0-9.]+)/g;
        const endRegex = /silence_end:\s*([0-9.]+)/g;

        const starts: number[] = [];
        const ends: number[] = [];
        let m: RegExpExecArray | null;

        while ((m = startRegex.exec(stderrLog)) !== null) {
          starts.push(parseFloat(m[1]));
        }
        while ((m = endRegex.exec(stderrLog)) !== null) {
          ends.push(parseFloat(m[1]));
        }

        for (let i = 0; i < starts.length; i++) {
          const s = Math.max(0, starts[i]);
          const e = i < ends.length ? Math.min(duration, ends[i]) : duration;
          if (e > s) {
            silences.push({ start: s, end: e });
          }
        }

        // Convert silences into active speech segments with padding
        const padSec = (paddingMs || 80) / 1000;
        const speechSegments: Array<{ start: number; end: number }> = [];
        let cursor = 0;

        for (const sil of silences) {
          const segStart = Math.max(0, cursor);
          const segEnd = Math.min(duration, sil.start + padSec);
          if (segEnd - segStart >= 0.12) {
            speechSegments.push({ start: segStart, end: segEnd });
          }
          cursor = Math.max(cursor, sil.end - padSec);
        }

        if (duration - cursor >= 0.12) {
          speechSegments.push({ start: cursor, end: duration });
        }

        // Merge overlapping speech segments if padding caused overlap
        const merged: Array<{ start: number; end: number }> = [];
        for (const seg of speechSegments) {
          if (merged.length === 0) {
            merged.push({ ...seg });
          } else {
            const prev = merged[merged.length - 1];
            if (seg.start <= prev.end + 0.04) {
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

// 6. OpenAI Whisper API Transcription (Word + Segment timestamps + Script Prompt Hint)
ipcMain.handle(
  'ai:transcribeOpenAI',
  async (
    _event,
    params: {
      filePath: string;
      sourceStart: number;
      duration: number;
      apiKey: string;
      language?: string;
      scriptHint?: string;
    }
  ) => {
    const { filePath, sourceStart, duration, apiKey, language = 'ko', scriptHint } = params;
    const tempAudioPath = path.join(os.tmpdir(), `agy_whisper_${Date.now()}.mp3`);

    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(resolvedFfmpegPath, [
          '-y',
          '-ss', String(sourceStart),
          '-t', String(duration),
          '-i', filePath,
          '-vn',
          '-ac', '1',
          '-ar', '16000',
          '-b:a', '64k',
          tempAudioPath,
        ]);
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Audio extract failed: ${code}`))));
        proc.on('error', reject);
      });

      const fileBuffer = await fs.promises.readFile(tempAudioPath);
      const formData = new FormData();
      formData.append('file', new Blob([fileBuffer], { type: 'audio/mpeg' }), 'audio.mp3');
      formData.append('model', 'whisper-1');
      formData.append('language', language);
      formData.append('response_format', 'verbose_json');
      formData.append('timestamp_granularities[]', 'word');
      formData.append('timestamp_granularities[]', 'segment');
      if (scriptHint && scriptHint.trim()) {
        formData.append('prompt', scriptHint.trim().slice(0, 600));
      }

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenAI API 오류 (${response.status}): ${errText}`);
      }

      const data = await response.json();
      return data;
    } finally {
      fs.promises.unlink(tempAudioPath).catch(() => {});
    }
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
        volume: number;
        muted: boolean;
      }>;
      audioClips: Array<{
        id: string;
        sourcePath: string;
        startTime: number;
        duration: number;
        sourceStart: number;
        volume: number;
        muted: boolean;
      }>;
      subtitleOverlays: Array<{
        id: string;
        startTime: number;
        endTime: number;
        pngDataUrl: string;
      }>;
      totalDuration: number;
      fps: number;
      width: number;
      height: number;
    }
  ) => {
    if (!mainWindow) return { canceled: true };

    const saveRes = await dialog.showSaveDialog(mainWindow, {
      title: '편집된 동영상 내보내기 (MP4)',
      defaultPath: `antigravity_edit_${Date.now()}.mp4`,
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
    });

    if (saveRes.canceled || !saveRes.filePath) {
      return { canceled: true };
    }

    const outputPath = saveRes.filePath;
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

      let inputIdx = 2;
      let currentVideoLabel = '[0:v]';
      const audioMixLabels: string[] = ['[1:a]'];

      // Process Video Clips
      const sortedVideos = [...videoClips].sort((a, b) => a.startTime - b.startTime);
      for (let i = 0; i < sortedVideos.length; i++) {
        const clip = sortedVideos[i];
        if (!clip.sourcePath) continue;
        inputArgs.push(
          '-ss', clip.sourceStart.toFixed(4),
          '-t', clip.duration.toFixed(4),
          '-i', clip.sourcePath
        );
        const vIdx = inputIdx++;
        const vScaled = `[vclip_${i}]`;
        const vOut = `[vbase_${i}]`;

        filterParts.push(
          `[${vIdx}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=${fps},setpts=PTS-STARTPTS+${clip.startTime.toFixed(4)}/TB${vScaled}`
        );
        const endT = (clip.startTime + clip.duration).toFixed(4);
        filterParts.push(
          `${currentVideoLabel}${vScaled}overlay=x=0:y=0:enable='between(t,${clip.startTime.toFixed(4)},${endT})':eof_action=pass${vOut}`
        );
        currentVideoLabel = vOut;

        if (!clip.muted && clip.volume > 0) {
          const delayMs = Math.round(clip.startTime * 1000);
          const aLabel = `[vaud_${i}]`;
          filterParts.push(
            `[${vIdx}:a]aresample=44100,volume=${clip.volume.toFixed(2)},adelay=${delayMs}|${delayMs}${aLabel}`
          );
          audioMixLabels.push(aLabel);
        }
      }

      // Process Dedicated Audio Clips
      for (let i = 0; i < audioClips.length; i++) {
        const clip = audioClips[i];
        if (!clip.sourcePath || clip.muted || clip.volume <= 0) continue;
        inputArgs.push(
          '-ss', clip.sourceStart.toFixed(4),
          '-t', clip.duration.toFixed(4),
          '-i', clip.sourcePath
        );
        const aIdx = inputIdx++;
        const delayMs = Math.round(clip.startTime * 1000);
        const aLabel = `[aaud_${i}]`;
        filterParts.push(
          `[${aIdx}:a]aresample=44100,volume=${clip.volume.toFixed(2)},adelay=${delayMs}|${delayMs}${aLabel}`
        );
        audioMixLabels.push(aLabel);
      }

      // Process Subtitle PNG Overlays (pixel-accurate Korean typography)
      for (let i = 0; i < subtitleOverlays.length; i++) {
        const sub = subtitleOverlays[i];
        const base64Data = sub.pngDataUrl.replace(/^data:image\/png;base64,/, '');
        const pngPath = path.join(tempDir, `sub_${i}.png`);
        await fs.promises.writeFile(pngPath, Buffer.from(base64Data, 'base64'));

        inputArgs.push('-i', pngPath);
        const sIdx = inputIdx++;
        const sOut = `[vsub_${i}]`;
        filterParts.push(
          `${currentVideoLabel}[${sIdx}:v]overlay=0:0:enable='between(t,${sub.startTime.toFixed(4)},${sub.endTime.toFixed(4)})'${sOut}`
        );
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

      return { canceled: false, outputPath };
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
      { name: 'Antigravity Studio 프로젝트 (*.agproj)', extensions: ['agproj'] },
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
      { name: 'Antigravity Studio 프로젝트 (*.agproj, *.json)', extensions: ['agproj', 'json'] },
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
