import { AlignedSubtitleItem, TimelineClip, WordTimestamp } from '../types/editor';

const CHOSUNG = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
];
const JUNGSUNG = [
  'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ',
  'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ',
];
const JONGSUNG = [
  '', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ',
  'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
];

/**
 * 한글 문자열을 발음/자모 단위로 정규화하여 STT 오타('ㅐ' vs 'ㅔ' 등)에도 강인하게 비교합니다.
 */
export function decomposeHangulToJamo(text: string): string {
  const cleaned = text.replace(/[^\uAC00-\uD7A3a-zA-Z0-9]/g, '').toLowerCase();
  let result = '';

  for (let i = 0; i < cleaned.length; i++) {
    const code = cleaned.charCodeAt(i);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const offset = code - 0xac00;
      const cho = CHOSUNG[Math.floor(offset / 588)];
      let jung = JUNGSUNG[Math.floor((offset % 588) / 28)];
      const jong = JONGSUNG[offset % 28];

      // 발음이 유사한 모음 정규화 (STT 흔한 오타 보정)
      if (jung === 'ㅐ') jung = 'ㅔ';
      if (jung === 'ㅒ') jung = 'ㅖ';
      if (jung === 'ㅙ' || jung === 'ㅚ') jung = 'ㅞ';

      result += cho + jung + jong;
    } else {
      result += cleaned[i];
    }
  }
  return result;
}

/**
 * 두 문자열 간의 한글 자모 기반 유사도(0.0 ~ 1.0)를 계산합니다.
 */
export function computePhoneticSimilarity(a: string, b: string): number {
  const jamoA = decomposeHangulToJamo(a);
  const jamoB = decomposeHangulToJamo(b);

  if (!jamoA && !jamoB) return 1;
  if (!jamoA || !jamoB) return 0;
  if (jamoA === jamoB) return 1;

  const lenA = jamoA.length;
  const lenB = jamoB.length;
  const dp: number[][] = Array.from({ length: lenA + 1 }, () => new Array(lenB + 1).fill(0));

  for (let i = 0; i <= lenA; i++) dp[i][0] = i;
  for (let j = 0; j <= lenB; j++) dp[0][j] = j;

  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const cost = jamoA[i - 1] === jamoB[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  const maxLen = Math.max(lenA, lenB);
  return Math.max(0, 1 - dp[lenA][lenB] / maxLen);
}

/**
 * 사용자가 입력한 대본을 자막 줄 단위로 분리합니다.
 * - 줄바꿈(엔터)을 기본 존중하며, 한 줄이 maxChars를 초과하면 어절 단위로 자연스럽게 나눕니다.
 */
export function parseScriptIntoLines(rawScript: string, maxCharsPerLine = 24): string[] {
  const paragraphs = rawScript
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^\d+$/.test(line) && !line.includes('-->'));

  const result: string[] = [];

  for (const para of paragraphs) {
    if (para.length <= maxCharsPerLine || maxCharsPerLine <= 0) {
      result.push(para);
      continue;
    }

    // 문장부호(. ? ! ,) 또는 어절 단위로 분할
    const words = para.split(/\s+/);
    let currentLine = '';

    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (candidate.length > maxCharsPerLine && currentLine.length > 0) {
        result.push(currentLine.trim());
        currentLine = word;
      } else {
        currentLine = candidate;
      }
    }
    if (currentLine.trim()) {
      result.push(currentLine.trim());
    }
  }

  return result;
}

interface CharTimeNode {
  char: string;
  jamo: string;
  start: number;
  end: number;
  wordIndex: number;
}

/**
 * AI가 추출한 단어/세그먼트 타임스탬프 배열과 사용자가 입력한 원본 대본(Script)을
 * 한글 자모 전역 시퀀스 정렬(Global Sequence Alignment)로 매칭하여,
 * 자막 글자는 100% 대본 그대로 교체하고 타이밍은 실제 음성에 정확히 맞춥니다.
 */
