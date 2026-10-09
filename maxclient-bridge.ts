'use strict';

/* Experimental bridge for the PC client, lib webmaxsocket (it works for me). */
/* tellarion.dev */

import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import { downloadUrlToTempFile, extFromAttachType, WebMaxClient, EventTypes, Opcode } from 'webmaxsocket';

function jsonSafeMessageId(id: any): string | null {
  if (id == null || id === '') return null;
  if (typeof id === 'bigint') return id.toString();
  return String(id);
}

function redirectConsoleToStderr(): void {
  const line = (prefix: string, args: any[]) => {
    const s = args
      .map((x) => {
        if (x instanceof Error) return x.message;
        if (typeof x === 'object') {
          try {
            return JSON.stringify(x);
          } catch (_) {
            return String(x);
          }
        }
        return String(x);
      })
      .join(' ');
    process.stderr.write((prefix || '') + s + '\n');
  };

  console.log = (...a: any[]) => line('', a);
  console.error = (...a: any[]) => line('[err] ', a);
  console.warn = (...a: any[]) => line('[warn] ', a);
}

function emit(obj: any): void {
  try {
    process.stdout.write(
      JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n'
    );
  } catch (e: any) {
    try {
      process.stderr.write('[emit-json-error] ' + (e && e.message ? e.message : String(e)) + '\n');
    } catch (_) {}
  }
}

redirectConsoleToStderr();

let sessionName = 'max_win_client';
let dataRoot: string | null = null;
let client: any = null;
let pendingAuth: any = null;
let pending2fa: any = null;

function createClient(): any {
  return new WebMaxClient({
    name: sessionName,
    deviceType: 'ANDROID',
    logIncoming: false,
    sessionRefreshIntervalMs: 15 * 60 * 1000,
    debug: process.env.WEBMAX_DEBUG === '1'
  });
}

function summarizeAttachments(list: any[]): any[] {
  if (!list || !list.length) return [];
  return list.map((a, i) => {
    const url =
      (a && (a.baseUrl || a.url || (a.photo && (a.photo.baseUrl || a.photo.url)))) || '';

    return {
      idx: i,
      type: (a && (a._type || a.type)) || '',
      url: url ? String(url) : ''
    };
  });
}

function pickAttachmentFileName(a: any): string {
  if (!a || typeof a !== 'object') return '';
  if (a.file && a.file.name) return String(a.file.name);
  if (a.fileName) return String(a.fileName);
  if (a.name) return String(a.name);
  if (a.filename) return String(a.filename);
  if (a.title) return String(a.title);
  return '';
}

function extractUrlFromDownloadPayload(p: any): string {
  if (!p || typeof p !== 'object') return '';
  return (
    p.url ||
    p.baseUrl ||
    p.downloadUrl ||
    p.href ||
    (p.info && (p.info.url || p.info.baseUrl || p.info.downloadUrl)) ||
    (p.data && (p.data.url || p.data.baseUrl)) ||
    (p.file && (p.file.url || p.file.baseUrl || p.file.downloadUrl)) ||
    ''
  );
}

function normalizeFileIdForRpc(v: any): any {
  if (v == null || v === '') return null;
  if (typeof v === 'bigint') {
    const s = v.toString();
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
    return s;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^-?\d+$/.test(t)) {
      const n = Number(t);
      if (Number.isSafeInteger(n)) return n;
    }
    return t;
  }
  return v;
}

/** The fileId fields differ between the protocol and raw JSON; without them FILE_DOWNLOAD gives "File not found". */
function extractAttachFileId(a: any): any {
  if (!a || typeof a !== 'object') return null;
  const cands = [
    a.fileId,
    a.attachId,
    a.attachmentId,
    a.file && a.file.fileId,
    a.file && a.file.id,
    a.attach && a.attach.fileId,
    a.attach && a.attach.id,
    a.document && a.document.fileId,
    a.document && a.document.id
  ];
  for (let i = 0; i < cands.length; i++) {
    const v = cands[i];
    if (v != null && v !== '') return v;
  }
  const t = String(a._type || a.type || '').toUpperCase();
  if (t === 'FILE' && a.id != null && a.id !== '') return a.id;
  return null;
}

