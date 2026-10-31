/**
 * Gemini Multimodal Audio + Visual-Waveform Locked Subtitle Aligner
 *
 * 1) 모든 자막의 시작(Start)과 끝(End) 시간은 타임라인 초록색 파형의 무음 바닥(Flat Floor Valley) 직후
 *    파형이 솟아오르는 절벽(Rising Cliff Onset, 예: 0.280s, 3.315s, 7.080s, 8.710s, 89.575s)에
 *    0.005초(5ms) 단위로 물리 고정됩니다.
 * 2) 문장 간 2.2초 이내 묵음은 이전 자막을 다음 대사 시작 정위치(next.start)까지 빈틈없이 유지합니다.
 * 3) Gemini는 실제 오디오 음원(WAV)을 직접 청취하면서 각 구간의 초벌 텍스트(및 대본)를 대조하여
 *    오타·동음이의어(예: "이 단 3단 독립 간에 헷갈리나" -> "2단, 3단 독립 칸에 색깔이나 소재별로")를
 *    교정하며, 타임스탬프는 절대 변경하지 않아 대본 밀림이 원천 차단됩니다.
 */

import { WordTimestamp } from '../types/editor';

let cachedWorkingGeminiModel = '';

/**
 * 16kHz Float32 PCM의 특정 구간 [startSec, endSec]을 가벼운 8kHz 16-bit Mono WAV Base64로 인코딩합니다.
 */
function encodePcmSliceTo8kWavBase64(
  pcm16k: Float32Array,
  startSec: number,
  endSec: number
): string {
  const srcRate = 16000;
  const dstRate = 8000;
  const sIdx = Math.max(0, Math.floor(startSec * srcRate));
  const eIdx = Math.min(pcm16k.length, Math.ceil(endSec * srcRate));
  const dstLen = Math.max(1, Math.floor((eIdx - sIdx) / 2));

  const buffer = new ArrayBuffer(44 + dstLen * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dstLen * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, dstRate, true);
  view.setUint32(28, dstRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dstLen * 2, true);

  let offset = 44;
  for (let i = 0; i < dstLen; i++) {
    const sample = Math.max(-1, Math.min(1, pcm16k[sIdx + i * 2] || 0));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunkSize))
    );
  }
  return btoa(binary);
}

/**
 * 자가치유(Self-Healing) 기능이 포함된 Gemini API 호출 헬퍼
 */
async function callGeminiWithSelfHealing(
  apiKey: string,
  requestedModel: string,
  payload: any,
  onProgress?: (msg: string) => void
): Promise<any> {
  const executeApiCall = async (targetModel: string) => {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  };

  let activeModel = cachedWorkingGeminiModel || requestedModel || 'gemini-3.8-flash';
  let response = await executeApiCall(activeModel);

  if (!response.ok) {
    const errText = await response.text();
    const suggestedMatch = errText.match(/models\/([a-zA-Z0-9._-]+)/);
    if (suggestedMatch && suggestedMatch[1] && suggestedMatch[1] !== activeModel) {
      activeModel = suggestedMatch[1];
      cachedWorkingGeminiModel = activeModel;
      onProgress?.(`Google 권장 최신 모델(${activeModel})로 자동 전환 중...`);
      response = await executeApiCall(activeModel);
    }

    if (!response.ok) {
      try {
        const listRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
        );
        if (listRes.ok) {
          const listData = await listRes.json();
          const validModels = (listData.models || [])
            .filter(
              (m: any) =>
                Array.isArray(m.supportedGenerationMethods) &&
                m.supportedGenerationMethods.includes('generateContent')
            )
            .map((m: any) => String(m.name || '').replace(/^models\//, ''));

          const preferred = [
            'gemini-3.8-flash',
            'gemini-3-flash',
            'gemini-3.0-flash',
            'gemini-2.5-flash',
            'gemini-2.0-flash',
            'gemini-1.5-flash-latest',
            'gemini-1.5-flash',
          ];
          const match =
            preferred.find((p) => validModels.includes(p)) ||
            validModels.find((vm: string) => vm.toLowerCase().includes('flash')) ||
            validModels[0];

          if (match && match !== activeModel) {
            activeModel = match;
            cachedWorkingGeminiModel = activeModel;
            response = await executeApiCall(activeModel);
          }
        }
      } catch (e) {
        console.warn('[Gemini listModels fallback failed]', e);
      }
    }

    if (!response.ok) {
      const finalErrText = await response.text();
      throw new Error(`Gemini API 오류 (${response.status}): ${finalErrText}`);
    }
  } else {
    cachedWorkingGeminiModel = activeModel;
  }

  const resData = await response.json();
  const rawJsonText = resData?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

  try {
    return JSON.parse(rawJsonText);
  } catch (e) {
    const jsonMatch = rawJsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]);
    }
    throw new Error('Gemini 응답 JSON 파싱 실패');
  }
}

/**
 * 파형 절벽(Rising Cliff)에 고정된 자막 세그먼트들의 타임스탬프는 100% 그대로 유지한 채,
 * 실제 오디오 구간(WAV)을 Gemini에 함께 들려주어 각 구간의 한국어 대사를 완벽히 받아적고 교정합니다.
 */
