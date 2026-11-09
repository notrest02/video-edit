import type { TimelineClip } from '../types/editor';

/**
 * 자막을 영상 컷에 맞춘 뒤: 자막 시작을 옮긴 양을 snapLead 에 누적 → '실제 목소리 시작'(startTime + snapLead)은 그대로 유지.
 * 예전엔 자동 배치가 옮겨진 자막 시작을 다시 기준으로 써서, 돌릴 때마다 컷·자막이 3프레임씩 앞당겨졌다 (2026-11-08, 규칙 R22)
 */
export function withSnapLead(before: TimelineClip[], after: TimelineClip[]): TimelineClip[] {
  const prev = new Map(before.map((c) => [c.id, c]));
  return after.map((c) => {
    const o = prev.get(c.id);
    if (!o || c.type !== 'text' || Math.abs(o.startTime - c.startTime) < 1e-6) return c;
    const lead = (o.snapLead ?? 0) + (o.startTime - c.startTime); // 반올림하지 않음 (되돌린 목소리 시작이 정확히 같아야 함)
    return { ...c, snapLead: Math.abs(lead) < 1e-4 ? undefined : lead };
  });
}

/** 자동 배치가 컷 자리를 계산할 때 쓰는 자막 시각 = 실제 목소리 시작 (snapLead 를 되돌림) */
export function voiceStartCaption<T extends Pick<TimelineClip, 'startTime' | 'duration' | 'snapLead'>>(c: T): T {
  return c.snapLead ? { ...c, startTime: c.startTime + c.snapLead, duration: Math.max(0.05, c.duration - c.snapLead) } : c;
}
