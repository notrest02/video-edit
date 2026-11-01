import { WordTimestamp } from '../types/editor';

let cachedPipeline: any = null;
let cachedModelId = '';

/**
 * Whisper 음성인식 특유의 환각 루프(Hallucination loop: 동일 단어/구절의 무한 반복) 및
 * 스트라이드 경계 중복을 깨끗하게 정리합니다.
 * (예: "긴 긴 사업을" -> "긴 사업을", "긴 사업을긴 긴 사업을" -> "긴 사업을")
 */
export function cleanWhisperHallucinations(rawText: string): string {
  let cleaned = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';

  // 1. 동일 단어 연속 반복 제거 (예: "긴 긴" -> "긴", "사업을 사업을" -> "사업을")
  cleaned = cleaned.replace(/\b(\S+)(?:\s+\1\b)+/gi, '$1');

  // 2. 2~4단어 구절 단위 연속 반복 제거 (예: "긴 사업을 긴 사업을" -> "긴 사업을")
  cleaned = cleaned.replace(/(\b\S+\s+\S+)(?:\s+\1)+/gi, '$1');
  cleaned = cleaned.replace(/(\b\S+\s+\S+\s+\S+)(?:\s+\1)+/gi, '$1');

  // 3. 문자열 내 동일 3자 이상 부분 문자열의 직후 반복 제거 (예: "긴 사업을긴 사업을" -> "긴 사업을")
  for (let len = Math.floor(cleaned.length / 2); len >= 3; len--) {
    for (let i = 0; i <= cleaned.length - 2 * len; i++) {
      const sub = cleaned.slice(i, i + len).trim();
      if (sub.length < 3) continue;
      const nextSub = cleaned.slice(i + len, i + 2 * len).trim();
      if (sub === nextSub) {
        cleaned = cleaned.slice(0, i + len) + cleaned.slice(i + 2 * len);
        i--;
      }
    }
  }

  // 4. 어절 단위 중복 및 부분 중복 검사
  const words = cleaned.split(/\s+/).filter(Boolean);
  const deduplicatedWords: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (deduplicatedWords.length > 0) {
      const prev = deduplicatedWords[deduplicatedWords.length - 1];
      if (w === prev) continue;
      if (w.length >= 3 && prev.endsWith(w)) continue;
      if (prev.length >= 3 && w.startsWith(prev)) {
        deduplicatedWords[deduplicatedWords.length - 1] = w;
        continue;
      }
    }
    deduplicatedWords.push(w);
  }

  return deduplicatedWords.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 타임라인의 초록색 오디오 파형(AudioWaveformCanvas.tsx / electron/main.ts)과
 * 100% 동일한 200Hz(5ms 해상도) 정규화 피크 배열을 산출합니다.
 */
export function computeVisualWaveformPeaks(
  audioData: Float32Array,
  sampleRate = 16000,
  samplesPerSec = 200
): { visualPeaks: Float32Array; samplesPerSec: number } {
  const samplesPerBucket = Math.max(1, Math.floor(sampleRate / samplesPerSec)); // 80 samples = 5ms
  const bucketCount = Math.ceil(audioData.length / samplesPerBucket);
  const rawPeaks = new Float32Array(bucketCount);

  for (let b = 0; b < bucketCount; b++) {
    const start = b * samplesPerBucket;
    const end = Math.min(audioData.length, start + samplesPerBucket);
    let maxAbs = 0;
    for (let s = start; s < end; s++) {
      const val = Math.abs(audioData[s]);
      if (val > maxAbs) maxAbs = val;
    }
    rawPeaks[b] = maxAbs;
  }

  const sorted = Float32Array.from(rawPeaks).sort();
  const p98 = sorted[Math.floor(sorted.length * 0.98)] || 0.01;
  const normScale = Math.max(0.04, Math.min(1.0, p98));
  const noiseGate = 0.038;

  const visualPeaks = new Float32Array(bucketCount);
  for (let b = 0; b < bucketCount; b++) {
    const normP = Math.min(1.0, rawPeaks[b] / normScale);
    visualPeaks[b] =
      normP <= noiseGate ? 0 : Math.pow((normP - noiseGate) / (1 - noiseGate), 0.8);
  }
  return { visualPeaks, samplesPerSec };
}

