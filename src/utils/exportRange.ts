/**
 * MP4 내보내기 준비 (구간 자르기 → 영상·소리·자막 PNG·마스크 PNG → 메인 프로세스 ffmpeg).
 * 화면의 'MP4 출력'(전체·인-아웃·광고 구간별)과 자동 시험(eval_data/tmp)이 같은 코드를 쓰게 한곳에 둠 (2026-11-12).
 */
import { blurPointsAt, maskPngDataUrl } from './blurMask';
import { effectiveMasks } from './autoMask';
import { hasTextMotionKeyframes, resolveTextAt, shiftKeyframes } from './keyframes';
import { renderSubtitleClipToPngDataUrl } from './subtitleCanvasRenderer';
import { ensureFontsForValues } from './pcFonts';
import { ensureGdiClipsReady } from './gdiFonts';
import { useEditorStore } from '../store/useEditorStore';
import type { ExportCheckResult, TimelineClip } from '../types/editor';

/**
 * 렌더 구간 [rangeStart, rangeEnd) 안으로 클립을 잘라내고 0초 기준으로 당긴다.
 * 구간 밖 클립은 제외, 걸친 클립은 원본 시작점(sourceStart)도 함께 보정.
 */
export function clipToRange(c: TimelineClip, rangeStart: number, rangeEnd: number): TimelineClip | null {
  const s = Math.max(c.startTime, rangeStart);
  const e = Math.min(c.startTime + c.duration, rangeEnd);
  if (e - s < 1e-4) return null;
  return {
    ...c,
    // 앞을 잘라낸 만큼 키프레임 시각도 당김 (클립 안 시각 기준)
    keyframes: shiftKeyframes(c.keyframes, s - c.startTime),
    blurMasks: c.blurMasks?.map((m) => {
      const cut = s - c.startTime;
      return {
        ...m,
        keyframes: m.keyframes?.map((f) => ({ ...f, t: f.t - cut })),
        from: m.from !== undefined ? m.from - cut : undefined,
        to: m.to !== undefined ? m.to - cut : undefined,
      };
    }),
    startTime: s - rangeStart,
    duration: e - s,
    sourceStart:
      c.type === 'text' ? c.sourceStart : c.sourceStart + (s - c.startTime) * (c.speed && c.speed > 0 ? c.speed : 1),
  };
}

/** 지금 시퀀스의 [rangeStart, rangeEnd] 구간을 MP4 로. outputPath 를 주면 저장 창 없이 그 경로로 */
export async function exportRange(
  rangeStart: number,
  rangeEnd: number,
  outputPath?: string
): Promise<{ canceled: boolean; outputPath?: string; check?: ExportCheckResult }> {
  const { clips, tracks, sequence, fps, getTotalDuration } = useEditorStore.getState();
  const visibleTrackIds = new Set(tracks.filter((t) => t.visible !== false).map((t) => t.id));
  const audioTracks = tracks.filter((t) => t.type === 'audio');
  const anySolo = audioTracks.some((t) => t.solo);
  const activeAudioTrackIds = new Set(audioTracks.filter((t) => (anySolo ? t.solo : !t.muted)).map((t) => t.id));
  const fullDuration = getTotalDuration();
  const ranged =
    rangeStart > 0 || rangeEnd < fullDuration
      ? (clips.map((c) => clipToRange(c, rangeStart, rangeEnd)).filter(Boolean) as TimelineClip[])
      : clips;
  const outW = sequence.width || 1920;
  const outH = sequence.height || 1080;
  const f = sequence.fps || fps;
  const pick = (type: 'video' | 'audio', ok: (c: TimelineClip) => boolean) =>
    ranged
      .filter((c) => c.type === type && ok(c) && c.sourcePath)
      .map((c) => ({
        id: c.id,
        sourcePath: c.sourcePath!,
        startTime: c.startTime,
        duration: c.duration,
        sourceStart: c.sourceStart,
        speed: c.speed && c.speed > 0 ? c.speed : 1,
        volume: c.volume,
        muted: c.muted,
        ...(type === 'video'
          ? {
              scale: c.scale,
              posX: c.posX,
              posY: c.posY,
              rotation: c.rotation,
              opacity: c.opacity,
              keyframes: c.keyframes,
              // 블러 마스크 (자동 마스크는 컷 앞뒤 끝까지 늘린 계산 — 미리보기와 같음, R26)
              masks: effectiveMasks(c.blurMasks, c.duration).map((m) => ({
                png: maskPngDataUrl(blurPointsAt(m, 0, outW, outH), outW, outH, m.feather),
                blur: m.blur,
                from: m.from,
                to: m.to,
                frames: m.keyframes?.length
                  ? Array.from({ length: Math.max(1, Math.ceil(c.duration * f)) }, (_, k) => maskPngDataUrl(blurPointsAt(m, k / f, outW, outH), outW, outH, m.feather))
                  : undefined,
              })),
            }
          : {}),
      }));
  // 자막에 쓰인 내 PC 글꼴을 모두 불러온 뒤에 그려야 기본 글꼴로 렌더되지 않음 / 옛 글꼴(GDI) 윤곽선도 미리
  await ensureFontsForValues(ranged.map((c) => c.fontFamily));
  await ensureGdiClipsReady(ranged.filter((c) => c.type === 'text'));
  const subtitleOverlays = ranged
    .filter((c) => c.type === 'text' && visibleTrackIds.has(c.trackId) && c.text && c.text.trim().length > 0)
    .map((c) => ({
      id: c.id,
      startTime: c.startTime,
      endTime: c.startTime + c.duration,
      pngDataUrl: renderSubtitleClipToPngDataUrl(resolveTextAt(c, 0), outW, outH),
      // 모션 키프레임이 있는 자막: 프레임마다 그린 PNG
      frames: hasTextMotionKeyframes(c)
        ? Array.from({ length: Math.max(1, Math.ceil(c.duration * f)) }, (_, k) => renderSubtitleClipToPngDataUrl(resolveTextAt(c, k / f), outW, outH))
        : undefined,
    }))
    .filter((s) => s.pngDataUrl.length > 0);
  return window.electronAPI!.exportVideo({
    videoClips: pick('video', (c) => visibleTrackIds.has(c.trackId)),
    audioClips: pick('audio', (c) => activeAudioTrackIds.has(c.trackId)),
    subtitleOverlays,
    totalDuration: rangeEnd - rangeStart,
    fps: f,
    width: outW,
    height: outH,
    outputPath,
  });
}
