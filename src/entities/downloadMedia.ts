/**
 * Downloads media from a public URL (for example `baseUrl` from attaches) to a temp file.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { pipeline } from 'stream/promises';

const UA = 'Mozilla/5.0 (compatible; WebMaxSocket/1.1)';

const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'application/octet-stream': '.bin',
  'text/plain': '.txt',
  'text/html': '.html',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/x-ns-proxy-autoconfig': '.pac'
};

export function extFromContentType(ct: any): string {
  if (!ct) return '';
  const main = String(ct).split(';')[0].trim().toLowerCase();
  return CONTENT_TYPE_EXT[main] || '';
}

export function extFromAttachType(t: any): string {
  if (!t) return '';
  const u = String(t).toUpperCase();
  if (u === 'PHOTO' || u === 'IMAGE') return '.jpg';
  if (u === 'VIDEO') return '.mp4';
  if (u === 'VOICE' || u === 'AUDIO') return '.ogg';
  if (u === 'FILE') return '.bin';
  return '';
}

/**
 * Follows redirects and returns the final HTTP(S) response.
 */
async function getFinalResponse(urlString: string, maxRedirects: number = 10): Promise<any> {
  let url = String(urlString);
  for (let i = 0; i < maxRedirects; i++) {
    const res: any = await new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.request(
        url,
        { method: 'GET', headers: { 'User-Agent': UA } },
        resolve
      );
      req.on('error', reject);
      req.end();
    });

    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      url = new URL(res.headers.location, url).href;
      continue;
    }

    if (res.statusCode !== 200) {
      res.resume();
      const err: any = new Error(`HTTP ${res.statusCode}`);
      err.statusCode = res.statusCode;
      throw err;
    }

    return res;
  }
  throw new Error('Too many redirects');
}

/**
 * Downloads a URL to a temp file (default directory: os.tmpdir()).
 *
 * @param url
 * @param options
 * @returns `{ path, contentType }`
 */
export async function downloadUrlToTempFile(
  url: string,
  options: { dir?: string; filename?: string; extFallback?: string } = {}
): Promise<{ path: string; contentType: string }> {
  if (!url || typeof url !== 'string') {
    throw new Error('downloadUrlToTempFile: URL must be a string');
  }

  const dir = options.dir != null ? String(options.dir) : os.tmpdir();
  const res = await getFinalResponse(url);
  const ct = (res.headers['content-type'] || '').trim();
  let ext = extFromContentType(ct);
  if (!ext && options.extFallback) {
    ext = options.extFallback.startsWith('.')
      ? options.extFallback
      : `.${options.extFallback}`;
  }
  if (!ext) ext = '.bin';

  const base =
    options.filename ||
    `max-media-${Date.now()}-${Math.random().toString(36).slice(2, 11)}${ext}`;
  const safeName = path.basename(base);
  const destPath = path.join(dir, safeName);

  const ws = fs.createWriteStream(destPath);
  try {
    await pipeline(res, ws);
  } catch (e) {
    try {
      await fs.promises.unlink(destPath);
    } catch (_) {}
    throw e;
  }

  return { path: destPath, contentType: ct };
}
