/**
 * Waveform-First Physical VAD & Acoustic Valley Subtitle Engine
 *
 * 1) 16kHz PCM 오디오 파형의 물리적 에너지(RMS)를 분석하여 실제 성대 발화 시작점(Onset)을 0.01초 단위로 검출
 * 2) 호흡음/들숨(1프레임 스파이크 및 저에너지 구간)을 철저히 배제하여 대사 전 자막 조기 노출 원천 차단
 * 3) 한 호흡 블록 내 여러 줄 자막 분할 시에도 글자 비율 근처의 실제 음향 무음 밸리(Valley)와 다음 음절 Onset에 정밀 스냅
 * 4) 문장 간 2.2초 이내의 묵음은 이전 자막을 다음 대사 시작 1프레임 직전까지 유지(Gap-Bridging)
 */

import { computePhoneticSimilarity } from './scriptAligner';

export interface PhysicalVoicedBlock {
  index: number;
  relStart: number;    // 클립 내 상대 시작 초 (0부터 시작)
  relVoiceEnd: number; // 클립 내 실제 발화 종료 상대 초
  start: number;       // 타임라인 절대 시작 초 (성대 발화 Onset)
  end: number;         // 타임라인 절대 종료 초 (Gap-Bridging 적용 후)
  voiceEnd: number;    // 타임라인 실제 소리 종료 초
  duration: number;    // 실제 발화 지속 시간 (voiceEnd - start)
}

export interface AlignedWaveformCaption {
  text: string;
  start: number;
  end: number;
}

/**
 * 16kHz PCM 오디오 데이터에서 실제 사람이 말하는 물리적 음성 블록(Voiced Blocks)을 추출합니다.
 */