/** @param ctx { chatId?, messageId? } */
function buildFileDownloadRpcPayload(fidRaw: any, ctx: any): any {
  const fileId = normalizeFileIdForRpc(fidRaw);
  if (fileId == null || fileId === '') return null;
  const body: any = { fileId };
  if (
    ctx &&
    ctx.chatId != null &&
    ctx.chatId !== '' &&
    Number.isFinite(Number(ctx.chatId)) &&
    Number(ctx.chatId) !== 0
  ) {
    body.chatId = Number(ctx.chatId);
  }
  const midRaw = ctx && ctx.messageId != null && ctx.messageId !== '' ? String(ctx.messageId).trim() : '';
  if (midRaw) {
    if (/^-?\d+$/.test(midRaw)) {
      const n = Number(midRaw);
      body.messageId = Number.isSafeInteger(n) ? n : midRaw;
    } else body.messageId = midRaw;
  }
  return body;
}

function attachDebugShape(a: any): string {
  if (!a || typeof a !== 'object') return '{}';
  try {
    const o: any = {};
    const keys = Object.keys(a);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = a[k];
      if (v != null && typeof v === 'object' && !Array.isArray(v)) o[k] = 'obj';
      else if (Array.isArray(v)) o[k] = 'arr';
      else o[k] = typeof v;
    }
    return JSON.stringify(o);
  } catch (_) {
    return '{}';
  }
}

/**
 * Direct URL from an attachment or FILE_DOWNLOAD by fileId.
 * ctx (chatId, messageId) is often required by the server for documents without a public url.
 */
async function resolveAttachDownloadUrl(cl: any, a: any, ctx: any): Promise<string> {
  if (!a || typeof a !== 'object') return '';
  let url =
    a.baseUrl ||
    a.url ||
    (a.photo && (a.photo.baseUrl || a.photo.url));
  if (url) return String(url);
  if (a.file && (a.file.baseUrl || a.file.url))
    return String(a.file.baseUrl || a.file.url);

  const fid = extractAttachFileId(a);
  if (!cl || fid == null || fid === '') return '';
  const withCtx = buildFileDownloadRpcPayload(fid, ctx || null);
  const minimal = buildFileDownloadRpcPayload(fid, null);
  const attempts: any[] = [];
  if (withCtx) attempts.push(withCtx);
  if (minimal && JSON.stringify(minimal) !== JSON.stringify(withCtx)) attempts.push(minimal);
  if (!attempts.length) return '';

  let lastErr: any = null;
  for (let ai = 0; ai < attempts.length; ai++) {
    try {
      const r = await cl.sendAndWait(Opcode.FILE_DOWNLOAD, attempts[ai]);
      const got = extractUrlFromDownloadPayload(r && r.payload);
      if (got) return String(got);
    } catch (e: any) {
      lastErr = e;
    }
  }

  if (lastErr) {
    try {
      process.stderr.write(
        '[attach-url] FILE_DOWNLOAD: ' +
          (lastErr.message ? lastErr.message : String(lastErr)) +
          ' fileId=' +
          String(fid) +
          ' shape=' +
          attachDebugShape(a) +
          '\n'
      );
    } catch (_) {}
  }
  return '';
}

/** @param ctx { chatId?, messageId? } */
async function buildAttachmentUiList(cl: any, list: any[], ctx: any): Promise<any[]> {
  if (!list || !list.length) return [];
  const out: any[] = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const url = await resolveAttachDownloadUrl(cl, a, ctx);
    out.push({
      idx: i,
      type: (a && (a._type || a.type)) || '',
      url: url ? String(url) : '',
      fileName: pickAttachmentFileName(a)
    });
  }
  return out;
}

