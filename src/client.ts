import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { SessionManager } from './session';
import { MaxSocketTransport } from './socketTransport';
import { Message, ChatAction, User } from './entities';
import { EventTypes, ChatActions, APP_VERSION, BUILD_NUMBER } from './constants';
import { Opcode, DeviceType, getOpcodeName } from './opcodes';
import { UserAgentPayload } from './userAgent';
import { resolveIncomingLogMode, printIncomingLog } from './incomingLog';
import { parseQrTrackId } from './qrWebLogin';
import * as callHelpers from './callHelpers';

const DEFAULT_OK_API_ENDPOINT = 'https://api.ok.ru/api/vchat/hangupConversation';
const DEFAULT_OK_API_APPLICATION_KEY = 'CMBGJFMGDIHBABABA';

/**
 * Loads a config: { token, agent }.
 */
function loadSessionConfig(configPath: string): any {
  let resolved: string;
  if (path.isAbsolute(configPath)) {
    resolved = configPath;
  } else if (!/[\\/]/.test(configPath) && !configPath.endsWith('.json')) {
    resolved = path.join(process.cwd(), 'config', `${configPath}.json`);
  } else {
    resolved = path.join(process.cwd(), configPath);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config not found: ${resolved}`);
  }
  const data = fs.readFileSync(resolved, 'utf8');
  return JSON.parse(data);
}

/**
 * Clear error when the server refuses to issue a QR (often qr_login.disabled for a non-official WEB handshake).
 */
function throwIfGetQRRejected(payload: any): void {
  if (!payload || !payload.error) {
    return;
  }
  const err = payload.error;
  const text =
    typeof err === 'string'
      ? err
      : err && typeof err.message === 'string'
        ? err.message
        : JSON.stringify(err);
  if (String(text).includes('qr_login.disabled')) {
    throw new Error(
      'The Max server refused to issue a QR (qr_login.disabled). Common causes: outdated appVersion in the User-Agent (needs >= 25.12.13), ' +
      'or QR disabled for this client on the VK side. Check https://web.max.ru in a browser. ' +
      'A second phone can also be added to the account by signing in by phone number in the Max app.'
    );
  }
  throw new Error(`QR request error: ${text}`);
}

/**
 * Main client for working with the Max API.
 */
class WebMaxClient extends EventEmitter {
  phone: any;
  sessionName: any;
  apiUrl: any;
  okApiEndpoint: any;
  okApiApplicationKey: any;
  okApiSessionKey: any;
  okApiSessionSecret: any;
  _explicitOptionToken: any;
  _configFileToken: any;
  _providedToken: any;
  _saveTokenToSession: any;
  _saveTwofaPassword: any;
  origin: any;
  _wsReferer: any;
  session: any;
  _handshakeUserAgent: any;
  userAgent: any;
  deviceId: any;
  _useSocketTransport: any;
  _socketTransport: any;
  ws: any;
  me: any;
  lastSyncPayload: any;
  isConnected: any;
  isAuthorized: any;
  _tcpLoginCompleted: any;
  reconnectAttempts: any;
  maxReconnectAttempts: any;
  reconnectDelay: any;
  seq: any;
  ver: any;
  handlers: any;
  messageQueue: any;
  pendingRequests: any;
  debug: any;
  _authDebug: any;
  _sessionBackupOnSuccess: any;
  _incomingLogMode: any;
  _clientSendCid: any;
  _uploadPendingVideo: any;
  _uploadPendingFile: any;
  _sessionRefreshIntervalMs: any;
  _sessionRefreshTimer: any;
  _sessionRefreshRunning: any;
  _tcpInteractivePingMs: any;
  _tcpInteractiveTimer: any;
  _clearSessionOnFailedSync: any;
  _token: any;

  constructor(options: any = {}) {
    super();

    this.phone = options.phone || null;
    this.sessionName = options.name || options.session || 'default';
    this.apiUrl = options.apiUrl || 'wss://ws-api.oneme.ru/websocket';
    this.okApiEndpoint = options.okApiEndpoint || DEFAULT_OK_API_ENDPOINT;
    this.okApiApplicationKey =
      options.okApiApplicationKey || DEFAULT_OK_API_APPLICATION_KEY;
    this.okApiSessionKey = options.okApiSessionKey || null;
    this.okApiSessionSecret = options.okApiSessionSecret || null;

    // Load from config — token, ua (agent), device_type
    let agent = options.ua || options.agent || options.headerUserAgent || null;
    let configObj: any = {};
    const configPath = options.configPath || options.config;
    if (configPath) {
      configObj = loadSessionConfig(configPath);
      agent = agent || configObj.agent || configObj.ua || configObj.headerUserAgent || null;
    }

    const optTok = options.token;
    this._explicitOptionToken =
      optTok !== undefined && optTok !== null && String(optTok).trim() !== ''
        ? String(optTok).trim()
        : null;
    this._configFileToken =
      configPath &&
      configObj.token !== undefined &&
      configObj.token !== null &&
      String(configObj.token).trim() !== ''
        ? String(configObj.token).trim()
        : null;
    /** Raw tokens from options/config (without sessions); priority at start is handled by _resolveTokenForStart. */
    this._providedToken = this._explicitOptionToken || this._configFileToken;
    this._saveTokenToSession = options.saveToken !== false;
    /** Save the 2FA password to sessions/*.json after a successful login (for a later full re-login without typing). Disable: saveTwofaPassword: false. */
    this._saveTwofaPassword = options.saveTwofaPassword !== false;
    this.origin = options.origin || 'https://web.max.ru';
    /** Extra header for ws (e.g. Referer for QR from max.ru, while Origin stays web.max.ru — otherwise 403). */
    this._wsReferer = options.referer || options.wsReferer || null;
    this.session = new SessionManager(this.sessionName);

    const deviceTypeMap: any = { 1: 'WEB', 2: 'ANDROID', 3: 'ANDROID' };
    const rawDeviceType = options.deviceType ?? configObj.device_type ?? configObj.deviceType ?? this.session.get('deviceType');
    let deviceType = deviceTypeMap[rawDeviceType] || rawDeviceType || 'WEB';
    deviceType = String(deviceType).toUpperCase() === 'IOS' ? 'ANDROID' : String(deviceType).toUpperCase();
    const androidUserAgent =
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
    const webUserAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    const uaString =
      agent ||
      configObj.headerUserAgent ||
      configObj.ua ||
      this.session.get('headerUserAgent') ||
      (deviceType === 'ANDROID' ? androidUserAgent : webUserAgent);
    const webDefaults = {
      deviceType: deviceType,
      locale: options.locale || configObj.locale || this.session.get('locale') || 'ru',
      deviceLocale:
        options.deviceLocale ||
        configObj.deviceLocale ||
        configObj.locale ||
        this.session.get('deviceLocale') ||
        this.session.get('locale') ||
        'ru',
      osVersion:
        options.osVersion ||
        configObj.osVersion ||
        this.session.get('osVersion') ||
        (deviceType === 'ANDROID' ? '14' : 'Windows 11'),
      deviceName:
        options.deviceName ||
        configObj.deviceName ||
        this.session.get('deviceName') ||
        (deviceType === 'ANDROID' ? 'Android' : 'Chrome'),
      headerUserAgent: options.headerUserAgent || options.ua || uaString,
      // Below the current version the server replies "The app is outdated" / qr_login.disabled.
      // We do not read appVersion/buildNumber from session — otherwise old sessions send the outdated fingerprint again.
      appVersion: options.appVersion || configObj.appVersion || APP_VERSION,
      screen:
        options.screen ||
        configObj.screen ||
        this.session.get('screen') ||
        (deviceType === 'ANDROID' ? '360x780 3.0x' : '1080x1920 1.0x'),
      timezone: options.timezone || configObj.timezone || this.session.get('timezone') || 'Europe/Moscow',
      buildNumber: options.buildNumber ?? configObj.buildNumber ?? (deviceType === 'ANDROID' ? BUILD_NUMBER : undefined),
      clientSessionId: options.clientSessionId ?? configObj.clientSessionId ?? this.session.get('clientSessionId'),
      release: options.release ?? configObj.release
    };
    this._handshakeUserAgent = new UserAgentPayload(webDefaults);
    this.userAgent = this._handshakeUserAgent;

    this.deviceId = options.deviceId || this.session.get('deviceId') || uuidv4();
    if (!this.session.get('deviceId')) {
      this.session.set('deviceId', this.deviceId);
    }

    // Determine transport type: Socket for ANDROID, WebSocket for WEB
    this._useSocketTransport = deviceType === 'ANDROID';
    this._socketTransport = null;

    this.ws = null;
    this.me = null;
    /** Last successful LOGIN/sync response (chats, delta messages, etc.) — handy on TCP, where CHATS_LIST is often empty. */
    this.lastSyncPayload = null;
    this.isConnected = false;
    this.isAuthorized = false;
    /** On TCP after the first LOGIN a repeated sync is only new TLS + LOGIN (19); opcode 21 is rejected by the socket server. */
    this._tcpLoginCompleted = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.reconnectDelay = options.reconnectDelay ?? 3000;

    // Protocol fields
    this.seq = 0;
    this.ver = 11;

    this.handlers = {
      [EventTypes.START]: [],
      [EventTypes.MESSAGE]: [],
      [EventTypes.MESSAGE_REMOVED]: [],
      [EventTypes.CHAT_ACTION]: [],
      [EventTypes.INCOMING_CALL]: [],
      [EventTypes.CALL_LOG]: [],
      [EventTypes.QR_CODE]: [],
      [EventTypes.ERROR]: [],
      [EventTypes.DISCONNECT]: []
    };

    this.messageQueue = [];
    this.pendingRequests = new Map();
    this.debug =
      Boolean(options.debug) ||
      process.env.DEBUG === '1' ||
      process.env.WEBMAX_DEBUG === '1';
    this._authDebug = Boolean(options.authDebug) || process.env.WEBMAX_AUTH_DEBUG === '1';
    /** After a successful sync copy sessions/<name>.json -> <name>.last_ok.json */
    this._sessionBackupOnSuccess = options.sessionBackup !== false;
    /** Incoming JSON log mode: off | messages | verbose (see logIncoming in README) */
    this._incomingLogMode = resolveIncomingLogMode(options);
    this._wireIncomingLogListeners();
    /** Client id of local outgoing messages (int32, the server often validates it) */
    this._clientSendCid = 1 + Math.floor(Math.random() * 0xfffff);
    /** After HTTP POST of a video/file — wait for NOTIF_ATTACH */
    this._uploadPendingVideo = new Map();
    this._uploadPendingFile = new Map();
    /** Periodic sync() to renew/rotate the token (ms). 0 — disabled. Alternative name: autoSyncIntervalMs */
    const refreshMs = Number(options.sessionRefreshIntervalMs ?? options.autoSyncIntervalMs ?? 0);
    this._sessionRefreshIntervalMs = Number.isFinite(refreshMs) && refreshMs > 0 ? refreshMs : 0;
    this._sessionRefreshTimer = null;
    this._sessionRefreshRunning = false;
    /**
     * TCP (like web): periodic outgoing PING (opcode 1) with `{ interactive: true }` (~30 s).
     * 0 — disabled. Option name: tcpInteractivePingMs.
     */
    const tcpPingRaw = options.tcpInteractivePingMs;
    const tcpPingMs =
      tcpPingRaw === undefined || tcpPingRaw === null ? 30000 : Number(tcpPingRaw);
    this._tcpInteractivePingMs =
      Number.isFinite(tcpPingMs) && tcpPingMs > 0 ? tcpPingMs : 0;
    this._tcpInteractiveTimer = null;
    /**
     * connectWithSession: after a failed sync call session.clear() before authorize().
     * Default false — the sessions/*.json file is kept; true — the previous "clean slate" behavior.
     */
    this._clearSessionOnFailedSync = options.clearSessionOnFailedSync === true;
  }

  /**
   * Current incoming log mode: `off` | `messages` | `verbose`.
   */
  get incomingLogMode(): any {
    return this._incomingLogMode;
  }

  /**
   * Manual output in the `[incoming:label]` format (like the internal log).
   */
  logIncoming(label: string, payload: any): void {
    printIncomingLog(label, payload);
  }

  /**
   * Delivers a QR link to the registered onQrCode handlers.
   * The handler is responsible for rendering the QR code (terminal, UI, file, ...).
   */
  private async _deliverQrCode(qrLink: string, small: boolean = true): Promise<void> {
    const handlers = this.handlers[EventTypes.QR_CODE] || [];
    for (const handler of handlers) {
      await handler(qrLink, small);
    }
  }

  _wireIncomingLogListeners(): void {
    if (this._incomingLogMode !== 'verbose') return;
    this.once('connected', () => {
      printIncomingLog('connected', { event: 'connected' });
    });
    this.on('raw_message', (data: any) => {
      printIncomingLog('raw_message', data);
    });
  }

  /**
   * Token priority: explicit options.token -> saved sessions/<name>.json -> token from config.
   * Otherwise after SMS a new token lives in sessions while the old one from config is used and sync fails with "update config".
   */
  _resolveTokenForStart(): any {
    if (this._explicitOptionToken) {
      return { token: this._explicitOptionToken, source: 'options.token' };
    }
    const sessionTok = this.session.get('token');
    if (sessionTok && String(sessionTok).trim() !== '') {
      return { token: String(sessionTok).trim(), source: 'session_file' };
    }
    if (this._configFileToken) {
      return { token: this._configFileToken, source: 'config_file' };
    }
    return { token: null, source: null };
  }

  _logAuthContext(phase: string, extra: any = {}): void {
    if (!this.debug && !this._authDebug) return;
    let libVersion = 'unknown';
    try {
      libVersion = require(path.join(__dirname, '..', '..', 'package.json')).version;
    } catch (_) {
      /* ignore */
    }
    const tok = this._token || this.session.get('token');
    const tokenPreview =
      tok && String(tok).length > 14
        ? `${String(tok).slice(0, 8)}…${String(tok).slice(-4)}`
        : tok
          ? '(short)'
          : '(none)';
    const payload = {
      phase,
      libVersion,
      node: process.version,
      cwd: process.cwd(),
      sessionName: this.sessionName,
      sessionPath: this.session.sessionFile,
      backupPath: path.join(this.session.sessionDir, `${this.sessionName}.last_ok.json`),
      tokenPreview,
      deviceId: this.deviceId,
      userAgent: this.userAgent.toJSON(),
      ...extra
    };
    console.log('[webmaxsocket:auth]', JSON.stringify(payload, null, 2));
  }

  /**
   * Registers a handler that runs when the client starts.
   *
   * @param handler - callback invoked after authorization completes; may return a Promise
   * @returns the registered handler, or a decorator function when no handler is passed
   */
  onStart(handler: any): any {
    if (typeof handler === 'function') {
      this.handlers[EventTypes.START].push(handler);
      return handler;
    }
    // Decorator support
    return (fn: any) => {
      this.handlers[EventTypes.START].push(fn);
      return fn;
    };
  }

  /**
   * Registers a handler for incoming messages.
   *
   * @param handler - callback that receives a Message instance; may return a Promise
   * @returns the registered handler, or a decorator function when no handler is passed
   */
  onMessage(handler: any): any {
    if (typeof handler === 'function') {
      this.handlers[EventTypes.MESSAGE].push(handler);
      return handler;
    }
    return (fn: any) => {
      this.handlers[EventTypes.MESSAGE].push(fn);
      return fn;
    };
  }

  /**
   * Registers a handler for removed messages.
   *
   * @param handler - callback that receives the removed Message; may return a Promise
   * @returns the registered handler, or a decorator function when no handler is passed
   */
  onMessageRemoved(handler: any): any {
    if (typeof handler === 'function') {
      this.handlers[EventTypes.MESSAGE_REMOVED].push(handler);
      return handler;
    }
    return (fn: any) => {
      this.handlers[EventTypes.MESSAGE_REMOVED].push(fn);
      return fn;
    };
  }

  /**
   * Registers a handler for chat actions (typing, sticker selection, etc.).
   *
   * @param handler - callback that receives a ChatAction instance; may return a Promise
   * @returns the registered handler, or a decorator function when no handler is passed
   */
  onChatAction(handler: any): any {
    if (typeof handler === 'function') {
      this.handlers[EventTypes.CHAT_ACTION].push(handler);
      return handler;
    }
    return (fn: any) => {
      this.handlers[EventTypes.CHAT_ACTION].push(fn);
      return fn;
    };
  }

  /**
   * Registers a handler for incoming calls.
   *
   * Fired on a TCP NOTIF_INCOMING_CALL notification (opcode 137).
   *
   * @param handler - callback that receives the call payload; may return a Promise
   * @returns the registered handler, or a decorator function when no handler is passed
   */
  onIncomingCall(handler: any): any {
    if (typeof handler === 'function') {
      this.handlers[EventTypes.INCOMING_CALL].push(handler);
      return handler;
    }
    return (fn: any) => {
      this.handlers[EventTypes.INCOMING_CALL].push(fn);
      return fn;
    };
  }

  /**
   * Registers a handler for call records in a chat.
   *
   * Fired when a NOTIF_MESSAGE carries a `_type: "CALL"` attachment.
   *
   * @param handler - callback that receives the call log event; may return a Promise
   * @returns the registered handler, or a decorator function when no handler is passed
   */
  onCallLog(handler: any): any {
    if (typeof handler === 'function') {
      this.handlers[EventTypes.CALL_LOG].push(handler);
      return handler;
    }
    return (fn: any) => {
      this.handlers[EventTypes.CALL_LOG].push(fn);
      return fn;
    };
  }

  /**
   * Registers an error handler.
   *
   * @param handler - callback that receives the error; may return a Promise
   * @returns the registered handler, or a decorator function when no handler is passed
   */
  onError(handler: any): any {
    if (typeof handler === 'function') {
      this.handlers[EventTypes.ERROR].push(handler);
      return handler;
    }
    return (fn: any) => {
      this.handlers[EventTypes.ERROR].push(fn);
      return fn;
    };
  }

  /**
   * Registers a QR code handler.
   *
   * The library never prints QR codes itself; the handler is responsible for
   * rendering the link (terminal, UI, file, ...).
   *
   * @param handler - callback `(qrLink, small)`; may return a Promise
   * @returns the registered handler, or a decorator function when no handler is passed
   */
  onQrCode(handler: any): any {
    if (typeof handler === 'function') {
      this.handlers[EventTypes.QR_CODE].push(handler);
      return handler;
    }
    return (fn: any) => {
      this.handlers[EventTypes.QR_CODE].push(fn);
      return fn;
    };
  }

  /**
   * Starts the client.
   */
  async start(): Promise<void> {
    try {
      console.log('🚀 Starting WebMax client...');

      // Connect to WebSocket or Socket
      await this.connect();

      const { token: tokenToUse, source: tokenSource } = this._resolveTokenForStart();

      if (tokenToUse) {
        if (tokenSource === 'session_file') {
          console.log('✅ Saved session found');
        } else {
          console.log('✅ Signing in by token (token auth)');
          if (this._saveTokenToSession) {
            this.session.set('token', tokenToUse);
            this.session.set('deviceId', this.deviceId);
          }
        }
        this._token = tokenToUse;

        this._logAuthContext('start:before_sync', { tokenSource });

        try {
          await this.sync();
          this.isAuthorized = true;
        } catch (error: any) {
          const fromConfigOrOptions =
            tokenSource === 'config_file' || tokenSource === 'options.token';
          this._explicitOptionToken = null;
          this._configFileToken = null;
          this._providedToken = null;
          if (fromConfigOrOptions) {
            throw new Error(
              `The token is invalid or the session has expired. Update the token in config, or remove/clear the token in config so the current session from sessions/ is used. (${error.message})`
            );
          }
          console.log('⚠️ Session expired, re-authorization required');
          if (this.debug || this._authDebug) {
            console.log(
              '[webmaxsocket:auth] Hint: to recover, try copying sessions/' +
                this.sessionName +
                '.last_ok.json over sessions/' +
                this.sessionName +
                '.json (if a copy exists).'
            );
          }
          await this.authorize();
        }
      } else {
        console.log('📱 Authorization required');
        await this.authorize();
      }

      // Run start handlers
      await this.triggerHandlers(EventTypes.START);

      this._scheduleSessionRefreshIfNeeded();

      console.log('\n✅ Client started successfully!');
    } catch (error: any) {
      console.error('❌ Error starting client:', error);
      await this.triggerHandlers(EventTypes.ERROR, error);
      throw error;
    }
  }

  /**
   * Requests a QR code for authorization (only for device_type="WEB").
   */
  async requestQR(): Promise<any> {
    console.log('Requesting QR code for authorization...');

    const response = await this.sendAndWait(Opcode.GET_QR, undefined);

    throwIfGetQRRejected(response.payload);

    return response.payload;
  }

  /**
   * Checks QR code status.
   */
  async checkQRStatus(trackId: string): Promise<any> {
    const response = await this.sendAndWait(Opcode.GET_QR_STATUS, { trackId });

    if (response.payload && response.payload.error) {
      throw new Error(`QR status error: ${JSON.stringify(response.payload.error)}`);
    }

    return response.payload;
  }

  /**
   * On TCP the server may close the socket after a LOGIN response — before the next RPC reconnect and LOGIN again.
   */
  async _ensureTcpSocketReadyForRpc(): Promise<void> {
    const st = this._socketTransport;
    if (st && st.socket && !st.socket.destroyed) return;
    const token = this._token || this.session.get('token');
    if (!token) {
      throw new Error('No token for TCP reconnection');
    }
    console.log('Reconnecting TCP (socket closed after the previous request)...');
    this.isConnected = false;
    await this.connect();
    this._token = token;
    await this.sync();
    this.isAuthorized = true;
  }

  /**
   * Completes QR authorization.
   * @param trackId — UUID (web GET_QR) or opaque token `qr_...` (max.ru/qr/v1/auth)
   */
  async loginByQR(trackId: string): Promise<any> {
    if (this._useSocketTransport) {
      await this._ensureTcpSocketReadyForRpc();
    }
    const id = String(trackId).trim();
    const payload = id.startsWith('qr_') ? { token: id } : { trackId: id };
    const response = await this.sendAndWait(Opcode.LOGIN_BY_QR, payload);

    if (response.payload && response.payload.error) {
      throw new Error(`QR login error: ${JSON.stringify(response.payload.error)}`);
    }

    return response.payload;
  }

  async approveQR(qrLink: string): Promise<any> {
    if (this._useSocketTransport) {
      await this._ensureTcpSocketReadyForRpc();
    }
    if (!this.isAuthorized) {
      throw new Error('An authorized session is required to approve the QR');
    }
    const link = String(qrLink).trim();
    const response = await this.sendAndWait(Opcode.AUTH_QR_APPROVE, { qrLink: link });
    if (response.payload && response.payload.error) {
      throw new Error(`QR approve error: ${JSON.stringify(response.payload.error)}`);
    }
    return response.payload;
  }

  /**
   * LOGIN_BY_QR: like web.max.ru — first only trackId (HAR), then fallback variants + account token.
   */
  async _loginByQrWebMax(web: any, trackId: string, accountToken: any): Promise<any> {
    const id = String(trackId).trim();
    if (id.startsWith('qr_')) {
      const response = await web.sendAndWait(Opcode.LOGIN_BY_QR, { token: id });
      if (response.payload && response.payload.error) {
        throw new Error(`QR login error: ${JSON.stringify(response.payload.error)}`);
      }
      return response.payload;
    }
    const payloads: any[] = [{ trackId: id }, { track: id }, { authTrackId: id }];
    if (accountToken) {
      payloads.push(
        { trackId: id, token: accountToken },
        { track: id, token: accountToken },
        { trackId: id, account_token: accountToken },
        { track: id, account_token: accountToken }
      );
    }

    let lastErr: any;
    for (const payload of payloads) {
      try {
        const response = await web.sendAndWait(Opcode.LOGIN_BY_QR, payload);
        if (response.payload && response.payload.error) {
          const err = response.payload.error;
          const msg =
            typeof err === 'string'
              ? err
              : err && typeof err.message === 'string'
                ? err.message
                : response.payload.localizedMessage || JSON.stringify(err);
          lastErr = new Error(msg);
          if (/track\.not\.found/i.test(String(msg))) {
            throw new Error(
              `${msg}\n` +
                'The QR track is outdated or already used. Open web.max.ru, wait for a new QR and save qr.png immediately.'
            );
          }
          if (/proto\.payload/i.test(String(msg))) {
            continue;
          }
          continue;
        }
        return response.payload;
      } catch (e: any) {
        lastErr = e;
        if (e && e.message && /track\.not\.found|The QR track is outdated/i.test(e.message)) {
          throw e;
        }
      }
    }
    throw lastErr || new Error('LOGIN_BY_QR failed');
  }

  /**
   * Like web.max.ru (HAR): poll GET_QR_STATUS until status.loginAvailable === true (after a scan in the Max app).
   * Without this LOGIN_BY_QR often returns track.not.found — the track is not "ready" to confirm.
   */
  async _waitForWebQrLoginAvailable(web: any, trackId: string, options: any = {}): Promise<void> {
    const pollingInterval = options.pollingInterval ?? 5000;
    const defaultTtlMs = options.defaultTtlMs ?? 180000;
    let expiresAt = Date.now() + defaultTtlMs;

    console.log(
      '\n📱 Confirmation from the phone is required (like the official web client):\n' +
        '   On the phone: Max -> the QR login section for the web version / devices — point it at the same QR (same account).\n' +
        '   So that the browser tab does not send LOGIN_BY_QR before the script: after saving qr.png close the web.max.ru tab,\n' +
        '   then run this script and scan the QR from a file / second monitor.\n' +
        '   Waiting for loginAvailable on the server...'
    );

    while (true) {
      const now = Date.now();
      if (now >= expiresAt) {
        throw new Error(
          'No loginAvailable before expiration: scan the QR with the app on the same account or refresh qr.png.'
        );
      }

      const statusResponse = await web.checkQRStatus(trackId);
      if (statusResponse.status && statusResponse.status.expiresAt != null) {
        const ex = Number(statusResponse.status.expiresAt);
        if (Number.isFinite(ex)) {
          expiresAt = Math.min(expiresAt, ex);
        }
      }
      if (statusResponse.status && statusResponse.status.loginAvailable) {
        console.log('\n✅ The server is ready for LOGIN_BY_QR (loginAvailable).');
        return;
      }

      process.stdout.write('.');

      const wait = Math.min(
        pollingInterval,
        Math.max(0, expiresAt - Date.now())
      );
      await new Promise((r) => setTimeout(r, wait || pollingInterval));
    }
  }

  /**
   * QR login confirmation: a new TCP connection (only SESSION_INIT), then LOGIN_BY_QR — without LOGIN on this socket.
   */
  async _approveWebLoginByQrViaEphemeralTcp(trackId: string): Promise<any> {
    const accountToken = this._token || this.session.get('token');
    const transport = new MaxSocketTransport({
      deviceId: this.deviceId,
      deviceType: this.userAgent.deviceType,
      ua: this.userAgent.headerUserAgent,
      debug: this.debug
    });
    await transport.connect();
    await transport.handshake(this.userAgent);
    try {
      const id = String(trackId).trim();
      if (id.startsWith('qr_')) {
        const result = await transport.sendAndWait(Opcode.LOGIN_BY_QR, { token: id });
        return result.payload;
      }
      const payloads = [
        { trackId: id },
        { track: id },
        { trackId: id, token: accountToken },
        { track: id, token: accountToken }
      ];
      let lastErr: any;
      for (const payload of payloads) {
        try {
          const result = await transport.sendAndWait(Opcode.LOGIN_BY_QR, payload);
          return result.payload;
        } catch (e: any) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('LOGIN_BY_QR (TCP) failed');
    } finally {
      await transport.close();
    }
  }

  /**
   * Confirms web.max login by QR when the main session is on TCP: a separate WebSocket + LOGIN + LOGIN_BY_QR.
   * On the same TCP after LOGIN the server does not accept LOGIN_BY_QR ("Invalid session state").
   * WEB client: we do not use the TCP deviceId (gives login.cred); we take webDeviceId from the session or a new UUID.
   * First try webToken for sync, then the main token. Without a successful sync LOGIN_BY_QR often gives auth_by_track.no.attempts.
   */
  async _approveWebLoginByQrViaEphemeralWeb(trackId: string, options: any = {}, qrSource: string = ''): Promise<any> {
    const {
      retry = true,
      saveWebSession = true,
      waitForPhoneScan = true,
      qrPollingInterval = 5000
    } = options;
    const accountToken = this._token || this.session.get('token');
    if (!accountToken) {
      throw new Error('No session token');
    }

    const refererForMaxQr =
      /https?:\/\/max\.ru\//i.test(String(qrSource)) && !/web\.max\.ru/i.test(String(qrSource))
        ? 'https://max.ru/'
        : null;

    const webUa =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
    const webDeviceId = this.session.get('webDeviceId') || uuidv4();

    const ephemeralName = `_web_qr_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const web = new (this.constructor as any)({
      name: ephemeralName,
      deviceType: 'WEB',
      deviceId: webDeviceId,
      // Do not share clientSessionId with the parallel TCP — otherwise the server may drop the WS (1006).
      clientSessionId: Math.floor(Math.random() * 0x7fffffff),
      headerUserAgent: webUa,
      appVersion: '26.3.9',
      screen: '1920x1080 1.0x',
      osVersion: 'Windows 11',
      deviceName: 'Chrome',
      saveToken: false,
      debug: this.debug,
      apiUrl: this.apiUrl,
      origin: 'https://web.max.ru',
      referer: refererForMaxQr,
      maxReconnectAttempts: 0
    });
    web.handleReconnect = () => {};

    const wrapTrackError = (e: any) => {
      const m = e && e.message ? e.message : String(e);
      if (/auth_by_track|no\.attempts|Invalid session state|track\.not\.found/i.test(m)) {
        return new Error(
          `${m}\n` +
            'Hint: the WebSocket only accepts Origin web.max.ru; a Referer is added for max.ru/:auth/. Take a new qr.png screenshot right after the QR appears; an old track gives track.not.found.'
        );
      }
      return e;
    };

    try {
      console.log(
        `Separate WebSocket (Origin=web.max.ru${refererForMaxQr ? ', Referer=max.ru' : ''}): ws-api only accepts Origin web.max.ru; a Referer is added for QR from max.ru.`
      );
      await web.connect();

      const webTok = this.session.get('webToken');
      let syncOk = false;
      // A TCP token on WEB gives login.cred and the server often drops the socket — do not call sync with it.
      // Only a separate webToken from a previous web.max login.
      if (webTok && webTok !== accountToken) {
        try {
          web._token = webTok;
          await web.sync();
          syncOk = true;
          web.isAuthorized = true;
          if (saveWebSession && web.deviceId) {
            this.session.set('webDeviceId', web.deviceId);
          }
        } catch (e: any) {
          const msg = e && e.message ? e.message : String(e);
          console.log(`WEB LOGIN (sync) with webToken: ${msg}`);
        }
      }

      if (waitForPhoneScan) {
        await this._waitForWebQrLoginAvailable(web, trackId, {
          pollingInterval: qrPollingInterval
        });
      }

      const attempts = retry ? 2 : 1;
      let lastErr: any;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const wsOpen = web.ws && web.ws.readyState === WebSocket.OPEN;
          if (!web.isConnected || !wsOpen) {
            console.log('Reconnecting WebSocket before LOGIN_BY_QR (the socket is often closed after a LOGIN error)...');
            if (web.ws) {
              try {
                web.ws.removeAllListeners();
              } catch (_) {}
              try {
                web.ws.close();
              } catch (_) {}
              web.ws = null;
            }
            web.isConnected = false;
            web.pendingRequests.clear();
            await web.connect();
          }

          let loginData;
          if (syncOk) {
            loginData = await this._loginByQrWebMax(web, trackId, null);
          } else {
            loginData = await this._loginByQrWebMax(web, trackId, accountToken);
          }

          if (saveWebSession && loginData && typeof loginData === 'object') {
            this.session.set('webQrTrackId', trackId);
            const loginAttrs = loginData.tokenAttrs && loginData.tokenAttrs.LOGIN;
            const wtoken = loginAttrs && loginAttrs.token;
            if (wtoken) {
              this.session.set('webToken', wtoken);
            }
            if (loginData.deviceId != null) {
              this.session.set('webDeviceId', loginData.deviceId);
            }
            if (loginData.clientSessionId != null) {
              this.session.set('webClientSessionId', loginData.clientSessionId);
            }
          }

          console.log('✅ Web login by QR confirmed (LOGIN_BY_QR via WebSocket)');
          return loginData;
        } catch (e: any) {
          lastErr = wrapTrackError(e);
          if (attempt < attempts) {
            await new Promise((r) => setTimeout(r, 400));
            continue;
          }
          throw lastErr;
        }
      }
      throw lastErr;
    } finally {
      try {
        await web.stop();
        web.session.destroy();
      } catch (_) {}
    }
  }

  /**
   * Confirms a web-version login (web.max.ru) by QR URL or trackId,
   * using an already authorized session (including TCP after SMS/token).
   * Analogous to the `qr_url` + `account_token` scenario on third-party services: here the token is already in the session.
   *
   * @param qrUrlOrTrackId — full URL from the QR, or a UUID trackId
   * @param options
   * @returns payload of the LOGIN_BY_QR response
   */
  async approveWebLoginByQr(qrUrlOrTrackId: string, options: any = {}): Promise<any> {
    const { retry = true, saveWebSession = true } = options;

    const trackId = parseQrTrackId(qrUrlOrTrackId);
    if (!trackId) {
      throw new Error(
        'Could not extract the identifier from the QR: expected a max.ru/qr/v1/auth?token=qr_... URL, web.max with trackId or a UUID'
      );
    }

    const token = this._token || this.session.get('token');
    if (!token) {
      throw new Error('No token in the session to confirm the login');
    }

    if (this._useSocketTransport) {
      if (!this.isAuthorized) {
        throw new Error(
          'An authorized session is required: run connect() + sync() with a valid token'
        );
      }
      if (process.env.MAX_QR_TRY_TCP_FIRST === '1') {
        try {
          const loginData = await this._approveWebLoginByQrViaEphemeralTcp(trackId);
          if (saveWebSession && loginData && typeof loginData === 'object') {
            this.session.set('webQrTrackId', trackId);
            const loginAttrs = loginData.tokenAttrs && loginData.tokenAttrs.LOGIN;
            const wtoken = loginAttrs && loginAttrs.token;
            if (wtoken) {
              this.session.set('webToken', wtoken);
            }
            if (loginData.deviceId != null) {
              this.session.set('webDeviceId', loginData.deviceId);
            }
            if (loginData.clientSessionId != null) {
              this.session.set('webClientSessionId', loginData.clientSessionId);
            }
          }
          console.log('✅ Web login by QR confirmed (LOGIN_BY_QR, new TCP connection)');
          return loginData;
        } catch (e: any) {
          const msg = e && e.message ? e.message : String(e);
          console.log(`LOGIN_BY_QR via new TCP: ${msg} — trying WebSocket (Origin web.max.ru)...`);
        }
      }
      return await this._approveWebLoginByQrViaEphemeralWeb(trackId, options, qrUrlOrTrackId);
    }

    if (!this.isConnected) {
      throw new Error('No connection: first await client.connect()');
    }
    if (!this.isAuthorized) {
      throw new Error(
        'An authorized session is required: run start() or connect() + sync() with a valid token'
      );
    }

    let lastErr: any;
    const attempts = retry ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const loginData = await this.loginByQR(trackId);

        if (saveWebSession && loginData && typeof loginData === 'object') {
          this.session.set('webQrTrackId', trackId);
          const loginAttrs = loginData.tokenAttrs && loginData.tokenAttrs.LOGIN;
          const wtoken = loginAttrs && loginAttrs.token;
          if (wtoken) {
            this.session.set('webToken', wtoken);
          }
          if (loginData.deviceId != null) {
            this.session.set('webDeviceId', loginData.deviceId);
          }
          if (loginData.clientSessionId != null) {
            this.session.set('webClientSessionId', loginData.clientSessionId);
          }
        }

        console.log('✅ Web login by QR confirmed (LOGIN_BY_QR)');
        return loginData;
      } catch (e: any) {
        lastErr = e;
        if (attempt < attempts) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  /**
   * Polls QR code status.
   */
  async pollQRStatus(trackId: string, pollingInterval: number, expiresAt: number): Promise<boolean> {
    console.log('Waiting for QR code scan...');

    while (true) {
      // Check whether the QR has expired
      const now = Date.now();
      if (now >= expiresAt) {
        throw new Error('The QR code has expired. Restart the bot to get a new one.');
      }

      // Wait the specified interval
      await new Promise((resolve) => setTimeout(resolve, pollingInterval));

      try {
        const statusResponse = await this.checkQRStatus(trackId);

        if (statusResponse.status && statusResponse.status.loginAvailable) {
          console.log('✅ QR code scanned!');
          return true;
        }

        // Keep polling
        process.stdout.write('.');
      } catch (error: any) {
        console.error('\nError checking QR status:', error.message);
        throw error;
      }
    }
  }

  /**
   * Prints a QR code for linking a new device (the same flow as the web login).
   * Requires an already authorized session (after SMS/QR and sync).
   * On the phone: Profile -> Devices / Security -> Connect device (QR).
   *
   * @param options
   * @param options.waitForScan — wait until the QR is scanned
   * @param options.small — compact QR in the terminal
   * @returns `{ qrLink, trackId, pollingInterval, expiresAt }`
   */
  async showLinkDeviceQR(options: any = {}): Promise<any> {
    const { waitForScan = true, small = true } = options;

    if (!this.isConnected) {
      throw new Error('No connection: first await client.connect()');
    }
    if (!this.isAuthorized) {
      throw new Error('Authorization required: sign in and run sync, then call showLinkDeviceQR');
    }

    // After LOGIN on TCP the server does not accept GET_QR ("Invalid session state") — the same QR as the web client, only before WebSocket authorization.
    if (this._useSocketTransport) {
      return await this._showLinkDeviceQRViaEphemeralWeb(options);
    }

    console.log('Requesting QR code for linking a device...');
    const response = await this.sendAndWait(Opcode.GET_QR, undefined);

    throwIfGetQRRejected(response.payload);

    const qrData = response.payload;
    if (!qrData.qrLink || !qrData.trackId || !qrData.pollingInterval || !qrData.expiresAt) {
      throw new Error('Incomplete QR data from the server');
    }

    await this._printLinkDeviceQRConsole(qrData.qrLink, small);
    console.log('\n💡 Or open the link: ' + qrData.qrLink);
    console.log('='.repeat(70) + '\n');

    if (waitForScan) {
      await this.pollQRStatus(qrData.trackId, qrData.pollingInterval, qrData.expiresAt);
      console.log('\n✅ Device connected. Check the login on the phone.');
    }

    return {
      qrLink: qrData.qrLink,
      trackId: qrData.trackId,
      pollingInterval: qrData.pollingInterval,
      expiresAt: qrData.expiresAt
    };
  }

  async _printLinkDeviceQRConsole(qrLink: string, small: boolean = true): Promise<void> {
    console.log('\n' + '='.repeat(70));
    console.log('📱 LINKING A NEW DEVICE');
    console.log('='.repeat(70));
    console.log('\nOn the phone open Max — as when adding a device in the app:');
    console.log('➡️  Profile -> Devices / Security -> Connect device (QR login)');
    console.log('📸 Point the camera at the QR below — this is the same flow as the web client:\n');
    await this._deliverQrCode(qrLink, small);
  }

  /**
   * QR for linking a device when the main session is on TCP (ANDROID): a short-lived WEB client without LOGIN.
   */
  async _showLinkDeviceQRViaEphemeralWeb(options: any = {}): Promise<any> {
    const { waitForScan = true, small = true } = options;
    const ephemeralName = `_link_qr_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const webQr = new (this.constructor as any)({
      name: ephemeralName,
      deviceType: 'WEB',
      debug: this.debug,
      apiUrl: this.apiUrl,
      origin: this.origin,
      maxReconnectAttempts: 0
    });

    try {
      console.log(
        'Separate WebSocket connection (like web.max.ru): on an already logged-in TCP a QR request is not available any other way.'
      );
      await webQr.connect();

      const response = await webQr.sendAndWait(Opcode.GET_QR, undefined);
      throwIfGetQRRejected(response.payload);

      const qrData = response.payload;
      if (!qrData.qrLink || !qrData.trackId || !qrData.pollingInterval || !qrData.expiresAt) {
        throw new Error('Incomplete QR data from the server');
      }

      await this._printLinkDeviceQRConsole(qrData.qrLink, small);

      console.log('\n💡 Or open the link: ' + qrData.qrLink);
      console.log('='.repeat(70) + '\n');

      if (waitForScan) {
        await webQr.pollQRStatus(qrData.trackId, qrData.pollingInterval, qrData.expiresAt);
        await webQr.loginByQR(qrData.trackId);
        console.log('\n✅ Device connected. Check the phone.');
      }

      return {
        qrLink: qrData.qrLink,
        trackId: qrData.trackId,
        pollingInterval: qrData.pollingInterval,
        expiresAt: qrData.expiresAt
      };
    } finally {
      try {
        await webQr.stop();
        webQr.session.destroy();
      } catch (_) {}
    }
  }

  /**
   * Authorization via QR code.
   */
  async authorizeByQR(): Promise<void> {
    try {
      console.log('Requesting QR code for authorization...');

      const qrData = await this.requestQR();

      if (!qrData.qrLink || !qrData.trackId || !qrData.pollingInterval || !qrData.expiresAt) {
        throw new Error('Incomplete QR data from the server');
      }

      console.log('\n' + '='.repeat(70));
      console.log('🔐 QR CODE AUTHORIZATION');
      console.log('='.repeat(70));
      console.log('\n📱 On the phone: Profile -> Devices / Security -> Connect device');
      console.log('📸 Scan the QR code:\n');

      // Deliver the QR code to the caller via the onQrCode callback (e.g. print it in the terminal)
      await this._deliverQrCode(qrData.qrLink, true);

      console.log('\n💡 Or open the link: ' + qrData.qrLink);
      console.log('='.repeat(70) + '\n');

      // Poll the status
      await this.pollQRStatus(qrData.trackId, qrData.pollingInterval, qrData.expiresAt);

      // Get the token
      console.log('\n\nGetting the authorization token...');
      const loginData = await this.loginByQR(qrData.trackId);

      const loginAttrs = loginData.tokenAttrs && loginData.tokenAttrs.LOGIN;
      const token = loginAttrs && loginAttrs.token;

      if (!token) {
        throw new Error('Token not received from the response');
      }

      // Save the token and all session data for the TCP connection
      this.session.set('token', token);
      this.session.set('deviceId', this.deviceId);
      this.session.set('clientSessionId', this.userAgent.clientSessionId);
      this.session.set('deviceType', 'ANDROID'); // Switch to Android TCP on the next run
      this.session.set('headerUserAgent', this.userAgent.headerUserAgent);
      this.session.set('appVersion', this.userAgent.appVersion);
      this.session.set('osVersion', this.userAgent.osVersion);
      this.session.set('deviceName', this.userAgent.deviceName);
      this.session.set('screen', this.userAgent.screen);
      this.session.set('timezone', this.userAgent.timezone);
      this.session.set('locale', this.userAgent.locale);
      this.session.set('buildNumber', this.userAgent.buildNumber);

      this.isAuthorized = true;
      this._token = token;

      console.log('✅ QR code authorization successful!');
      console.log('💡 The TCP Socket transport will be used on the next run');

      // Run sync
      await this.sync();
    } catch (error: any) {
      console.error('QR authorization error:', error);
      throw error;
    }
  }

  /**
   * Authorization by phone number via SMS (ANDROID).
   */
  async authorizeBySMS(phone: string): Promise<any> {
    if (!this._useSocketTransport) {
      throw new Error('SMS authorization is only available for ANDROID (use deviceType: "ANDROID")');
    }

    try {
      console.log('📱 Authorization by phone number...');

      // Normalize the phone number
      const normalizedPhone = this._normalizePhoneNumber(phone);

      console.log(`📤 Requesting a code for: ${normalizedPhone}`);

      if (!this._socketTransport) {
        throw new Error('Socket transport is not initialized');
      }

      // Request the code
      const tempToken = await this._socketTransport.requestCode(normalizedPhone);

      if (!tempToken) {
        throw new Error('Temporary token not received');
      }

      console.log('✅ Code sent! Waiting for code input...');

      return {
        tempToken,
        phone: normalizedPhone,
        sendCode: async (code: string) => {
          console.log('🔐 Checking code...');

          const authResponse = await this._socketTransport.sendCode(tempToken, code);

          const pc =
            authResponse && authResponse.passwordChallenge != null
              ? authResponse.passwordChallenge
              : null;
          const trackId =
            pc &&
            (() => {
              const t = pc.trackId ?? pc.track_id;
              return t != null && String(t).trim() !== '' ? String(t).trim() : null;
            })();

          if (pc && trackId) {
            const hint = pc.hint != null ? String(pc.hint) : '';
            const email = pc.email != null ? String(pc.email) : '';
            if (this.debug || this._authDebug) {
              console.log('[webmaxsocket:auth] passwordChallenge: trackId=%s hint=%s', trackId, hint || '(empty)');
            }
            console.log('🔒 A 2FA password is required (as in the Max app).');
            if (hint) console.log('   Hint:', hint);
            if (email) console.log('   Email in challenge:', email);

            return {
              needsPassword: true,
              passwordChallenge: pc,
              trackId,
              sendPassword: async (password: string) => {
                if (!password || !String(password).trim()) {
                  throw new Error('Empty 2FA password');
                }
                console.log('🔐 Checking 2FA password...');
                const afterPwd = await this._socketTransport.sendLogin2FAPassword(trackId, String(password).trim());
                const token = afterPwd?.tokenAttrs?.LOGIN?.token;
                if (!token) {
                  throw new Error('Token not received after entering the 2FA password');
                }
                this.session.set('token', token);
                this.session.set('deviceId', this.deviceId);
                this.session.set('clientSessionId', this.userAgent.clientSessionId);
                this.session.set('deviceType', this.userAgent.deviceType);
                this.session.set('headerUserAgent', this.userAgent.headerUserAgent);
                this.session.set('appVersion', this.userAgent.appVersion);
                this.session.set('osVersion', this.userAgent.osVersion);
                this.session.set('deviceName', this.userAgent.deviceName);
                this.session.set('screen', this.userAgent.screen);
                this.session.set('timezone', this.userAgent.timezone);
                this.session.set('locale', this.userAgent.locale);
                this.session.set('buildNumber', this.userAgent.buildNumber);
                this.isAuthorized = true;
                this._token = token;
                console.log('✅ SMS + 2FA authorization successful!');
                this._logAuthContext('sms:after_login', { tokenSource: 'sms_2fa' });
                await this.sync();
                if (this._saveTwofaPassword) {
                  this.session.set('twofaPassword', String(password).trim());
                }
                return token;
              }
            };
          }

          const token = authResponse?.tokenAttrs?.LOGIN?.token;

          if (!token) {
            throw new Error('Token not received from the response');
          }

          // Save the session
          this.session.set('token', token);
          this.session.set('deviceId', this.deviceId);
          this.session.set('clientSessionId', this.userAgent.clientSessionId);
          this.session.set('deviceType', this.userAgent.deviceType);
          this.session.set('headerUserAgent', this.userAgent.headerUserAgent);
          this.session.set('appVersion', this.userAgent.appVersion);
          this.session.set('osVersion', this.userAgent.osVersion);
          this.session.set('deviceName', this.userAgent.deviceName);
          this.session.set('screen', this.userAgent.screen);
          this.session.set('timezone', this.userAgent.timezone);
          this.session.set('locale', this.userAgent.locale);
          this.session.set('buildNumber', this.userAgent.buildNumber);

          this.isAuthorized = true;
          this._token = token;

          console.log('✅ SMS authorization successful!');
          this._logAuthContext('sms:after_login', { tokenSource: 'sms' });

          // Run sync
          await this.sync();

          return token;
        }
      };
    } catch (error: any) {
      console.error('SMS authorization error:', error);
      throw error;
    }
  }

  /**
   * User authorization (QR code for WEB, SMS for ANDROID).
   */
  async authorize(phone: string | null = null): Promise<any> {
    if (this._useSocketTransport && phone) {
      // SMS authorization for ANDROID
      console.log('🔐 Authorization via SMS');
      return await this.authorizeBySMS(phone);
    } else if (this._useSocketTransport && !phone) {
      throw new Error('A phone number is required for ANDROID. Use: authorize("+79001234567")');
    } else {
      // QR authorization for WEB
      console.log('🔐 Authorization via QR code');
      await this.authorizeByQR();
    }
  }

  /**
   * Saves a new session token if it differs from the current one (server-side rotation).
   */
  _persistSessionTokenIfNew(trimmed: any): boolean {
    if (!trimmed || typeof trimmed !== 'string') {
      return false;
    }
    const t = trimmed.trim();
    if (!t) {
      return false;
    }
    const prev = this._token || this.session.get('token');
    if (t === prev) {
      return false;
    }
    this._token = t;
    if (this._saveTokenToSession) {
      this.session.set('token', t);
    }
    if (this.debug || this._authDebug) {
      console.log('[webmaxsocket:auth] Saved a new session token (rotation)');
    }
    return true;
  }

  /**
   * Recursively collects tokenAttrs.LOGIN.token strings from msgpack/JSON (like LOGIN responses and Max client pushes).
   */
  _collectRotatedLoginTokens(value: any, depth: number, outSet: Set<string>): void {
    if (depth > 24 || value == null) {
      return;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return;
    }
    if (typeof value !== 'object') {
      return;
    }
    if (value instanceof Map) {
      for (const v of value.values()) {
        this._collectRotatedLoginTokens(v, depth + 1, outSet);
      }
      return;
    }
    const ta = value.tokenAttrs;
    if (ta && ta.LOGIN && typeof ta.LOGIN.token === 'string') {
      const tok = ta.LOGIN.token.trim();
      if (tok.length > 0) {
        outSet.add(tok);
      }
    }
    if (Array.isArray(value)) {
      for (const el of value) {
        this._collectRotatedLoginTokens(el, depth + 1, outSet);
      }
      return;
    }
    for (const k of Object.keys(value)) {
      this._collectRotatedLoginTokens(value[k], depth + 1, outSet);
    }
  }

  /**
   * Any incoming payload: LOGIN response, notification, nested array — pick up token rotation.
   */
  _applyAnyRotatedSessionToken(payload: any): void {
    const set = new Set<string>();
    this._collectRotatedLoginTokens(payload, 0, set);
    for (const t of set) {
      this._persistSessionTokenIfNew(t);
    }
  }

  /**
   * If the server returned a new LOGIN token (rotation), save it like for SMS/QR.
   */
  _applyLoginTokenFromSyncResponse(responsePayload: any): void {
    this._applyAnyRotatedSessionToken(responsePayload);
  }

  _scheduleSessionRefreshIfNeeded(): void {
    this._clearSessionRefreshTimer();
    const ms = this._sessionRefreshIntervalMs;
    if (!ms) {
      return;
    }
    const minMs = 10_000;
    const interval = ms < minMs ? minMs : ms;
    if (ms < minMs) {
      console.warn(
        `[webmaxsocket] sessionRefreshIntervalMs=${ms} is too small, using the minimum ${minMs} ms`
      );
    }
    this._sessionRefreshTimer = setInterval(() => {
      if (!this.isAuthorized || !this.isConnected) {
        return;
      }
      if (this._sessionRefreshRunning) {
        return;
      }
      this._sessionRefreshRunning = true;
      this.sync()
        .catch((e: any) => {
          console.error('⚠️ Periodic sync failed:', e.message || e);
        })
        .finally(() => {
          this._sessionRefreshRunning = false;
        });
    }, interval);
  }

  _clearSessionRefreshTimer(): void {
    if (this._sessionRefreshTimer) {
      clearInterval(this._sessionRefreshTimer);
      this._sessionRefreshTimer = null;
    }
  }

  /** Stops the background periodic sync (`sessionRefreshIntervalMs`). */
  stopSessionRefresh(): void {
    this._clearSessionRefreshTimer();
  }

  _clearTcpInteractiveTimer(): void {
    if (this._tcpInteractiveTimer) {
      clearInterval(this._tcpInteractiveTimer);
      this._tcpInteractiveTimer = null;
    }
  }

  /** Periodic "interactive" PING on TCP (like web: cmd(1, { interactive })). */
  _startTcpInteractivePing(): void {
    this._clearTcpInteractiveTimer();
    if (!this._useSocketTransport || !this._tcpInteractivePingMs) {
      return;
    }
    this._tcpInteractiveTimer = setInterval(() => {
      if (
        !this._tcpLoginCompleted ||
        !this._socketTransport ||
        !this._socketTransport.socket ||
        this._socketTransport.socket.destroyed
      ) {
        return;
      }
      try {
        this._socketTransport.sendOneWay(Opcode.PING, { interactive: true });
      } catch (_) {
        /* ignore */
      }
    }, this._tcpInteractivePingMs);
  }

  /**
   * TCP: after LOGIN save the fields for the next LOGIN (lastLogin = time, counters — like web cmd(19)).
   */
  _persistTcpSyncStateFromResponse(p: any): void {
    if (!this._useSocketTransport || !p || typeof p !== 'object') {
      return;
    }
    const time =
      p.time != null
        ? Number(p.time)
        : p.serverTime != null
          ? Number(p.serverTime)
          : NaN;
    if (Number.isFinite(time)) {
      this.session.set('maxTcpSyncLastLogin', time);
    }
    const pick = (v: any) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const nums = [
      ['chatsSync', 'maxTcpChatsSync'],
      ['contactsSync', 'maxTcpContactsSync'],
      ['draftsSync', 'maxTcpDraftsSync']
    ];
    for (const [from, sessKey] of nums) {
      const n = pick(p[from]);
      if (n != null) {
        this.session.set(sessKey, n);
      }
    }
    if (p.configHash != null && String(p.configHash).length) {
      this.session.set('maxTcpConfigHash', String(p.configHash));
    }
  }

  /** LOGIN (19) fields on TCP (like web cmd(19): lastLogin, counters, presenceSync -1). */
  _buildTcpCompactSyncPayload(token: string): any {
    const sn = (key: string, def: number = 0) => {
      const v = this.session.get(key);
      const n = Number(v);
      return Number.isFinite(n) ? n : def;
    };
    const out: any = {
      interactive: true,
      token,
      chatsSync: sn('maxTcpChatsSync', 0),
      contactsSync: sn('maxTcpContactsSync', 0),
      presenceSync: -1,
      draftsSync: sn('maxTcpDraftsSync', 0),
      chatsCount: 40
    };
    const ll = Number(this.session.get('maxTcpSyncLastLogin'));
    if (Number.isFinite(ll)) {
      out.lastLogin = ll;
    }
    const ch = this.session.get('maxTcpConfigHash');
    if (ch != null && String(ch).length) {
      out.configHash = String(ch);
    }
    return out;
  }

  /**
   * Synchronizes with the server (user info, chats, etc.).
   */
  async sync(): Promise<any> {
    console.log('🔄 Synchronizing with the server...');

    this._logAuthContext('sync');

    const token = this._token || this.session.get('token');

    if (!token) {
      throw new Error('Token not found, authorization required');
    }

    let payload: any;
    if (this._useSocketTransport) {
      payload = {
        ...this._buildTcpCompactSyncPayload(token),
        userAgent: this.userAgent.toJSON()
      };
    } else {
      payload = {
        interactive: true,
        token: token,
        chatsSync: 0,
        contactsSync: 0,
        presenceSync: 0,
        draftsSync: 0,
        chatsCount: 40,
        userAgent: this.userAgent.toJSON()
      };
    }

    /**
     * TCP: the socket may have dropped (server, network) while isConnected is still true — restore the transport.
     */
    if (this._useSocketTransport) {
      const dead =
        !this._socketTransport ||
        !this._socketTransport.socket ||
        this._socketTransport.socket.destroyed;
      if (dead) {
        if (this.debug || this._authDebug) {
          console.log('[webmaxsocket:sync] TCP: socket unavailable — new connection');
        }
        this._clearTcpInteractiveTimer();
        if (this._socketTransport) {
          try {
            await this._socketTransport.close();
          } catch (_) {
            /* ignore */
          }
        }
        this._socketTransport = null;
        this.isConnected = false;
        this._tcpLoginCompleted = false;
        await this._connectSocket();
      }
    }

    /**
     * TCP: a repeated LOGIN (19) on the same TLS gives "Invalid session state".
     * SYNC (21) on the socket reliably gives "Something went wrong" (in the web client a resync is also opcode 19, not 21).
     * Working path: close the socket, new connection, LOGIN again with the same body.
     */
    let response: any;
    try {
      if (this._useSocketTransport && this._tcpLoginCompleted) {
        if (this.debug || this._authDebug) {
          const { token: _tok, userAgent: _ua, ...rest } = payload;
          console.log(
            '[webmaxsocket:sync] TCP: repeated sync — new TLS + LOGIN (19), body:',
            JSON.stringify(rest)
          );
        }
        this._clearTcpInteractiveTimer();
        if (this._socketTransport) {
          try {
            await this._socketTransport.close();
          } catch (_) {
            /* ignore */
          }
          this._socketTransport = null;
        }
        this.isConnected = false;
        this._tcpLoginCompleted = false;
        await this._connectSocket();
        response = await this.sendAndWait(Opcode.LOGIN, payload);
      } else {
        response = await this.sendAndWait(Opcode.LOGIN, payload);
      }
    } catch (e: any) {
      if (this._useSocketTransport) {
        this._tcpLoginCompleted = false;
        this._clearTcpInteractiveTimer();
        try {
          if (this._socketTransport) {
            await this._socketTransport.close();
          }
        } catch (_) {
          /* ignore */
        }
        this._socketTransport = null;
        this.isConnected = false;
      }
      throw e;
    }

    if (response.payload && response.payload.error) {
      const err = response.payload.error;
      const msg = typeof err === 'string' ? err : response.payload.localizedMessage || JSON.stringify(err);
      throw new Error(msg);
    }

    if (this._useSocketTransport) {
      this._tcpLoginCompleted = true;
      this._startTcpInteractivePing();
    }

    // Save user info
    const responsePayload = response.payload || {};

    this._applyLoginTokenFromSyncResponse(responsePayload);
    this._persistTcpSyncStateFromResponse(responsePayload);

    // Extract user data from profile.contact
    if (responsePayload.profile && responsePayload.profile.contact) {
      const contact = responsePayload.profile.contact;
      const name = contact.names && contact.names.length > 0 ? contact.names[0] : {};

      const userData = {
        id: contact.id,
        firstname: name.firstName || name.name || '',
        lastname: name.lastName || '',
        phone: contact.phone,
        avatar: contact.baseUrl || contact.baseRawUrl,
        photoId: contact.photoId,
        rawData: contact
      };

      this.me = new User(userData);
      const fullName = this.me.fullname || this.me.firstname || 'User';
      console.log(`✅ Synchronization completed. Signed in as: ${fullName} (ID: ${this.me.id})`);
    } else if (!this.me) {
      console.log('User data not found in the sync response (normal for a short SYNC without profile)');
    }

    try {
      let libVersion = 'unknown';
      try {
        libVersion = require(path.join(__dirname, '..', '..', 'package.json')).version;
      } catch (_) {
        /* ignore */
      }
      this.session.set('_authMeta', {
        lastSyncOkAt: new Date().toISOString(),
        webmaxsocket: libVersion,
        node: process.version
      });
    } catch (_) {
      /* ignore */
    }
    if (this._sessionBackupOnSuccess) {
      this.session.copyToLastOk();
    }
    this._logAuthContext('sync:ok', { userId: this.me?.id });

    this.lastSyncPayload = responsePayload;
    return responsePayload;
  }

  /**
   * Gets the current user's profile.
   */
  async fetchMyProfile(): Promise<void> {
    try {
      console.log('📱 Requesting user profile...');
      const response = await this.sendAndWait(Opcode.PROFILE, {});

      if (response.payload && response.payload.user) {
        this.me = new User(response.payload.user);
        const name = this.me.fullname || this.me.firstname || 'User';
        console.log(`✅ Profile loaded: ${name} (ID: ${this.me.id})`);
      }
    } catch (error: any) {
      console.error('⚠️ Failed to load profile:', error.message);
    }
  }

  /**
   * Connects with an existing session.
   */
  async connectWithSession(): Promise<void> {
    try {
      await this.connect();

      const token = this.session.get('token');

      if (!token) {
        console.log('Token not found, authorization required');
        await this.authorize();
        return;
      }

      this._token = token;

      this._logAuthContext('connectWithSession:before_sync', { tokenSource: 'session_file' });

      try {
        await this.sync();
        this.isAuthorized = true;
        console.log('Connected with the saved session successfully');
        this._scheduleSessionRefreshIfNeeded();
      } catch (error: any) {
        console.log('Session expired, re-authorization required');
        if (this.debug || this._authDebug) {
          console.log('[webmaxsocket:auth] sync error:', error.message);
        }
        if (this._clearSessionOnFailedSync) {
          this.session.clear();
        }
        await this.authorize();
      }
    } catch (error: any) {
      throw error;
    }
  }

  /**
   * Establishes a connection (WebSocket or Socket).
   */
  async connect(): Promise<any> {
    if (this._useSocketTransport) {
      return this._connectSocket();
    } else {
      return this._connectWebSocket();
    }
  }

  /**
   * Connects via TCP Socket (for ANDROID).
   */
  async _connectSocket(): Promise<void> {
    if (this._socketTransport && this._socketTransport.socket && !this._socketTransport.socket.destroyed) {
      this.isConnected = true;
      return;
    }

    this._tcpLoginCompleted = false;
    this._clearTcpInteractiveTimer();
    this._socketTransport = new MaxSocketTransport({
      deviceId: this.deviceId,
      deviceType: this.userAgent.deviceType,
      ua: this.userAgent.headerUserAgent,
      debug: this.debug
    });

    this._socketTransport.onNotification = (data: any) => {
      this.handleSocketNotification(data);
    };

    await this._socketTransport.connect();
    await this._socketTransport.handshake(this.userAgent);

    this.isConnected = true;
    this.reconnectAttempts = 0;
    this.emit('connected');

    console.log('TCP Socket connection established');
  }

  /**
   * Establishes a WebSocket connection (for WEB).
   */
  async _connectWebSocket(): Promise<void> {
    if (this.ws && this.isConnected) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const headers: any = {
        Origin: this.origin,
        'User-Agent': this._handshakeUserAgent.headerUserAgent
      };
      if (this._wsReferer) {
        headers.Referer = this._wsReferer;
      }

      this.ws = new WebSocket(this.apiUrl, {
        headers: headers
      });

      this.ws.on('open', async () => {
        console.log('WebSocket connection established');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.emit('connected');

        try {
          await this.handshake();
          resolve();
        } catch (error: any) {
          reject(error);
        }
      });

      this.ws.on('message', (data: any) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error: any) => {
        console.error('WebSocket error:', error.message);
        this.triggerHandlers(EventTypes.ERROR, error);
        reject(error);
      });

      this.ws.on('close', (code: number, reason: any) => {
        const rs = reason && reason.length ? reason.toString() : '';
        console.log(`WebSocket connection closed (code=${code}${rs ? `, ${rs}` : ''})`);
        this.isConnected = false;
        const err = new Error('Connection closed');
        for (const [, pending] of this.pendingRequests) {
          if (pending.timeoutId) clearTimeout(pending.timeoutId);
          pending.reject(err);
        }
        this.pendingRequests.clear();
        this.triggerHandlers(EventTypes.DISCONNECT);
        this.handleReconnect();
      });
    });
  }

  /**
   * Handshake after connecting.
   */
  async handshake(): Promise<any> {
    console.log('Performing handshake...');

    const payload = {
      deviceId: this.deviceId,
      userAgent: this._handshakeUserAgent.toJSON()
    };

    const response = await this.sendAndWait(Opcode.SESSION_INIT, payload);

    if (response.payload && response.payload.error) {
      throw new Error(`Handshake error: ${JSON.stringify(response.payload.error)}`);
    }

    console.log('Handshake completed successfully');
    return response;
  }

  /**
   * Handles notifications from the Socket transport.
   */
  async handleSocketNotification(data: any): Promise<void> {
    try {
      if (this.debug && data.opcode !== Opcode.PING) {
        const payload = data.payload?.error ? ` error=${JSON.stringify(data.payload.error)}` : '';
        console.log(`📥 ${getOpcodeName(data.opcode)} (seq=${data.seq})${payload}`);
      }

      this._applyAnyRotatedSessionToken(data.payload);

      switch (data.opcode) {
        case Opcode.NOTIF_MESSAGE:
          await this.handleNewMessage(data.payload);
          break;

        case Opcode.NOTIF_MSG_DELETE:
          await this.handleRemovedMessage(data.payload);
          break;

        case Opcode.NOTIF_CHAT:
          await this.handleChatAction(data.payload);
          break;

        case Opcode.PING:
          // Otherwise the server drops TCP after ~minutes; WebSocket sends sendPong here (same opcode PING + {})
          if (
            this._socketTransport &&
            this._socketTransport.socket &&
            !this._socketTransport.socket.destroyed
          ) {
            this._socketTransport.sendOneWay(Opcode.PING, {});
          }
          break;

        case Opcode.NOTIF_ATTACH:
          this._handleNotifAttach(data.payload);
          break;

        case Opcode.NOTIF_INCOMING_CALL:
          this.emit('incoming_call', data.payload);
          await this.triggerHandlers(EventTypes.INCOMING_CALL, data.payload);
          this.emit('raw_message', data);
          break;

        default:
          this.emit('raw_message', data);
      }
    } catch (error: any) {
      console.error('Error handling Socket notification:', error);
      await this.triggerHandlers(EventTypes.ERROR, error);
    }
  }

  /**
   * Handles reconnection.
   */
  handleReconnect(): void {
    if (this.maxReconnectAttempts <= 0) {
      return;
    }
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`);

      setTimeout(() => {
        this.connect();
      }, this.reconnectDelay);
    } else {
      console.error('Maximum number of reconnection attempts exceeded');
    }
  }

  /**
   * Handles incoming messages (WebSocket).
   */
  async handleMessage(data: any): Promise<void> {
    try {
      const message = JSON.parse(data.toString());

      if (this.debug && message.opcode !== Opcode.PING) {
        const payload = message.payload?.error ? ` error=${JSON.stringify(message.payload.error)}` : '';
        console.log(`📥 ${getOpcodeName(message.opcode)} (seq=${message.seq})${payload}`);
      }

      this._applyAnyRotatedSessionToken(message.payload);

      // Handle replies to requests by seq (seq may be 0 — do not use truthiness)
      if (
        message.seq !== undefined &&
        message.seq !== null &&
        this.pendingRequests.has(message.seq)
      ) {
        const pending = this.pendingRequests.get(message.seq);
        this.pendingRequests.delete(message.seq);

        if (pending.timeoutId) {
          clearTimeout(pending.timeoutId);
        }

        pending.resolve(message);
        return;
      }

      // Handle notifications
      switch (message.opcode) {
        case Opcode.NOTIF_MESSAGE:
          await this.handleNewMessage(message.payload);
          break;

        case Opcode.NOTIF_MSG_DELETE:
          await this.handleRemovedMessage(message.payload);
          break;

        case Opcode.NOTIF_CHAT:
          await this.handleChatAction(message.payload);
          break;

        case Opcode.PING:
          await this.sendPong();
          break;

        case Opcode.NOTIF_ATTACH:
          this._handleNotifAttach(message.payload);
          break;

        case Opcode.NOTIF_INCOMING_CALL:
          this.emit('incoming_call', message.payload);
          await this.triggerHandlers(EventTypes.INCOMING_CALL, message.payload);
          this.emit('raw_message', message);
          break;

        default:
          this.emit('raw_message', message);
      }
    } catch (error: any) {
      console.error('Error handling message:', error);
      await this.triggerHandlers(EventTypes.ERROR, error);
    }
  }

  /**
   * Sends a pong answer to a ping.
   */
  async sendPong(): Promise<void> {
    try {
      const message = this.makeMessage(Opcode.PING, {});
      this.ws.send(JSON.stringify(message));
    } catch (error: any) {
      console.error('Error sending pong:', error);
    }
  }

  /**
   * Handles a new message.
   */
  async handleNewMessage(data: any): Promise<void> {
    // Extract message data from the correct place
    // Structure: { chatId, message: { sender, id, text, ... } }
    const messageData = data.message || data;

    // Add chatId if missing in messageData
    if (!messageData.chatId && data.chatId) {
      messageData.chatId = data.chatId;
    }

    const message = new Message(messageData, this);

    if (this._incomingLogMode === 'messages' || this._incomingLogMode === 'verbose') {
      printIncomingLog('message', message.rawData);
    }

    // Try to load sender info if missing
    if (!message.sender && message.senderId && message.senderId !== this.me?.id) {
      await message.fetchSender();
    }

    await this.triggerHandlers(EventTypes.MESSAGE, message);

    const callAttaches = callHelpers.extractCallAttachesFromNotifPayload(data);
    if (callAttaches.length > 0) {
      const summaries = callAttaches.map((a: any) => callHelpers.summarizeCallAttach(a));
      const callLogEvent = {
        chatId: data.chatId,
        message,
        callAttaches,
        summaries
      };
      this.emit('call_log', callLogEvent);
      await this.triggerHandlers(EventTypes.CALL_LOG, callLogEvent);
    }
  }

  /**
   * Handles a removed message.
   */
  async handleRemovedMessage(data: any): Promise<void> {
    const message = new Message(data, this);
    if (this._incomingLogMode === 'verbose') {
      printIncomingLog('message_removed', message.rawData);
    }
    await this.triggerHandlers(EventTypes.MESSAGE_REMOVED, message);
  }

  /**
   * Handles a chat action.
   */
  async handleChatAction(data: any): Promise<void> {
    const action = new ChatAction(data, this);
    if (this._incomingLogMode === 'verbose') {
      printIncomingLog('chat_action', action.rawData);
    }
    await this.triggerHandlers(EventTypes.CHAT_ACTION, action);
  }

  /**
   * Creates a message in the Max API protocol.
   * payload is not included in JSON when undefined — like web.max.ru for GET_QR (only opcode).
   */
  makeMessage(opcode: number, payload: any, cmd: number = 0): any {
    this.seq += 1;

    const message: any = {
      ver: this.ver,
      cmd: cmd,
      seq: this.seq,
      opcode: opcode
    };
    if (payload !== undefined) {
      message.payload = payload;
    }
    return message;
  }

  /**
   * Sends a request and waits for a reply.
   */
  async sendAndWait(opcode: number, payload: any, cmd: number = 0, timeout: number = 20000): Promise<any> {
    if (!this.isConnected) {
      throw new Error('Connection not established');
    }

    // Use Socket transport for ANDROID
    if (this._useSocketTransport && this._socketTransport) {
      return await this._socketTransport.sendAndWait(opcode, payload, cmd, timeout);
    }

    // WebSocket transport for WEB
    return new Promise((resolve, reject) => {
      const message = this.makeMessage(opcode, payload, cmd);
      const seq = message.seq;

      this.pendingRequests.set(seq, { resolve, reject });

      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(seq)) {
          this.pendingRequests.delete(seq);
          reject(new Error(`Request timeout (seq: ${seq}, opcode: ${opcode})`));
        }
      }, timeout);

      this.pendingRequests.get(seq).timeoutId = timeoutId;

      this.ws.send(JSON.stringify(message));
    });
  }

  _nextClientMessageId(): number {
    const n = this._clientSendCid;
    this._clientSendCid = (this._clientSendCid % 0x7fffffff) + 1;
    return n;
  }

  /** int32: Date.now() and large numbers break MSG_SEND validation on TCP. */
  _normalizeOutgoingCid(cid: any): number {
    if (cid == null || cid === '') return this._nextClientMessageId();
    const n = Number(cid);
    if (!Number.isFinite(n)) return this._nextClientMessageId();
    const x = Math.trunc(n);
    if (x > 2147483647 || x < -2147483648) {
      return this._nextClientMessageId();
    }
    return x;
  }

  /**
   * messageId for REPLY: int when safe, otherwise string (long ids).
   */
  _normalizeReplyMessageId(replyTo: any): any {
    if (replyTo == null || replyTo === '') return null;
    if (typeof replyTo === 'number' && Number.isFinite(replyTo)) return replyTo;
    if (typeof replyTo === 'bigint') return Number(replyTo);
    if (typeof replyTo === 'string' && /^-?\d+$/.test(replyTo)) {
      const n = Number(replyTo);
      if (Number.isSafeInteger(n)) return n;
      return replyTo;
    }
    return String(replyTo);
  }

  /**
   * Builds the MSG_SEND message body: without link: null; cid in int32; elements for text.
   */
  _buildOutgoingMessageBody(text: any, cid: any, replyTo: any, attachments: any): any {
    const t = text == null ? '' : String(text);
    const cidVal = this._normalizeOutgoingCid(cid);

    const body: any = {
      text: t,
      cid: cidVal,
      elements: []
    };

    const att = attachments || [];
    if (att.length) {
      body.attaches = att;
    }

    if (replyTo != null && replyTo !== '') {
      body.link = {
        type: 'REPLY',
        messageId: this._normalizeReplyMessageId(replyTo)
      };
    }
    return body;
  }

  _normalizeChatId(chatId: any): any {
    if (chatId == null) return chatId;
    if (typeof chatId === 'bigint') return Number(chatId);
    const n = Number(chatId);
    return Number.isNaN(n) ? chatId : n;
  }

  /**
   * int64 for the msgpack body of a file URL request. For large ids do not use Number — BigInt/string.
   */
  _toInt64ForPayload(v: any): bigint {
    if (v == null) {
      throw new Error('_toInt64ForPayload: empty value');
    }
    if (typeof v === 'bigint') {
      return v;
    }
    const s = String(v).trim();
    if (!/^-?\d+$/.test(s)) {
      throw new Error(`_toInt64ForPayload: expected an integer, got: ${typeof v}`);
    }
    return BigInt(s);
  }

  /** Temporary HTTPS URL for a FILE attachment when there is no baseUrl in history. */
  async requestFileDownloadUrl({
    chatId,
    messageId,
    fileId,
    fileName = '',
    requestId = null,
    attachLocalId = ''
  }: any): Promise<string> {
    const rid =
      requestId != null
        ? this._toInt64ForPayload(requestId)
        : BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000));

    const payload: any = {
      requestId: rid,
      fileId: this._toInt64ForPayload(fileId),
      fileName: fileName != null ? String(fileName) : '',
      messageId: this._toInt64ForPayload(messageId),
      chatId: this._toInt64ForPayload(chatId)
    };
    if (attachLocalId != null && String(attachLocalId).length > 0) {
      payload.attachLocalId = String(attachLocalId);
    }

    const r = await this.sendAndWait(Opcode.FILE_DOWNLOAD, payload);
    const p = r.payload;
    if (!p || p.error) {
      const msg =
        p && (p.localizedMessage || p.message || (typeof p.error === 'string' ? p.error : ''));
      throw new Error(msg || 'requestFileDownloadUrl: error response');
    }
    const url = p.url || p.c;
    if (!url || typeof url !== 'string') {
      throw new Error('requestFileDownloadUrl: no url in the response');
    }
    return url;
  }

  /**
   * NOTIF_ATTACH (136): attachment readiness after a video/file upload.
   */
  _handleNotifAttach(payload: any): void {
    if (!payload || typeof payload !== 'object') return;
    const vid = payload.videoId;
    if (vid != null) {
      const k = String(vid);
      const fn = this._uploadPendingVideo.get(k);
      if (fn) {
        this._uploadPendingVideo.delete(k);
        fn();
      }
    }
    const fid = payload.fileId;
    if (fid != null) {
      const k = String(fid);
      const fn = this._uploadPendingFile.get(k);
      if (fn) {
        this._uploadPendingFile.delete(k);
        fn();
      }
    }
  }

  _waitUploadNotif(map: any, id: any, label: string, timeoutMs: number = 120000): Promise<void> {
    return new Promise((resolve, reject) => {
      const k = String(id);
      const t = setTimeout(() => {
        map.delete(k);
        reject(new Error(`Timeout waiting for NOTIF_ATTACH (${label})`));
      }, timeoutMs);
      map.set(k, () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  async _postMultipartUpload(uploadUrl: string, buf: Buffer, fname: string, mime: string): Promise<any> {
    const { Blob } = require('buffer');
    if (typeof fetch !== 'function') {
      throw new Error('upload: Node.js 18+ with global fetch is required');
    }
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mime }), fname);
    const res = await fetch(uploadUrl, {
      method: 'POST',
      body: form,
      headers: {
        Accept: '*/*',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        Origin: 'https://web.max.ru',
        Referer: 'https://web.max.ru/',
        'User-Agent': this.userAgent.headerUserAgent || 'Mozilla/5.0'
      }
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP upload: ${res.status} ${t.slice(0, 300)}`);
    }
    return res;
  }

  /**
   * Sends a message (with notification).
   */
  async sendMessage(options: any): Promise<any> {
    if (typeof options === 'string') {
      throw new Error('sendMessage requires an object with parameters: { chatId, text, cid }');
    }

    const { chatId, text, cid, replyTo, attachments } = options;

    const payload = {
      chatId: this._normalizeChatId(chatId),
      message: this._buildOutgoingMessageBody(text, cid, replyTo, attachments),
      notify: true
    };

    const response = await this.sendAndWait(Opcode.MSG_SEND, payload);

    if (response.payload && response.payload.message) {
      return new Message(response.payload.message, this);
    }

    return response.payload;
  }

  /**
   * Sends a message to a channel (without notification).
   */
  async sendMessageChannel(options: any): Promise<any> {
    if (typeof options === 'string') {
      throw new Error('sendMessageChannel requires an object with parameters: { chatId, text, cid }');
    }

    const { chatId, text, cid, replyTo, attachments } = options;

    const payload = {
      chatId: this._normalizeChatId(chatId),
      message: this._buildOutgoingMessageBody(text, cid, replyTo, attachments),
      notify: false
    };

    const response = await this.sendAndWait(Opcode.MSG_SEND, payload);

    if (response.payload && response.payload.message) {
      return new Message(response.payload.message, this);
    }

    return response.payload;
  }

  /**
   * Uploads a local image to the Max server; pass the result to `attachments` of sendMessage / reply.
   * Flow: PHOTO_UPLOAD -> UPLOAD_ATTACH_PREP -> HTTP POST to the returned URL. Requires Node 18+ (fetch, FormData).
   *
   * @param chatId
   * @param filePath path to the file (.png, .jpg, ...)
   * @returns `{ _type: 'PHOTO', photoToken: string }`
   */
  async uploadPhoto(chatId: any, filePath: string): Promise<any> {
    const fsp = require('fs/promises');
    const path = require('path');

    const buf = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === '.png'
        ? 'image/png'
        : ext === '.webp'
          ? 'image/webp'
          : ext === '.gif'
            ? 'image/gif'
            : 'image/jpeg';
    const fname = path.basename(filePath) || 'image.jpg';

    const r1 = await this.sendAndWait(Opcode.PHOTO_UPLOAD, { count: 1 });
    const p1 = r1.payload;
    if (p1 && p1.error) {
      const e: any = new Error(
        typeof p1.error === 'string' ? p1.error : JSON.stringify(p1.error)
      );
      e.rawPayload = p1;
      throw e;
    }
    const uploadUrl = p1 && p1.url;
    if (!uploadUrl) {
      throw new Error('PHOTO_UPLOAD: no url in the response');
    }

    await this.sendAndWait(Opcode.UPLOAD_ATTACH_PREP, {
      chatId: this._normalizeChatId(chatId),
      type: 'PHOTO'
    });

    const res = await this._postMultipartUpload(uploadUrl, buf, fname, mime);
    const obj = await res.json();
    const photos = obj.photos;
    let first: any;
    if (Array.isArray(photos)) {
      [first] = photos;
    } else if (photos && typeof photos === 'object') {
      first = Object.values(photos)[0];
    }
    const token = first && first.token;
    if (!token) {
      throw new Error(`PHOTO upload: unexpected JSON: ${JSON.stringify(obj).slice(0, 400)}`);
    }

    return {
      _type: 'PHOTO',
      photoToken: token
    };
  }

  /**
   * Uploads a video; result for `attachments: [{ _type: 'VIDEO', videoId, token }]`.
   * After HTTP POST waits for NOTIF_ATTACH (opcode 136).
   */
  async uploadVideo(chatId: any, filePath: string): Promise<any> {
    const fsp = require('fs/promises');
    const path = require('path');

    const buf = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const fname = path.basename(filePath) || 'video.mp4';
    const mime =
      ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';

    const r = await this.sendAndWait(Opcode.VIDEO_UPLOAD, { count: 1 });
    const p = r.payload;
    if (p && p.error) {
      const e: any = new Error(
        typeof p.error === 'string' ? p.error : JSON.stringify(p.error)
      );
      e.rawPayload = p;
      throw e;
    }
    const info = p && p.info && p.info[0];
    if (!info) {
      throw new Error('VIDEO_UPLOAD: no info in the response');
    }
    const { url: uploadUrl, videoId, token } = info;
    if (!uploadUrl || videoId == null || token == null) {
      throw new Error('VIDEO_UPLOAD: no url, videoId or token');
    }

    const waitReady = this._waitUploadNotif(this._uploadPendingVideo, videoId, 'VIDEO');

    await this.sendAndWait(Opcode.UPLOAD_ATTACH_PREP, {
      chatId: this._normalizeChatId(chatId),
      type: 'VIDEO'
    });

    await this._postMultipartUpload(uploadUrl, buf, fname, mime);

    await waitReady;

    return { _type: 'VIDEO', videoId, token };
  }

  /**
   * Uploads an arbitrary file (document, archive, **audio**, etc.) for `attachments: [{ _type: 'FILE', fileId }]`.
   * After HTTP POST waits for NOTIF_ATTACH.
   *
   * @param options
   */
  async uploadFile(chatId: any, filePath: string, options: any = {}): Promise<any> {
    const fsp = require('fs/promises');
    const path = require('path');

    const buf = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const fname = options.filename || path.basename(filePath) || 'file.bin';
    const mime =
      options.mimeType ||
      this._mimeGuessForFile(ext);

    const r = await this.sendAndWait(Opcode.FILE_UPLOAD, { count: 1 });
    const p = r.payload;
    if (p && p.error) {
      const e: any = new Error(
        typeof p.error === 'string' ? p.error : JSON.stringify(p.error)
      );
      e.rawPayload = p;
      throw e;
    }
    const info = p && p.info && p.info[0];
    if (!info) {
      throw new Error('FILE_UPLOAD: no info in the response');
    }
    const { url: uploadUrl, fileId } = info;
    if (!uploadUrl || fileId == null) {
      throw new Error('FILE_UPLOAD: no url or fileId');
    }

    const waitReady = this._waitUploadNotif(this._uploadPendingFile, fileId, 'FILE');

    await this.sendAndWait(Opcode.UPLOAD_ATTACH_PREP, {
      chatId: this._normalizeChatId(chatId),
      type: 'FILE'
    });

    await this._postMultipartUpload(uploadUrl, buf, fname, mime);

    await waitReady;

    return { _type: 'FILE', fileId };
  }

  /**
   * Uploads audio as a file (handy for .mp3, .ogg, .m4a, .wav).
   * Internally calls uploadFile() with a suitable MIME type.
   */
  async uploadAudio(chatId: any, filePath: string): Promise<any> {
    const path = require('path');
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === '.mp3'
        ? 'audio/mpeg'
        : ext === '.ogg' || ext === '.oga'
          ? 'audio/ogg'
          : ext === '.m4a' || ext === '.aac'
            ? 'audio/mp4'
            : ext === '.wav'
              ? 'audio/wav'
              : ext === '.flac'
                ? 'audio/flac'
                : 'audio/mpeg';
    return this.uploadFile(chatId, filePath, { mimeType: mime });
  }

  _mimeGuessForFile(ext: string): string {
    const m: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
      '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg',
      '.m4a': 'audio/mp4',
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm'
    };
    return m[ext] || 'application/octet-stream';
  }

  /**
   * Edits a message.
   */
  async editMessage(options: any): Promise<any> {
    const { messageId, chatId, text, attachments } = options;

    const payload = {
      chatId: chatId,
      messageId: messageId,
      text: text || '',
      elements: [],
      attaches: Array.isArray(attachments) && attachments.length ? attachments : []
    };

    const response = await this.sendAndWait(Opcode.MSG_EDIT, payload);

    if (response.payload && response.payload.message) {
      return new Message(response.payload.message, this);
    }

    return response.payload;
  }

  /**
   * Deletes a message.
   */
  async deleteMessage(options: any): Promise<boolean> {
    const { messageId, chatId, forMe } = options;

    const payload = {
      chatId: chatId,
      messageIds: Array.isArray(messageId) ? messageId : [messageId],
      forMe: forMe || false
    };

    await this.sendAndWait(Opcode.MSG_DELETE, payload);

    return true;
  }

  /**
   * Gets user info by ID.
   */
  async getUser(userId: any): Promise<any> {
    const response = await this.sendAndWait(Opcode.CONTACT_INFO, {
      contactIds: [userId]
    });

    const contact =
      response.payload && response.payload.contacts && response.payload.contacts.length > 0
        ? response.payload.contacts[0]
        : null;

    return this._contactToUser(contact);
  }

  /**
   * Phone normalization: '+79001234567'.
   */
  _normalizePhoneNumber(phone: any): string {
    if (phone == null || String(phone).trim() === '') {
      throw new Error('Phone number not provided');
    }
    let cleanPhone = String(phone).replace(/\D/g, '');
    if (cleanPhone.startsWith('8') && cleanPhone.length === 11) {
      cleanPhone = '7' + cleanPhone.slice(1);
    } else if (cleanPhone.startsWith('9') && cleanPhone.length === 10) {
      cleanPhone = '7' + cleanPhone;
    }
    if (!cleanPhone) {
      throw new Error('Invalid phone number');
    }
    return '+' + cleanPhone;
  }

  /**
   * Contact -> User (common parser for CONTACT_INFO / CONTACT_INFO_BY_PHONE).
   */
  _contactToUser(contact: any): any {
    if (!contact || contact.id == null) return null;
    const name = contact.names && contact.names.length > 0 ? contact.names[0] : {};
    return new User({
      id: contact.id,
      firstname: name.firstName || name.name || '',
      lastname: name.lastName || '',
      username: contact.nick || name.nick || null,
      phone: contact.phone,
      avatar: contact.baseUrl || contact.baseRawUrl,
      photoId: contact.photoId,
      bio: contact.description || '',
      rawData: contact
    });
  }

  /**
   * Searches a user by phone number (opcode CONTACT_INFO_BY_PHONE = 46).
   * Works if the target allows search by phone in privacy settings.
   * @returns `User | null`
   */
  async getUserByPhone(phone: string): Promise<any> {
    const normalizedPhone = this._normalizePhoneNumber(phone);
    try {
      const response = await this.sendAndWait(Opcode.CONTACT_INFO_BY_PHONE, {
        phone: normalizedPhone
      });
      const contact = response?.payload?.contact;
      return this._contactToUser(contact);
    } catch (e: any) {
      const msg = e && e.message ? String(e.message) : String(e);
      if (/contact\.not\.found|not found/i.test(msg)) {
        return null;
      }
      throw e;
    }
  }

  /**
   * User ID by phone number.
   * @returns `number | string | null`
   */
  async getUserIdByPhone(phone: string): Promise<any> {
    const user = await this.getUserByPhone(phone);
    return user ? user.id : null;
  }

  /**
   * Gets the chat list.
   */
  async getChats(marker: number = 0): Promise<any[]> {
    if (this._useSocketTransport && this._socketTransport) {
      return await this._socketTransport.getChats(marker);
    }

    const payload = {
      marker: marker
    };

    const response = await this.sendAndWait(Opcode.CHATS_LIST, payload);

    return response.payload && response.payload.chats ? response.payload.chats : [];
  }

  /**
   * Gets message history.
   */
  async getHistory(chatId: any, from: number = Date.now(), backward: number = 200, forward: number = 0): Promise<any[]> {
    const cid = this._normalizeChatId(chatId);

    if (this._useSocketTransport && this._socketTransport) {
      const messages = await this._socketTransport.getHistory(chatId, from, backward, forward);
      return messages.map((msg: any) =>
        new Message({ ...msg, chatId: msg.chatId != null ? msg.chatId : cid }, this)
      );
    }

    const payload = {
      chatId: chatId,
      from: from,
      forward: forward,
      backward: backward,
      getMessages: true
    };

    const response = await this.sendAndWait(Opcode.CHAT_HISTORY, payload);

    const messages = response.payload && response.payload.messages ? response.payload.messages : [];
    return messages.map((msg: any) =>
      new Message({ ...msg, chatId: msg.chatId != null ? msg.chatId : cid }, this)
    );
  }

  /**
   * Pins a message in a chat (CHAT_UPDATE).
   */
  async pinMessage({ chatId, messageId, notifyPin = false }: any): Promise<any> {
    return await this.sendAndWait(Opcode.CHAT_UPDATE, {
      chatId: this._normalizeChatId(chatId),
      messageId: String(messageId),
      notifyPin: !!notifyPin
    });
  }

  /**
   * Adds an emoji reaction to a message.
   */
  async setMessageReaction({ chatId, messageId, emoji }: any): Promise<any> {
    return await this.sendAndWait(Opcode.MSG_REACTION, {
      chatId: this._toInt64ForPayload(chatId),
      messageId: this._toInt64ForPayload(messageId),
      reaction: {
        reactionType: 'EMOJI',
        id: String(emoji)
      }
    });
  }

  /**
   * Removes your reaction from a message.
   */
  async cancelMessageReaction({ chatId, messageId }: any): Promise<any> {
    return await this.sendAndWait(Opcode.MSG_CANCEL_REACTION, {
      chatId: this._toInt64ForPayload(chatId),
      messageId: this._toInt64ForPayload(messageId)
    });
  }

  /**
   * List of reactions on a message.
   */
  async getMessageReactions({ chatId, messageId, count = 100 }: any): Promise<any> {
    return await this.sendAndWait(Opcode.MSG_GET_REACTIONS, {
      chatId: this._normalizeChatId(chatId),
      messageId: String(messageId),
      count
    });
  }

  /**
   * Info about chats by id (opcode 48).
   */
  async getChatInfo(chatIds: any): Promise<any> {
    const ids = Array.isArray(chatIds) ? chatIds : [chatIds];
    const response = await this.sendAndWait(Opcode.CHAT_INFO, { chatIds: ids });
    return response.payload;
  }

  /**
   * Resolves a link: channel, join/... invite, max.ru URL (LINK_INFO).
   */
  async resolveLink(link: string): Promise<any> {
    const response = await this.sendAndWait(Opcode.LINK_INFO, { link: String(link) });
    return response.payload;
  }

  /**
   * Joins by link (channel, group, etc.).
   */
  async joinChatByLink(link: string): Promise<any> {
    const response = await this.sendAndWait(Opcode.CHAT_JOIN, { link: String(link) });
    return response.payload;
  }

  /**
   * Subscribe / unsubscribe to a channel.
   */
  async setChatSubscription(chatId: any, subscribe: boolean): Promise<any> {
    return await this.sendAndWait(Opcode.CHAT_SUBSCRIBE, {
      chatId: this._normalizeChatId(chatId),
      subscribe: !!subscribe
    });
  }

  /**
   * Creates a group chat (CONTROL in MSG_SEND).
   */
  async createGroup({ title, userIds }: any): Promise<any> {
    const cid = this._nextClientMessageId();
    return await this.sendAndWait(Opcode.MSG_SEND, {
      message: {
        text: '',
        cid,
        elements: [],
        attaches: [
          {
            _type: 'CONTROL',
            event: 'new',
            chatType: 'CHAT',
            title,
            userIds
          }
        ]
      },
      notify: true
    });
  }

  /**
   * Creates a channel (CONTROL in MSG_SEND).
   */
  async createChannel({ title }: any): Promise<any> {
    const cid = this._nextClientMessageId();
    return await this.sendAndWait(Opcode.MSG_SEND, {
      message: {
        text: '',
        cid,
        elements: [],
        attaches: [
          {
            _type: 'CONTROL',
            event: 'new',
            title,
            chatType: 'CHANNEL'
          }
        ]
      },
      notify: true
    });
  }

  /**
   * Mutes chat notifications (CONFIG), like "do not disturb" for a chat.
   */
  async muteChat(chatId: any, mute: boolean = true): Promise<any> {
    const id = String(this._normalizeChatId(chatId));
    return await this.sendAndWait(Opcode.CONFIG, {
      settings: {
        chats: {
          [id]: {
            dontDisturbUntil: mute ? -1 : 0
          }
        }
      }
    });
  }

  /**
   * Chat members (no more than 500 per request).
   */
  async getChatMembers({ chatId, marker = 0, count = 500, type = 'MEMBER' }: any): Promise<any> {
    if (count > 500) {
      throw new Error('getChatMembers: count must not exceed 500');
    }
    return await this.sendAndWait(Opcode.CHAT_MEMBERS, {
      type,
      marker,
      chatId: this._normalizeChatId(chatId),
      count
    });
  }

  /**
   * Invites users to a chat.
   */
  async inviteToChat({ chatId, userIds, showHistory = true }: any): Promise<any> {
    return await this.sendAndWait(Opcode.CHAT_MEMBERS_UPDATE, {
      chatId: this._normalizeChatId(chatId),
      userIds,
      showHistory,
      operation: 'add'
    });
  }

  /**
   * Removes users from a chat.
   */
  async removeFromChat({ chatId, userIds, cleanMsgPeriod = 0 }: any): Promise<any> {
    return await this.sendAndWait(Opcode.CHAT_MEMBERS_UPDATE, {
      chatId: this._normalizeChatId(chatId),
      userIds,
      operation: 'remove',
      cleanMsgPeriod
    });
  }

  /**
   * Appoints admins. `permissions` — permission bitmask (default 120).
   */
  async addChatAdmins({ chatId, userIds, permissions = 120 }: any): Promise<any> {
    return await this.sendAndWait(Opcode.CHAT_MEMBERS_UPDATE, {
      chatId: this._normalizeChatId(chatId),
      userIds,
      type: 'ADMIN',
      operation: 'add',
      permissions
    });
  }

  /**
   * Removes admin rights.
   */
  async removeChatAdmins({ chatId, userIds }: any): Promise<any> {
    return await this.sendAndWait(Opcode.CHAT_MEMBERS_UPDATE, {
      chatId: this._normalizeChatId(chatId),
      userIds,
      type: 'ADMIN',
      operation: 'remove'
    });
  }

  /**
   * Transfers group ownership.
   */
  async transferChatOwnership({ chatId, newOwnerId }: any): Promise<any> {
    return await this.sendAndWait(Opcode.CHAT_UPDATE, {
      chatId: this._normalizeChatId(chatId),
      changeOwnerId: newOwnerId
    });
  }

  /**
   * Group settings: e.g. ONLY_OWNER_CAN_CHANGE_ICON_TITLE, ALL_CAN_PIN_MESSAGE, ONLY_ADMIN_CAN_ADD_MEMBER.
   */
  async setGroupOptions({ chatId, options }: any): Promise<any> {
    return await this.sendAndWait(Opcode.CHAT_UPDATE, {
      chatId: this._normalizeChatId(chatId),
      options
    });
  }

  /**
   * Several contacts by id (raw CONTACT_INFO response).
   */
  async getContacts(contactIds: any): Promise<any> {
    const ids = Array.isArray(contactIds) ? contactIds : [contactIds];
    const response = await this.sendAndWait(Opcode.CONTACT_INFO, { contactIds: ids });
    return response.payload;
  }

  /**
   * Adds a user to contacts.
   */
  async addContact(userId: any): Promise<any> {
    return await this.sendAndWait(Opcode.CONTACT_UPDATE, {
      contactId: userId,
      action: 'ADD'
    });
  }

  /**
   * Blocks a user.
   */
  async blockUser(userId: any): Promise<any> {
    return await this.sendAndWait(Opcode.CONTACT_UPDATE, {
      contactId: userId,
      action: 'BLOCK'
    });
  }

  /**
   * Changes your name / description (PROFILE).
   */
  async updateProfile({ firstName, lastName, description }: any = {}): Promise<any> {
    const payload: any = {};
    if (firstName !== undefined) payload.firstName = firstName;
    if (lastName !== undefined) payload.lastName = lastName;
    if (description !== undefined) payload.description = description;
    return await this.sendAndWait(Opcode.PROFILE, payload);
  }

  /**
   * Hides the "online" status from others.
   */
  async setHiddenOnline(hidden: boolean): Promise<any> {
    return await this.sendAndWait(Opcode.CONFIG, {
      settings: {
        user: { HIDDEN: !!hidden }
      }
    });
  }

  /**
   * Who can find you by phone: 'ALL' | 'CONTACTS' or true/false (as ALL/CONTACTS).
   */
  async setFindableByPhone(mode: any): Promise<any> {
    const v =
      mode === true || mode === 'ALL'
        ? 'ALL'
        : mode === false || mode === 'CONTACTS'
          ? 'CONTACTS'
          : String(mode);
    return await this.sendAndWait(Opcode.CONFIG, {
      settings: {
        user: { SEARCH_BY_PHONE: v }
      }
    });
  }

  /**
   * Who can call you: 'ALL' | 'CONTACTS'.
   */
  async setCallsPrivacyMode(mode: any): Promise<any> {
    const v =
      mode === true || mode === 'ALL'
        ? 'ALL'
        : mode === false || mode === 'CONTACTS'
          ? 'CONTACTS'
          : String(mode);
    return await this.sendAndWait(Opcode.CONFIG, {
      settings: {
        user: { INCOMING_CALL: v }
      }
    });
  }

  /**
   * Ends/rejects a call via the OK API:
   * vchat.hangupConversation(conversationId, reason, anonymToken?).
   *
   * For an incoming call reason='REJECTED' is usually required.
   * @param call - conversationId or the payload from incoming_call.
   * @param options
   */
  async hangupCall(call: any, options: any = {}): Promise<any> {
    const source = typeof call === 'object' && call !== null ? call : {};
    const conversationId =
      typeof call === 'string' ? call : source.conversationId || options.conversationId;
    if (!conversationId) {
      throw new Error('hangupCall: conversationId is required');
    }

    const reason = String(options.reason || source.reason || 'REJECTED').toUpperCase();
    const endpoint = options.endpoint || this.okApiEndpoint || DEFAULT_OK_API_ENDPOINT;
    const params: any = {
      application_key:
        options.applicationKey ||
        options.okApiApplicationKey ||
        this.okApiApplicationKey ||
        DEFAULT_OK_API_APPLICATION_KEY,
      conversationId: String(conversationId),
      reason
    };

    const sessionKey = options.sessionKey || options.okApiSessionKey || this.okApiSessionKey;
    if (sessionKey) params.session_key = String(sessionKey);

    const anonymToken =
      options.anonymToken ??
      options.anonToken ??
      source.anonymToken ??
      source.anonToken ??
      null;
    if (anonymToken) params.anonymToken = String(anonymToken);

    const sessionSecret =
      options.sessionSecret || options.okApiSessionSecret || this.okApiSessionSecret;
    if (sessionSecret) {
      params.sig = WebMaxClient.signOkApiParams(params, sessionSecret);
    }

    const body = new URLSearchParams(params);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':
          this.userAgent?.headerUserAgent ||
          'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
      },
      body
    });

    const text = await response.text();
    let payload: any = text;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (_) {
      // The OK API may return non-JSON on a network/proxy error.
    }

    if (!response.ok) {
      const err: any = new Error(`hangupCall failed: HTTP ${response.status}`);
      err.status = response.status;
      err.payload = payload;
      throw err;
    }

    return {
      ok: true,
      status: response.status,
      payload,
      conversationId: String(conversationId),
      reason
    };
  }

  /**
   * Convenient alias for an incoming call (NOTIF_INCOMING_CALL / opcode 137).
   */
  async rejectIncomingCall(call: any, options: any = {}): Promise<any> {
    return this.hangupCall(call, {
      ...options,
      reason: options.reason || 'REJECTED'
    });
  }

  /**
   * Who can invite you to chats: 'ALL' | 'CONTACTS'.
   */
  async setChatsInvitePrivacy(mode: any): Promise<any> {
    const v =
      mode === true || mode === 'ALL'
        ? 'ALL'
        : mode === false || mode === 'CONTACTS'
          ? 'CONTACTS'
          : String(mode);
    return await this.sendAndWait(Opcode.CONFIG, {
      settings: {
        user: { CHATS_INVITE: v }
      }
    });
  }

  /**
   * Convenience: channel by @username (resolveLink on https://max.ru/username).
   */
  async resolveChannelByUsername(username: string): Promise<any> {
    const u = String(username).replace(/^@/, '');
    return this.resolveLink(`https://max.ru/${u}`);
  }

  /**
   * Joins a channel by @username.
   */
  async joinChannelByUsername(username: string): Promise<any> {
    const u = String(username).replace(/^@/, '');
    return this.joinChatByLink(`https://max.ru/${u}`);
  }

  /**
   * Invite by hash from a join/XXXX link.
   */
  async resolveInviteHash(hash: string): Promise<any> {
    const h = String(hash).replace(/^join\//, '');
    return this.resolveLink(`join/${h}`);
  }

  static signOkApiParams(params: any, sessionSecret: string): string {
    const base = Object.entries(params)
      .filter(([key, value]) => key !== 'sig' && value !== undefined && value !== null)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('');
    return crypto
      .createHash('md5')
      .update(base + String(sessionSecret), 'utf8')
      .digest('hex');
  }

  async getSessionsInfo(): Promise<any> {
    const r = await this.sendAndWait(Opcode.SESSIONS_INFO, {});
    return r.payload;
  }

  static normalizeSessionsList(payload: any): any[] {
    if (!payload || typeof payload !== 'object') return [];
    const list = Array.isArray(payload.sessions)
      ? payload.sessions
      : Array.isArray(payload.sessionList)
        ? payload.sessionList
        : [];
    return list
      .map((s: any) => {
        if (!s || typeof s !== 'object') return null;
        const time = s.time != null ? Number(s.time) : s.ts != null ? Number(s.ts) : NaN;
        const deviceId =
          s.deviceId != null
            ? String(s.deviceId)
            : s.device_id != null
              ? String(s.device_id)
              : s.sessionDeviceId != null
                ? String(s.sessionDeviceId)
                : s.udid != null
                  ? String(s.udid)
                  : '';
        return {
          time: Number.isFinite(time) ? time : 0,
          client: s.client != null ? String(s.client) : '',
          info: s.info != null ? String(s.info) : '',
          location: s.location != null ? String(s.location) : '',
          current: Boolean(s.current || s.isCurrent || s.self),
          deviceId,
          raw: s
        };
      })
      .filter(Boolean);
  }

  /**
   * Whether a SESSIONS_INFO row refers to this client (current TCP/device).
   */
  _isSessionRowThisDevice(row: any): boolean {
    if (!row || typeof row !== 'object') return false;
    if (row.current) return true;
    const mine = String(this.deviceId || '').trim().toLowerCase();
    if (!mine) return false;
    const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
    const candidates = [
      row.deviceId,
      raw.deviceId,
      raw.device_id,
      raw.sessionDeviceId,
      raw.udid
    ]
      .filter((x: any) => x != null && String(x).trim() !== '')
      .map((x: any) => String(x).trim().toLowerCase());
    return candidates.some((c: string) => c === mine);
  }

  async closeSessions(payload: any): Promise<any> {
    return await this.sendAndWait(Opcode.SESSIONS_CLOSE, payload || {});
  }

  async closeAllSessionsExceptCurrent(): Promise<any> {
    const info = await this.getSessionsInfo();
    const rows = WebMaxClient.normalizeSessionsList(info || {});

    const byDevice = rows.filter((r) => this._isSessionRowThisDevice(r));
    let selfTimeSet = new Set<any>();
    if (byDevice.length > 0) {
      for (const r of byDevice) {
        if (r.time > 0) selfTimeSet.add(r.time);
      }
    } else {
      const byFlag = rows.filter((r) => r.current);
      if (byFlag.length > 0) {
        for (const r of byFlag) {
          if (r.time > 0) selfTimeSet.add(r.time);
        }
      } else if (rows.length <= 1) {
        if (this.debug || this._authDebug) {
          console.log(
            '[webmaxsocket] closeAllSessionsExceptCurrent: one or zero sessions in the list — SESSIONS_CLOSE is not called'
          );
        }
        return { skipped: true, reason: 'single_or_empty_session_list', sessionsPayload: info };
      } else {
        throw new Error(
          'closeAllSessionsExceptCurrent: cannot determine the current session (no current/deviceId). Close devices in the Max app.'
        );
      }
    }

    const otherTimes = rows.filter((r) => r.time > 0 && !selfTimeSet.has(r.time)).map((r) => r.time);
    const uniqTimes = [...new Set(otherTimes)];

    if (uniqTimes.length === 0) {
      if (this.debug || this._authDebug) {
        console.log(
          '[webmaxsocket] closeAllSessionsExceptCurrent: no other sessions — SESSIONS_CLOSE is not called'
        );
      }
      return { skipped: true, reason: 'no_other_sessions', sessionsPayload: info };
    }

    /**
     * Do not use allExceptCurrent / excludeCurrent without a list: on the Max side
     * this invalidated the current token after a restart. We close
     * only explicitly listed other times (as in the devices list).
     */
    const attempts = [{ times: uniqTimes }, { sessionTimes: uniqTimes }, { ids: uniqTimes }];
    let lastErr: any;
    for (const body of attempts) {
      try {
        const r = await this.sendAndWait(Opcode.SESSIONS_CLOSE, body);
        if (this.debug || this._authDebug) {
          console.log('[webmaxsocket] SESSIONS_CLOSE ok, body keys:', Object.keys(body).join(','));
        }
        return r.payload;
      } catch (e: any) {
        lastErr = e;
        if (this.debug || this._authDebug) {
          console.log('[webmaxsocket] SESSIONS_CLOSE fail:', e.message, 'body:', JSON.stringify(body));
        }
      }
    }
    throw lastErr || new Error('SESSIONS_CLOSE: failed to close sessions');
  }

  async getTwoFADetails(): Promise<any> {
    const r = await this.sendAndWait(Opcode.AUTH_2FA_DETAILS, {});
    return r.payload;
  }

  async setTwoFAPassword({ trackId, password, hint, email }: any): Promise<any> {
    if (!trackId || !password) {
      throw new Error('setTwoFAPassword: trackId and password are required');
    }
    const payload: any = {
      trackId: String(trackId).trim(),
      password: String(password)
    };
    if (hint != null && String(hint).trim() !== '') payload.hint = String(hint).trim();
    if (email != null && String(email).trim() !== '') payload.email = String(email).trim();
    const r = await this.sendAndWait(Opcode.AUTH_SET_2FA, payload);
    return r.payload;
  }

  /**
   * Runs registered handlers.
   */
  async triggerHandlers(eventType: string, data: any = null): Promise<void> {
    if (
      eventType === EventTypes.ERROR &&
      data !== null &&
      this._incomingLogMode === 'verbose'
    ) {
      printIncomingLog('error', {
        message: data && data.message,
        stack: data && data.stack
      });
    }

    const handlers = this.handlers[eventType] || [];

    for (const handler of handlers) {
      try {
        if (data !== null) {
          await handler(data);
        } else {
          await handler();
        }
      } catch (error: any) {
        console.error(`Error in ${eventType} handler:`, error);
      }
    }
  }

  /**
   * Stops the client.
   */
  async stop(): Promise<void> {
    this._clearSessionRefreshTimer();
    this._clearTcpInteractiveTimer();
    if (this._socketTransport) {
      await this._socketTransport.close();
      this._socketTransport = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.isAuthorized = false;
    this._tcpLoginCompleted = false;
    console.log('Client stopped');
  }

  /**
   * Logs out of the account.
   */
  async logout(): Promise<void> {
    await this.stop();
    this.session.destroy();
    console.log('Logged out, session removed');
  }
}

export { WebMaxClient };