export async function refineWaveformLockedSegmentsWithGemini(params: {
  pcmFloat32: Float32Array;
  baseSegments: WordTimestamp[];
  clipTimelineStart: number;
  apiKey: string;
  model?: string;
  scriptText?: string;
  captionMaxChars?: number;
  fps?: number;
  onProgress?: (msg: string) => void;
}): Promise<WordTimestamp[]> {
  const {
    pcmFloat32,
    baseSegments,
    clipTimelineStart,
    apiKey,
    model = 'gemini-3.8-flash',
    scriptText,
    onProgress,
  } = params;

  if (baseSegments.length === 0) return [];
  const totalAudioSec = pcmFloat32.length / 16000;
  const correctedMap = new Map<number, string>();

  // 22개 세그먼트(약 60~75초 분량) 단위로 오디오 WAV와 함께 멀티모달 청취 교정
  const BATCH_SIZE = 22;
  const totalBatches = Math.ceil(baseSegments.length / BATCH_SIZE);

  for (let bIdx = 0; bIdx < totalBatches; bIdx++) {
    const startIdx = bIdx * BATCH_SIZE;
    const endIdx = Math.min(baseSegments.length, startIdx + BATCH_SIZE);
    const batchSegs = baseSegments.slice(startIdx, endIdx);

    const sliceStartSec = Math.max(0, batchSegs[0].start - clipTimelineStart - 0.15);
    const sliceEndSec = Math.min(
      totalAudioSec,
      batchSegs[batchSegs.length - 1].end - clipTimelineStart + 0.15
    );

    const indexedBatch = batchSegs.map((seg, localIdx) => {
      const globalIdx = startIdx + localIdx;
      const relS = Math.max(0, seg.start - clipTimelineStart - sliceStartSec);
      const relE = Math.max(relS + 0.2, seg.end - clipTimelineStart - sliceStartSec);
      return {
        index: globalIdx,
        audioTimeSec: `${relS.toFixed(2)}s ~ ${relE.toFixed(2)}s`,
        draftStt: seg.text,
      };
    });

    let prompt = `당신은 한국어 광고/내레이션 오디오 정밀 전사 및 자막 교정 전문가입니다.
첨부된 오디오 파일의 실제 음성을 직접 듣고, 아래 ${indexedBatch.length}개 구간(index ${startIdx} ~ ${endIdx - 1})의 초벌 텍스트(draftStt) 오타를 실제 발화 내용과 100% 일치하게 교정하세요:
${JSON.stringify(indexedBatch, null, 2)}

[절대 준수 규칙]
1. 반드시 첨부된 오디오에서 각 구간(audioTimeSec)에 실제로 들리는 한국어 문장을 정확히 적으세요. (예: "이 단 3단 독립간에 색깔이 나 소재 별로" -> "2단, 3단 독립 칸에 색깔이나 소재별로 가족별로 나눠 담을 수 있어요.", "분리순업/블리스납" -> "분리 수납", "2단 백니터 3단 백이십니터라" -> "2단 100L, 3단 120L라")
2. 각 항목의 번호(index: ${startIdx} ~ ${endIdx - 1})를 절대 빠뜨리거나 앞뒤 번호와 합치지 말고 1:1로 반환하세요.
`;

    if (scriptText && scriptText.trim()) {
      prompt += `\n[사용자 원본 대본 참조]
아래 대본과 발음이 일치하는 문장은 대본의 정확한 표기법을 따르세요:
"""
${scriptText.trim().slice(0, 5000)}
"""`;
    }

    prompt += `\n[응답 JSON 형식]
{
  "items": [
    { "index": ${startIdx}, "text": "오디오를 듣고 완벽히 교정된 자막 문장" }
  ]
}`;

    try {
      onProgress?.(
        `Gemini 멀티모달 오디오 정밀 청취 및 교정 중... (${bIdx + 1}/${totalBatches} 구간)`
      );
      const wavBase64 = encodePcmSliceTo8kWavBase64(pcmFloat32, sliceStartSec, sliceEndSec);
      const payload = {
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/wav',
                  data: wavBase64,
                },
              },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      };

      const parsed = await callGeminiWithSelfHealing(apiKey, model, payload, onProgress);
      const list: any[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.items)
        ? parsed.items
        : Array.isArray(parsed?.captions)
        ? parsed.captions
        : Array.isArray(parsed?.results)
        ? parsed.results
        : [];

      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (!item) continue;
        const rawIdx = item.index ?? item.id ?? item.block ?? startIdx + i;
        const numIdx =
          typeof rawIdx === 'number'
            ? rawIdx
            : parseInt(String(rawIdx).replace(/[^0-9]/g, ''), 10);
        const txt = String(item.text ?? item.caption ?? item.stt ?? '').trim();
        if (!Number.isNaN(numIdx) && txt) {
          correctedMap.set(numIdx, txt);
        }
      }
    } catch (err) {
      console.warn(`[Gemini audio batch ${bIdx + 1} fallback]`, err);
    }
  }

  // 중요: baseSegments의 start/end/voiceEnd는 이미 타임라인 초록색 파형의 무음 골짜기 직후 절벽(Rising Cliff)에
  // 5ms 단위로 칼같이 고정되어 있으므로, 절대 다시 변형하지 않고 그대로 보존합니다!
  return baseSegments.map((seg, idx) => ({
    text: (correctedMap.get(idx) || seg.text).trim(),
    start: seg.start,
    end: seg.end,
    voiceEnd: seg.voiceEnd,
  }));
}