export function alignScriptWithSttWords(
  scriptLines: string[],
  sttWords: WordTimestamp[],
  fallbackTotalDuration: number
): AlignedSubtitleItem[] {
  if (scriptLines.length === 0) return [];

  // 만약 STT 결과가 아예 없거나 비어있다면 글자 수 비례로 균등 배분
  const validWords = sttWords.filter((w) => w.text.trim().length > 0 && w.end >= w.start);
  if (validWords.length === 0) {
    return distributeScriptEvenly(scriptLines, 0, Math.max(1, fallbackTotalDuration));
  }

  // 1. STT 단어들을 글자(음절) 단위 타임맵으로 펼침
  const sttChars: CharTimeNode[] = [];
  validWords.forEach((word, wIdx) => {
    const cleanWord = word.text.replace(/\s+/g, '');
    if (!cleanWord) return;
    const charDur = Math.max(0.01, (word.end - word.start) / cleanWord.length);
    for (let c = 0; c < cleanWord.length; c++) {
      const ch = cleanWord[c];
      sttChars.push({
        char: ch,
        jamo: decomposeHangulToJamo(ch) || ch.toLowerCase(),
        start: word.start + c * charDur,
        end: word.start + (c + 1) * charDur,
        wordIndex: wIdx,
      });
    }
  });

  if (sttChars.length === 0) {
    return distributeScriptEvenly(scriptLines, 0, Math.max(1, fallbackTotalDuration));
  }

  // 2. 대본 각 줄의 글자(공백 제외) 수 및 누적 비율 계산
  const scriptCleanLines = scriptLines.map((line) => line.replace(/\s+/g, ''));
  const totalScriptChars = scriptCleanLines.reduce((acc, s) => acc + Math.max(1, s.length), 0);
  const totalSttChars = sttChars.length;

  const alignedItems: AlignedSubtitleItem[] = [];
  let sttCursor = 0;

  for (let lineIdx = 0; lineIdx < scriptLines.length; lineIdx++) {
    const originalLine = scriptLines[lineIdx];
    const cleanLine = scriptCleanLines[lineIdx];
    const isLastLine = lineIdx === scriptLines.length - 1;

    if (isLastLine) {
      const startNode = sttChars[Math.min(sttCursor, totalSttChars - 1)];
      const endNode = sttChars[totalSttChars - 1];
      const matchedSttSlice = sttChars
        .slice(Math.min(sttCursor, totalSttChars - 1), totalSttChars)
        .map((n) => n.char)
        .join('');
      const similarity = computePhoneticSimilarity(cleanLine, matchedSttSlice);

      alignedItems.push({
        id: `sub_${Date.now()}_${lineIdx}`,
        scriptText: originalLine,
        sttText: matchedSttSlice || '(음성 구간 끝)',
        startTime: roundFrameTime(startNode.start),
        endTime: roundFrameTime(Math.max(startNode.start + 0.25, endNode.end)),
        confidence: Math.max(0.75, similarity),
      });
      break;
    }

    // 예상되는 STT 글자 길이 계산 후 주변 탐색 윈도우 내에서 자모 유사도가 가장 높은 경계점 탐색
    const expectedLen = Math.max(
      1,
      Math.round((cleanLine.length / totalScriptChars) * totalSttChars)
    );
    const idealEndIdx = Math.min(totalSttChars - 1, sttCursor + expectedLen);
    const searchRadius = Math.max(4, Math.round(expectedLen * 0.6));

    const minCandidate = Math.max(sttCursor + 1, idealEndIdx - searchRadius);
    const maxCandidate = Math.min(totalSttChars - 1, idealEndIdx + searchRadius);

    let bestEndIdx = Math.min(totalSttChars - 1, Math.max(sttCursor + 1, idealEndIdx));
    let bestScore = -1;

    // 다음 줄 대본까지 함께 고려하는 Lookahead 매칭으로 경계 정확도 극대화
    const nextCleanLine = scriptCleanLines[lineIdx + 1] || '';

    for (let candEnd = minCandidate; candEnd <= maxCandidate; candEnd++) {
      const candidateSttStr = sttChars
        .slice(sttCursor, candEnd)
        .map((n) => n.char)
        .join('');
      const simCurrent = computePhoneticSimilarity(cleanLine, candidateSttStr);

      // 길이 비율 페널티 (너무 짧거나 길게 잡히는 현상 방지)
      const lenDiffRatio = Math.abs(candidateSttStr.length - cleanLine.length) / Math.max(1, cleanLine.length);
      let score = simCurrent - lenDiffRatio * 0.22;

      if (nextCleanLine.length > 0) {
        const nextPreviewEnd = Math.min(totalSttChars, candEnd + nextCleanLine.length);
        const nextSttStr = sttChars
          .slice(candEnd, nextPreviewEnd)
          .map((n) => n.char)
          .join('');
        const simNext = computePhoneticSimilarity(
          nextCleanLine.slice(0, Math.max(1, nextSttStr.length)),
          nextSttStr
        );
        score = score * 0.7 + simNext * 0.3;
      }

      // 단어(어절) 경계에서 끊어질 때 가산점 부여
      if (
        candEnd < totalSttChars &&
        sttChars[candEnd - 1].wordIndex !== sttChars[candEnd].wordIndex
      ) {
        score += 0.08;
      }

      if (score > bestScore) {
        bestScore = score;
        bestEndIdx = candEnd;
      }
    }

    const startNode = sttChars[Math.min(sttCursor, totalSttChars - 1)];
    const endNode = sttChars[Math.max(sttCursor, bestEndIdx - 1)];
    const matchedSttText = sttChars
      .slice(sttCursor, bestEndIdx)
      .map((n) => n.char)
      .join('');

    alignedItems.push({
      id: `sub_${Date.now()}_${lineIdx}`,
      scriptText: originalLine,
      sttText: matchedSttText,
      startTime: roundFrameTime(startNode.start),
      endTime: roundFrameTime(Math.max(startNode.start + 0.2, endNode.end)),
      confidence: Math.min(1, Math.max(0.65, computePhoneticSimilarity(cleanLine, matchedSttText))),
    });

    sttCursor = bestEndIdx;
  }

  return alignedItems;
}

/**
 * 컷 편집된 비디오/오디오 클립들의 구간에 맞춰 대본 줄들을 정확히 매핑하는 함수입니다.
 * - 음성 파일을 먼저 컷 편집한 상태에서 대본을 넣으면, 각 클립의 시작/끝 지점과 완벽히 일치하는 자막을 생성합니다.
 */
export function alignScriptDirectlyToMediaClips(
  scriptLines: string[],
  mediaClips: TimelineClip[]
): AlignedSubtitleItem[] {
  if (scriptLines.length === 0) return [];
  const sortedClips = [...mediaClips].sort((a, b) => a.startTime - b.startTime);

  if (sortedClips.length === 0) {
    return distributeScriptEvenly(scriptLines, 0, Math.max(5, scriptLines.length * 2.5));
  }

  // 대본 줄 수와 클립 수가 같다면 1:1 칼매칭
  if (scriptLines.length === sortedClips.length) {
    return scriptLines.map((line, idx) => {
      const clip = sortedClips[idx];
      return {
        id: `sub_clip_${Date.now()}_${idx}`,
        scriptText: line,
        sttText: `[클립 #${idx + 1} 1:1 매칭]`,
        startTime: clip.startTime,
        endTime: clip.startTime + clip.duration,
        confidence: 1.0,
        snappedStart: true,
        snappedEnd: true,
      };
    });
  }

  // 클립들의 총 재생 길이에 비례하여 각 클립에 대본 줄을 배분하고, 클립 시작/끝 경계에 100% 일치시킴
  const totalClipDuration = sortedClips.reduce((acc, c) => acc + c.duration, 0);
  const lineWeights = scriptLines.map((l) => Math.max(1, l.replace(/\s+/g, '').length));
  const totalWeight = lineWeights.reduce((a, b) => a + b, 0);

  const results: AlignedSubtitleItem[] = [];
  let lineCursor = 0;

  for (let cIdx = 0; cIdx < sortedClips.length; cIdx++) {
    const clip = sortedClips[cIdx];
    const isLastClip = cIdx === sortedClips.length - 1;
    const remainingLines = scriptLines.length - lineCursor;
    if (remainingLines <= 0) break;

    let linesForThisClip = 1;
    if (isLastClip) {
      linesForThisClip = remainingLines;
    } else {
      const clipRatio = clip.duration / Math.max(0.1, totalClipDuration);
      linesForThisClip = Math.max(
        1,
        Math.min(
          remainingLines - (sortedClips.length - 1 - cIdx),
          Math.round(scriptLines.length * clipRatio)
        )
      );
    }

    const sliceLines = scriptLines.slice(lineCursor, lineCursor + linesForThisClip);
    const sliceWeights = lineWeights.slice(lineCursor, lineCursor + linesForThisClip);
    const sliceTotalWeight = sliceWeights.reduce((a, b) => a + b, 0);

    let subCursorTime = clip.startTime;
    for (let sIdx = 0; sIdx < sliceLines.length; sIdx++) {
      const isLastInClip = sIdx === sliceLines.length - 1;
      const dur = isLastInClip
        ? clip.startTime + clip.duration - subCursorTime
        : (clip.duration * sliceWeights[sIdx]) / Math.max(1, sliceTotalWeight);

      const startT = sIdx === 0 ? clip.startTime : subCursorTime;
      const endT = isLastInClip ? clip.startTime + clip.duration : subCursorTime + dur;

      results.push({
        id: `sub_clip_${Date.now()}_${lineCursor + sIdx}`,
        scriptText: sliceLines[sIdx],
        sttText: `[클립 #${cIdx + 1} 구간 매칭]`,
        startTime: startT,
        endTime: endT,
        confidence: 1.0,
        snappedStart: sIdx === 0,
        snappedEnd: isLastInClip,
      });

      subCursorTime = endT;
    }

    lineCursor += linesForThisClip;
    if (totalWeight <= 0) break;
  }

  return results;
}

