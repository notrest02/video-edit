/**
 * Claude API 키 상자 — STEP 0 대본 만들기와 STEP 3 AI 자동 배치가 같이 쓴다.
 * 한쪽에서 저장/삭제하면 'claude-key-changed' 이벤트로 다른 쪽도 바로 바뀐다. 키 자체는 메인 프로세스에만 있다.
 */
import React, { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';

const EVT = 'claude-key-changed';
const input =
  'w-full bg-[#111318] border border-[#333947] focus:border-[#2d8ceb] rounded px-2 py-1.5 text-xs text-white placeholder-[#666666] focus:outline-none';
const btn = 'py-1.5 px-2.5 rounded text-[11px] font-semibold transition disabled:opacity-45';

/** 키 저장 여부 (다른 상자에서 바뀌어도 따라감) */
export function useClaudeKey(): boolean | null {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  useEffect(() => {
    const refresh = () => window.electronAPI?.claudeKeyStatus?.().then((s) => setHasKey(s.hasKey));
    refresh();
    window.addEventListener(EVT, refresh);
    return () => window.removeEventListener(EVT, refresh);
  }, []);
  return hasKey;
}

export const ClaudeKeyBox: React.FC<{ usedFor: string }> = ({ usedFor }) => {
  const api = window.electronAPI;
  const hasKey = useClaudeKey();
  const [open, setOpen] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [msg, setMsg] = useState('');
  const changed = () => window.dispatchEvent(new Event(EVT));

  const save = async () => {
    if (!keyInput.trim() || !api?.claudeSaveKey) return;
    setMsg('확인 중...');
    const r = await api.claudeSaveKey(keyInput);
    setMsg(r.message);
    if (r.ok) {
      setKeyInput('');
      setOpen(false);
      changed();
    }
  };

  const showInput = hasKey === false || open;
  return (
    <div className={`rounded p-2 space-y-1 border ${hasKey === false ? 'border-[#ff9b9b]/50 bg-[#2a1a1a]' : 'border-[#2e3440] bg-[#14161a]'}`}>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-[#cccccc] flex items-center gap-1">
          <KeyRound className="w-3 h-3" /> Claude API 키
        </span>
        {hasKey === true && (
          <span className="flex items-center gap-2">
            <span className="text-[#7ee787]">연결됨</span>
            <button onClick={() => setOpen(!open)} className="text-[10px] text-[#888888] hover:text-white">
              {open ? '닫기' : '바꾸기'}
            </button>
          </span>
        )}
        {hasKey === false && <span className="text-[#ff9b9b]">연결 안 됨</span>}
      </div>
      {hasKey === false && (
        <div className="text-[10px] text-[#ffb4b4] leading-relaxed">
          {usedFor}은(는) Claude API 키가 있어야 쓸 수 있어요. 키를 한 번 넣으면 대본 만들기와 AI 자동 배치에 같이 쓰여요.
        </div>
      )}
      {showInput && (
        <div className="flex gap-1">
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            placeholder={hasKey ? '새 키로 바꾸려면 입력' : 'sk-ant-...'}
            className={input}
          />
          <button onClick={save} disabled={!keyInput.trim()} className={`${btn} bg-[#2d8ceb] text-white shrink-0`}>
            저장
          </button>
          {hasKey && (
            <button
              onClick={async () => {
                await api?.claudeClearKey?.();
                setMsg('키를 지웠습니다.');
                setOpen(false);
                changed();
              }}
              className={`${btn} bg-[#2b2b2b] text-[#dddddd] shrink-0`}
            >
              삭제
            </button>
          )}
        </div>
      )}
      {msg && <div className="text-[10px] text-[#aaaaaa]">{msg}</div>}
    </div>
  );
};
