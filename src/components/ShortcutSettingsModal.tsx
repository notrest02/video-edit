import React, { useEffect, useState } from 'react';
import { X, RotateCcw } from 'lucide-react';
import {
  SHORTCUT_ACTIONS,
  type ShortcutActionId,
  type ShortcutMap,
  bindingFromEvent,
  defaultShortcutMap,
  displayBinding,
  findConflict,
  getShortcutMap,
  setShortcutMap,
  setShortcutsSuspended,
} from '../utils/shortcuts';

/**
 * 키보드 단축키 설정 창
 * - [변경]을 누르고 원하는 키를 누르면 바뀜 (Esc: 취소)
 * - 같은 상황에서 이미 쓰는 키면 알려주고, [바꾸기]를 누르면 그 동작에서 빼고 이쪽에 지정
 * - 키 칩의 × 로 개별 삭제, [기본값으로] 로 전체 복원
 */
export const ShortcutSettingsModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [map, setMap] = useState<ShortcutMap>(() => getShortcutMap());
  const [capturing, setCapturing] = useState<ShortcutActionId | null>(null);
  const [captureMode, setCaptureMode] = useState<'replace' | 'add'>('replace');
  const [pending, setPending] = useState<{
    action: ShortcutActionId;
    binding: string;
    conflictWith: ShortcutActionId;
    mode: 'replace' | 'add';
  } | null>(null);
  const applyBinding = (base: ShortcutMap, action: ShortcutActionId, b: string, mode: 'replace' | 'add') => ({
    ...base,
    [action]: mode === 'replace' ? [b] : [...base[action].filter((x) => x !== b), b],
  });

  const commit = (next: ShortcutMap) => {
    setMap(next);
    setShortcutMap(next);
  };

  // 키 입력받기 (창이 열려 있는 동안 앱 단축키 정지)
  useEffect(() => {
    setShortcutsSuspended(true);
    return () => setShortcutsSuspended(false);
  }, []);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        setCapturing(null);
        return;
      }
      const b = bindingFromEvent(e);
      if (!b) return; // 보조키만 누른 상태 → 다음 키 기다림
      const conflict = findConflict(map, capturing, b);
      if (conflict) {
        setPending({ action: capturing, binding: b, conflictWith: conflict.id, mode: captureMode });
      } else {
        commit(applyBinding(map, capturing, b, captureMode));
      }
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, captureMode, map]);

  const removeBinding = (id: ShortcutActionId, b: string) =>
    commit({ ...map, [id]: map[id].filter((x) => x !== b) });

  const labelOf = (id: ShortcutActionId) => SHORTCUT_ACTIONS.find((a) => a.id === id)!.label;
  const groups = Array.from(new Set(SHORTCUT_ACTIONS.map((a) => a.group)));

  return (
    <div className="fixed inset-0 z-[120] bg-black/60 flex items-center justify-center" onMouseDown={onClose}>
      <div
        className="w-[620px] max-h-[85vh] flex flex-col bg-[#1e1e1e] border border-[#3a3a3a] rounded-lg shadow-2xl text-[12px] text-[#dddddd]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[#333333] flex items-center justify-between">
          <div>
            <div className="font-bold text-white">키보드 단축키</div>
            <div className="text-[11px] text-[#999999]">
              [변경] 또는 [+]를 누른 뒤 원하는 키를 누르세요 (Esc: 취소). 한글 자판 상태에서도 같은 자리의 키로 동작해요.
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#333333]" title="닫기">
            <X className="w-4 h-4" />
          </button>
        </div>

        {pending && (
          <div className="mx-4 mt-3 px-3 py-2 rounded bg-[#3a2f12] border border-[#7a5d1f] text-[#ffd68a] flex items-center gap-2">
            <span className="flex-1">
              <b>{displayBinding(pending.binding)}</b> 은(는) 이미 '{labelOf(pending.conflictWith)}'에 쓰고 있어요.
              바꾸면 그쪽에서는 빠져요.
            </span>
            <button
              onClick={() => {
                const base = { ...map };
                base[pending.conflictWith] = base[pending.conflictWith].filter((x) => x !== pending.binding);
                commit(applyBinding(base, pending.action, pending.binding, pending.mode));
                setPending(null);
              }}
              className="px-2 py-0.5 rounded bg-[#2d8ceb] text-white"
            >
              바꾸기
            </button>
            <button onClick={() => setPending(null)} className="px-2 py-0.5 rounded bg-[#333333]">
              취소
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-2">
          {groups.map((g) => (
            <div key={g} className="mb-3">
              <div className="text-[11px] font-semibold text-[#79b8ff] mb-1">{g}</div>
              {SHORTCUT_ACTIONS.filter((a) => a.group === g).map((a) => (
                <div key={a.id} className="flex items-center gap-2 py-1 border-b border-[#2a2a2a]">
                  <span className="flex-1 truncate">{a.label}</span>
                  <div className="flex items-center gap-1 flex-wrap justify-end">
                    {map[a.id].length === 0 && <span className="text-[#666666]">없음</span>}
                    {map[a.id].map((b) => (
                      <span
                        key={b}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#2b2b2b] border border-[#444444] font-mono text-[11px]"
                      >
                        {displayBinding(b)}
                        <button
                          onClick={() => removeBinding(a.id, b)}
                          className="text-[#888888] hover:text-[#ff8080]"
                          title="이 키 빼기"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                  {(['replace', 'add'] as const).map((mode) => {
                    const active = capturing === a.id && captureMode === mode;
                    return (
                      <button
                        key={mode}
                        onClick={() => {
                          setPending(null);
                          if (active) {
                            setCapturing(null);
                          } else {
                            setCaptureMode(mode);
                            setCapturing(a.id);
                          }
                        }}
                        title={mode === 'replace' ? '이 동작의 키를 새 키 하나로 바꾸기' : '키를 하나 더 추가하기'}
                        className={`shrink-0 px-2 py-0.5 rounded border text-[11px] ${
                          mode === 'replace' ? 'w-[64px]' : 'w-[28px]'
                        } ${
                          active
                            ? 'bg-[#2d8ceb] border-[#2d8ceb] text-white animate-pulse'
                            : 'bg-[#262626] border-[#3a3a3a] hover:bg-[#333333]'
                        }`}
                      >
                        {active ? '…' : mode === 'replace' ? '변경' : '+'}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="px-4 py-2.5 border-t border-[#333333] flex items-center justify-between">
          <button
            onClick={() => {
              commit(defaultShortcutMap());
              setPending(null);
            }}
            className="px-2.5 py-1 rounded bg-[#262626] border border-[#3a3a3a] hover:bg-[#333333] flex items-center gap-1"
          >
            <RotateCcw className="w-3.5 h-3.5" /> 기본값으로
          </button>
          <button onClick={onClose} className="px-3 py-1 rounded bg-[#2d8ceb] hover:bg-[#1e78d6] text-white">
            완료
          </button>
        </div>
      </div>
    </div>
  );
};