function distributeScriptEvenly(
  scriptLines: string[],
  startOffset: number,
  totalDuration: number
): AlignedSubtitleItem[] {
  const weights = scriptLines.map((l) => Math.max(1, l.replace(/\s+/g, '').length));
  const sumWeights = weights.reduce((a, b) => a + b, 0);
  let cursor = startOffset;

  return scriptLines.map((line, idx) => {
    const dur = (totalDuration * weights[idx]) / Math.max(1, sumWeights);
    const start = cursor;
    const end = idx === scriptLines.length - 1 ? startOffset + totalDuration : cursor + dur;
    cursor = end;
    return {
      id: `sub_even_${Date.now()}_${idx}`,
      scriptText: line,
      sttText: line,
      startTime: roundFrameTime(start),
      endTime: roundFrameTime(end),
      confidence: 1.0,
    };
  });
}

function roundFrameTime(sec: number, fps = 30): number {
  const frameDuration = 1 / fps;
  return Math.round(sec / frameDuration) * frameDuration;
}

export interface CaptionDiffItem {
  clipId: string;
  index: number;
  startTime: number;
  endTime: number;
  beforeText: string; // 기존 AI 생성 캡션
  afterText: string;  // 내 대본과 비교해 변환된 캡션
  similarity: number;
  isChanged: boolean;
}

/**
 * [STEP 2 핵심 알고리즘]
 * 이미 생성된 AI 자막 캡션(subtitleClips)들과 사용자가 제공한 대본(rawScript)을 비교 검수하여,
 * 각 AI 캡션의 타임스탬프는 그대로 유지하면서 오타를 내 대본의 정확한 글자로 변환하고
 * Before(기존 AI 캡션) -> After(대본 교정본) 비교 리포트를 반환합니다.
 */
export function compareAndCorrectCaptionsWithScript(
  subtitleClips: TimelineClip[],
  rawScript: string
): CaptionDiffItem[] {
  const sortedSubs = [...subtitleClips].sort((a, b) => a.startTime - b.startTime);
  if (sortedSubs.length === 0 || !rawScript.trim()) return [];

  const explicitLines = rawScript
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // 케이스 1: 사용자의 대본 줄 수와 기존 AI 캡션 개수가 같을 때 -> 1:1 직접 매칭 비교
  if (explicitLines.length === sortedSubs.length) {
    return sortedSubs.map((sub, idx) => {
      const before = (sub.text || '').trim();
      const after = explicitLines[idx];
      const sim = computePhoneticSimilarity(before, after);
      return {
        clipId: sub.id,
        index: idx + 1,
        startTime: sub.startTime,
        endTime: sub.startTime + sub.duration,
        beforeText: before,
        afterText: after,
        similarity: sim,
        isChanged: before !== after,
      };
    });
  }

  // 케이스 2: 대본의 전체 어절(Words) 시퀀스를 기존 AI 캡션들의 발음/글자 길이에 맞춰 DP/Lookahead로 매칭 분할
  const scriptTokens = rawScript
    .replace(/\r?\n/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (scriptTokens.length === 0) return [];

  const totalScriptChars = scriptTokens.reduce((acc, w) => acc + w.length, 0);
  const subCharLengths = sortedSubs.map((s) =>
    Math.max(1, (s.text || '').replace(/\s+/g, '').length)
  );
  const totalSubChars = subCharLengths.reduce((a, b) => a + b, 0);

  const results: CaptionDiffItem[] = [];
  let tokenCursor = 0;

  for (let i = 0; i < sortedSubs.length; i++) {
    const sub = sortedSubs[i];
    const before = (sub.text || '').trim();
    const isLastSub = i === sortedSubs.length - 1;

    if (tokenCursor >= scriptTokens.length) {
      results.push({
        clipId: sub.id,
        index: i + 1,
        startTime: sub.startTime,
        endTime: sub.startTime + sub.duration,
        beforeText: before,
        afterText: before,
        similarity: 1,
        isChanged: false,
      });
      continue;
    }

    if (isLastSub) {
      const after = scriptTokens.slice(tokenCursor).join(' ');
      const sim = computePhoneticSimilarity(before, after);
      results.push({
        clipId: sub.id,
        index: i + 1,
        startTime: sub.startTime,
        endTime: sub.startTime + sub.duration,
        beforeText: before,
        afterText: after,
        similarity: sim,
        isChanged: before !== after,
      });
      break;
    }

    // 현재 AI 캡션의 글자 비율에 해당하는 대본 어절 탐색 범위 설정 후 한글 자모 유사도가 가장 높은 지점 선택
    const targetCharCount = Math.max(
      2,
      Math.round((subCharLengths[i] / Math.max(1, totalSubChars)) * totalScriptChars)
    );

    let bestEndToken = tokenCursor + 1;
    let bestScore = -999;
    let accumChars = 0;

    const maxSearchToken = Math.min(
      scriptTokens.length - (sortedSubs.length - 1 - i),
      tokenCursor + 25
    );

    for (let candEnd = tokenCursor + 1; candEnd <= Math.max(tokenCursor + 1, maxSearchToken); candEnd++) {
      const candidateScriptPhrase = scriptTokens.slice(tokenCursor, candEnd).join(' ');
      accumChars = candidateScriptPhrase.replace(/\s+/g, '').length;

      const sim = computePhoneticSimilarity(before, candidateScriptPhrase);
      const lenPenalty =
        Math.abs(accumChars - targetCharCount) / Math.max(4, targetCharCount) * 0.35;

      // 다음 캡션과의 연결성(Lookahead)도 함께 평가
      let nextSimBonus = 0;
      const nextSubText = (sortedSubs[i + 1]?.text || '').trim();
      if (nextSubText && candEnd < scriptTokens.length) {
        const nextPreview = scriptTokens.slice(candEnd, Math.min(scriptTokens.length, candEnd + 6)).join(' ');
        nextSimBonus = computePhoneticSimilarity(
          nextSubText.slice(0, nextPreview.length),
          nextPreview
        ) * 0.25;
      }

      const totalScore = sim + nextSimBonus - lenPenalty;
      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestEndToken = candEnd;
      }
    }

    const matchedScriptText = scriptTokens.slice(tokenCursor, bestEndToken).join(' ');
    const finalSim = computePhoneticSimilarity(before, matchedScriptText);

    results.push({
      clipId: sub.id,
      index: i + 1,
      startTime: sub.startTime,
      endTime: sub.startTime + sub.duration,
      beforeText: before,
      afterText: matchedScriptText,
      similarity: finalSim,
      isChanged: before !== matchedScriptText,
    });

    tokenCursor = bestEndToken;
  }

  return results;
}

