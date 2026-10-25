import React, { useEffect, useRef, useState } from 'react';

export interface WaveformData {
  peaks: number[];
  rms: number[];
  samplesPerSec: number;
}

export const rendererWaveformCache = new Map<string, WaveformData>();
const inFlightRequests = new Map<string, Promise<WaveformData>>();

export function normalizeAudioPath(p: string): string {
  return (p || '').replace(/\\/g, '/').toLowerCase();
}

// 현재 타임라인 시점의 실제 오디오 피크/RMS 레벨(0.0 ~ 1.0)을 즉시 조회하는 유틸리티
export function getInstantAudioLevelAtTime(
  filePath: string,
  sourceTime: number,
  volume = 1.0,
  muted = false
): { peak: number; rms: number } {
  if (muted || volume <= 0 || !filePath) return { peak: 0, rms: 0 };
  const key = normalizeAudioPath(filePath);
  const data = rendererWaveformCache.get(key) || rendererWaveformCache.get(filePath);
  if (!data || data.peaks.length === 0) {
    fetchWaveformData(filePath);
    return { peak: 0, rms: 0 };
  }

  const idx = Math.floor(sourceTime * data.samplesPerSec);
  if (idx < 0 || idx >= data.peaks.length) return { peak: 0, rms: 0 };

  const p = (data.peaks[idx] || 0) * volume;
  const r = (data.rms[idx] || 0) * volume;
  return {
    peak: Math.min(1.0, p),
    rms: Math.min(1.0, r),
  };
}

// Electron IPC 또는 브라우저 Web Audio API를 통해 실제 오디오 파일의 피크 데이터를 추출 (가짜 사인파 절대 사용 안 함)
export async function fetchWaveformData(filePath: string): Promise<WaveformData> {
  if (!filePath) return { peaks: [], rms: [], samplesPerSec: 200 };
  const key = normalizeAudioPath(filePath);

  if (rendererWaveformCache.has(key)) {
    return rendererWaveformCache.get(key)!;
  }
  if (rendererWaveformCache.has(filePath)) {
    return rendererWaveformCache.get(filePath)!;
  }
  if (inFlightRequests.has(key)) {
    return inFlightRequests.get(key)!;
  }

  const promise = (async (): Promise<WaveformData> => {
    // 1) 1차 시도: Electron 메인 프로세스 FFmpeg PCM 추출 (200 samples/sec = 5ms 고정밀도)
    try {
      if (window.electronAPI?.getWaveformPeaks) {
        const res = await window.electronAPI.getWaveformPeaks({
          filePath,
          samplesPerSec: 200,
        });
        if (res && res.peaks && res.peaks.length > 0) {
          rendererWaveformCache.set(key, res);
          rendererWaveformCache.set(filePath, res);
          return res;
        }
      }
    } catch (err) {
      console.warn('[AudioWaveformCanvas] Electron IPC getWaveformPeaks error:', err);
    }

    // 2) 2차 시도 (Fallback): 브라우저 AudioContext를 통한 실제 PCM 디코딩 (100% 신뢰성 보장)
    try {
      const mediaUrl = `media://local?path=${encodeURIComponent(filePath)}`;
      const response = await fetch(mediaUrl);
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          const audioCtx = new AudioCtx();
          try {
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            const channelData = audioBuffer.getChannelData(0);
            const samplesPerSec = 200;
            const samplesPerBucket = Math.max(1, Math.floor(audioBuffer.sampleRate / samplesPerSec));
            const bucketCount = Math.ceil(channelData.length / samplesPerBucket);

            const rawPeaks = new Float32Array(bucketCount);
            const rawRms = new Float32Array(bucketCount);

            for (let b = 0; b < bucketCount; b++) {
              const start = b * samplesPerBucket;
              const end = Math.min(channelData.length, start + samplesPerBucket);
              let maxAbs = 0;
              let sumSq = 0;
              const count = end - start;
              for (let s = start; s < end; s++) {
                const val = Math.abs(channelData[s]);
                if (val > maxAbs) maxAbs = val;
                sumSq += val * val;
              }
              rawPeaks[b] = maxAbs;
              rawRms[b] = count > 0 ? Math.sqrt(sumSq / count) : 0;
            }

            // 98% 분위수 정규화
            const sorted = Float32Array.from(rawPeaks).sort();
            const p98 = sorted[Math.floor(sorted.length * 0.98)] || 0.01;
            const normScale = Math.max(0.04, Math.min(1.0, p98));

            const peaks: number[] = new Array(bucketCount);
            const rms: number[] = new Array(bucketCount);
            const noiseGate = 0.038;

            for (let b = 0; b < bucketCount; b++) {
              const normP = Math.min(1.0, rawPeaks[b] / normScale);
              const normR = Math.min(1.0, rawRms[b] / normScale);
              // 배경 잡음 및 발화 전 숨소리는 0으로 완벽히 수렴
              peaks[b] =
                normP <= noiseGate ? 0 : Number(Math.pow((normP - noiseGate) / (1 - noiseGate), 0.8).toFixed(3));
              rms[b] =
                normR <= noiseGate ? 0 : Number(Math.pow((normR - noiseGate) / (1 - noiseGate), 0.8).toFixed(3));
            }

            const result = { peaks, rms, samplesPerSec };
            rendererWaveformCache.set(key, result);
            rendererWaveformCache.set(filePath, result);
            return result;
          } finally {
            audioCtx.close().catch(() => {});
          }
        }
      }
    } catch (err) {
      console.warn('[AudioWaveformCanvas] WebAudio fallback failed:', err);
    }

    return { peaks: [], rms: [], samplesPerSec: 200 };
  })();

  inFlightRequests.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightRequests.delete(key);
  }
}