async function saveAttachmentsForIncomingMessage(msg: any, cl: any): Promise<void> {
  const dir = process.env.MAXCLIENT_DOWNLOADS;
  if (!dir || !msg.attachments || msg.attachments.length === 0) return;

  const midRaw = jsonSafeMessageId(msg.id) || 'x';
  const safeMsgIdBase = midRaw.replace(/[^\w.-]+/g, '_').slice(0, 80);
  const sock = cl || client;

  for (let i = 0; i < msg.attachments.length; i++) {
    const a = msg.attachments[i];
    const attachCtx = { chatId: msg.chatId, messageId: jsonSafeMessageId(msg.id) };

    const url = await resolveAttachDownloadUrl(sock, a, attachCtx);
    if (!url) continue;

    try {
      const ext = extFromAttachType(a._type || a.type) || '.bin';
      const fname = `chat-${msg.chatId}-msg-${safeMsgIdBase}-a${i}${ext}`;
      const r = await downloadUrlToTempFile(String(url), {
        dir,
        filename: fname,
        extFallback: ext
      });

      emit({
        evt: 'media_saved',
        chatId: msg.chatId,
        messageId: midRaw,
        path: r.path,
        contentType: r.contentType || ''
      });
    } catch (e: any) {
      emit({
        evt: 'media_error',
        chatId: msg.chatId,
        messageId: midRaw,
        error: e && e.message ? e.message : String(e),
        urlPreview: String(url).slice(0, 180)
      });
    }
  }
}

function wireHandlers(): void {
  client.onMessage(async (msg: any) => {
    try {
      if (client.me && msg.senderId === client.me.id) return;

      const attachCtx = { chatId: msg.chatId, messageId: jsonSafeMessageId(msg.id) };
      const attUi = await buildAttachmentUiList(client, msg.attachments || [], attachCtx);

      const preview =
        msg.text ||
        (msg.attachments && msg.attachments.length ? '[attachment]' : '');

      emit({
        evt: 'message',
        senderName: msg.getSenderName(),
        text: preview,
        chatId: msg.chatId,
        senderId: msg.senderId,
        timestamp: msg.timestamp,
        messageId: jsonSafeMessageId(msg.id),
        id: jsonSafeMessageId(msg.id),
        attachments: attUi
      });

      try {
        await saveAttachmentsForIncomingMessage(msg, client);
      } catch (_) {
        /* already logged as media_error */
      }
    } catch (e: any) {
      emit({ evt: 'error', message: e.message });
    }
  });

  client.onError(async (err: any) => {
    emit({
      evt: 'error',
      message: err && err.message ? err.message : String(err)
    });
  });
}

async function cmdConfigure(payload: any): Promise<void> {
  payload = payload || {};
  dataRoot =
    (process.env.MAXCLIENT_DATA_ROOT &&
      String(process.env.MAXCLIENT_DATA_ROOT).trim()) ||
    payload.dataRoot;
  sessionName =
    (process.env.MAXCLIENT_SESSION_NAME &&
      String(process.env.MAXCLIENT_SESSION_NAME).trim()) ||
    payload.sessionName ||
    sessionName;
  if (!dataRoot || String(dataRoot).trim() === '') {
    throw new Error('Set MAXCLIENT_DATA_ROOT (from C#) or the dataRoot field in configure');
  }
  dataRoot = path.resolve(String(dataRoot).trim());
  if (!fs.existsSync(dataRoot)) {
    fs.mkdirSync(dataRoot, { recursive: true });
  }
  process.chdir(dataRoot);

  const dl = process.env.MAXCLIENT_DOWNLOADS && String(process.env.MAXCLIENT_DOWNLOADS).trim();
  if (dl && !fs.existsSync(dl)) {
    fs.mkdirSync(dl, { recursive: true });
  }

  emit({
    evt: 'configured',
    dataRoot,
    sessionDir: path.join(dataRoot, 'sessions'),
    sessionName,
    downloadsDir: dl || ''
  });
}

async function stopClientQuiet(): Promise<void> {
  if (!client) return;
  try {
    await client.stop();
  } catch (_) {
    /* ignore */
  }
  client = null;
}

