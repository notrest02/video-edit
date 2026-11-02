/**
 * 자막이 바뀌는 시점과 영상 컷이 바뀌는 시점이 맞는지 검증 (앱의 자막 나누기 코드를 그대로 사용)
 *
 * 빌드: npx esbuild tools/premiere/caption_check.ts --bundle --platform=node --outfile=tools/premiere/caption_check.cjs
 * 사용: node tools/premiere/caption_check.cjs <정답표 truth.json> <시퀀스 이름> <최대 글자수> [계획 plan.json]
 *   출력(stdout JSON): {captions: [{start, text}], cuts: [...], report}
 *
 * 앱의 자막 시점 (useEditorStore.buildAlignedSplitProvider + scriptAligner.reformatSubtitleClipsByLineMode):
 *   - 문장(대본 줄)이 splitSentenceIntoNaturalChunks(문장, 최대 글자수)로 2조각 이상이면
 *     강제 정렬 단어 시각의 말 쉼으로 splitWordsByPauses 가 한 줄 경계를 다시 고름 (2026-11-02 개선)
 *   - 각 조각이 화면에 나타나는 시점 = 그 조각 첫 단어가 발음되기 시작하는 시점 (강제 정렬, 같은 모델)
 *   - 문장 첫 조각 = 문장 첫 단어 시작 (프레임 단위로 반올림)
 *   정답표의 words 는 같은 강제 정렬 모델(align_cli)로 만든 단어 시각이라 그대로 쓴다.
 */
import fs from 'fs';
import { splitSentenceIntoNaturalChunks, splitWordsByPauses } from '../../src/utils/scriptAligner';
import { snapSubtitleClipsToMediaCuts } from '../../src/utils/subtitleSnapper';

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
    let pieces = splitSentenceIntoNaturalChunks(s.text, maxChars);
    if (pieces.length > 1 && process.env.CAPTION_SPLIT !== 'chars') {
      const toks = s.text.split(/\s+/).filter(Boolean);
      const gaps = toks.map((_, k) => {
        const a = sw[k - 1];
        const b = sw[k];
        return k > 0 && a && b && a.end != null && b.start != null ? b.start - a.end : null;
      });
      const br = splitWordsByPauses(toks, gaps, maxChars);
      const cuts = [0, ...br, toks.length];
      pieces = cuts.slice(0, -1).map((a, j) => toks.slice(a, cuts[j + 1]).join(' '));
    }
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
  if (planPath && process.argv.includes('--snap')) {
    // 앱의 '클립에 자막 맞추기'(snapSubtitleClipsToMediaCuts, 앱 기본 ±6프레임)를 그대로 돌려 결과 확인
    // 타임라인: 영상 클립 = 계획, 음성 = TTS 한 덩어리, 자막 = 위 자막 조각 (다음 자막 시작까지)
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8')).plan as Array<{ start: number; end: number }>;
    const total = seq.duration as number;
    const mk = (id: string, type: string, trackId: string, start: number, end: number) =>
      ({ id, type, trackId, startTime: start, duration: end - start }) as never;
    const clips = [
      ...plan.map((p, i) => mk(`v${i}`, 'video', 'V1', p.start, p.end)),
      mk('a0', 'audio', 'A1', 0, total),
      ...caps.map((c, i) => mk(`t${i}`, 'text', 'T1', c.start, i + 1 < caps.length ? caps[i + 1].start : total)),
    ];
    const res = snapSubtitleClipsToMediaCuts(clips, { thresholdFrames: 6, fps: FPS, closeMicroGaps: true, alignClipdominantSubtitles: true });
    const after = (res.updatedClips as unknown as Array<{ id: string; startTime: number; duration: number }>)
      .filter((c) => c.id.startsWith('t'))
      .sort((a, b) => a.startTime - b.startTime);
    const cuts = plan.map((p) => p.start).slice(1);
    const capStarts = after.map((c) => c.startTime);
    out.snap = {
      cutsMatched: cuts.map((t) => {
        const near = capStarts.reduce((a, c) => (Math.abs(c - t) < Math.abs(a - t) ? c : a), capStarts[0]);
        return Math.round((t - near) * FPS);
      }),
      moved: after.map((c, i) => Math.round((c.startTime - caps[i].start) * FPS)),
      overlapsOrGaps: after.slice(1).filter((c, i) => Math.abs(after[i].startTime + after[i].duration - c.startTime) > 0.001).length,
    };
  }
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
