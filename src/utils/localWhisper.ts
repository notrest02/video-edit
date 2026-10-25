import { WordTimestamp } from '../types/editor';

let cachedPipeline: any = null;
let cachedModelId = '';

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
    onProgress?: (msg: string) => void;
  } = {}
): Promise<WordTimestamp[]> {
  const {
    modelId = 'Xenova/whisper-tiny',
    language = 'korean',
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
      stride_length_s: 5,
    });

    const totalAudioSec = audioData.length / 16000;
    const chunks = output?.chunks || [];

    if (chunks.length > 0) {
      const parsed: WordTimestamp[] = [];
      for (const c of chunks) {
        const text = String(c.text || '').trim();
        if (!text) continue;
        const startRel = Array.isArray(c.timestamp) ? (c.timestamp[0] ?? 0) : 0;
        const endRel = Array.isArray(c.timestamp)
          ? (c.timestamp[1] ?? Math.min(totalAudioSec, startRel + 2.2))
          : Math.min(totalAudioSec, startRel + 2.2);

        // 만약 하나의 청크가 너무 길면(예: 28자 초과) 자연스럽게 어절 단위로 분할해 자막 가독성 향상
        const subSegments = splitLongCaptionSegment(
          text,
          clipTimelineStart + startRel,
          clipTimelineStart + Math.max(startRel + 0.3, endRel),
          24
        );
        parsed.push(...subSegments);
      }
      if (parsed.length > 0) {
        return parsed;
      }
    }

    if (output?.text && String(output.text).trim().length > 0) {
      return splitLongCaptionSegment(
        String(output.text).trim(),
        clipTimelineStart,
        clipTimelineStart + Math.max(0.5, totalAudioSec),
        24
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