async function cmdLoginResume(): Promise<void> {
  pendingAuth = null;
  pending2fa = null;
  await stopClientQuiet();

  client = createClient();
  wireHandlers();

  await client.connect();

  const tok = client.session.get('token');
  if (tok && String(tok).trim() !== '') {
    try {
      client._token = String(tok).trim();
      await client.sync();
      client.isAuthorized = true;
      await client.triggerHandlers(EventTypes.START);
      const me = client.me
        ? {
            id: client.me.id,
            fullname: client.me.fullname,
            phone: client.me.phone
          }
        : null;
      emit({ evt: 'ready', me });
    } catch (e: any) {
      emit({
        evt: 'session_invalid',
        message: e && e.message ? e.message : String(e)
      });
      await stopClientQuiet();
    }
    return;
  }

  emit({ evt: 'need_phone' });
}

async function cmdSmsRequest(payload: any): Promise<void> {
  const phone = payload.phone;
  if (!phone || !String(phone).trim()) {
    throw new Error('Specify a phone number');
  }
  if (!client || !client.isConnected) {
    throw new Error('No connection: run login_resume');
  }
  pendingAuth = await client.authorizeBySMS(String(phone).trim());
  pending2fa = null;
  emit({ evt: 'sms_sent', phone: pendingAuth.phone });
}

async function cmdSmsCode(payload: any): Promise<void> {
  const code = payload.code;
  if (!pendingAuth) {
    throw new Error('Request a code first (sms_request)');
  }
  if (!code || !/^\d{6}$/.test(String(code).trim())) {
    throw new Error('A 6-digit code is required');
  }

  const out = await pendingAuth.sendCode(String(code).trim());

  if (
    out &&
    typeof out === 'object' &&
    out.needsPassword &&
    typeof out.sendPassword === 'function'
  ) {
    pending2fa = out.sendPassword;
    const pc = out.passwordChallenge || {};
    emit({
      evt: 'need_2fa',
      hint: pc.hint != null ? String(pc.hint) : '',
      email: pc.email != null ? String(pc.email) : ''
    });
    return;
  }

  pendingAuth = null;
  pending2fa = null;
  await client.triggerHandlers(EventTypes.START);
  const me = client.me
    ? {
        id: client.me.id,
        fullname: client.me.fullname,
        phone: client.me.phone
      }
    : null;
  emit({ evt: 'ready', me });
}

async function cmdSms2fa(payload: any): Promise<void> {
  const password = payload.password;
  if (!pending2fa) {
    throw new Error('2FA is not expected');
  }
  if (!password || !String(password).trim()) {
    throw new Error('Empty 2FA password');
  }
  await pending2fa(String(password).trim());
  pending2fa = null;
  pendingAuth = null;
  await client.triggerHandlers(EventTypes.START);
  const me = client.me
    ? {
        id: client.me.id,
        fullname: client.me.fullname,
        phone: client.me.phone
      }
    : null;
  emit({ evt: 'ready', me });
}

function mapChatRowsFromRaw(chats: any[]): any[] {
  return (chats || [])
    .map((c) => {
      const chatId =
        c.id ??
        c.chatId ??
        (c.chat && (c.chat.id ?? c.chat.chatId));
      const title =
        c.title ||
        c.name ||
        (c.chat && (c.chat.title || c.chat.name)) ||
        `Chat ${chatId}`;
      const lm =
        c.lastMessage ||
        c.lastMsg ||
        (c.chat && c.chat.lastMessage) ||
        {};
      const lastText = lm.text || lm.message || '';
      const lastTs =
        lm.timestamp ?? lm.time ?? c.lastTimestamp ?? c.time ?? 0;

      return {
        chatId,
        title: String(title),
        lastText: String(lastText).slice(0, 220),
        lastTimestamp: lastTs
      };
    })
    .filter((r) => r.chatId != null && Number.isFinite(Number(r.chatId)));
}

function extractChatListFromInfoPayload(info: any): any[] {
  if (!info) return [];
  if (Array.isArray(info)) return info;
  if (Array.isArray(info.chats)) return info.chats;
  if (Array.isArray(info.chatInfos)) return info.chatInfos;
  if (info.payload && Array.isArray(info.payload.chats)) return info.payload.chats;
  if (info.result && Array.isArray(info.result.chats)) return info.result.chats;
  return [];
}

function normalizeKnownChatIds(raw: any): number[] {
  if (!raw) return [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x: any) => Number(x))
    .filter((n: number) => Number.isFinite(n));
}

