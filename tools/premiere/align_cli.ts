/**
 * 음성 파일 하나에 대본 줄들을 강제 정렬해 줄마다 [시작, 끝] 초를 출력 (정답표 만들기용)
 *
 * 빌드: npx esbuild tools/premiere/align_cli.ts --bundle --platform=node --external:onnxruntime-node --outfile=tools/premiere/align_cli.cjs
 * 사용: node tools/premiere/align_cli.cjs <input.json>
 *   input.json: {"audio": "음성.mp3", "lines": ["첫 줄", "둘째 줄", ...]}
 *   출력(stdout): {"duration": 초, "lines": [[시작, 끝] | null, ...], "words": [[줄 번호, 단어, 시작, 끝] ...]}
 * 모델: %APPDATA%/antigravity-video-editor/models/ko-wav2vec2/{model_int8.onnx, vocab.json} (앱이 받아 둔 것)
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ALIGN_SAMPLE_RATE, computeEmission, createSyllableTokenizer, wordSpansInRange } from '../../src/utils/forcedAligner';

async function main() {
  const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as { audio: string; lines: string[] };
  const dir = process.env.ALIGN_MODEL_DIR || path.join(process.env.APPDATA || '', 'antigravity-video-editor', 'models', 'ko-wav2vec2');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', input.audio, '-ac', '1', '-ar', String(ALIGN_SAMPLE_RATE), '-f', 'f32le', '-'], {
    maxBuffer: 1 << 30,
  });
  if (r.status !== 0) throw new Error('ffmpeg 실패: ' + r.stderr.toString());
  const buf = r.stdout as Buffer;
  const pcm = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ort = require('onnxruntime-node');
  const vocab = JSON.parse(fs.readFileSync(path.join(dir, 'vocab.json'), 'utf8'));
  const session = await ort.InferenceSession.create(path.join(dir, 'model_int8.onnx'));
  const tokenizer = createSyllableTokenizer(vocab, { useWordDelimiter: true });
  const em = await computeEmission(async (chunk) => {
    const out = await session.run({ audio: new ort.Tensor('float32', chunk, [1, chunk.length]) });
    const [, frames, labels] = out.emission.dims as number[];
    return { data: out.emission.data as Float32Array, frames, labels };
  }, pcm);
  const duration = pcm.length / ALIGN_SAMPLE_RATE;
  if (!em) {
    process.stdout.write(JSON.stringify({ duration, lines: input.lines.map(() => null), words: [] }));
    return;
  }
  // 모든 줄의 단어를 한 번에 정렬 → 줄별로 첫 단어 시작 ~ 마지막 단어 끝
  const words: string[] = [];
  const owner: number[] = [];
  input.lines.forEach((l, i) => l.split(/\s+/).filter(Boolean).forEach((w) => (words.push(w), owner.push(i))));
  const spans = wordSpansInRange(em, 0, duration, words, tokenizer);
  const lines = input.lines.map((_, i) => {
    if (!spans) return null;
    const mine = spans.filter((s, k) => owner[k] === i && s) as Array<[number, number]>;
    return mine.length ? [+mine[0][0].toFixed(3), +mine[mine.length - 1][1].toFixed(3)] : null;
  });
  const wordOut = words.map((w, k) => {
    const sp = spans ? spans[k] : null;
    return [owner[k], w, sp ? +sp[0].toFixed(3) : null, sp ? +sp[1].toFixed(3) : null];
  });
  process.stdout.write(JSON.stringify({ duration, lines, words: wordOut }));
}

main().catch((e) => {
  process.stderr.write(String(e && e.stack ? e.stack : e));
  process.exit(1);
});