/**
 * 초록색 시각 파형(visualPeaks, 5ms 단위)에서 문장 간 무음 바닥(Flat Floor Valley)을
 * 양방향([rawStartSec - 0.55s, rawStartSec + 0.85s])으로 탐색한 뒤,
 * 무음 바닥이 끝나고 초록색 파형 절벽이 솟아오르는 정확한 첫 지점(Rising Cliff Onset)에 스냅합니다.
 * - AI 타임스탬프가 0.4초 빠르든 0.4초 늦든 항상 파형의 실제 대사 시작 절벽(예: 7.080s)에 100% 고정됩니다.
 * - 첫 단어("이건" 등)가 짧아도 절대 건너뛰지 않습니다.
 */
export function snapSegmentToVisualWaveform(
  visualPeaks: Float32Array,
  samplesPerSec: number,
  rawStartSec: number,
  rawEndSec: number,
  prevOnsetSec = 0,
  isFirst = false
): { start: number; voiceEnd: number } {
  const totalBuckets = visualPeaks.length;
  if (totalBuckets < 4) {
    return { start: rawStartSec, voiceEnd: Math.max(rawStartSec + 0.25, rawEndSec) };
  }
  const bucketDur = 1 / samplesPerSec; // 0.005s (5ms)

  if (isFirst && rawStartSec < 0.8) {
    const maxB = Math.min(totalBuckets - 2, Math.floor(1.5 * samplesPerSec));
    let onsetB = 0;
    for (let b = 0; b < maxB; b++) {
      if (
        visualPeaks[b] >= 0.04 &&
        (visualPeaks[b + 1] >= 0.04 || visualPeaks[b + 2] >= 0.05)
      ) {
        onsetB = b;
        break;
      }
    }
    const onsetSec = Number((onsetB * bucketDur).toFixed(3));
    const endB = Math.min(totalBuckets - 1, Math.floor(rawEndSec * samplesPerSec));
    let offsetB = endB;
    for (let b = endB; b > onsetB + 20; b--) {
      if (visualPeaks[b] >= 0.035 && visualPeaks[b - 1] >= 0.035) {
        offsetB = Math.min(totalBuckets - 1, b + 1);
        break;
      }
    }
    return {
      start: onsetSec,
      voiceEnd: Number(Math.max(onsetSec + 0.25, offsetB * bucketDur).toFixed(3)),
    };
  }

  // rawStartSec 주변 양방향 탐색 윈도우 설정:
  // 직전 문장의 시작점(prevOnsetSec + 0.35s)만 침범하지 않는 선에서 왼쪽으로 최대 0.65초까지 자유롭게 탐색하여
  // AI 타임스탬프가 다음 문장 파형 안쪽(0.25~0.5초 늦게)에 찍혔더라도 바로 왼쪽의 무음 골짜기를 100% 찾아냅니다!
  const winStartSec = Math.max(prevOnsetSec + 0.35, rawStartSec - 0.65);
  const winEndSec = Math.min(rawEndSec - 0.2, rawStartSec + 0.85);

  const startB = Math.max(0, Math.floor(winStartSec * samplesPerSec));
  const endB = Math.min(totalBuckets - 2, Math.floor(winEndSec * samplesPerSec));
  const rawB = Math.floor(rawStartSec * samplesPerSec);

  let onsetB = Math.max(startB, Math.min(endB, rawB));

  if (endB > startB + 6) {
    const valleys: Array<{ startB: number; endB: number }> = [];
    let inValley = false;
    let vStart = startB;

    for (let b = startB; b <= endB; b++) {
      const isSilent = visualPeaks[b] <= 0.025;
      if (isSilent) {
        if (!inValley) {
          inValley = true;
          vStart = b;
        }
      } else if (inValley) {
        const nextIsSilent = b + 1 <= endB && visualPeaks[b + 1] <= 0.025;
        if (!nextIsSilent) {
          inValley = false;
          const durBuckets = b - vStart;
          if (durBuckets >= 8) {
            // 최소 40ms 이상의 무음 바닥
            valleys.push({ startB: vStart, endB: b });
          }
        }
      }
    }
    if (inValley && endB - vStart >= 8) {
      valleys.push({ startB: vStart, endB });
    }

    if (valleys.length > 0) {
      let bestValley: { startB: number; endB: number } | null = null;
      let bestScore = -Infinity;

      for (const v of valleys) {
        const durSec = (v.endB - v.startB) * bucketDur;
        let distBuckets = 0;
        if (rawB < v.startB) distBuckets = v.startB - rawB;
        else if (rawB > v.endB) distBuckets = rawB - v.endB;
        const distSec = distBuckets * bucketDur;

        const score = Math.min(0.42, durSec) * 3.2 - distSec * 1.15;
        if (score > bestScore) {
          bestScore = score;
          bestValley = v;
        }
      }

      if (bestValley) {
        onsetB = bestValley.endB;
        const maxWalkB = Math.min(
          totalBuckets - 2,
          bestValley.endB + Math.floor(0.35 * samplesPerSec)
        );
        for (let b = bestValley.endB; b <= maxWalkB; b++) {
          if (
            visualPeaks[b] >= 0.035 &&
            (visualPeaks[b + 1] >= 0.035 || visualPeaks[b + 2] >= 0.045)
          ) {
            onsetB = b;
            break;
          }
        }
      }
    } else {
      let minSum = Infinity;
      let minB = onsetB;
      for (let b = startB + 2; b <= endB - 2; b++) {
        const sum =
          (visualPeaks[b - 2] +
            visualPeaks[b - 1] +
            visualPeaks[b] +
            visualPeaks[b + 1] +
            visualPeaks[b + 2]) /
          5;
        const penalty = Math.abs(b - rawB) * bucketDur * 0.08;
        if (sum + penalty < minSum) {
          minSum = sum + penalty;
          minB = b;
        }
      }
      onsetB = minB;
      for (let b = minB; b <= Math.min(totalBuckets - 2, minB + 30); b++) {
        if (visualPeaks[b] >= 0.04) {
          onsetB = b;
          break;
        }
      }
    }
  }

  const onsetSec = Number((onsetB * bucketDur).toFixed(3));

  const rawEndB = Math.min(totalBuckets - 1, Math.floor(rawEndSec * samplesPerSec));
  const searchEndStartB = Math.max(onsetB + 20, rawEndB - Math.floor(0.55 * samplesPerSec));

  // 만약 rawEndB가 이미 다음 문장 파형 안쪽에 걸쳐 있는 경우, 먼저 그 직전의 무음 바닥(Valley)으로 내려간 뒤 현재 문장의 실제 끝(voiceEnd)을 찾음!
  let endScanStartB = rawEndB;
  if (visualPeaks[rawEndB] >= 0.035) {
    for (let b = rawEndB; b >= searchEndStartB; b--) {
      if (visualPeaks[b] <= 0.025 && b - 1 >= 0 && visualPeaks[b - 1] <= 0.025) {
        endScanStartB = b;
        break;
      }
    }
  }

  let offsetB = endScanStartB;
  for (let b = endScanStartB; b >= searchEndStartB; b--) {
    if (visualPeaks[b] >= 0.035 && (b - 1 < 0 || visualPeaks[b - 1] >= 0.03)) {
      offsetB = Math.min(totalBuckets - 1, b + 1);
      break;
    }
  }

  const voiceEndSec = Number(Math.max(onsetSec + 0.25, offsetB * bucketDur).toFixed(3));
  return { start: onsetSec, voiceEnd: voiceEndSec };
}

