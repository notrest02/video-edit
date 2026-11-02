/**
 * 자막이 바뀌는 시점과 영상 컷이 바뀌는 시점이 맞는지 검증 (앱의 자막 나누기 코드를 그대로 사용)
 *
 * 빌드: npx esbuild tools/premiere/caption_check.ts --bundle --platform=node --outfile=tools/premiere/caption_check.cjs
 * 사용: node tools/premiere/caption_check.cjs <정답표 truth.json> <시퀀스 이름> <최대 글자수> [계획 plan.json]
 *   출력(stdout JSON): {captions: [{start, text}], cuts: [...], report}
 *
 * 앱의 자막 시점 (useEditorStore.buildAlignedSplitProvider + scriptAligner.reformatSubtitleClipsByLineMode):
 *   - 문장(대본 줄)을 splitSentenceIntoNaturalChunks(문장, 최대 글자수)로 한 줄 자막 조각으로 나눔
 *   - 각 조각이 화면에 나타나는 시점 = 그 조각 첫 단어가 발음되기 시작하는 시점 (강제 정렬, 같은 모델)
 *   - 문장 첫 조각 = 문장 첫 단어 시작 (프레임 단위로 반올림)
 *   정답표의 words 는 같은 강제 정렬 모델(align_cli)로 만든 단어 시각이라 그대로 쓴다.
 */
import fs from 'fs';
import { splitSentenceIntoNaturalChunks } from '../../src/utils/scriptAligner';

type Word = { text: string; start: number | null; end: number | null };
type Sentence = { text: string; start: number | null; end: number | null };

const FPS = 30;
const frame = (t: number) => Math.round(t * FPS) / FPS;

export function captionTimes(seq: { sentences: Sentence[]; words: Word[] }, maxChars: number) {
  const words = seq.words;
  let wi = 0;
  const caps: Array<{ start: number; text: string; sentence: number; firstWord: number }> = [];
  seq.sentences.forEach((s, si) => {
    const n = s.text.split(/\s+/).filter(Boolean).length;
    const sw = words.slice(wi, wi + n);
    const pieces = splitSentenceIntoNaturalChunks(s.text, maxChars);
    let k = 0;
    for (const p of pieces) {
      const pn = p.split(/\s+/).filter(Boolean).length;
      const w = sw.slice(k).find((x) => x.start != null);
      if (w && w.start != null) caps.push({ start: frame(w.start), text: p, sentence: si, firstWord: wi + k });
      k += pn;
    }
    wi += n;
  });
  return caps;
}

function main() {
  const [truthPath, seqName, maxCharsArg, planPath] = process.argv.slice(2);
  const truth = JSON.parse(fs.readFileSync(truthPath, 'utf8'));
  const seq = truth.sequences.find((s: { sequence: string }) => s.sequence === seqName);
  const caps = captionTimes(seq, Number(maxCharsArg || 18));
  const out: Record<string, unknown> = { captions: caps };
  if (planPath) {
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8')).plan as Array<{ start: number }>;
    const cuts = plan.map((p) => p.start).slice(1);
    out.cuts = cuts.map((t) => {
      const near = caps.reduce((a, c) => (Math.abs(c.start - t) < Math.abs(a.start - t) ? c : a), caps[0]);
      return { cut: t, caption: near.start, diffFrames: Math.round((t - near.start) * FPS), text: near.text };
    });
  }
  process.stdout.write(JSON.stringify(out));
}

if (require.main === module) main();
