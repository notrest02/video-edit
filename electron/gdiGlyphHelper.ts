/**
 * GDI 글꼴 윤곽선 추출 서비스 (메인 프로세스 전용)
 *
 * 일부 옛 한글 글꼴(a개똥벌레, a뉴굴림 등)은 Windows 에는 정상 설치돼 있지만
 * Chromium 이 글꼴 파일 형식을 거부해 앱 화면/렌더에 표시할 수 없다.
 * Windows GDI+ 는 이 글꼴을 그릴 수 있으므로, 글자별 윤곽선(SVG path)과 글자 폭을 GDI+ 로 뽑아
 * 렌더러가 canvas Path2D 로 직접 그리게 한다 (외곽선/그림자/색은 기존 자막 렌더 로직 그대로 적용).
 *
 * PowerShell 프로세스 하나를 계속 띄워두고 한 줄 JSON 요청/응답으로 통신한다.
 * 한글 인코딩 문제를 피하려고 글자와 글꼴 이름은 코드포인트 숫자 배열로 주고받는다.
 */
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';

const CSHARP_SOURCE = `
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Globalization;
using System.Text;

public static class AgGdiGlyphs {
  static string F(float v) { return v.ToString("0.##", CultureInfo.InvariantCulture); }

  static string FromCps(int[] cps) {
    var sb = new StringBuilder();
    foreach (var cp in cps) sb.Append(char.ConvertFromUtf32(cp));
    return sb.ToString();
  }

  public static string Check(int[] familyCps) {
    try { using (var ff = new FontFamily(FromCps(familyCps))) { return "true"; } }
    catch { return "false"; }
  }

  public static string Glyphs(int[] familyCps, int style, int[] cps) {
    string family = FromCps(familyCps);
    using (var ff = new FontFamily(family)) {
      var fs = (FontStyle)style;
      bool synthetic = false;
      if (!ff.IsStyleAvailable(fs)) {
        synthetic = (style & 1) != 0;
        fs = ff.IsStyleAvailable(FontStyle.Regular) ? FontStyle.Regular : fs;
      }
      const float em = 100f;
      float emH = ff.GetEmHeight(fs);
      float asc = ff.GetCellAscent(fs) * em / emH;
      float desc = ff.GetCellDescent(fs) * em / emH;
      var fmt = (StringFormat)StringFormat.GenericTypographic.Clone();
      fmt.FormatFlags |= StringFormatFlags.MeasureTrailingSpaces;
      var sb = new StringBuilder();
      sb.Append("{\\"asc\\":").Append(F(asc)).Append(",\\"desc\\":").Append(F(desc));
      sb.Append(",\\"synthBold\\":").Append(synthetic ? "true" : "false").Append(",\\"glyphs\\":[");
      using (var bmp = new Bitmap(1, 1))
      using (var g = Graphics.FromImage(bmp))
      using (var font = new Font(ff, em, fs, GraphicsUnit.Pixel)) {
        g.TextRenderingHint = TextRenderingHint.AntiAlias;
        for (int k = 0; k < cps.Length; k++) {
          string ch = char.ConvertFromUtf32(cps[k]);
          float adv = g.MeasureString(ch, font, PointF.Empty, fmt).Width;
          var d = new StringBuilder();
          using (var gp = new GraphicsPath()) {
            gp.AddString(ch, ff, (int)fs, em, new PointF(0, 0), fmt);
            if (gp.PointCount > 0) {
              var pts = gp.PathPoints;
              var types = gp.PathTypes;
              int i = 0;
              while (i < pts.Length) {
                int t = types[i] & 0x07;
                if (t == 0) {
                  d.Append('M').Append(F(pts[i].X)).Append(' ').Append(F(pts[i].Y));
                  if ((types[i] & 0x80) != 0) d.Append('Z');
                  i++;
                } else if (t == 1) {
                  d.Append('L').Append(F(pts[i].X)).Append(' ').Append(F(pts[i].Y));
                  if ((types[i] & 0x80) != 0) d.Append('Z');
                  i++;
                } else if (t == 3 && i + 2 < pts.Length) {
                  d.Append('C')
                   .Append(F(pts[i].X)).Append(' ').Append(F(pts[i].Y)).Append(' ')
                   .Append(F(pts[i + 1].X)).Append(' ').Append(F(pts[i + 1].Y)).Append(' ')
                   .Append(F(pts[i + 2].X)).Append(' ').Append(F(pts[i + 2].Y));
                  if ((types[i + 2] & 0x80) != 0) d.Append('Z');
                  i += 3;
                } else {
                  i++;
                }
              }
            }
          }
          if (k > 0) sb.Append(',');
          sb.Append("{\\"cp\\":").Append(cps[k]).Append(",\\"adv\\":").Append(F(adv)).Append(",\\"d\\":\\"").Append(d.ToString()).Append("\\"}");
        }
      }
      sb.Append("]}");
      return sb.ToString();
    }
  }
}
`;

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$src = Get-Content -LiteralPath $args[0] -Raw -Encoding UTF8
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition $src
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $id = 0
  try {
    $req = $line | ConvertFrom-Json
    $id = [int]$req.id
    $fam = [int[]]@($req.family)
    if ($req.op -eq 'check') {
      $out = [AgGdiGlyphs]::Check($fam)
    } else {
      $out = [AgGdiGlyphs]::Glyphs($fam, [int]$req.style, [int[]]@($req.cps))
    }
    [Console]::Out.WriteLine('{"id":' + $id + ',"ok":true,"data":' + $out + '}')
  } catch {
    [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false}')
  }
  [Console]::Out.Flush()
}
`;

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class GdiGlyphService {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';

  constructor(private workDir: string) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      fs.mkdirSync(this.workDir, { recursive: true });
      const csPath = path.join(this.workDir, 'AgGdiGlyphs.cs');
      const psPath = path.join(this.workDir, 'gdi-glyph-helper.ps1');
      fs.writeFileSync(csPath, CSHARP_SOURCE, 'utf8');
      fs.writeFileSync(psPath, '﻿' + PS_SCRIPT, 'utf8');
      const proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath, csPath],
        { windowsHide: true }
      );
      this.proc = proc;
      let started = false;
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => {
        this.buffer += chunk;
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (!line) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.ready) {
            started = true;
            resolve();
            continue;
          }
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.data);
          else p.reject(new Error('GDI glyph request failed'));
        }
      });
      let errLog = '';
      proc.stderr.on('data', (d) => (errLog += d.toString()));
      const fail = (why: string) => {
        const err = new Error(`GDI helper ${why}: ${errLog.slice(0, 300)}`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.proc = null;
        this.ready = null;
        if (!started) reject(err);
      };
      proc.on('exit', () => fail('exited'));
      proc.on('error', () => fail('spawn error'));
    });
    return this.ready;
  }

  private async request(payload: Record<string, unknown>): Promise<any> {
    await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }

  private static cps(s: string): number[] {
    return Array.from(s).map((c) => c.codePointAt(0) || 32);
  }

  async check(family: string): Promise<boolean> {
    try {
      return (await this.request({ op: 'check', family: GdiGlyphService.cps(family) })) === true;
    } catch {
      return false;
    }
  }

  /** style: 1=굵게, 2=기울임 (GDI+ FontStyle 비트) */
  async glyphs(family: string, style: number, chars: string): Promise<any> {
    const uniq = Array.from(new Set(Array.from(chars)));
    return this.request({
      op: 'glyphs',
      family: GdiGlyphService.cps(family),
      style,
      cps: uniq.map((c) => c.codePointAt(0) || 32),
    });
  }

  dispose() {
    try {
      this.proc?.kill();
    } catch {
      // ignore
    }
  }
}