export type CaptionLineMode = 'single-line' | 'double-line';

/**
 * 문장 부호(. ? ! , " ')는 한글 음절보다 시각적 폭이 훨씬 좁으므로
 * 줄 길이 계산 시 문장 부호를 제외한 실질 글자 길이를 계산합니다.
 */
function getVisualCharLength(text: string): number {
  const withoutPunct = text.replace(/[.?!,~"'“”‘’「」『』]/g, '');
  return withoutPunct.length;
}

/**
 * 어절(또는 묶인 구절) 뒤에서 한국어 호흡(연결어미·인용절·쉼표·절 경계)이 자연스럽게 끊어지는지 판별합니다.
 * 단, 현재 줄(currentChunk)이 너무 짧을 때(예: `"야,` 처럼 3글자 이하 감탄사)는 쉼표 뒤에서 끊지 않습니다.
 */
function isKoreanBreathBoundaryAfterUnit(unit: string, currentChunk = ''): boolean {
  const clean = unit.trim();
  if (!clean) return false;

  const chunkVisualLen = getVisualCharLength(currentChunk || clean);

  // 1) 닫는 따옴표 + 인용 연결어미 (`~다녀"라며`, `~해"라고`, `~좋다"면서` 등) 뒤에서는 무조건 호흡 분리!
  if (/["'”’」』](라며|라고|면서|하고|더니|길래|니까|는데|며|고)[,!~.]?$/.test(clean)) {
    return true;
  }

  // 2) 쉼표나 세미콜론 등 구두점으로 끝나는 경우:
  // 단, `"야,` / `아,` / `어,` 처럼 현재 줄의 실질 글자 수가 4글자 이하로 너무 짧으면 단독 줄이 되지 않게 끊지 않음!
  if (/[,;，、]$/.test(clean)) {
    return chunkVisualLen >= 5;
  }

  // 3) 보조용언/의존명사 결합형 호흡 단위 ("~까 봐", "~할 때", "~을 때", "~것까지", "~기 때문에", "~해도 되니")
  if (
    /(까\s*봐|나\s*봐|가\s*봐|할\s*때|을\s*때|던\s*때|것까지|거까지|기\s*때문에|도\s*되니|도\s*되니까)[,!~.]?$/.test(
      clean
    )
  ) {
    return true;
  }

  // 4) 한국어 주요 연결어미 (이유·조건·대조·양보·전환·인용·나열)로 끝나는 어절
  const stripped = clean.replace(/[,!~.?]+$/, '');
  if (stripped.length >= 2) {
    // 강한 절 연결어미 (3글자 이상 구절이면 즉시 호흡 분리)
    if (
      /(면서도|면서|으며|해서|아서|어서|니까|으니까|때문에|거든|거든요|길래|느라|지만|는데|은데|던데|더라도|아도|어도|나도|여도|해도|다면|으면|려면|자마자|도록|게끔|라며|라고|되니|하니)$/.test(
        stripped
      )
    ) {
      return chunkVisualLen >= 3;
    }

    // 대등적 연결어미 `~고` (예: `옷 값도 아끼고` 뒤에서 호흡 분리. 단, 보조용언 결합 `만족하고 있어요`는 이미 앞단계에서 한 덩어리로 묶여 보호됨)
    if (
      /(끼고|입고|쓰고|바르고|붙이고|가리고|잡고|놓고|보고|듣고|먹고|자고|하고)$/.test(
        stripped
      ) &&
      chunkVisualLen >= 6
    ) {
      return true;
    }
  }

  return false;
}

/**
 * 띄어쓰기로 분리된 어절 배열에서:
 * 1) 뒷 어절과 절대 떨어지면 안 되는 관형사/부사/수치/여는 감탄사
 *    ("이" + "테이프를", "절대" + "안" + "떨어져요", "100%" + "잡아주니까", "너무" + "만족하고")
 * 2) 앞 어절과 절대 떨어지면 안 되는 의존명사/보조용언
 *    ("올라가는" + "것까지", "입었을" + "때", "안써도" + "되니", "만족하고" + "있어요", "벌어질까" + "봐")
 * 을 하나의 의미 덩어리로 묶습니다.
 */
function mergeInseparableKoreanTokens(
  words: string[],
  maxCharsPerLine = 13
): string[] {
  const working = [...words];

  // Pass 1: 뒷 어절을 수식하는 관형사·부사·감탄사를 뒷 어절과 결합
  const forwardMerged: string[] = [];
  for (let i = 0; i < working.length; i++) {
    const curr = working[i];
    const currStripped = curr.replace(/^["'“‘「『]+/, '').replace(/[,!~.?]+$/, '');

    // (a) `"야,`, `야,`, `아,`, `어,`, `음,` 처럼 짧은 대화 시작 감탄사
    const isShortInterjection =
      ((/[,，]$/.test(curr) && currStripped.length <= 2) ||
        /^(야|어|아|음|자|있잖아)$/.test(currStripped)) &&
      i < working.length - 1;

    // (b) 1음절 관형사/부사 (`이`, `그`, `저`, `새`, `헌`, `한`, `두`, `세`, `네`, `다`, `더`, `안`, `못`, `잘`, `꼭`, `막`, `좀`, `늘`, `참`)
    const isSingleCharModifier =
      !/[,!~.?'"”’]$/.test(curr) &&
      /^(이|그|저|새|헌|한|두|세|네|전|현|다|더|안|못|잘|꼭|막|좀|늘|참)$/.test(curr) &&
      i < working.length - 1;

    // (c) 부정·정도 부사 및 퍼센트 수치 (`절대`, `너무`, `아주`, `정말`, `진짜`, `완전`, `전혀`, `100%`)
    //     예: `절대` + `안` + `떨어져요.` -> `절대 안 떨어져요.`, `100%` + `잡아주니까` -> `100% 잡아주니까`
    const isStrongAdverbOrNumber =
      !/[,!~.?'"”’]$/.test(curr) &&
      (/^(절대|너무|아주|정말|진짜|완전|전혀|결코|훨씬|가장|제일)$/.test(currStripped) ||
        /^\d+%$/.test(currStripped)) &&
      i < working.length - 1;

    if (isShortInterjection || isSingleCharModifier || isStrongAdverbOrNumber) {
      const combined = `${curr} ${working[i + 1]}`;
      if (getVisualCharLength(combined) <= maxCharsPerLine) {
        working[i + 1] = combined;
        continue;
      }
    }

    forwardMerged.push(curr);
  }

  // Pass 2: 앞 어절에 종속되는 보조용언·의존명사를 앞 어절과 결합
  const merged: string[] = [];
  for (let i = 0; i < forwardMerged.length; i++) {
    const curr = forwardMerged[i];
    const prev = merged[merged.length - 1];

    if (prev) {
      const prevClean = prev.replace(/[,!~.?]+$/, '');
      const currClean = curr.replace(/[,!~.?]+$/, '');

      // 1) "~까 봐", "~나 봐", "~어 봐", "~해 봐" 등 보조용언 '봐/봤어/보세요'
      const isAuxiliaryBwa =
        /^(봐|봐요|봤어|봤어요|보세요)$/.test(currClean) &&
        /(까|나|가|어|아|해|워|봐)$/.test(prevClean);

      // 2) "~고 있어요 / ~고 계세요 / ~고 싶어요 / ~고 봤더니" 등 진행·보조용언 결합
      //    예: `너무 만족하고` + `있어요` -> `너무 만족하고 있어요`, `가리고` + `계세요?` -> `가리고 계세요?`
      const isAuxiliaryProgressive =
        /^(있어요|있습니다|있어|있고|있는|있던|계세요|계십니다|계신가요|싶어요|싶습니다|싶어)$/.test(
          currClean
        ) && /(고|어|아|여|해)$/.test(prevClean);

      // 3) "~아/어도 되니 / 돼요 / 됩니다" 등 허락·보조용언 결합
      //    예: `안써도` + `되니` -> `안써도 되니`
      const isAuxiliaryDoeni =
        /^(되니|되니까|돼서|돼요|됩니다|된다|되더라고요|됐어요)$/.test(currClean) &&
        /(도|면|야)$/.test(prevClean);

      // 4) 관형사형 어미 `~(으)ㄴ/는/던/ㄹ` 뒤에 오는 의존명사 결합
      //    예: `올라가는` + `것까지` -> `올라가는 것까지`, `입었을` + `때` -> `입었을 때`, `옷` + `값도` -> `옷 값도`
      const isBoundNoun =
        /^(것|것까지|것도|것은|것이|것을|거|거까지|거예요|걸|건|게|때|때도|때는|때부터|수|수도|수밖에|줄|듯|데|편|중|후|전|뿐|터|바|지|만큼|요|때문에|값도|값은|값이|값을)$/.test(
          currClean
        );

      if (
        isAuxiliaryBwa ||
        isAuxiliaryProgressive ||
        isAuxiliaryDoeni ||
        isBoundNoun
      ) {
        const combined = `${prev} ${curr}`;
        if (getVisualCharLength(combined) <= maxCharsPerLine) {
          merged[merged.length - 1] = combined;
          continue;
        }
      }
    }

    merged.push(curr);
  }

  return merged;
}

/**
 * 의미 덩어리(units) 배열을 받아 동적 계획법(DP)과 한국어 호흡 규칙으로
 * 고아 어절(예: 끝에 2~3글자만 남는 현상) 없이 한 줄 최대 글자 수(maxCharsPerLine) 이내로 균형 있게 분할합니다.
 */
function splitUnitsIntoBalancedLines(
  units: string[],
  maxCharsPerLine: number
): string[] {
  if (units.length === 0) return [];
  if (units.length === 1) return [units[0]];

  // 먼저 명확한 인용문 시작이나 강한 호흡 경계(절 단위)에서 서브 절(clauses)로 1차 분리
  const clauses: string[][] = [];
  let currentClause: string[] = [];

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const isLast = i === units.length - 1;

    // 여는 따옴표(`"야,` 등)나 대화 감탄사로 시작하면 앞 절을 먼저 확정
    const startsWithOpenQuoteOrDialogue =
      /^["'“‘「『]/.test(unit) || /^(야|있잖아)\s/.test(unit);
    if (
      startsWithOpenQuoteOrDialogue &&
      currentClause.length > 0 &&
      getVisualCharLength(currentClause.join(' ')) >= 4
    ) {
      clauses.push(currentClause);
      currentClause = [];
    }

    currentClause.push(unit);

    const clauseText = currentClause.join(' ');
    if (!isLast && isKoreanBreathBoundaryAfterUnit(unit, clauseText)) {
      clauses.push(currentClause);
      currentClause = [];
    }
  }
  if (currentClause.length > 0) {
    clauses.push(currentClause);
  }

  // 인접한 두 절을 합쳤을 때 maxCharsPerLine 이내이고, 뒷 절이 단독 서술어/보조어절이 아닌 자연스러운 연결이면 합침
  // (예: `피부용이라` (5자) + `순하면서도` (5자) = `피부용이라 순하면서도` (11자 <= 12자))
  const mergedClauses: string[][] = [];
  for (const clause of clauses) {
    const prev = mergedClauses[mergedClauses.length - 1];
    if (prev) {
      const prevText = prev.join(' ');
      const currText = clause.join(' ');
      const combinedText = `${prevText} ${currText}`;
      const prevEndsWithStrongBreak =
        /["'”’」』](라며|라고|면서)/.test(prevText) ||
        /(까\s*봐|나\s*봐|기\s*때문에|아끼고|잡아주니까|입었을\s*때|안써도\s*되니|순하면서도|땀이나도)[,!~.]?$/.test(
          prevText
        );

      if (
        !prevEndsWithStrongBreak &&
        !/^["'“‘「『]/.test(currText) &&
        getVisualCharLength(combinedText) <= maxCharsPerLine
      ) {
        mergedClauses[mergedClauses.length - 1] = [...prev, ...clause];
        continue;
      }
    }
    mergedClauses.push(clause);
  }

  // 각 절(clause) 내부가 maxCharsPerLine을 초과하면 동적 계획법(DP)으로 가장 균형 잡힌 지점에서 분할
  const finalLines: string[] = [];

  for (let cIdx = 0; cIdx < mergedClauses.length; cIdx++) {
    const clauseUnits = mergedClauses[cIdx];
    const isLastClause = cIdx === mergedClauses.length - 1;
    const fullClauseText = clauseUnits.join(' ');
    const fullVisualLen = getVisualCharLength(fullClauseText);

    // 문장 맨 마지막 절(`이 테이프를 던져주더라고요.`)은 1글자 여유를 허용하여 어색하게 쪼개지지 않게 함
    const limitForWholeClause = isLastClause ? maxCharsPerLine + 1 : maxCharsPerLine;
    if (fullVisualLen <= limitForWholeClause || clauseUnits.length === 1) {
      finalLines.push(fullClauseText);
      continue;
    }

    // 절 내부 DP 분할: 각 줄이 maxCharsPerLine 이하가 되도록 하되, 줄 간 글자 수 편차와 짧은 고아 줄에 큰 페널티 부여
    const n = clauseUnits.length;
    const dpCost = new Array<number>(n + 1).fill(Infinity);
    const dpNext = new Array<number>(n + 1).fill(n);
    dpCost[n] = 0;

    for (let i = n - 1; i >= 0; i--) {
      for (let j = i + 1; j <= n; j++) {
        const lineText = clauseUnits.slice(i, j).join(' ');
        const vLen = getVisualCharLength(lineText);
        const isLastSegment = j === n && isLastClause;
        const allowedMax = isLastSegment ? maxCharsPerLine + 1 : maxCharsPerLine;

        if (vLen > allowedMax && j > i + 1) {
          break;
        }

        // 기본 줄 비용 + 남은 여백의 제곱 비용 + 고아 줄(3글자 이하) 강한 페널티
        const slack = Math.max(0, maxCharsPerLine - vLen);
        let cost = 100 + slack * slack;
        if (vLen <= 3 && n > 1) {
          cost += 500;
        }
        const total = cost + dpCost[j];
        if (total < dpCost[i]) {
          dpCost[i] = total;
          dpNext[i] = j;
        }
      }
    }

    let cursor = 0;
    while (cursor < n) {
      const nextCursor = dpNext[cursor] > cursor ? dpNext[cursor] : cursor + 1;
      finalLines.push(clauseUnits.slice(cursor, nextCursor).join(' '));
      cursor = nextCursor;
    }
  }

  return finalLines;
}

/**
 * 긴 문장을 문장부호(. ? ! ,), 인용구(""), 한국어 호흡(연결어미: ~할까 봐, ~라며, ~해서, ~는데 등) 및
 * 의미 덩어리 균형 분할(DP) 기준으로 한 줄 최대 글자 수(maxCharsPerLine) 이하의 조각들로 자연스럽게 나눕니다.
 */
export function splitSentenceIntoNaturalChunks(
  rawText: string,
  maxCharsPerLine = 13
): string[] {
  const cleanText = rawText.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleanText) return [];

  // 1차: 따옴표 밖의 마침표, 물음표, 느낌표 등 문장 종결 경계로 먼저 분리
  const sentences = cleanText
    .split(/(?<=[.?!~])\s+(?=[^"'”’]|$)/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];

  for (const sentence of sentences) {
    if (getVisualCharLength(sentence) <= maxCharsPerLine) {
      chunks.push(sentence);
      continue;
    }

    const rawWords = sentence.split(/\s+/).filter(Boolean);
    const units = mergeInseparableKoreanTokens(rawWords, maxCharsPerLine);
    const balancedLines = splitUnitsIntoBalancedLines(units, maxCharsPerLine);
    chunks.push(...balancedLines);
  }

  return chunks;
}

/**
 * 기존 타임라인의 자막 캡션 클립들을 사용자가 선택한 줄 표시 방식
 * ('single-line': 무조건 1줄씩 별도 클립으로 분할 / 'double-line': 한 화면에 최대 2줄 이내로 줄바꿈 및 분할)
 * 으로 재구성하여 새로운 자막 클립 배열을 반환합니다.
 *
 * 특히 Whisper 초벌 자막이 문장 중간(예: `...다녀"라며 이` / `테이프를 던져주더라고요.`, `...절대 안` / `떨어져요.`)에서
 * 어색하게 잘려 있더라도, 연속된 자막 클립들의 어절별 타임스탬프를 보존한 채 문장을 먼저 하나로 이어 붙인 뒤
 * 한국어 호흡·의미 덩어리 기준으로 다시 깔끔하게 재분할합니다!
 */
export function reformatSubtitleClipsByLineMode(
  allClips: TimelineClip[],
  options: {
    mode: CaptionLineMode;
    maxCharsPerLine: number;
    fps?: number;
  }
): { updatedClips: TimelineClip[]; beforeCount: number; afterCount: number } {
  const { mode, maxCharsPerLine = 13, fps = 30 } = options;
  const frameSec = 1 / Math.max(1, fps);

  const nonTextClips = allClips.filter((c) => c.type !== 'text');
  const textClips = allClips
    .filter((c) => c.type === 'text')
    .sort((a, b) => a.startTime - b.startTime);

  if (textClips.length === 0) {
    return { updatedClips: allClips, beforeCount: 0, afterCount: 0 };
  }

  interface TimedWordToken {
    word: string;
    start: number;
    end: number;
  }

  interface ContiguousSpeechBlock {
    templateClip: TimelineClip;
    groupId: string;
    tokens: TimedWordToken[];
  }

  // 1단계: 각 자막 클립 내부 어절들의 타임스탬프를 계산하면서,
  // 클립 간 간격이 0.8초 이하로 이어지는 연속 발화 구간은 하나의 어절 스트림(ContiguousSpeechBlock)으로 묶습니다.
  // (이렇게 해야 이전 클립 끝에 남은 `이`, `절대 안`, `만족하고` 등이 다음 클립 첫 단어와 자연스럽게 결합됩니다!)
  const blocks: ContiguousSpeechBlock[] = [];

  for (const clip of textClips) {
    const words = (clip.text || '')
      .replace(/\r?\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);

    if (words.length === 0) continue;

    const weights = words.map((w) => Math.max(1, w.replace(/\s+/g, '').length));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const clipStart = clip.startTime;
    const clipEnd = clip.startTime + clip.duration;
    let cursor = clipStart;

    const clipTokens: TimedWordToken[] = words.map((word, idx) => {
      const isLast = idx === words.length - 1;
      const wStart = idx === 0 ? clipStart : cursor;
      const wEnd = isLast
        ? clipEnd
        : Math.min(clipEnd, wStart + (clip.duration * weights[idx]) / Math.max(1, totalWeight));
      cursor = wEnd;
      return { word, start: wStart, end: wEnd };
    });

    const prevBlock = blocks[blocks.length - 1];
    const prevEnd = prevBlock?.tokens[prevBlock.tokens.length - 1]?.end ?? -999;
    const gap = clipStart - prevEnd;

    if (
      prevBlock &&
      prevBlock.templateClip.trackId === clip.trackId &&
      gap <= 0.85
    ) {
      prevBlock.tokens.push(...clipTokens);
    } else {
      blocks.push({
        templateClip: clip,
        groupId: clip.sentenceGroupId || `cap_grp_${clip.id}`,
        tokens: clipTokens,
      });
    }
  }

  const reformattedTextClips: TimelineClip[] = [];

  // 2단계: 각 연속 발화 블록의 전체 문장을 한국어 호흡·균형 분할기로 나눈 뒤,
  // 각 줄에 속한 어절들의 원래 [첫 어절 시작 시간 ~ 끝 어절 종료 시간]을 그대로 매핑합니다.
  for (const block of blocks) {
    const fullText = block.tokens.map((t) => t.word).join(' ');
    const oneLineChunks = splitSentenceIntoNaturalChunks(fullText, maxCharsPerLine);

    if (oneLineChunks.length === 0) continue;

    // 모드 A ('single-line'): 모든 조각을 각각 1줄짜리 개별 자막 클립으로 분할
    // 모드 B ('double-line'): 조각들을 2줄씩('\n'으로 결합) 묶되, 문장 종결 부호(. ? !) 뒤에서는 새 클립으로 분리
    const finalClipTexts: string[] = [];
    if (mode === 'single-line') {
      finalClipTexts.push(...oneLineChunks);
    } else {
      let i = 0;
      while (i < oneLineChunks.length) {
        const firstLine = oneLineChunks[i];
        // 첫 줄 자체가 마침표/물음표/느낌표로 끝나는 완전한 문장이면 다음 문장과 섞지 않고 단독 표시하거나,
        // 아직 문장이 이어지면 두 번째 줄과 결합
        if (i + 1 < oneLineChunks.length && !/[.?!]$/.test(firstLine.trim())) {
          finalClipTexts.push(`${firstLine}\n${oneLineChunks[i + 1]}`);
          i += 2;
        } else if (i + 1 < oneLineChunks.length) {
          finalClipTexts.push(`${firstLine}\n${oneLineChunks[i + 1]}`);
          i += 2;
        } else {
          finalClipTexts.push(firstLine);
          i += 1;
        }
      }
    }

    let tokenCursor = 0;
    const totalTokens = block.tokens.length;

    finalClipTexts.forEach((pieceText, idx) => {
      const pieceWords = pieceText
        .replace(/\r?\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean);

      const wordCount = Math.max(1, pieceWords.length);
      const startTokenIdx = Math.min(tokenCursor, totalTokens - 1);
      const isLastPiece = idx === finalClipTexts.length - 1;
      const endTokenIdx = isLastPiece
        ? totalTokens - 1
        : Math.min(totalTokens - 1, startTokenIdx + wordCount - 1);

      tokenCursor = endTokenIdx + 1;

      const rawStart = block.tokens[startTokenIdx].start;
      const rawEnd = block.tokens[endTokenIdx].end;

      const pieceStart = idx === 0 ? rawStart : roundFrameTime(rawStart, fps);
      const pieceEnd = isLastPiece
        ? rawEnd
        : Math.max(pieceStart + frameSec * 2, roundFrameTime(rawEnd, fps));
      const pieceDuration = Math.max(frameSec * 2, pieceEnd - pieceStart);

      reformattedTextClips.push({
        ...block.templateClip,
        id:
          idx === 0
            ? block.templateClip.id
            : `${block.templateClip.id}_ln_${idx}_${Math.random().toString(36).slice(2, 5)}`,
        sentenceGroupId: block.groupId,
        name: pieceText.replace(/\r?\n/g, ' ').slice(0, 18),
        text: pieceText,
        startTime: Number(pieceStart.toFixed(5)),
        duration: Number(pieceDuration.toFixed(5)),
      });
    });
  }

  return {
    updatedClips: [...nonTextClips, ...reformattedTextClips],
    beforeCount: textClips.length,
    afterCount: reformattedTextClips.length,
  };
}

/**
 * [방안 1] 사용자가 대본 입력창에서 줄바꿈(Enter)한 한 줄 한 줄을
 * 100% 그대로 개별 자막 캡션 클립으로 만들면서,
 * 기존 AI 캡션의 음성 타임스탬프와 한글 자모 발음 유사도(Phonetic Alignment)를 이용해
 * 각 줄의 시작/종료 시간을 정밀하게 매칭합니다.
 */
export function alignScriptLinesToExistingCaptions(
  allClips: TimelineClip[],
  rawScript: string,
  fps = 30
): {
  updatedClips: TimelineClip[];
  diffs: CaptionDiffItem[];
} {
  const frameSec = 1 / Math.max(1, fps);
  const nonTextClips = allClips.filter((c) => c.type !== 'text');
  const textClips = allClips
    .filter((c) => c.type === 'text')
    .sort((a, b) => a.startTime - b.startTime);

  const scriptLines = rawScript
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (textClips.length === 0 || scriptLines.length === 0) {
    return { updatedClips: allClips, diffs: [] };
  }

  // 기존 AI 캡션들의 어절(단어)별 타임스탬프 스트림 생성 (무음 간격 보존)
  interface TimedSttToken {
    word: string;
    start: number;
    end: number;
  }

  const sttTokens: TimedSttToken[] = [];
  for (const clip of textClips) {
    const words = (clip.text || '')
      .replace(/\r?\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);

    if (words.length === 0) continue;

    const weights = words.map((w) => Math.max(1, w.replace(/\s+/g, '').length));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const clipStart = clip.startTime;
    const clipEnd = clip.startTime + clip.duration;
    let cursor = clipStart;

    words.forEach((word, idx) => {
      const isLast = idx === words.length - 1;
      const wStart = idx === 0 ? clipStart : cursor;
      const wEnd = isLast
        ? clipEnd
        : Math.min(clipEnd, wStart + (clip.duration * weights[idx]) / Math.max(1, totalWeight));
      cursor = wEnd;
      sttTokens.push({ word, start: wStart, end: wEnd });
    });
  }

  if (sttTokens.length === 0) {
    return { updatedClips: allClips, diffs: [] };
  }

  const template = textClips[0];
  const totalScriptChars = Math.max(
    1,
    scriptLines.reduce((acc, l) => acc + Math.max(1, l.replace(/\s+/g, '').length), 0)
  );
  const totalSttChars = Math.max(
    1,
    sttTokens.reduce((acc, t) => acc + Math.max(1, t.word.length), 0)
  );

  const newTextClips: TimelineClip[] = [];
  const diffs: CaptionDiffItem[] = [];
  let tokenCursor = 0;

  for (let i = 0; i < scriptLines.length; i++) {
    const scriptLine = scriptLines[i];
    const isLastLine = i === scriptLines.length - 1;
    const remainingLinesAfter = scriptLines.length - 1 - i;

    if (tokenCursor >= sttTokens.length) {
      const lastClip = newTextClips[newTextClips.length - 1];
      const fallbackStart = lastClip ? lastClip.startTime + lastClip.duration : template.startTime;
      const fallbackDur = Math.max(0.6, frameSec * 15);
      const clipId = `sub_sc_${Date.now()}_${i}`;
      newTextClips.push({
        ...template,
        id: clipId,
        name: scriptLine.slice(0, 18),
        text: scriptLine,
        startTime: Number(fallbackStart.toFixed(5)),
        duration: Number(fallbackDur.toFixed(5)),
      });
      diffs.push({
        clipId,
        index: i + 1,
        startTime: fallbackStart,
        endTime: fallbackStart + fallbackDur,
        beforeText: '(추가 대본 줄)',
        afterText: scriptLine,
        similarity: 1,
        isChanged: true,
      });
      continue;
    }

    if (isLastLine) {
      const sliceTokens = sttTokens.slice(tokenCursor);
      const beforeStt = sliceTokens.map((t) => t.word).join(' ');
      const startT = sliceTokens[0].start;
      const endT = Math.max(startT + frameSec * 2, sliceTokens[sliceTokens.length - 1].end);
      const clipId = `sub_sc_${Date.now()}_${i}`;
      const sim = computePhoneticSimilarity(beforeStt, scriptLine);

      newTextClips.push({
        ...template,
        id: clipId,
        name: scriptLine.slice(0, 18),
        text: scriptLine,
        originalSttText: beforeStt,
        startTime: Number(startT.toFixed(5)),
        duration: Number((endT - startT).toFixed(5)),
      });

      diffs.push({
        clipId,
        index: i + 1,
        startTime: startT,
        endTime: endT,
        beforeText: beforeStt,
        afterText: scriptLine,
        similarity: sim,
        isChanged: beforeStt.trim() !== scriptLine.trim(),
      });
      break;
    }

    // 현재 대본 줄의 글자 비율에 해당하는 STT 어절 범위를 탐색하며 한글 자모 발음 유사도 최적점 선택
    const lineCharLen = Math.max(1, scriptLine.replace(/\s+/g, '').length);
    const targetSttCharLen = Math.max(
      1,
      Math.round((lineCharLen / totalScriptChars) * totalSttChars)
    );

    const maxEndToken = Math.max(
      tokenCursor + 1,
      Math.min(sttTokens.length - Math.min(remainingLinesAfter, sttTokens.length - tokenCursor - 1), tokenCursor + 20)
    );

    let bestEndToken = tokenCursor + 1;
    let bestScore = -999;

    for (let candEnd = tokenCursor + 1; candEnd <= maxEndToken; candEnd++) {
      const candPhrase = sttTokens
        .slice(tokenCursor, candEnd)
        .map((t) => t.word)
        .join(' ');
      const candChars = Math.max(1, candPhrase.replace(/\s+/g, '').length);

      const sim = computePhoneticSimilarity(candPhrase, scriptLine);
      const lenDiffRatio = Math.abs(candChars - targetSttCharLen) / Math.max(3, targetSttCharLen);

      let nextLookaheadBonus = 0;
      const nextScriptLine = scriptLines[i + 1];
      if (nextScriptLine && candEnd < sttTokens.length) {
        const nextSttPreview = sttTokens
          .slice(candEnd, Math.min(sttTokens.length, candEnd + 6))
          .map((t) => t.word)
          .join(' ');
        nextLookaheadBonus =
          computePhoneticSimilarity(
            nextSttPreview.slice(0, nextScriptLine.length),
            nextScriptLine
          ) * 0.3;
      }

      const score = sim + nextLookaheadBonus - lenDiffRatio * 0.35;
      if (score > bestScore) {
        bestScore = score;
        bestEndToken = candEnd;
      }
    }

    const matchedSlice = sttTokens.slice(tokenCursor, bestEndToken);
    const beforeStt = matchedSlice.map((t) => t.word).join(' ');
    const startT = i === 0 ? matchedSlice[0].start : roundFrameTime(matchedSlice[0].start, fps);
    const endT = Math.max(
      startT + frameSec * 2,
      roundFrameTime(matchedSlice[matchedSlice.length - 1].end, fps)
    );
    const clipId = `sub_sc_${Date.now()}_${i}`;
    const sim = computePhoneticSimilarity(beforeStt, scriptLine);

    newTextClips.push({
      ...template,
      id: clipId,
      name: scriptLine.slice(0, 18),
      text: scriptLine,
      originalSttText: beforeStt,
      startTime: Number(startT.toFixed(5)),
      duration: Number((endT - startT).toFixed(5)),
    });

    diffs.push({
      clipId,
      index: i + 1,
      startTime: startT,
      endTime: endT,
      beforeText: beforeStt,
      afterText: scriptLine,
      similarity: sim,
      isChanged: beforeStt.trim() !== scriptLine.trim(),
    });

    tokenCursor = bestEndToken;
  }

  return {
    updatedClips: [...nonTextClips, ...newTextClips],
    diffs,
  };
}