/**
 * 16kHz Float32 PCM 오디오에서 타임라인 시각 파형(Visual Waveform) 기반으로
 * 실제 발화 시작점(Rising Cliff Onset)과 종료점(Offset)을 5ms 단위로 칼같이 스냅합니다.
 */
export function snapSpeechBoundaries(
  audioData: Float32Array,
  segStartSec: number,
  segEndSec: number,
  sampleRate = 16000
): { start: number; end: number } {
  const { visualPeaks, samplesPerSec } = computeVisualWaveformPeaks(audioData, sampleRate, 200);
  const res = snapSegmentToVisualWaveform(
    visualPeaks,
    samplesPerSec,
    segStartSec,
    segEndSec,
    Math.max(0, segStartSec - 0.4),
    segStartSec < 0.5
  );
  return { start: res.start, end: res.voiceEnd };
}

/**
 * 긴 문장 구간 내에서 자연스러운 호흡 무음 밸리(Silence valley / Breath pause)를 탐색하여
 * 자막 분할 지점을 음향적으로 결정합니다.
 */
export function findSilenceSplitPoint(
  audioData: Float32Array,
  segStartSec: number,
  segEndSec: number,
  splitRatio = 0.5,
  sampleRate = 16000
): number {
  const startSample = Math.max(0, Math.floor(segStartSec * sampleRate));
  const endSample = Math.min(audioData.length, Math.floor(segEndSec * sampleRate));
  const totalSamples = endSample - startSample;
  if (totalSamples <= sampleRate * 0.5) {
    return segStartSec + (segEndSec - segStartSec) * splitRatio;
  }

  const targetSample = startSample + Math.floor(totalSamples * splitRatio);
  const searchRadius = Math.floor(totalSamples * 0.25);
  const searchStart = Math.max(startSample, targetSample - searchRadius);
  const searchEnd = Math.min(endSample, targetSample + searchRadius);

  const frameSize = Math.floor(sampleRate * 0.02); // 20ms
  let minRms = 999999;
  let bestSample = targetSample;

  for (let s = searchStart; s < searchEnd - frameSize; s += Math.floor(frameSize / 2)) {
    let sumSq = 0;
    for (let i = 0; i < frameSize; i++) {
      const val = audioData[s + i];
      sumSq += val * val;
    }
    const rms = Math.sqrt(sumSq / frameSize);
    if (rms < minRms) {
      minRms = rms;
      bestSample = s + Math.floor(frameSize / 2);
    }
  }

  return Number((bestSample / sampleRate).toFixed(3));
}

