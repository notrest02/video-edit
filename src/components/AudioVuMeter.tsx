import React, { useEffect, useRef } from 'react';
import { useEditorStore } from '../store/useEditorStore';
import { getInstantAudioLevelAtTime, normalizeAudioPath } from './AudioWaveformCanvas';

/**
 * 프리미어 프로 스타일 고성능 실시간 스테레오 dB 오디오 레벨 미터 (VU Meter)
 * - React state 리렌더링 없이 Direct DOM 조작으로 60fps 부드러운 반응 보장
 * - 오디오 클립([A]) 및 비디오 클립([V])의 실제 사운드 신호와 1:1로 실시간 연동
 * - 소리가 없거나 정지 상태에서는 바닥(0%)으로 싹 가라앉고, 소리가 날 때 파형과 똑같이 치솟음
 */
export const AudioVuMeter: React.FC = () => {
  const leftBarRef = useRef<HTMLDivElement | null>(null);
  const rightBarRef = useRef<HTMLDivElement | null>(null);
  const peakHoldLRef = useRef<HTMLDivElement | null>(null);
  const peakHoldRRef = useRef<HTMLDivElement | null>(null);
  const badgeLRef = useRef<HTMLSpanElement | null>(null);
  const badgeRRef = useRef<HTMLSpanElement | null>(null);

  const levelsRef = useRef({
    l: 0,
    r: 0,
    holdL: 0,
    holdR: 0,
    holdTimerL: 0,
    holdTimerR: 0,
  });

  useEffect(() => {
    let animId: number;

    const tick = () => {
      const state = useEditorStore.getState();
      const currTime = state.currentTime;
      const playing = state.isPlaying;

      // 1. 현재 재생 중인 오디오가 있는 클립 탐색 (오디오 트랙 + 비디오 트랙 모두 포함!)
      const activeClips = state.clips.filter((c) => {
        if (!c.sourcePath || c.volume <= 0) return false;
        if (currTime < c.startTime || currTime >= c.startTime + c.duration) return false;

        const track = state.tracks.find((t) => t.id === c.trackId);
        if (!track || track.muted) return false;

        // 비디오 클립의 경우 자체 음소거가 아니어야 함
        if (c.type === 'video') return !c.muted;
        // 오디오 클립의 경우 음소거가 아니어야 함
        if (c.type === 'audio') return !c.muted;

        return false;
      });

      let maxPeak = 0;
      let maxRms = 0;

      for (const clip of activeClips) {
        if (!clip.sourcePath) continue;
        const sourceTime = clip.sourceStart + (currTime - clip.startTime);
        const lvl = getInstantAudioLevelAtTime(clip.sourcePath, sourceTime, clip.volume, clip.muted);
        if (lvl.peak > maxPeak) maxPeak = lvl.peak;
        if (lvl.rms > maxRms) maxRms = lvl.rms;
      }

      // 2. 소리 크기에 따른 목표 레벨 계산 (부드러운 방송용 표준 VU 미터 볼리스틱)
      // - 메인 바(컬러): 사람 귀가 체감하는 지속 음량(RMS) 위주로 부드럽고 차분하게 표현
      // - 피크 라인(흰색 선): 순간 피크를 잡아 1초 이상 상단에 안정적으로 유지
      let targetVuL = 0;
      let targetVuR = 0;
      let targetPeakPctL = 0;
      let targetPeakPctR = 0;

      if (playing && activeClips.length > 0) {
        // 음절별 급격한 요동을 없애기 위해 RMS(지속 음량) 비중을 대폭 높임
        const perceivedLevel = Math.min(1.0, maxRms * 1.75 + maxPeak * 0.12);

        if (perceivedLevel > 0.008) {
          // 데시벨 근사 커브 (0 ~ 1 -> 0% ~ 96%)
          const dbRatio = Math.pow(perceivedLevel, 0.62);
          targetVuL = Math.min(96, Math.max(2, dbRatio * 94));
          // 스테레오 자연스러운 미세 편차
          targetVuR = Math.min(96, Math.max(2, dbRatio * 92 + (targetVuL % 3)));
        }

        if (maxPeak > 0.01) {
          const peakRatio = Math.pow(maxPeak, 0.62);
          targetPeakPctL = Math.min(98, Math.round(peakRatio * 96));
          targetPeakPctR = Math.min(98, Math.round(peakRatio * 95));
        }
      }

      const cur = levelsRef.current;

      // 3. 차분하고 안정적인 볼리스틱 (아날로그 VU 미터의 300ms 통합 적분 모델)
      // - 올라갈 때(Attack): 급격히 치솟지 않고 150~250ms에 걸쳐 묵직하고 부드럽게 상승 (0.82 : 0.18)
      // - 내려갈 때(Decay/Release): 말 한마디마다 바닥으로 곤두박질치지 않고 0.972 배율로 천천히 유려하게 하강 (~1초)
      if (targetVuL > cur.l) {
        cur.l = cur.l * 0.82 + targetVuL * 0.18;
      } else {
        cur.l = Math.max(0, cur.l * 0.972 - 0.06);
      }

      if (targetVuR > cur.r) {
        cur.r = cur.r * 0.82 + targetVuR * 0.18;
      } else {
        cur.r = Math.max(0, cur.r * 0.972 - 0.06);
      }

      // 4. Peak Hold (피크 홀드 라인: 최고점을 75프레임(~1.25초)간 안정적으로 머문 뒤 천천히 하강)
      if (targetPeakPctL >= cur.holdL) {
        cur.holdL = targetPeakPctL;
        cur.holdTimerL = 75; // ~1.25초 유지
      } else {
        if (cur.holdTimerL > 0) {
          cur.holdTimerL--;
        } else {
          cur.holdL = Math.max(cur.l, cur.holdL * 0.965);
        }
      }

      if (targetPeakPctR >= cur.holdR) {
        cur.holdR = targetPeakPctR;
        cur.holdTimerR = 75;
      } else {
        if (cur.holdTimerR > 0) {
          cur.holdTimerR--;
        } else {
          cur.holdR = Math.max(cur.r, cur.holdR * 0.965);
        }
      }

      // 4. React 리렌더링 없이 Direct DOM 스타일 직접 업데이트 (초당 60~120fps 즉각 반응)
      if (leftBarRef.current) {
        leftBarRef.current.style.height = `${Math.round(cur.l)}%`;
      }
      if (rightBarRef.current) {
        rightBarRef.current.style.height = `${Math.round(cur.r)}%`;
      }

      if (peakHoldLRef.current) {
        if (cur.holdL > 4) {
          peakHoldLRef.current.style.display = 'block';
          peakHoldLRef.current.style.bottom = `${Math.round(cur.holdL)}%`;
        } else {
          peakHoldLRef.current.style.display = 'none';
        }
      }

      if (peakHoldRRef.current) {
        if (cur.holdR > 4) {
          peakHoldRRef.current.style.display = 'block';
          peakHoldRRef.current.style.bottom = `${Math.round(cur.holdR)}%`;
        } else {
          peakHoldRRef.current.style.display = 'none';
        }
      }

      if (badgeLRef.current) {
        if (cur.l > 2) {
          badgeLRef.current.className = 'px-1 rounded bg-[#2ea043] text-white transition-colors';
        } else {
          badgeLRef.current.className = 'px-1 rounded bg-[#222222] text-[#666666] transition-colors';
        }
      }

      if (badgeRRef.current) {
        if (cur.r > 2) {
          badgeRRef.current.className = 'px-1 rounded bg-[#2ea043] text-white transition-colors';
        } else {
          badgeRRef.current.className = 'px-1 rounded bg-[#222222] text-[#666666] transition-colors';
        }
      }

      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, []); // 의존성 빈 배열로 언마운트 시까지 안정적 60fps 루프 보장!

  return (
    <div className="w-14 shrink-0 bg-[#141414] border-l border-[#111111] p-1.5 flex flex-col justify-between items-center select-none">
      <div className="flex-1 w-full flex gap-1">
        {/* L / R 레벨 미터 바 컨테이너 */}
        <div className="flex-1 bg-[#0a0a0a] border border-[#262626] rounded-xs flex gap-[2px] p-[2px] items-end relative overflow-hidden">
          {/* L 채널 */}
          <div className="flex-1 h-full flex items-end relative">
            <div
              ref={leftBarRef}
              style={{ height: '0%' }}
              className="w-full bg-gradient-to-t from-[#3fb950] via-[#d29922] to-[#f85149]"
            />
            <div
              ref={peakHoldLRef}
              style={{ display: 'none', bottom: '0%' }}
              className="absolute inset-x-0 h-[1.5px] bg-white pointer-events-none shadow-xs"
            />
          </div>

          {/* R 채널 */}
          <div className="flex-1 h-full flex items-end relative">
            <div
              ref={rightBarRef}
              style={{ height: '0%' }}
              className="w-full bg-gradient-to-t from-[#3fb950] via-[#d29922] to-[#f85149]"
            />
            <div
              ref={peakHoldRRef}
              style={{ display: 'none', bottom: '0%' }}
              className="absolute inset-x-0 h-[1.5px] bg-white pointer-events-none shadow-xs"
            />
          </div>
        </div>

        {/* dB 눈금 */}
        <div className="flex flex-col justify-between text-[9px] font-mono text-[#777777] py-0.5 pointer-events-none">
          <span>0</span>
          <span>-6</span>
          <span>-12</span>
          <span>-18</span>
          <span>-24</span>
          <span>-30</span>
          <span>-36</span>
          <span>-42</span>
          <span>-48</span>
          <span>-54</span>
          <span className="text-[#999999]">dB</span>
        </div>
      </div>

      {/* 하단 스테레오(S S) 인디케이터 */}
      <div className="flex gap-1 pt-1 text-[9px] font-bold text-[#888888]">
        <span ref={badgeLRef} className="px-1 bg-[#222222] text-[#666666] rounded">
          S
        </span>
        <span ref={badgeRRef} className="px-1 bg-[#222222] text-[#666666] rounded">
          S
        </span>
      </div>
    </div>
  );
};