export function extractPhysicalVoicedBlocks(
  pcm: Float32Array,
  clipTimelineStart = 0,
  options: {
    fps?: number;
    minPhraseDurationSec?: number;
    maxPhraseDurationSec?: number;
    minSilenceSplitSec?: number;
    maxGapBridgeSec?: number;
  } = {}
): PhysicalVoicedBlock[] {
  const {
    fps = 30,
    minPhraseDurationSec = 0.28,
    maxPhraseDurationSec = 5.2,
    minSilenceSplitSec = 0.22, // 0.22초 이상의 묵음/호흡 구간에서 문장 블록 분리
    maxGapBridgeSec = 2.2,     // 2.2초 이내의 공백은 다음 대사 직전까지 자막 유지
  } = options;

  const sampleRate = 16000;
  const frameSec = 1 / Math.max(1, fps);
  const totalAudioSec = pcm.length / sampleRate;

  // 15ms frame (240 samples) 단위 RMS 계산
  const windowSamples = Math.floor(sampleRate * 0.015);
  const totalFrames = Math.floor(pcm.length / windowSamples);
  if (totalFrames < 6) return [];

  const rmsList = new Float32Array(totalFrames);
  let maxRms = 0.0001;

  // 상위 퍼센타일 기반 안정적 maxRms 산출 (단발성 파열음 피크 왜곡 방지)
  const sortedRmsSample: number[] = [];
  for (let f = 0; f < totalFrames; f++) {
    let sumSq = 0;
    const base = f * windowSamples;
    for (let i = 0; i < windowSamples; i++) {
      const s = pcm[base + i];
      sumSq += s * s;
    }
    const val = Math.sqrt(sumSq / windowSamples);
    rmsList[f] = val;
    if (val > 0.005) sortedRmsSample.push(val);
    if (val > maxRms) maxRms = val;
  }

  sortedRmsSample.sort((a, b) => a - b);
  const p90Rms =
    sortedRmsSample.length > 10
      ? sortedRmsSample[Math.floor(sortedRmsSample.length * 0.9)]
      : maxRms;

  // 성대 발화 시작 임계값: 들숨/숨소리(0.01~0.035)를 확실히 건너뛰고 실제 목소리만 포착
  const voiceOnsetThreshold = Math.max(0.038, p90Rms * 0.24);
  // 발화 유지 임계값: 호흡 구간에서 확실히 끊어주도록 설정
  const voiceSubsideThreshold = Math.max(0.022, p90Rms * 0.12);

  const silenceMinFrames = Math.max(10, Math.floor(minSilenceSplitSec / 0.015));

  const rawSegments: Array<{ start: number; end: number }> = [];
  let inVoice = false;
  let phraseStartFrame = 0;
  let silenceFramesCounter = 0;
  let lastVoiceFrame = 0;

  for (let f = 0; f < totalFrames; f++) {
    const val = rmsList[f];

    if (!inVoice) {
      // 실제 발화 시작 판정: 최소 2연속 프레임(30ms) 이상 임계값을 넘어야 성대 발화로 인정 (일시적 입소리/숨소리 노이즈 차단)
      const nextVal = f + 1 < totalFrames ? rmsList[f + 1] : val;
      if (val >= voiceOnsetThreshold && nextVal >= voiceSubsideThreshold) {
        inVoice = true;
        phraseStartFrame = f;
        silenceFramesCounter = 0;
        lastVoiceFrame = f;
      }
    } else {
      if (val >= voiceSubsideThreshold) {
        silenceFramesCounter = 0;
        lastVoiceFrame = f;
      } else {
        silenceFramesCounter++;
        if (silenceFramesCounter >= silenceMinFrames) {
          const s = (phraseStartFrame * windowSamples) / sampleRate;
          const e = (Math.min(totalFrames - 1, lastVoiceFrame + 1) * windowSamples) / sampleRate;
          if (e - s >= minPhraseDurationSec) {
            rawSegments.push({ start: s, end: e });
          }
          inVoice = false;
          silenceFramesCounter = 0;
        }
      }
    }
  }

  if (inVoice) {
    const s = (phraseStartFrame * windowSamples) / sampleRate;
    const e = (Math.min(totalFrames - 1, lastVoiceFrame + 1) * windowSamples) / sampleRate;
    if (e - s >= minPhraseDurationSec) {
      rawSegments.push({ start: s, end: e });
    }
  }

  if (rawSegments.length === 0) {
    return [
      {
        index: 0,
        relStart: 0,
        relVoiceEnd: totalAudioSec,
        start: clipTimelineStart,
        end: clipTimelineStart + totalAudioSec,
        voiceEnd: clipTimelineStart + totalAudioSec,
        duration: totalAudioSec,
      },
    ];
  }

  // 너무 긴 단일 발화 블록(5.2초 초과)은 내부의 가장 깊은 호흡 밸리(Valley)에서 분할하여 자연스러운 호흡 단위 유지
  const refinedSegments: Array<{ start: number; end: number }> = [];
  for (const seg of rawSegments) {
    const queue = [seg];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const curDur = cur.end - cur.start;
      if (curDur <= maxPhraseDurationSec) {
        refinedSegments.push(cur);
      } else {
        const splitPt = findBestAcousticValleyWithOnset(
          rmsList,
          cur.start,
          cur.end,
          0.5,
          windowSamples,
          sampleRate,
          voiceOnsetThreshold
        );
        if (splitPt.valleyEnd > cur.start + 0.6 && cur.end - splitPt.nextOnset > 0.6) {
          queue.unshift(
            { start: cur.start, end: splitPt.valleyEnd },
            { start: splitPt.nextOnset, end: cur.end }
          );
        } else {
          refinedSegments.push(cur);
        }
      }
    }
  }

  // Gap-Bridging 적용
  const results: PhysicalVoicedBlock[] = [];
  for (let i = 0; i < refinedSegments.length; i++) {
    const cur = refinedSegments[i];
    const absStart = Number((clipTimelineStart + cur.start).toFixed(3));
    const absVoiceEnd = Number((clipTimelineStart + cur.end).toFixed(3));
    let absEnd = absVoiceEnd;

    if (i < refinedSegments.length - 1) {
      const nextAbsStart = Number((clipTimelineStart + refinedSegments[i + 1].start).toFixed(3));
      const gap = nextAbsStart - absVoiceEnd;

      if (gap >= 0 && gap <= maxGapBridgeSec) {
        absEnd = Number((nextAbsStart - frameSec).toFixed(3));
      } else if (gap > maxGapBridgeSec) {
        absEnd = Number(Math.min(nextAbsStart - frameSec, absVoiceEnd + 0.8).toFixed(3));
      } else {
        absEnd = Number(Math.max(absStart + frameSec * 2, nextAbsStart - frameSec).toFixed(3));
      }
    } else {
      absEnd = Number(Math.min(clipTimelineStart + totalAudioSec, absVoiceEnd + 0.8).toFixed(3));
    }

    results.push({
      index: i,
      relStart: Number(cur.start.toFixed(3)),
      relVoiceEnd: Number(cur.end.toFixed(3)),
      start: absStart,
      end: Math.max(absStart + frameSec * 3, absEnd),
      voiceEnd: absVoiceEnd,
      duration: Number(Math.max(0.2, cur.end - cur.start).toFixed(3)),
    });
  }

  return results;
}

