/**
 * 정렬 모델 첫 실행 다운로드 (메인 프로세스)
 *
 * - 최대 3번 시도. 시도 사이에 받은 부분(.part)은 유지하고 끊긴 지점부터 이어받기(HTTP Range)
 * - 구글 드라이브의 "바이러스 검사 불가" 확인 화면(큰 파일)을 자동으로 넘김
 * - 다 받은 뒤 SHA-256 으로 원본과 같은지 검사 → 다르면 지우고 다음 시도에서 처음부터
 * - 3번 모두 실패하면 'failed' 상태로 멈춤 (이전 방식으로 대체하지 않음).
 *   사용자는 [다시 시도] 또는 [모델 파일 직접 선택]으로 진행
 */
import { net } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export type ModelFileSpec = {
  name: string;
  size: number;
  sha256: string;
  /** 받을 주소 후보 (앞에서부터 차례로 사용). 'gdrive:<파일ID>' 형식은 구글 드라이브 직접 다운로드로 변환 */
  sources: string[];
};

export type ModelStatus =
  | { state: 'ready' }
  | { state: 'missing' }
  | {
      state: 'downloading';
      attempt: number;
      maxAttempts: number;
      file: string;
      received: number;
      total: number;
    }
  | { state: 'verifying'; file: string }
  | { state: 'failed'; message: string };

export const MAX_ATTEMPTS = 3;

function resolveSource(src: string): string {
  const m = src.match(/^gdrive:(.+)$/);
  if (m) {
    return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(m[1])}&export=download&confirm=t`;
  }
  return src;
}

/** 구글 드라이브 확인 화면(HTML)에서 실제 다운로드 주소를 꺼냄 */
function confirmUrlFromHtml(html: string, fallbackUrl: string): string | null {
  const form = html.match(/<form[^>]+action="([^"]+)"[\s\S]*?<\/form>/i);
  if (!form) return null;
  const action = form[1].replace(/&amp;/g, '&');
  const params = new URLSearchParams();
  const inputRe = /<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi;
  let mm: RegExpExecArray | null;
  while ((mm = inputRe.exec(form[0]))) params.set(mm[1], mm[2].replace(/&amp;/g, '&'));
  if (![...params.keys()].length) return null;
  try {
    const u = new URL(action, fallbackUrl);
    params.forEach((v, k) => u.searchParams.set(k, v));
    return u.toString();
  } catch {
    return null;
  }
}

async function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

export class ModelDownloader {
  private status: ModelStatus;
  private running: Promise<ModelStatus> | null = null;

  constructor(
    private dir: string,
    private files: ModelFileSpec[],
    private onStatus: (s: ModelStatus) => void
  ) {
    this.status = this.isInstalled() ? { state: 'ready' } : { state: 'missing' };
  }

  getStatus(): ModelStatus {
    return this.status;
  }

  isInstalled(): boolean {
    return this.files.every((f) => {
      const p = path.join(this.dir, f.name);
      return fs.existsSync(p) && fs.statSync(p).size === f.size;
    });
  }

  private set(s: ModelStatus) {
    this.status = s;
    this.onStatus(s);
  }

  /** 모델이 준비될 때까지 다운로드 (최대 3번 시도). 이미 진행 중이면 그 결과를 기다림 */
  ensure(): Promise<ModelStatus> {
    if (this.status.state === 'ready' && this.isInstalled()) return Promise.resolve(this.status);
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<ModelStatus> {
    fs.mkdirSync(this.dir, { recursive: true });
    let lastError = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        for (const f of this.files) {
          const dest = path.join(this.dir, f.name);
          if (fs.existsSync(dest) && fs.statSync(dest).size === f.size) continue;
          await this.downloadFile(f, attempt);
          this.set({ state: 'verifying', file: f.name });
          const part = dest + '.part';
          const hash = await sha256Of(part);
          if (hash !== f.sha256) {
            fs.rmSync(part, { force: true });
            throw new Error(`${f.name} 파일이 손상되었습니다 (확인값 불일치)`);
          }
          fs.renameSync(part, dest);
        }
        this.set({ state: 'ready' });
        return this.status;
      } catch (err: any) {
        lastError = err?.message || String(err);
        console.warn(`[model] attempt ${attempt}/${MAX_ATTEMPTS} failed:`, lastError);
        if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    this.set({
      state: 'failed',
      message: `정렬 모델 다운로드에 ${MAX_ATTEMPTS}번 실패했습니다. (${lastError}) 인터넷 연결을 확인한 뒤 [다시 시도]하거나, 받아둔 모델 파일을 [직접 선택]해 주세요.`,
    });
    return this.status;
  }

  private async downloadFile(f: ModelFileSpec, attempt: number): Promise<void> {
    const part = path.join(this.dir, f.name + '.part');
    let lastErr: unknown = null;
    for (const src of f.sources) {
      try {
        await this.fetchToPart(resolveSource(src), part, f, attempt);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async fetchToPart(url: string, part: string, f: ModelFileSpec, attempt: number, depth = 0): Promise<void> {
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (have > f.size) {
      fs.rmSync(part, { force: true });
      have = 0;
    }
    if (have === f.size) return;
    const res = await net.fetch(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {} });
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/html')) {
      // 구글 드라이브 확인 화면 → 실제 주소로 한 번 더
      const html = await res.text();
      const next = depth < 2 ? confirmUrlFromHtml(html, url) : null;
      if (!next) {
        if (/quota|할당량|too many users/i.test(html)) throw new Error('구글 드라이브 다운로드 한도를 초과했습니다');
        throw new Error('다운로드 주소에서 파일 대신 웹페이지가 왔습니다');
      }
      return this.fetchToPart(next, part, f, attempt, depth + 1);
    }
    if (res.status !== 200 && res.status !== 206) throw new Error(`서버 응답 ${res.status}`);
    if (res.status === 200 && have > 0) {
      // 서버가 이어받기를 지원하지 않음 → 처음부터
      fs.rmSync(part, { force: true });
      have = 0;
    }
    if (!res.body) throw new Error('응답 본문이 없습니다');
    const out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
    const reader = res.body.getReader();
    let received = have;
    let lastReport = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        received += value.byteLength;
        const now = Date.now();
        if (now - lastReport > 200) {
          lastReport = now;
          this.set({ state: 'downloading', attempt, maxAttempts: MAX_ATTEMPTS, file: f.name, received, total: f.size });
        }
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }
    this.set({ state: 'downloading', attempt, maxAttempts: MAX_ATTEMPTS, file: f.name, received, total: f.size });
    if (received !== f.size) throw new Error(`${f.name} 다운로드가 중간에 끊겼습니다 (${received}/${f.size} 바이트)`);
  }

  /** 사용자가 고른 파일을 확인값 검사 후 설치 */
  async importFile(srcPath: string): Promise<{ ok: boolean; message: string }> {
    const base = path.basename(srcPath);
    const spec = this.files.find((f) => f.name === base) || this.files.find((f) => fs.statSync(srcPath).size === f.size);
    if (!spec) return { ok: false, message: `알 수 없는 파일입니다: ${base}` };
    const hash = await sha256Of(srcPath);
    if (hash !== spec.sha256) return { ok: false, message: `${base} 확인값이 원본과 다릅니다` };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.copyFileSync(srcPath, path.join(this.dir, spec.name));
    if (this.isInstalled()) this.set({ state: 'ready' });
    else this.set({ state: 'missing' });
    return { ok: true, message: `${spec.name} 설치 완료` };
  }
}
