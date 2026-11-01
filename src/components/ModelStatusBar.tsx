import React, { useEffect, useState } from 'react';
import type { AlignModelStatus } from '../types/editor';

/**
 * 정렬 모델(자막 위치 정밀 맞춤용) 다운로드 상태 표시줄.
 * 모델이 준비되면 숨고, 받는 중/실패일 때만 상단에 나타난다.
 */
export const ModelStatusBar: React.FC = () => {
  const [status, setStatus] = useState<AlignModelStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.modelGetStatus) return;
    api.modelGetStatus().then(setStatus).catch(() => {});
    const off = api.onModelStatus?.((s) => setStatus(s));
    return () => off?.();
  }, []);

  if (!status || status.state === 'ready') return null;

  const retry = async () => {
    setNote(null);
    setBusy(true);
    try {
      setStatus(await window.electronAPI!.modelEnsure!());
    } finally {
      setBusy(false);
    }
  };
  const importFile = async () => {
    setBusy(true);
    try {
      const r = await window.electronAPI!.modelImportDialog!();
      setNote(r.message);
      if (r.status) setStatus(r.status);
    } finally {
      setBusy(false);
    }
  };

  let text = '';
  let pct: number | null = null;
  if (status.state === 'missing') text = '자막 위치 정밀 맞춤 모델 준비 중...';
  if (status.state === 'downloading') {
    pct = status.total > 0 ? Math.min(100, (status.received / status.total) * 100) : null;
    text = `자막 위치 정밀 맞춤 모델 받는 중 (${status.attempt}/${status.maxAttempts}번째 시도) · ${(
      status.received / 1e6
    ).toFixed(0)} / ${(status.total / 1e6).toFixed(0)} MB`;
  }
  if (status.state === 'verifying') text = `받은 파일 확인 중 (${status.file})...`;
  const failed = status.state === 'failed';
  if (failed) text = status.message;

  return (
    <div
      className={`shrink-0 px-3 py-1.5 text-[11px] flex items-center gap-3 border-b ${
        failed ? 'bg-[#3a1d1d] border-[#7a2f2f] text-[#ffb4b4]' : 'bg-[#1b2838] border-[#2d4a6b] text-[#9cc9ff]'
      }`}
    >
      <span className="truncate">{text}</span>
      {pct !== null && (
        <div className="w-40 h-1.5 bg-black/40 rounded overflow-hidden shrink-0">
          <div className="h-full bg-[#2d8ceb]" style={{ width: `${pct}%` }} />
        </div>
      )}
      {note && <span className="text-[#dddddd] truncate">{note}</span>}
      {failed && (
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button
            disabled={busy}
            onClick={retry}
            className="px-2 py-0.5 rounded bg-[#2d8ceb] hover:bg-[#1e78d6] text-white disabled:opacity-50"
          >
            다시 시도
          </button>
          <button
            disabled={busy}
            onClick={importFile}
            title="다른 PC에서 받은 model_int8.onnx, vocab.json 을 직접 선택 (확인값 검사 후 설치)"
            className="px-2 py-0.5 rounded bg-[#333333] hover:bg-[#444444] text-white disabled:opacity-50"
          >
            모델 파일 직접 선택
          </button>
        </div>
      )}
    </div>
  );
};