async function cmdGetChats(payload: any): Promise<void> {
  const p = payload || {};
  if (!client || !client.isAuthorized) {
    throw new Error('Sign in first');
  }
  const marker = p.marker != null ? Number(p.marker) : 0;
  let chats = await client.getChats(marker);
  let rows = mapChatRowsFromRaw(chats);
  const known = normalizeKnownChatIds(p.knownChatIds);
  if (rows.length === 0 && known.length > 0) {
    try {
      const info = await client.getChatInfo(known);
      const list = extractChatListFromInfoPayload(info);
      rows = mapChatRowsFromRaw(list);
    } catch (_) {
      /* the fallback is optional for UX */
    }
  }
  emit({ evt: 'chats_list', chats: rows, marker });
}

async function cmdGetHistory(payload: any): Promise<void> {
  const p = payload || {};
  if (!client || !client.isAuthorized) {
    throw new Error('Sign in first');
  }
  const chatId = p.chatId;
  if (chatId == null) {
    throw new Error('chatId is required');
  }
  const backward = p.backward != null ? Number(p.backward) : 80;
  const from = p.from != null ? Number(p.from) : Date.now();

  const msgs = await client.getHistory(chatId, from, backward, 0);
  const rows: any[] = [];
  for (const m of msgs) {
    const attachCtx = {
      chatId: m.chatId != null ? m.chatId : chatId,
      messageId: jsonSafeMessageId(m.id)
    };
    const attUi = await buildAttachmentUiList(client, m.attachments || [], attachCtx);
    rows.push({
      id: jsonSafeMessageId(m.id),
      messageId: jsonSafeMessageId(m.id),
      chatId: m.chatId != null ? m.chatId : chatId,
      text: m.text || '',
      senderId: m.senderId,
      senderName: m.getSenderName ? m.getSenderName() : '',
      timestamp: m.timestamp,
      attachments: attUi
    });
  }
  emit({ evt: 'history_loaded', chatId, messages: rows, appendOlder: !!p.appendOlder, backwardRequested: backward });
}

async function cmdDownloadAttachment(payload: any): Promise<void> {
  const p = payload || {};
  const dir = process.env.MAXCLIENT_DOWNLOADS && String(process.env.MAXCLIENT_DOWNLOADS).trim();
  if (!dir) {
    throw new Error('The downloads directory is not set (MAXCLIENT_DOWNLOADS). Restart the client.');
  }
  const url = p.url != null ? String(p.url).trim() : '';
  if (!url) {
    throw new Error('url is required');
  }
  const chatId = p.chatId != null ? Number(p.chatId) : 0;
  const messageId = p.messageId != null ? String(p.messageId) : 'x';
  const idx = p.idx != null ? Number(p.idx) : 0;
  const attachType = p.attachType != null ? String(p.attachType) : '';
  const openAfter = !!p.openAfter;

  const ext = extFromAttachType(attachType) || '.bin';
  const safeMsgId = messageId.replace(/[^\w.-]+/g, '_').slice(0, 80);
  const fname = `chat-${chatId}-msg-${safeMsgId}-a${idx}${ext}`;

  try {
    const r = await downloadUrlToTempFile(url, {
      dir,
      filename: fname,
      extFallback: ext
    });

    emit({
      evt: 'media_saved',
      chatId,
      messageId,
      path: r.path,
      contentType: r.contentType || '',
      openAfter
    });
  } catch (e: any) {
    emit({
      evt: 'media_error',
      chatId,
      messageId,
      error: e && e.message ? e.message : String(e),
      urlPreview: url.slice(0, 180)
    });
  }
}

function messageToChatUiPayload(
  message: any,
  chatIdFallback: any,
  textFallback: any,
  attachmentsUi: any
): any {
  const me = client && client.me;
  if (!message || message.id == null) {
    return {
      evt: 'message',
      chatId: chatIdFallback,
      text: textFallback || '',
      senderId: me ? me.id : null,
      senderName: me && me.fullname ? me.fullname : 'Me',
      timestamp: Date.now(),
      messageId: null,
      id: null,
      attachments: []
    };
  }
  const idStr = jsonSafeMessageId(message.id);
  const att =
    attachmentsUi != null
      ? attachmentsUi
      : summarizeAttachments(message.attachments || []);
  return {
    evt: 'message',
    chatId: message.chatId != null ? message.chatId : chatIdFallback,
    text: message.text || textFallback || '',
    senderId: message.senderId,
    senderName: message.getSenderName ? message.getSenderName() : '',
    timestamp: message.timestamp,
    messageId: idStr,
    id: idStr,
    attachments: att
  };
}