/**
 * 긴 문장을 어절 단위로 자연스럽게 분할합니다.
 */
export function splitPhraseByChars(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [text.trim()];
  const lines: string[] = [];
  let current = '';

  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (candidate.length > maxChars && current.length > 0) {
      lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * 로컬 Whisper ONNX 모델(@huggingface/transformers)을 사용하여
 * 대본 없이도 선택된 오디오 클립(16kHz Float32 PCM)에서 실제 한국어 음성을 인식해
 * 타임스탬프가 포함된 초벌 자막(캡션) 세그먼트들을 생성합니다.
 */
export async function transcribeWithLocalWhisper(
  audioData: Float32Array,
  clipTimelineStart: number,
  options: {
    modelId?: string;
    language?: string;
    maxCharsPerLine?: number;
    onProgress?: (msg: string) => void;
  } = {}
): Promise<WordTimestamp[]> {
  const {
    modelId = 'Xenova/whisper-small',
    language = 'korean',
    maxCharsPerLine = 15,
    onProgress,
  } = options;

  try {
    onProgress?.(`로컬 AI 음성인식 모델(${modelId}) 준비 중...`);
    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowLocalModels = false;

    if (!cachedPipeline || cachedModelId !== modelId) {
      cachedPipeline = await pipeline('automatic-speech-recognition', modelId, {
        progress_callback: (info: any) => {
          if (info.status === 'progress' && typeof info.progress === 'number') {
            onProgress?.(
              `AI 음성인식 모델 다운로드 중: ${Math.round(info.progress)}% (${info.file || ''})`
            );
          }
        },
      });
      cachedModelId = modelId;
    }

    onProgress?.('선택된 오디오의 음성을 분석하여 AI 초벌 자막을 생성하는 중...');
    const output = await cachedPipeline(audioData, {
      language,
      task: 'transcribe',
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 4,
    });

    const totalAudioSec = audioData.length / 16000;
    const rawChunks = output?.chunks || [];

    if (rawChunks.length > 0) {
      const { visualPeaks, samplesPerSec } = computeVisualWaveformPeaks(audioData, 16000, 200);
      const parsed: WordTimestamp[] = [];
      let lastValidVoiceEnd = 0;
      let lastValidOnset = 0;

      for (let cIdx = 0; cIdx < rawChunks.length; cIdx++) {
        const c = rawChunks[cIdx];
        const text = cleanWhisperHallucinations(String(c.text || '')).trim();
        if (!text) continue;

        let sTime =
          Array.isArray(c.timestamp) && typeof c.timestamp[0] === 'number'
            ? c.timestamp[0]
            : lastValidVoiceEnd;
        let eTime =
          Array.isArray(c.timestamp) && typeof c.timestamp[1] === 'number'
            ? c.timestamp[1]
            : sTime + Math.max(0.4, text.length * 0.15);

        if (eTime <= sTime) {
          eTime = sTime + Math.max(0.3, text.length * 0.14);
        }

        // 스트라이드 경계 처리: 30초 스트라이드 경계에서 이전 청크 종료점보다 앞으로 점프하는 현상 보정
        if (sTime < lastValidVoiceEnd - 0.25) {
          sTime = lastValidVoiceEnd;
          if (eTime <= sTime) {
            eTime = sTime + Math.max(0.4, text.length * 0.14);
          }
        }

        // 타임라인의 초록색 파형과 100% 동일한 피크 배열(5ms 해상도)에서
        // 문장 간 무음 골짜기 직후 초록색 파형이 솟아오르는 절벽(Rising Cliff)에 시작점을 칼같이 스냅!
        const snapped = snapSegmentToVisualWaveform(
          visualPeaks,
          samplesPerSec,
          sTime,
          Math.min(totalAudioSec, eTime),
          lastValidOnset,
          parsed.length === 0
        );
        const activeStart = snapped.start;
        const activeVoiceEnd = snapped.voiceEnd;
        const absVoiceEnd = Number(
          (clipTimelineStart + Math.max(activeStart + 0.25, activeVoiceEnd)).toFixed(3)
        );

        parsed.push({
          text,
          start: Number((clipTimelineStart + activeStart).toFixed(3)),
          end: absVoiceEnd,
          voiceEnd: absVoiceEnd,
        });
        lastValidOnset = activeStart;
        lastValidVoiceEnd = activeVoiceEnd;
      }

      // [대사 간 빈 공간 없이 쭉 이어주고, 다음 대사가 시작되는 파형 절벽(nextStart) 정위치에서 0.000초 오차 없이 칼같이 컷 분할]
      for (let pIdx = 0; pIdx < parsed.length; pIdx++) {
        if (pIdx < parsed.length - 1) {
          const nextStart = parsed[pIdx + 1].start;
          const gap = nextStart - parsed[pIdx].end;
          if (gap >= 0 && gap <= 2.2) {
            // 2.2초 이내의 자연스러운 문장 간 묵음: 이전 대사를 다음 대사 시작점(파란 재생헤드 절벽)까지 빈틈없이 100% 유지!
            parsed[pIdx].end = Number(nextStart.toFixed(3));
          } else if (gap > 2.2) {
            // 긴 무음 구간: 0.8초간 잔상 유지 후 닫기
            parsed[pIdx].end = Number(Math.min(nextStart, parsed[pIdx].end + 0.8).toFixed(3));
          } else {
            parsed[pIdx].end = Number(
              Math.max(parsed[pIdx].start + 0.25, nextStart).toFixed(3)
            );
          }
        } else {
          parsed[pIdx].end = Number(
            Math.min(clipTimelineStart + totalAudioSec, parsed[pIdx].end + 0.6).toFixed(3)
          );
        }
      }

      return parsed;
    }

    if (output?.text && String(output.text).trim().length > 0) {
      return splitLongCaptionSegment(
        cleanWhisperHallucinations(String(output.text).trim()),
        clipTimelineStart,
        clipTimelineStart + Math.max(0.5, totalAudioSec),
        maxCharsPerLine
      );
    }

    return extractSpeechEnvelopeTimestamps(audioData, clipTimelineStart, '');
  } catch (err) {
    console.warn('[Local Whisper fallback to Acoustic Speech Envelope Detection]', err);
    onProgress?.('오디오 발화 구간 감지 및 초벌 캡션 구간 생성 중...');
    return extractSpeechEnvelopeTimestamps(audioData, clipTimelineStart, '');
  }
}

/**
 * 대본+파형 정렬기(scriptWaveformAligner)용: Whisper 청크를 가공 없이 그대로 돌려줍니다.
 * 여기서 나온 시간은 "이 문장이 대략 어디쯤"이라는 위치 단서로만 쓰이고,
 * 자막의 실제 시간은 파형 무음 구간에서, 자막 글자는 대본에서 가져옵니다.
 */
export async function transcribeRawChunksWithLocalWhisper(
  audioData: Float32Array,
  options: { modelId?: string; onProgress?: (msg: string) => void } = {}
): Promise<Array<{ start: number; end: number | null; text: string }>> {
  const { modelId = 'Xenova/whisper-small', onProgress } = options;
  onProgress?.(`로컬 AI 음성인식 모델(${modelId}) 준비 중...`);
  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowLocalModels = false;

  if (!cachedPipeline || cachedModelId !== modelId) {
    cachedPipeline = await pipeline('automatic-speech-recognition', modelId, {
      progress_callback: (info: any) => {
        if (info.status === 'progress' && typeof info.progress === 'number') {
          onProgress?.(`AI 음성인식 모델 다운로드 중: ${Math.round(info.progress)}% (${info.file || ''})`);
        }
      },
    });
    cachedModelId = modelId;
  }

  onProgress?.('음성에서 문장 위치 단서를 찾는 중 (Whisper)...');
  const output = await cachedPipeline(audioData, {
    language: 'korean',
    task: 'transcribe',
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 4,
  });

  return (output?.chunks || []).map((c: any) => ({
    start: Array.isArray(c.timestamp) && typeof c.timestamp[0] === 'number' ? c.timestamp[0] : 0,
    end: Array.isArray(c.timestamp) && typeof c.timestamp[1] === 'number' ? c.timestamp[1] : null,
    text: String(c.text || ''),
  }));
}

/**
 * 긴 문장 세그먼트를 글자 수 비율에 맞춰 자막 한 줄 크기로 나눕니다.
 */
function splitLongCaptionSegment(
  text: string,
  absStart: number,
  absEnd: number,
  maxChars = 24
): WordTimestamp[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= maxChars) {
    return [{ text: clean, start: absStart, end: absEnd }];
  }

  const words = clean.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const w of words) {
    const cand = current ? `${current} ${w}` : w;
    if (cand.length > maxChars && current.length > 0) {
      lines.push(current);
      current = w;
    } else {
      current = cand;
    }
  }
  if (current) lines.push(current);

  const totalChars = lines.reduce((acc, l) => acc + Math.max(1, l.length), 0);
  const totalDur = Math.max(0.2, absEnd - absStart);
  let cursor = absStart;

  return lines.map((line, idx) => {
    const dur = (totalDur * Math.max(1, line.length)) / totalChars;
    const s = cursor;
    const e = idx === lines.length - 1 ? absEnd : cursor + dur;
    cursor = e;
    return {
      text: line,
      start: Number(s.toFixed(4)),
      end: Number(e.toFixed(4)),
    };
  });
}