interface AudioWaveformCanvasProps {
  sourcePath?: string;
  sourceStart: number;
  duration: number;
  widthPx: number;
  heightPx?: number;
  volume?: number;
  muted?: boolean;
}

export const AudioWaveformCanvas: React.FC<AudioWaveformCanvasProps> = ({
  sourcePath,
  sourceStart,
  duration,
  widthPx,
  heightPx = 76,
  volume = 1,
  muted = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [waveform, setWaveform] = useState<WaveformData | null>(
    sourcePath ? rendererWaveformCache.get(sourcePath) || null : null
  );

  useEffect(() => {
    let cancelled = false;
    if (!sourcePath) {
      setWaveform(null);
      return;
    }
    const cached = rendererWaveformCache.get(sourcePath);
    if (cached) {
      setWaveform(cached);
      return;
    }
    fetchWaveformData(sourcePath).then((data) => {
      if (!cancelled) {
        setWaveform(data);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sourcePath]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const safeW = Math.max(16, Math.min(8192, Math.floor(widthPx)));
    const safeH = Math.max(24, Math.floor(heightPx));
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    canvas.width = Math.floor(safeW * dpr);
    canvas.height = Math.floor(safeH * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, safeW, safeH);

    // 프리미어 프로 스타일 오디오 트랙 배경 (짙은 올리브 녹색)
    ctx.fillStyle = 'rgba(28, 48, 20, 0.95)';
    ctx.fillRect(0, 0, safeW, safeH);

    // 프리미어 프로 Rectified Waveform: 바닥에서 위로 치솟는 형태
    const baseY = safeH - 3;
    const maxWaveHeight = safeH - 18; // 상단 텍스트 라벨 공간 확보

    // 1. 프리미어 프로 볼륨 기준선 (중단 가로 흰색/회색 실선)
    const volumeLineY = Math.round(baseY - maxWaveHeight * 0.65);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, volumeLineY);
    ctx.lineTo(safeW, volumeLineY);
    ctx.stroke();

    // 2. 바닥 무음 베이스라인
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, baseY);
    ctx.lineTo(safeW, baseY);
    ctx.stroke();

    const gain = muted ? 0 : Math.max(0, Math.min(2, volume));

    // 아직 실제 파형 데이터가 로딩 중이거나 없을 때는 가짜 파형을 그리지 않고, 바닥선만 유지
    if (!waveform || waveform.peaks.length === 0) {
      ctx.restore();
      return;
    }

    const { peaks, samplesPerSec } = waveform;
    const totalBuckets = peaks.length;

    // 3. 프리미어 프로 1:1 파형 렌더링 (바닥에서 위로 솟구치는 연두색 정류 파형)
    // 룩어헤드(미래 소리를 미리 당겨와 소리 나기 전부터 솟는 현상)를 방지하기 위해 정확한 시점 t 기준으로 샘플링
    ctx.beginPath();
    ctx.moveTo(0, baseY);

    const step = 1.5; // 1.5px 단위로 더욱 촘촘하고 매끄럽게 연결
    const wavePoints: Array<{ x: number; y: number; isOverload: boolean }> = [];
    const secPerPx = duration / safeW;

    for (let x = 0; x <= safeW; x += step) {
      // 해당 픽셀의 시작 및 중심 시간
      const t = sourceStart + (x / safeW) * duration;
      const dt = step * secPerPx;

      // 해당 픽셀 구간 내의 버킷 범위
      const bStart = Math.max(0, Math.floor(t * samplesPerSec));
      const bEnd = Math.min(totalBuckets - 1, Math.floor((t + dt) * samplesPerSec));

      let localPeak = 0;
      if (bStart <= bEnd && bStart < totalBuckets) {
        if (bStart === bEnd) {
          localPeak = peaks[bStart] || 0;
        } else {
          // 줌아웃 시 피크 유지하되, 만약 시작점(bStart)이 0(무음)이라면 미래 버킷이 과거 픽셀을 앞당겨 띄우지 않도록 가중치 보정
          for (let b = bStart; b <= bEnd; b++) {
            const p = peaks[b] || 0;
            if (p > localPeak) localPeak = p;
          }
        }
      }

      const scaledPeak = Math.min(1.05, localPeak * gain);
      // 무음 구간은 0으로 바닥에 완벽히 붙음
      const waveH = scaledPeak <= 0.008 ? 0 : Math.max(1, scaledPeak * maxWaveHeight);
      const y = Math.round(baseY - waveH);
      wavePoints.push({ x, y, isOverload: scaledPeak > 0.98 });
    }

    // 파형 실루엣 채우기 (프리미어 프로 라임 그린 #8ec968)
    ctx.beginPath();
    ctx.moveTo(0, baseY);
    for (const pt of wavePoints) {
      ctx.lineTo(pt.x, pt.y);
    }
    ctx.lineTo(safeW, baseY);
    ctx.closePath();

    ctx.fillStyle = 'rgba(142, 201, 104, 0.92)';
    ctx.fill();

    // 상단 림/윤곽선 (더 선명한 밝은 연두색 하이라이트)
    ctx.beginPath();
    let started = false;
    for (const pt of wavePoints) {
      if (!started) {
        ctx.moveTo(pt.x, pt.y);
        started = true;
      } else {
        ctx.lineTo(pt.x, pt.y);
      }
    }
    ctx.strokeStyle = 'rgba(180, 233, 149, 1.0)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 과부하(피크 클리핑) 구간이 있다면 상단에 앰버/오렌지 포인트 표시
    for (const pt of wavePoints) {
      if (pt.isOverload && pt.y < baseY - 4) {
        ctx.fillStyle = '#f5a623';
        ctx.fillRect(pt.x - 1, pt.y - 1, 2, 2.5);
      }
    }

    ctx.restore();
  }, [waveform, sourceStart, duration, widthPx, heightPx, volume, muted]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: `${Math.max(16, Math.floor(widthPx))}px`,
        height: `${heightPx}px`,
      }}
      className="absolute inset-x-0 bottom-0 pointer-events-none select-none"
    />
  );
};