/**
 * 구간 [startSec, endSec] 내부의 targetRatio(0~1) 부근에서
 * 가장 소리가 작아지는 호흡 밸리(Valley)의 끝점과, 그 직후 다음 음절이 실제로 터져 나오는 Onset 시점을 찾습니다.
 */
function findBestAcousticValleyWithOnset(
  rmsList: Float32Array,
  startSec: number,
  endSec: number,
  targetRatio: number,
  windowSamples: number,
  sampleRate: number,
  voiceOnsetThreshold: number
): { valleyEnd: number; nextOnset: number } {
  const startF = Math.max(0, Math.floor((startSec * sampleRate) / windowSamples));
  const endF = Math.min(rmsList.length - 1, Math.floor((endSec * sampleRate) / windowSamples));
  const spanF = endF - startF;

  if (spanF < 8) {
    const mid = startSec + (endSec - startSec) * targetRatio;
    return { valleyEnd: mid, nextOnset: mid };
  }

  const targetF = startF + Math.floor(spanF * Math.max(0.18, Math.min(0.82, targetRatio)));
  const searchRadius = Math.max(4, Math.floor(spanF * 0.22));
  const minF = Math.max(startF + 3, targetF - searchRadius);
  const maxF = Math.min(endF - 3, targetF + searchRadius);

  let bestF = targetF;
  let bestScore = Infinity;

  for (let f = minF; f <= maxF; f++) {
    // 3프레임 평균 에너지 + 목표 비율 거리 페널티
    const localRms = (rmsList[f - 1] + rmsList[f] + rmsList[f + 1]) / 3;
    const distPenalty = (Math.abs(f - targetF) / Math.max(1, searchRadius)) * 0.015;
    const score = localRms + distPenalty;
    if (score < bestScore) {
      bestScore = score;
      bestF = f;
    }
  }

  // bestF(무음 골짜기) 이후 실제로 다음 단어 목소리가 다시 올라오는 Onset 프레임 탐색
  let onsetF = bestF;
  const maxOnsetSearchF = Math.min(endF - 2, bestF + Math.floor(0.45 / 0.015));
  for (let f = bestF; f <= maxOnsetSearchF; f++) {
    if (rmsList[f] >= voiceOnsetThreshold * 0.75) {
      onsetF = f;
      break;
    }
  }

  const valleyEnd = (bestF * windowSamples) / sampleRate;
  const nextOnset = (onsetF * windowSamples) / sampleRate;
  return {
    valleyEnd: Number(valleyEnd.toFixed(3)),
    nextOnset: Number(Math.max(valleyEnd, nextOnset).toFixed(3)),
  };
}

/**
 * 단일 물리 블록 내에 여러 줄의 자막(subLines)이 배정된 경우,
 * 글자 수 비율 위치 주변의 실제 파형 무음 밸리(Valley)와 다음 단어 Onset을 찾아 정밀 분할합니다.
 */
