import {
  AssemblyMatchedSentence,
  AssemblyMatchedShot,
  AssemblySettings,
  TimelineClip,
} from '../types/editor';

export interface VideoFootageCandidate {
  assetId?: string;
  sourcePath: string;
  name: string;
  duration: number;
  keyframes: Array<{ time: number; base64: string }>;
}

export interface NarrationSentence {
  index: number;
  text: string;
  startTime: number;
  endTime: number;
  duration: number;
}

/**
 * 대본 문장 텍스트를 나레이션 음성 파일 길이와 Whisper 타임스탬프를 바탕으로 분할
 */
export function parseScriptToSentences(
  scriptText: string,
  totalNarrationDuration: number
): NarrationSentence[] {
  const lines = scriptText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return [
      {
        index: 0,
        text: '나레이션 대본',
        startTime: 0,
        endTime: totalNarrationDuration,
        duration: totalNarrationDuration,
      },
    ];
  }

  // 문장별 글자 수에 비례하여 1차 시간 균등 배분 (추후 Whisper 단어 싱크가 있으면 더욱 정밀하게 보정)
  const totalChars = lines.reduce((acc, l) => acc + l.length, 0);
  let cursor = 0;
  const sentences: NarrationSentence[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const weight = line.length / totalChars;
    const dur =
      i === lines.length - 1
        ? Math.max(0.8, totalNarrationDuration - cursor)
        : Math.max(0.8, Number((totalNarrationDuration * weight).toFixed(2)));

    sentences.push({
      index: i,
      text: line,
      startTime: Number(cursor.toFixed(2)),
      endTime: Number((cursor + dur).toFixed(2)),
      duration: Number(dur.toFixed(2)),
    });

    cursor += dur;
  }

  return sentences;
}

/**
 * Gemini 2.0 Flash / 1.5 Pro API를 호출하여 영상 씬과 대본 매칭 분석
 */
async function callGeminiMatching(
  apiKey: string,
  model: string,
  sentences: NarrationSentence[],
  footages: VideoFootageCandidate[]
): Promise<Array<{ sentenceIndex: number; shotIndex: number; sourceStart: number; label: string }>> {
  const targetModel = model || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey.trim()}`;

  // 프롬프트 구성: 각 영상 푸티지의 대표 썸네일과 시간대를 안내
  const promptParts: any[] = [];

  promptParts.push({
    text: `You are a professional video editor. We are creating a dynamic video editing timeline by matching voiceover script sentences with B-roll video footage.
Here are the narration sentences:
${sentences.map((s) => `[Sentence ${s.index} (${s.duration}s)]: "${s.text}"`).join('\n')}

Here are the video footage clips available:
${footages.map((f, idx) => `Clip ${idx}: "${f.name}", duration: ${f.duration}s, has ${f.keyframes.length} keyframes.`).join('\n')}

