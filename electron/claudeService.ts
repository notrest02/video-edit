/**
 * Claude API (메인 프로세스 전용) — 키 저장/확인과 호출.
 * 키는 Electron safeStorage 로 암호화해 userData/claude-key.bin 에 저장하고, 화면(렌더러) 쪽으로는 절대 보내지 않는다.
 * 모델: 자동 배치 비교 결과(2026-11-02) 비용 대비 Haiku 5.5 로 결정.
 */
import Anthropic from '@anthropic-ai/sdk';
import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';

export const CLAUDE_MODEL = 'claude-haiku-5-5';

const keyFile = () => path.join(app.getPath('userData'), 'claude-key.bin');

export function hasClaudeKey(): boolean {
  return fs.existsSync(keyFile());
}

function readKey(): string | null {
  if (!hasClaudeKey()) return null;
  const buf = fs.readFileSync(keyFile());
  return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
}

export function saveClaudeKey(key: string) {
  const k = key.trim();
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(k) : Buffer.from(k, 'utf8');
  fs.writeFileSync(keyFile(), data);
}

export function clearClaudeKey() {
  if (hasClaudeKey()) fs.unlinkSync(keyFile());
}

function client(): Anthropic {
  const key = readKey();
  if (!key) throw new Error('Claude API 키가 없습니다. STEP 3 의 [API 키]에 입력해 주세요.');
  return new Anthropic({ apiKey: key });
}

/** 키 확인: 아주 짧은 호출 한 번 */
export async function testClaudeKey(key?: string): Promise<{ ok: boolean; message: string }> {
  try {
    const c = key ? new Anthropic({ apiKey: key.trim() }) : client();
    await c.messages.create({ model: CLAUDE_MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] });
    return { ok: true, message: '연결 확인됨' };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, message: 'API 키가 올바르지 않습니다.' };
    if (e instanceof Anthropic.PermissionDeniedError) return { ok: false, message: '이 키로는 모델을 쓸 권한이 없습니다.' };
    if (e instanceof Anthropic.RateLimitError) return { ok: false, message: '요청 한도 초과. 잠시 후 다시 시도해 주세요.' };
    if (e instanceof Anthropic.APIError) return { ok: false, message: `API 오류 ${e.status}: ${e.message}` };
    return { ok: false, message: `연결 실패: ${(e as Error).message}` };
  }
}

export type UsageTotal = { input: number; output: number };

/** 답이 최대 길이에 걸려 잘림 (호출한 쪽이 나눠서 다시 물어볼 수 있게 따로 구분) */
export class TruncatedError extends Error {
  /** 잘린 답에도 비용이 들었으므로 사용량을 같이 넘김 */
  usage: UsageTotal;
  constructor(usage: UsageTotal = { input: 0, output: 0 }) {
    super('응답이 너무 길어 잘렸습니다.');
    this.name = 'TruncatedError';
    this.usage = usage;
  }
}

/**
 * 이미지 + 글 → JSON (구조화 출력). 이미지는 jpg 파일 경로.
 * 반환: 파싱된 JSON 과 토큰 사용량
 */
export async function claudeJson<T>(params: {
  system: string;
  text: string;
  images?: Array<{ label: string; path: string }>;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<{ data: T; usage: UsageTotal }> {
  const content: Anthropic.ContentBlockParam[] = [];
  for (const im of params.images || []) {
    content.push({ type: 'text', text: im.label });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(im.path).toString('base64') },
    });
  }
  content.push({ type: 'text', text: params.text });
  const stream = client().messages.stream({
    model: CLAUDE_MODEL,
    // Haiku 는 답 전에 생각을 먼저 하고 그 생각도 이 한도에 포함된다 → 넉넉히 (실제로 쓴 만큼만 비용). 스트리밍이라 길어도 끊기지 않음
    max_tokens: params.maxTokens ?? 64000,
    system: params.system,
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema: params.schema } },
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('모델이 요청을 거절했습니다.');
  if (msg.stop_reason === 'max_tokens') throw new TruncatedError({ input: msg.usage.input_tokens, output: msg.usage.output_tokens });
  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return {
    data: JSON.parse(text) as T,
    usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens },
  };
}