export function splitBlockIntoSubCaptionsAtValleys(
  pcm: Float32Array,
  block: PhysicalVoicedBlock,
  clipTimelineStart: number,
  subLines: string[],
  fps = 30
): AlignedWaveformCaption[] {
  const cleanLines = subLines.map((l) => l.trim()).filter(Boolean);
  if (cleanLines.length === 0) return [];
  if (cleanLines.length === 1) {
    return [{ text: cleanLines[0], start: block.start, end: block.end }];
  }

  const sampleRate = 16000;
  const frameSec = 1 / Math.max(1, fps);
  const windowSamples = Math.floor(sampleRate * 0.015);
  const totalFrames = Math.floor(pcm.length / windowSamples);
  const rmsList = new Float32Array(totalFrames);
  let maxRms = 0.0001;

  for (let f = 0; f < totalFrames; f++) {
    let sumSq = 0;
    const base = f * windowSamples;
    for (let i = 0; i < windowSamples; i++) {
      const s = pcm[base + i];
      sumSq += s * s;
    }
    const val = Math.sqrt(sumSq / windowSamples);
    rmsList[f] = val;
    if (val > maxRms) maxRms = val;
  }

  const voiceOnsetThreshold = Math.max(0.035, maxRms * 0.20);
  const results: AlignedWaveformCaption[] = [];

  let curRelStart = block.relStart;
  const relEnd = block.relVoiceEnd;

  for (let i = 0; i < cleanLines.length; i++) {
    const isLast = i === cleanLines.length - 1;
    if (isLast) {
      results.push({
        text: cleanLines[i],
        start: Number((clipTimelineStart + curRelStart).toFixed(3)),
        end: block.end,
      });
      break;
    }

    const remainingLines = cleanLines.slice(i);
    const totalRemChars = remainingLines.reduce((acc, l) => acc + Math.max(1, l.length), 0);
    const ratio = Math.max(1, cleanLines[i].length) / Math.max(1, totalRemChars);

    const splitPt = findBestAcousticValleyWithOnset(
      rmsList,
      curRelStart,
      relEnd,
      ratio,
      windowSamples,
      sampleRate,
      voiceOnsetThreshold
    );

    const nextAbsStart = Number((clipTimelineStart + splitPt.nextOnset).toFixed(3));
    const curAbsStart = Number((clipTimelineStart + curRelStart).toFixed(3));
    // 다음 줄 시작 1프레임 직전까지 현재 줄을 빈틈없이 유지
    const curAbsEnd = Number(Math.max(curAbsStart + frameSec * 3, nextAbsStart - frameSec).toFixed(3));

    results.push({
      text: cleanLines[i],
      start: curAbsStart,
      end: curAbsEnd,
    });

    curRelStart = splitPt.nextOnset;
  }

  return results;
}

/**
 * 한 블록에 들어갈 텍스트가 maxCharsPerLine보다 길 때 자연스러운 어절 단위로 줄을 나눕니다.
 */
export function wrapTextIntoSubLines(text: string, maxCharsPerLine = 18): string[] {
  const rawLines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const subLines: string[] = [];
  for (const line of rawLines) {
    if (line.length <= maxCharsPerLine + 2) {
      subLines.push(line);
    } else {
      const words = line.split(/\s+/);
      let cur = '';
      for (const w of words) {
        const cand = cur ? `${cur} ${w}` : w;
        if (cand.length > maxCharsPerLine && cur.length > 0) {
          subLines.push(cur);
          cur = w;
        } else {
          cur = cand;
        }
      }
      if (cur) subLines.push(cur);
    }
  }
  return subLines;
}

/**
 * [로컬 모드용 음향 앵커 매칭]
 * 각 물리 파형 블록에서 인식된 초벌 음성 텍스트(blockSttTexts)와 사용자의 원본 대본(scriptText)을
 * 발음 유사도(Phonetic Similarity) 및 동적 계획법(DP)으로 매칭하여 대본 밀림을 원천 차단합니다.
 */
