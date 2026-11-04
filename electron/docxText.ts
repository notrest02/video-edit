/**
 * docx 에서 글자만 뽑기 (클라이언트 오더·가이드 파일 읽기용). 따로 라이브러리 없이 zip 안의 word/document.xml 만 푼다.
 * 문단마다 한 줄, 표 칸은 문단으로 들어 있어서 그대로 한 줄씩 나온다.
 */
import fs from 'fs';
import zlib from 'zlib';

function readZipEntry(buf: Buffer, name: string): Buffer | null {
  // 끝에서 '중앙 디렉터리 끝' 표시(0x06054b50)를 찾는다
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const entryName = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (entryName === name) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

export function docxToText(filePath: string): string {
  const xml = readZipEntry(fs.readFileSync(filePath), 'word/document.xml');
  if (!xml) throw new Error('docx 안의 본문을 찾지 못했습니다.');
  const doc = xml.toString('utf8');
  const paras = doc.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
  return paras
    .map((para) => unescapeXml((para.match(/<w:t[^>]*>[\s\S]*?<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