I will provide keyframe images for each clip below.
Please analyze which clip and time offset best matches each sentence's meaning and mood.
Respond ONLY with a valid JSON array in this format:
[
  { "sentenceIndex": 0, "shotIndex": 0, "sourceStart": 2.0, "label": "description of why this shot matches" }
]
`,
  });

  // 영상별 키프레임 썸네일 첨부 (클립당 대표 3~5장 첨부하여 토큰 효율 극대화)
  for (let fIdx = 0; fIdx < footages.length; fIdx++) {
    const f = footages[fIdx];
    const sampleFrames = f.keyframes.slice(0, 4);
    for (const kf of sampleFrames) {
      const pureBase64 = kf.base64.replace(/^data:image\/[a-z]+;base64,/, '');
      promptParts.push({
        text: `Clip ${fIdx} ("${f.name}") at ${kf.time}s:`,
      });
      promptParts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: pureBase64,
        },
      });
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: promptParts }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API Error (${res.status}): ${errText}`);
  }

  const json = await res.json();
  const rawContent = json?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  try {
    const parsed = JSON.parse(rawContent);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * OpenAI GPT-4o API 호출 매칭
 */
async function callOpenAiMatching(
  apiKey: string,
  model: string,
  sentences: NarrationSentence[],
  footages: VideoFootageCandidate[]
): Promise<Array<{ sentenceIndex: number; shotIndex: number; sourceStart: number; label: string }>> {
  const targetModel = model || 'gpt-4o';
  const url = 'https://api.openai.com/v1/chat/completions';

  const userContent: any[] = [
    {
      type: 'text',
      text: `You are an expert video editor. Match the narration sentences with the best video footage clips.
Sentences:
${sentences.map((s) => `[Sentence ${s.index} (${s.duration}s)]: "${s.text}"`).join('\n')}

Available Footages:
${footages.map((f, idx) => `Clip ${idx}: "${f.name}", duration ${f.duration}s`).join('\n')}

Respond ONLY with JSON format:
[
  { "sentenceIndex": 0, "shotIndex": 0, "sourceStart": 1.5, "label": "description" }
]
`,
    },
  ];

  for (let fIdx = 0; fIdx < footages.length; fIdx++) {
    const f = footages[fIdx];
    const sampleFrames = f.keyframes.slice(0, 3);
    for (const kf of sampleFrames) {
      userContent.push({
        type: 'image_url',
        image_url: { url: kf.base64, detail: 'low' },
      });
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: targetModel,
      messages: [{ role: 'user', content: userContent }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API Error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : parsed.cuts || parsed.matches || [];
  } catch {
    return [];
  }
}

/**
 * Anthropic Claude 3.5 Sonnet 비전 매칭
 */
async function callClaudeMatching(
  apiKey: string,
  model: string,
  sentences: NarrationSentence[],
  footages: VideoFootageCandidate[]
): Promise<Array<{ sentenceIndex: number; shotIndex: number; sourceStart: number; label: string }>> {
  const targetModel = model || 'claude-3-5-sonnet-20241022';
  const url = 'https://api.anthropic.com/v1/messages';

  const userContent: any[] = [
    {
      type: 'text',
      text: `You are an expert video editor. Match the narration sentences with the best video footage clips.
Sentences:
${sentences.map((s) => `[Sentence ${s.index} (${s.duration}s)]: "${s.text}"`).join('\n')}

Available Footages:
${footages.map((f, idx) => `Clip ${idx}: "${f.name}", duration ${f.duration}s`).join('\n')}

Respond ONLY with valid JSON array in this format (no conversational text):
[
  { "sentenceIndex": 0, "shotIndex": 0, "sourceStart": 1.0, "label": "description" }
]
`,
    },
  ];

  for (let fIdx = 0; fIdx < footages.length; fIdx++) {
    const f = footages[fIdx];
    const sampleFrames = f.keyframes.slice(0, 3);
    for (const kf of sampleFrames) {
      const pureBase64 = kf.base64.replace(/^data:image\/[a-z]+;base64,/, '');
      userContent.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: pureBase64,
        },
      });
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey.trim(),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: targetModel,
      max_tokens: 2048,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API Error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const rawText = data?.content?.[0]?.text || '[]';
  try {
    const match = rawText.match(/\[[\s\S]*\]/);
    if (match) {
      return JSON.parse(match[0]);
    }
    return JSON.parse(rawText);
  } catch {
    return [];
  }
}

/**
 * 로컬 룰 기반 매칭 (API 키 없이 완전 무료 오프라인 실행)
 */
function runLocalRuleMatching(
  sentences: NarrationSentence[],
  footages: VideoFootageCandidate[]
): Array<{ sentenceIndex: number; shotIndex: number; sourceStart: number; label: string }> {
  const results: Array<{ sentenceIndex: number; shotIndex: number; sourceStart: number; label: string }> = [];

  for (let i = 0; i < sentences.length; i++) {
    const shotIdx = i % footages.length;
    const f = footages[shotIdx];
    // 문장 길이에 맞춰 클립 내부 시작 오프셋을 자연스럽게 분배
    const maxOffset = Math.max(0, f.duration - sentences[i].duration);
    const sourceStart = Number(((i * 1.5) % Math.max(1, maxOffset)).toFixed(2));

    results.push({
      sentenceIndex: i,
      shotIndex: shotIdx,
      sourceStart,
      label: `${f.name} (로컬 매칭 컷)`,
    });
  }

  return results;
}

/**
 * 메인 어셈블리 오케스트레이터:
 * 1. AI 또는 로컬 엔진으로 1차 매칭
 * 2. 사용자가 지정한 예외 처리 적용:
 *    - 길이가 부족할 때: 2순위 관련 샷으로 교차 편집(몽타주)
 *    - 어울리는 샷이 없을 때: 대표 안전 샷(Hero Shot) 대체 vs 빈 공간(플레이스홀더) 유지
 */
export async function generateAutoAssemblyMatch(params: {
  sentences: NarrationSentence[];
  footages: VideoFootageCandidate[];
  settings: AssemblySettings;
  apiKeys: {
    geminiKey?: string;
    geminiModel?: string;
    openAiKey?: string;
    openAiModel?: string;
    claudeKey?: string;
    claudeModel?: string;
  };
  onProgress?: (msg: string) => void;
}): Promise<AssemblyMatchedSentence[]> {
  const { sentences, footages, settings, apiKeys, onProgress } = params;
  if (footages.length === 0 || sentences.length === 0) return [];

  onProgress?.('AI 장면 분석 및 대본 매칭 준비 중...');

  let rawMatches: Array<{ sentenceIndex: number; shotIndex: number; sourceStart: number; label: string }> = [];

  try {
    if (settings.aiEngine === 'gemini' && apiKeys.geminiKey) {
      onProgress?.('Google Gemini 2.0 비전 모델로 영상 장면과 대사 분석 중...');
      rawMatches = await callGeminiMatching(
        apiKeys.geminiKey,
        apiKeys.geminiModel || 'gemini-2.0-flash',
        sentences,
        footages
      );
    } else if (settings.aiEngine === 'openai' && apiKeys.openAiKey) {
      onProgress?.('OpenAI GPT-4o 비전 모델로 영상 컷 매칭 중...');
      rawMatches = await callOpenAiMatching(
        apiKeys.openAiKey,
        apiKeys.openAiModel || 'gpt-4o',
        sentences,
        footages
      );
    } else if (settings.aiEngine === 'claude' && apiKeys.claudeKey) {
      onProgress?.('Anthropic Claude 3.5 Sonnet 비전 모델로 영상 컷 매칭 중...');
      rawMatches = await callClaudeMatching(
        apiKeys.claudeKey,
        apiKeys.claudeModel || 'claude-3-5-sonnet-20241022',
        sentences,
        footages
      );
    } else {
      onProgress?.('로컬 스마트 룰 엔진으로 영상 컷 매칭 중...');
      rawMatches = runLocalRuleMatching(sentences, footages);
    }
  } catch (err: any) {
    console.warn('AI API call failed, falling back to local rule matching:', err);
    onProgress?.(`AI 호출 오류 발생 (${err.message}) → 로컬 스마트 엔진으로 자동 전환`);
    rawMatches = runLocalRuleMatching(sentences, footages);
  }

  onProgress?.('타임라인 컷 길이 검증 및 교차 몽타주 예외 처리 적용 중...');

  // 대표 안전 샷(Master Hero Shot): 가장 긴 영상 또는 0번 영상
  const heroFootage =
    [...footages].sort((a, b) => b.duration - a.duration)[0] || footages[0];

  const matchedSentences: AssemblyMatchedSentence[] = [];

  for (const sent of sentences) {
    const match = rawMatches.find((m) => m.sentenceIndex === sent.index);
    const chosenFootage =
      match && footages[match.shotIndex] ? footages[match.shotIndex] : null;

    const sentenceShots: AssemblyMatchedShot[] = [];

    if (!chosenFootage) {
      // [예외 상황 2]: 어울리는 장면이 아예 없는 경우
      if (settings.missingStrategy === 'empty-placeholder') {
        // 나중에 채울 수 있게 빈 공간(플레이스홀더)으로 유지
        sentenceShots.push({
          sourcePath: '',
          sourceStart: 0,
          duration: sent.duration,
          label: `[푸티지 필요: "${sent.text}"]`,
          isPlaceholder: true,
        });
      } else {
        // 대표 전체 샷(Hero Shot)으로 안전 대체
        sentenceShots.push({
          assetId: heroFootage.assetId,
          sourcePath: heroFootage.sourcePath,
          sourceStart: 0,
          duration: sent.duration,
          label: `${heroFootage.name} (대표 안전 샷)`,
          isFallback: true,
        });
      }
    } else {
      // [예외 상황 1]: 어울리는 장면의 길이가 대사보다 짧은 경우 (교차 편집 / 몽타주)
      const matchSourceStart = match?.sourceStart || 0;
      const matchLabel = match?.label || chosenFootage.name;
      const availableDuration = Math.max(0.5, chosenFootage.duration - matchSourceStart);

      if (availableDuration < sent.duration - 0.2 && settings.shortageStrategy === 'montage-crosscut') {
        // 1차 샷 배치 (사용 가능한 만큼)
        const primaryShotDuration = Math.max(1.0, availableDuration);
        sentenceShots.push({
          assetId: chosenFootage.assetId,
          sourcePath: chosenFootage.sourcePath,
          sourceStart: matchSourceStart,
          duration: primaryShotDuration,
          label: `${chosenFootage.name} (1차 샷)`,
        });

        // 부족한 나머지 시간은 2순위 관련 샷(다른 영상)으로 이어붙여 몽타주 완성!
        const remainingDuration = Number((sent.duration - primaryShotDuration).toFixed(2));
        const secondaryFootage =
          footages.find((f) => f.sourcePath !== chosenFootage.sourcePath) || heroFootage;

        sentenceShots.push({
          assetId: secondaryFootage.assetId,
          sourcePath: secondaryFootage.sourcePath,
          sourceStart: 0,
          duration: remainingDuration,
          label: `${secondaryFootage.name} (2차 교차 몽타주 샷)`,
        });
      } else {
        // 길이가 충분한 경우: 대사 길이만큼 깔끔하게 컷팅
        sentenceShots.push({
          assetId: chosenFootage.assetId,
          sourcePath: chosenFootage.sourcePath,
          sourceStart: matchSourceStart,
          duration: sent.duration,
          label: matchLabel,
        });
      }
    }

    matchedSentences.push({
      sentenceIndex: sent.index,
      text: sent.text,
      startTime: sent.startTime,
      endTime: sent.endTime,
      duration: sent.duration,
      shots: sentenceShots,
    });
  }

  return matchedSentences;
}