export function alignScriptToPhysicalBlocksWithSttAnchors(
  pcm: Float32Array,
  blocks: PhysicalVoicedBlock[],
  blockSttTexts: string[],
  scriptText: string,
  clipTimelineStart = 0,
  maxCharsPerLine = 18,
  fps = 30
): AlignedWaveformCaption[] {
  if (blocks.length === 0) return [];
  const frameSec = 1 / Math.max(1, fps);

  // 원본 대본이 없으면 각 블록의 STT 텍스트를 그대로 파형 밸리 분할하여 사용
  if (!scriptText || !scriptText.trim()) {
    const rawCaptions: AlignedWaveformCaption[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const stt = (blockSttTexts[i] || '').trim();
      if (!stt) continue;
      const subLines = wrapTextIntoSubLines(stt, maxCharsPerLine);
      rawCaptions.push(
        ...splitBlockIntoSubCaptionsAtValleys(pcm, blocks[i], clipTimelineStart, subLines, fps)
      );
    }
    return bridgeCaptionGaps(rawCaptions, frameSec);
  }

  // 대본을 어절(단어) 배열로 분해하여 각 물리 블록의 STT 텍스트와 음운 유사도 기반 최적 정렬 수행
  const scriptWords = scriptText
    .replace(/\r?\n/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (scriptWords.length === 0) return [];

  const activePairs: Array<{ block: PhysicalVoicedBlock; stt: string }> = [];
  for (let i = 0; i < blocks.length; i++) {
    const stt = (blockSttTexts[i] || '').trim();
    if (stt || blocks.length === 1) {
      activePairs.push({ block: blocks[i], stt });
    }
  }

  if (activePairs.length === 0) return [];

  const B = activePairs.length;
  const W = scriptWords.length;
  let wordCursor = 0;
  const rawCaptions: AlignedWaveformCaption[] = [];

  for (let bIdx = 0; bIdx < B; bIdx++) {
    const { block, stt } = activePairs[bIdx];
    const isLast = bIdx === B - 1;
    const remWords = W - wordCursor;
    if (remWords <= 0) break;

    if (isLast) {
      const lineText = scriptWords.slice(wordCursor).join(' ');
      const subLines = wrapTextIntoSubLines(lineText, maxCharsPerLine);
      rawCaptions.push(
        ...splitBlockIntoSubCaptionsAtValleys(pcm, block, clipTimelineStart, subLines, fps)
      );
      break;
    }

    // 현재 블록의 STT 글자 수 근처에서 발음 유사도가 가장 높은 대본 어절 끝점 탐색
    const targetCharLen = Math.max(4, stt.replace(/\s+/g, '').length);
    let bestEndWord = wordCursor + 1;
    let bestScore = -Infinity;

    const maxSearchWords = Math.min(W - (B - 1 - bIdx), wordCursor + 28);
    for (let endW = wordCursor + 1; endW <= maxSearchWords; endW++) {
      const candidateText = scriptWords.slice(wordCursor, endW).join(' ');
      const candCharLen = candidateText.replace(/\s+/g, '').length;

      const sim = stt ? computePhoneticSimilarity(stt, candidateText) : 0.5;
      const lenDiffRatio = Math.abs(candCharLen - targetCharLen) / Math.max(4, targetCharLen);
      const score = sim * 2.2 - lenDiffRatio * 0.65;

      if (score > bestScore) {
        bestScore = score;
        bestEndWord = endW;
      }
    }

    const matchedText = scriptWords.slice(wordCursor, bestEndWord).join(' ');
    const subLines = wrapTextIntoSubLines(matchedText, maxCharsPerLine);
    rawCaptions.push(
      ...splitBlockIntoSubCaptionsAtValleys(pcm, block, clipTimelineStart, subLines, fps)
    );
    wordCursor = bestEndWord;
  }

  return bridgeCaptionGaps(rawCaptions, frameSec);
}

/**
 * 생성된 자막 클립들 사이의 2.2초 이내 묵음 공백을 다음 대사 시작 정위치(next.start)까지 빈틈없이 이어줍니다.
 */
export function bridgeCaptionGaps(
  captions: AlignedWaveformCaption[],
  frameSec = 1 / 30,
  maxGapSec = 2.2
): AlignedWaveformCaption[] {
  if (captions.length <= 1) return captions;

  const result = captions.map((c) => ({ ...c }));
  for (let i = 0; i < result.length - 1; i++) {
    const cur = result[i];
    const next = result[i + 1];
    const gap = next.start - cur.end;

    if (gap > 0 && gap <= maxGapSec) {
      cur.end = Number(next.start.toFixed(3));
    } else if (cur.end > next.start) {
      cur.end = Number(Math.max(cur.start + frameSec * 2, next.start).toFixed(3));
    }
  }
  return result;
}
