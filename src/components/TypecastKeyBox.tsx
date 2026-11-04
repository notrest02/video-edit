/**
 * AI 음성(Typecast / ElevenLabs) API 키 상자 — STEP 0 위쪽(Claude 키 옆)과 음성 만들기가 같이 씀.
 * 저장/삭제하면 이벤트로 다른 곳도 바로 바뀐다. 키 자체는 메인 프로세스에만 있다.
 */
import React, { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import type { ElevenSubscription, TypecastSubscription } from '../types/editor';

const EVT = 'typecast-key-changed';
const EVT_ELEVEN = 'eleven-key-changed';
const input =
  'w-full bg-[#111318] border border-[#333947] focus:border-[#2d8ceb] rounded px-2 py-1.5 text-xs text-white placeholder-[#666666] focus:outline-none';
const btn = 'py-1.5 px-2.5 rounded text-[11px] font-semibold transition disabled:opacity-45';

export const notifyTypecastChanged = () => window.dispatchEvent(new Event(EVT));
export const notifyElevenChanged = () => window.dispatchEvent(new Event(EVT_ELEVEN));

/** Typecast 키 저장 여부 + 남은 크레딧 (다른 상자에서 바뀌어도 따라감). refresh 로 크레딧만 다시 읽기 */
export function useTypecastKey(): { hasKey: boolean | null; sub: TypecastSubscription | null; refresh: () => void } {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [sub, setSub] = useState<TypecastSubscription | null>(null);
  const load = async () => {
    const api = window.electronAPI;
    const s = await api?.typecastKeyStatus?.();
    setHasKey(!!s?.hasKey);
    if (s?.hasKey) {
      try {
        setSub((await api?.typecastSubscription?.()) || null);
      } catch {
        setSub(null);
      }
    } else setSub(null);
  };
  useEffect(() => {
    load();
    window.addEventListener(EVT, load);
    return () => window.removeEventListener(EVT, load);
  }, []);
  return { hasKey, sub, refresh: notifyTypecastChanged };
}

/** ElevenLabs 키 저장 여부 + 남은 크레딧 */
export function useElevenKey(): { hasKey: boolean | null; sub: ElevenSubscription | null; refresh: () => void } {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [sub, setSub] = useState<ElevenSubscription | null>(null);
  const load = async () => {
    const api = window.electronAPI;
    const s = await api?.elevenKeyStatus?.();
    setHasKey(!!s?.hasKey);
    if (s?.hasKey) {
      try {
        setSub((await api?.elevenSubscription?.()) || null);
      } catch {
        setSub(null);
      }
    } else setSub(null);
  };
  useEffect(() => {
    load();
    window.addEventListener(EVT_ELEVEN, load);
    return () => window.removeEventListener(EVT_ELEVEN, load);
  }, []);
  return { hasKey, sub, refresh: notifyElevenChanged };
}

export const TypecastKeyBox: React.FC = () => {
  const api = window.electronAPI;
  const { hasKey, sub } = useTypecastKey();
  const [open, setOpen] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [msg, setMsg] = useState('');

  const save = async () => {
    if (!keyInput.trim() || !api?.typecastSaveKey) return;
    setMsg('확인 중...');
    const r = await api.typecastSaveKey(keyInput);
    setMsg(r.message);
    if (r.ok) {
      setKeyInput('');
      setOpen(false);
      notifyTypecastChanged();
    }
  };

  const showInput = hasKey === false || open;
  return (
    <div className="rounded p-2 space-y-1 border border-[#2e3440] bg-[#14161a]">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-[#cccccc] flex items-center gap-1">
          <KeyRound className="w-3 h-3" /> Typecast API 키 <span className="text-[#777777]">(AI 음성용, 선택)</span>
        </span>
        {hasKey === true && (
          <span className="flex items-center gap-2">
            <span className="text-[#7ee787]">연결됨{sub ? ` · ${sub.plan} · 남은 ${sub.remaining.toLocaleString()}` : ''}</span>
            <button onClick={() => setOpen(!open)} className="text-[10px] text-[#888888] hover:text-white">
              {open ? '닫기' : '바꾸기'}
            </button>
          </span>
        )}
        {hasKey === false && <span className="text-[#888888]">연결 안 됨</span>}
      </div>
      {showInput && (
        <>
          {hasKey === false && (
            <div className="text-[10px] text-[#999999] leading-relaxed">
              대본으로 AI 음성을 만들 때 필요해요. Typecast API 콘솔(studio.typecast.ai/developers/api)에서 받은 키를 넣어 주세요. 웹(Studio)
              요금제와 API 요금제는 따로예요.
            </div>
          )}
          <div className="flex gap-1">
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              placeholder={hasKey ? '새 키로 바꾸려면 입력' : 'Typecast API 키'}
              className={input}
            />
            <button onClick={save} disabled={!keyInput.trim()} className={`${btn} bg-[#2d8ceb] text-white shrink-0`}>
              저장
            </button>
            {hasKey && (
              <button
                onClick={async () => {
                  await api?.typecastClearKey?.();
                  setMsg('키를 지웠습니다.');
                  setOpen(false);
                  notifyTypecastChanged();
                }}
                className={`${btn} bg-[#2b2b2b] text-[#dddddd] shrink-0`}
              >
                삭제
              </button>
            )}
          </div>
        </>
      )}
      {msg && <div className="text-[10px] text-[#aaaaaa]">{msg}</div>}
    </div>
  );
};

export const ElevenLabsKeyBox: React.FC = () => {
  const api = window.electronAPI;
  const { hasKey, sub } = useElevenKey();
  const [open, setOpen] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [msg, setMsg] = useState('');

  const save = async () => {
    if (!keyInput.trim() || !api?.elevenSaveKey) return;
    setMsg('확인 중...');
    const r = await api.elevenSaveKey(keyInput);
    setMsg(r.message);
    if (r.ok) {
      setKeyInput('');
      setOpen(false);
      notifyElevenChanged();
    }
  };

  const showInput = hasKey === false || open;
  return (
    <div className="rounded p-2 space-y-1 border border-[#2e3440] bg-[#14161a]">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-[#cccccc] flex items-center gap-1">
          <KeyRound className="w-3 h-3" /> ElevenLabs API 키 <span className="text-[#777777]">(AI 음성용, 선택)</span>
        </span>
        {hasKey === true && (
          <span className="flex items-center gap-2">
            <span className="text-[#7ee787]">
              연결됨{sub ? ` · ${sub.plan}${sub.planCredits > 0 ? ` · 남은 ${sub.remaining.toLocaleString()}자` : ''}` : ''}
            </span>
            <button onClick={() => setOpen(!open)} className="text-[10px] text-[#888888] hover:text-white">
              {open ? '닫기' : '바꾸기'}
            </button>
          </span>
        )}
        {hasKey === false && <span className="text-[#888888]">연결 안 됨</span>}
      </div>
      {showInput && (
        <>
          {hasKey === false && (
            <div className="text-[10px] text-[#999999] leading-relaxed">
              ElevenLabs로 AI 음성을 만들 때 필요해요. ElevenLabs(elevenlabs.io/app/settings/api-keys)에서 발급받은 API 키(xi-api-key)를 넣어 주세요.
            </div>
          )}
          <div className="flex gap-1">
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              placeholder={hasKey ? '새 키로 바꾸려면 입력' : 'ElevenLabs API 키 (sk_...)'}
              className={input}
            />
            <button onClick={save} disabled={!keyInput.trim()} className={`${btn} bg-[#2d8ceb] text-white shrink-0`}>
              저장
            </button>
            {hasKey && (
              <button
                onClick={async () => {
                  await api?.elevenClearKey?.();
                  setMsg('키를 지웠습니다.');
                  setOpen(false);
                  notifyElevenChanged();
                }}
                className={`${btn} bg-[#2b2b2b] text-[#dddddd] shrink-0`}
              >
                삭제
              </button>
            )}
          </div>
        </>
      )}
      {msg && <div className="text-[10px] text-[#aaaaaa]">{msg}</div>}
    </div>
  );
};
