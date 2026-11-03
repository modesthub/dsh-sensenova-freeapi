/**
 * 视觉输入的图像归一化：本地路径 / http(s) URL / data: URL / 裸 base64
 * → 字节 + MIME。
 *
 * 从 dsh-sensenova-vision-aid 迁移而来（原 image-input.ts）。融合后**不再**
 * 承接子 agent 路径与附件保存，因此 `admitImage` / `AttachmentsLike` 一并删除——
 * 视觉请求现在与主请求共用同一个 apiBase 与同一批账户密钥。
 *
 * @module dsh-sensenova-freeapi/vision/image-input
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

/** 扩展名 → MIME（显式表，避免 Windows 注册表查不到返回 null；bmp 仅直连路径用）。 */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/** 一张归一化后的图片：字节 + MIME。 */
export interface NormalizedImage {
  /** MIME 字符串；直连路径按原样内联为 data: URL。 */
  mime: string;
  bytes: Uint8Array;
  /** 来源形态（http 源不取回字节，按原 URL 直传）。 */
  source: 'path' | 'http' | 'data' | 'base64';
  /** 本地文件名（无目录信息）或 undefined。 */
  name?: string;
}

/** 判断字符串是否为直传形式（URL / data URL）。 */
function isUrlLike(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://') || value.startsWith('data:');
}

/**
 * 解析裸 base64 的 MIME 前缀；无前缀时按字节魔数猜测 PNG/JPEG/GIF/WebP，
 * 无法识别回落 image/png（与 vision-aid 的宽容策略一致）。
 */
export function guessMimeFromDataUrl(value: string): string {
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,/i.exec(value);
  if (match !== null && match[1] !== undefined) {
    const declared = match[1].toLowerCase();
    if (declared.startsWith('image/')) return declared;
    return 'image/png';
  }
  const body = value.indexOf(',') >= 0 ? value.slice(value.indexOf(',') + 1) : value;
  const sample = Buffer.from(body, 'base64').subarray(0, 12);
  if (sample.length >= 8
    && sample[0] === 0x89 && sample[1] === 0x50 && sample[2] === 0x4e && sample[3] === 0x47
    && sample[4] === 0x0d && sample[5] === 0x0a && sample[6] === 0x1a && sample[7] === 0x0a) {
    return 'image/png';
  }
  if (sample.length >= 3 && sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) {
    return 'image/jpeg';
  }
  if (sample.length >= 6 && sample[0] === 0x47 && sample[1] === 0x49 && sample[2] === 0x46
    && sample[3] === 0x38 && (sample[4] === 0x37 || sample[4] === 0x39) && sample[5] === 0x61) {
    return 'image/gif';
  }
  if (sample.length >= 12 && sample[0] === 0x52 && sample[1] === 0x49 && sample[2] === 0x46
    && sample[3] === 0x46 && sample[8] === 0x57 && sample[9] === 0x45 && sample[10] === 0x42
    && sample[11] === 0x50) {
    return 'image/webp';
  }
  return 'image/png';
}

/**
 * 归一化一个图片输入（本地路径 / http(s) URL / data: URL / 裸 base64）。
 * http(s) URL 不取回字节（按 URL 直传）。
 */
export async function normalizeImageInput(raw: string): Promise<NormalizedImage> {
  const value = raw.trim();
  if (value === '') throw new Error('image input must be a non-empty string');

  if (value.startsWith('http://') || value.startsWith('https://')) {
    return { mime: 'image/png', bytes: new Uint8Array(0), source: 'http' };
  }
  if (value.startsWith('data:')) {
    const semicolon = value.indexOf(';base64,');
    const comma = value.indexOf(',');
    if (semicolon < 0 || comma < 0) throw new Error('invalid data: URL (missing ;base64,)');
    const body = value.slice(semicolon + 8);
    const mime = guessMimeFromDataUrl(value);
    const bytes = Buffer.from(body, 'base64');
    if (bytes.length === 0) throw new Error('empty image bytes in data: URL');
    return { mime, bytes: new Uint8Array(bytes), source: 'data' };
  }
  // 裸 base64（不含 data: 前缀）按字节猜测 MIME。
  if (!isUrlLike(value) && /^[A-Za-z0-9+/=\s]+$/.test(value) && value.length > 32) {
    try {
      const bytes = Buffer.from(value.replace(/\s+/g, ''), 'base64');
      if (bytes.length > 0) {
        return { mime: guessMimeFromDataUrl(`data:;base64,${value}`), bytes: new Uint8Array(bytes), source: 'base64' };
      }
    } catch {
      // 落到本地路径分支。
    }
  }
  // 本地路径。
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(value));
  } catch {
    throw new Error(`image file not found: ${value}`);
  }
  const ext = extname(value).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? 'image/png';
  const leaf = value.split(/[\\/]/).pop() ?? '';
  return {
    mime,
    bytes,
    source: 'path',
    ...(leaf !== '' ? { name: leaf } : {}),
  };
}

/** 直连路径用：把归一化图片内联为 `data:<mime>;base64,`（http 源直传原 URL）。 */
export function toDataUrl(input: NormalizedImage, raw: string): string {
  if (input.source === 'http') return raw.trim();
  return `data:${input.mime};base64,${Buffer.from(input.bytes).toString('base64')}`;
}