async function cmdSendMessage(payload: any): Promise<void> {
  const p = payload || {};
  if (!client || !client.isAuthorized) {
    emit({ evt: 'send_finished', ok: false, message: 'Sign in first' });
    return;
  }
  const chatId = p.chatId != null ? Number(p.chatId) : 0;
  const text = p.text != null ? String(p.text) : '';
  if (!chatId || !text.trim()) {
    emit({ evt: 'send_finished', ok: false, message: 'A chat and text are required' });
    return;
  }

  try {
    const message = await client.sendMessage({ chatId, text: text.trim() });
    const attachCtx = { chatId, messageId: jsonSafeMessageId(message.id) };
    const attUi = await buildAttachmentUiList(client, message.attachments || [], attachCtx);
    emit(messageToChatUiPayload(message, chatId, text.trim(), attUi));
    emit({ evt: 'send_finished', ok: true });
  } catch (e: any) {
    emit({
      evt: 'send_finished',
      ok: false,
      message: e && e.message ? e.message : String(e)
    });
  }
}

async function cmdStop(): Promise<void> {
  pendingAuth = null;
  pending2fa = null;
  await stopClientQuiet();
  emit({ evt: 'stopped' });
}

async function cmdLogout(payload: any): Promise<void> {
  const p = payload || {};
  const remove = p.removeLocalSession !== false;
  pendingAuth = null;
  pending2fa = null;
  if (client) {
    try {
      await client.stop();
      if (remove) client.session.destroy();
    } catch (e: any) {
      emit({
        evt: 'error',
        message: e && e.message ? e.message : String(e)
      });
    }
    client = null;
  }
  emit({ evt: 'logged_out', keepSession: !remove });
}

async function cmdSwitchSession(payload: any): Promise<void> {
  const p = payload || {};
  const name = p.sessionName != null ? String(p.sessionName).trim() : '';
  if (!name) {
    throw new Error('sessionName is required');
  }
  if (!dataRoot) {
    throw new Error('Run configure first');
  }
  pendingAuth = null;
  pending2fa = null;
  await stopClientQuiet();
  sessionName = name;
  emit({ evt: 'session_slot', sessionName: name });
  await cmdConfigure({ dataRoot, sessionName: name });
  await cmdLoginResume();
}

async function dispatch(cmd: any): Promise<void> {
  switch (cmd.cmd) {
    case 'configure':
      await cmdConfigure(cmd);
      return;
    case 'login_resume':
      await cmdLoginResume();
      return;
    case 'sms_request':
      await cmdSmsRequest(cmd);
      return;
    case 'sms_code':
      await cmdSmsCode(cmd);
      return;
    case 'sms_2fa':
      await cmdSms2fa(cmd);
      return;
    case 'get_chats':
      await cmdGetChats(cmd);
      return;
    case 'get_history':
      await cmdGetHistory(cmd);
      return;
    case 'send_message':
      await cmdSendMessage(cmd);
      return;
    case 'download_attachment':
      await cmdDownloadAttachment(cmd);
      return;
    case 'stop':
      await cmdStop();
      return;
    case 'logout':
      await cmdLogout(cmd);
      return;
    case 'switch_session':
      await cmdSwitchSession(cmd);
      return;
    default:
      throw new Error('Unknown command: ' + cmd.cmd);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch (_) {
    emit({ evt: 'error', message: 'Invalid command JSON' });
    return;
  }

  Promise.resolve()
    .then(() => dispatch(msg))
    .catch((e: any) => {
      emit({
        evt: 'error',
        message: e && e.message ? e.message : String(e)
      });
    });
});

setTimeout(() => {
  emit({ evt: 'bridge_ready', node: process.version });
}, 150);
