/**
 * Downloads attachments from chat history (with baseUrl or documents without a direct URL).
 *
 * Usage:
 *   npm run example:download -- <chatId> [backward]
 *   SESSION_NAME=my_session BACKWARD=80 npm run example:download -- 12345
 *   USE_LAST_OK=1 — merge sessions/<name>.last_ok.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { WebMaxClient } from '../src/index';

const sessionName = process.env.SESSION_NAME || 'sms_session';
const useLastOk =
  process.env.USE_LAST_OK === '1' ||
  process.env.USE_LAST_OK === 'true' ||
  process.env.USE_LAST_OK === 'yes';
const downloadDir = path.join(process.cwd(), 'downloads');

function parseChatId(arg: string): number {
  const s = String(arg).trim();
  if (!/^-?\d+$/.test(s)) {
    throw new Error(`chatId must be an integer, got: ${arg}`);
  }
  return Number(s);
}

function safeBasename(name: any, fallback: string): string {
  const base = (name && String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')) || fallback;
  return base.length > 180 ? base.slice(0, 180) : base;
}

async function main(): Promise<void> {
  const chatArg = process.argv[2];
  const backward = Math.max(
    1,
    parseInt(process.argv[3] || process.env.BACKWARD || '50', 10) || 50
  );

  if (
    chatArg == null ||
    chatArg === '' ||
    chatArg === '-h' ||
    chatArg === '--help'
  ) {
    console.log('Usage: npm run example:download -- <chatId> [backward]\n');
    console.log('Environment variables: SESSION_NAME, BACKWARD, USE_LAST_OK=1, DEBUG=1');
    process.exit(chatArg == null || chatArg === '' ? 1 : 0);
  }

  const chatId = parseChatId(chatArg);

  const client = new WebMaxClient({
    name: sessionName,
    deviceType: 'ANDROID',
    debug: process.env.DEBUG === '1'
  });

  if (useLastOk) {
    const lastOk = path.join(process.cwd(), 'sessions', `${sessionName}.last_ok.json`);
    if (fs.existsSync(lastOk)) {
      const snap = JSON.parse(fs.readFileSync(lastOk, 'utf8'));
      Object.assign(client.session.data, snap);
      console.log('Merged the session snapshot:', lastOk);
    } else {
      console.warn('USE_LAST_OK: file not found:', lastOk);
    }
  }

  const token = client.session.get('token');
  if (!token) {
    console.error(
      `No token in sessions/${sessionName}.json. Sign in first (example-sms.js, example-token.js or QR).`
    );
    process.exit(1);
  }

  await client.connect();
  client._token = token;
  await client.sync();

  if (client.me) {
    console.log(`Signed in as: ${client.me.fullname || client.me.firstname} (id ${client.me.id})`);
  }

  console.log(`Loading history chatId=${chatId}, backward=${backward}...`);

  const messages = await client.getHistory(chatId, Date.now(), backward, 0);
  const ordered = [...messages].sort(
    (a: any, b: any) => Number(a.timestamp || 0) - Number(b.timestamp || 0)
  );

  fs.mkdirSync(downloadDir, { recursive: true });

  let ok = 0;
  for (const m of ordered) {
    if (!m.attachments || !m.attachments.length) continue;

    for (let i = 0; i < m.attachments.length; i++) {
      const att = m.attachments[i];
      const kind = String(att._type || att.type || '').toUpperCase() || 'FILE';
      const guessed =
        att.name || att.fileName || att.filename || `msg-${String(m.id)}-${i}`;
      const fname = safeBasename(guessed, `msg-${String(m.id)}-${i}`);
      const filename = fname.includes('.')
        ? fname
        : `${fname}.${
            kind === 'PHOTO' || kind === 'IMAGE'
              ? 'img'
              : kind === 'VIDEO'
                ? 'mp4'
                : 'bin'
          }`;

      try {
        const { path: savedPath, contentType } = await m.downloadAttachment(i, {
          dir: downloadDir,
          filename
        });
        console.log(`✓ [${kind}] ${path.basename(savedPath)}  ${contentType || ''}`);
        ok++;
      } catch (e: any) {
        console.warn(`⚠ [${kind}] ${filename}: ${e.message}`);
      }
    }
  }

  console.log(`\nDone: ${ok} file(s) → ${downloadDir}`);

  try {
    await client.stop();
  } catch (_) {
    /* ignore */
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