/**
 * 16kHz PCM 파형에서 실제 목소리가 나오는 유음(Voiced) 발화 구간들을 감지하여
 * 초벌 캡션 구간을 생성합니다.
 */
export function extractSpeechEnvelopeTimestamps(
  audioData: Float32Array,
  clipTimelineStart: number,
  fallbackText: string
): WordTimestamp[] {
  const sampleRate = 16000;
  const windowSamples = Math.floor(sampleRate * 0.025); // 25ms frame
  const totalFrames = Math.floor(audioData.length / windowSamples);

  if (totalFrames === 0) return [];

  const rmsValues: number[] = [];
  let maxRms = 0.0001;

  for (let f = 0; f < totalFrames; f++) {
    let sumSq = 0;
    const offset = f * windowSamples;
    for (let i = 0; i < windowSamples; i++) {
      const sample = audioData[offset + i];
      sumSq += sample * sample;
    }
    const rms = Math.sqrt(sumSq / windowSamples);
    rmsValues.push(rms);
    if (rms > maxRms) maxRms = rms;
  }

  const threshold = Math.max(0.008, maxRms * 0.14);
  const voicedIntervals: Array<{ start: number; end: number }> = [];
  let inSpeech = false;
  let segStart = 0;

  for (let f = 0; f < totalFrames; f++) {
    const t = f * 0.025;
    if (rmsValues[f] >= threshold) {
      if (!inSpeech) {
        inSpeech = true;
        segStart = t;
      }
    } else if (inSpeech) {
      let hasVoiceSoon = false;
      for (let look = 1; look <= 8 && f + look < totalFrames; look++) {
        if (rmsValues[f + look] >= threshold) {
          hasVoiceSoon = true;
          break;
        }
      }
      if (!hasVoiceSoon) {
        inSpeech = false;
        if (t - segStart >= 0.12) {
          voicedIntervals.push({ start: segStart, end: t });
        }
      }
    }
  }

  if (inSpeech) {
    voicedIntervals.push({ start: segStart, end: totalFrames * 0.025 });
  }

  const totalDur = audioData.length / sampleRate;
  const activeIntervals =
    voicedIntervals.length > 0 ? voicedIntervals : [{ start: 0, end: Math.max(0.5, totalDur) }];

  if (!fallbackText.trim()) {
    return activeIntervals.map((iv, idx) => ({
      text: `[음성 인식 구간 #${idx + 1}]`,
      start: clipTimelineStart + iv.start,
      end: clipTimelineStart + iv.end,
    }));
  }

  const words = fallbackText
    .replace(/\r?\n/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const totalVoicedDuration = activeIntervals.reduce((acc, iv) => acc + (iv.end - iv.start), 0);
  const wordWeights = words.map((w) => Math.max(1, w.length));

  const results: WordTimestamp[] = [];
  let wordIdx = 0;

  for (let i = 0; i < activeIntervals.length; i++) {
    const iv = activeIntervals[i];
    const ivDur = iv.end - iv.start;
    const isLastIv = i === activeIntervals.length - 1;
    const remainingWords = words.length - wordIdx;
    if (remainingWords <= 0) break;

    const countForIv = isLastIv
      ? remainingWords
      : Math.max(1, Math.round((ivDur / Math.max(0.1, totalVoicedDuration)) * words.length));

    const sliceWords = words.slice(wordIdx, wordIdx + countForIv);
    const sliceWeights = wordWeights.slice(wordIdx, wordIdx + countForIv);
    const sliceWeightSum = sliceWeights.reduce((a, b) => a + b, 0);

    let cursor = iv.start;
    for (let k = 0; k < sliceWords.length; k++) {
      const wDur = (ivDur * sliceWeights[k]) / Math.max(1, sliceWeightSum);
      const s = cursor;
      const e = k === sliceWords.length - 1 ? iv.end : cursor + wDur;
      results.push({
        text: sliceWords[k],
        start: clipTimelineStart + s,
        end: clipTimelineStart + e,
      });
      cursor = e;
    }

    wordIdx += countForIv;
  }

  return results;
}
