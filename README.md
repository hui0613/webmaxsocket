# WebMaxSocket - Node.js Client for Max Messenger

## Description

**WebMaxSocket** — async Node.js library for working with the internal API of the Max messenger. Supports **QR code authorization**, **Token authorization**, **SMS login** with an optional **2FA password** (like the Max app), and operation over **WebSocket** (WEB) or **TCP Socket** (ANDROID).

**Current package version: 1.2.7**

Method summary: **[api.package.md](./api.package.md)**.

## Changelog (excerpt)

### 1.2.7

- **Fingerprint 26.19.2 (6733):** up-to-date `APP_VERSION` / `BUILD_NUMBER` (fixes "The app is outdated" on SMS).
- **`getUserByPhone` / `getUserIdByPhone`:** user lookup by phone number (`CONTACT_INFO_BY_PHONE`).

### 1.2.6

- **`client.lastSyncPayload`** — stores the last successful **`LOGIN`/`sync()`** response (including the `chats` array). On **TCP** the **`getChats()`** list is sometimes empty; take the chats from **`lastSyncPayload.chats`**.
- **Downloading `FILE` documents without `baseUrl` in history:** **`requestFileDownloadUrl({ chatId, messageId, fileId, fileName?, … })`** — the server returns a temporary HTTPS **`url`** for downloading.
- **`message.downloadAttachment()`** — for **`_type: FILE`** without a URL it calls **`requestFileDownloadUrl`** itself (needs the correct **`chatId`** of the message and **`messageId`**).
- **`getHistory`**: each message is annotated with **`chatId`** from the request argument (raw messages often don't have it).
- **`Message`**: **`chatId === 0`** is handled correctly (e.g. "Saved messages").
- **TCP + msgpack:** if the outgoing payload contains **`BigInt`**, **`useBigInt64`** is enabled when encoding; incoming packets are decoded with **`useBigInt64`** so that **`message.id`** and other int64 values aren't lost (above **`Number.MAX_SAFE_INTEGER`**).
- **`downloadMedia`:** extended MIME → extension map (`text/plain`, `application/pdf`, …).
- New example: **`example-download-files.ts`** (chat history → `downloads/` folder).

## Features

- ✅ **QR code authorization**
- ✅ **QR for device linking** (`showLinkDeviceQR`) after SMS/TCP login — the same flow as "Profile → Devices → Connect device" in the app
- ✅ **Token authorization**
- ✅ **SMS + 2FA password** (ANDROID): after the SMS code, when needed, the second step `AUTH_LOGIN_CHECK_PASSWORD` (opcode `0x73`); optionally save the password in the session (`saveTwofaPassword`)
- ✅ **Two transports:** WebSocket (WEB) and TCP Socket (ANDROID)
- ✅ **Automatic session storage**
- ✅ **Token rotation after `sync()`:** if the server returns a new `token` in the `LOGIN` response, it is saved to `sessions/*.json` (like SMS/QR)
- ✅ **Periodic `sync()`** (`sessionRefreshIntervalMs` / `autoSyncIntervalMs`) to keep the session alive: on **TCP** after the first `LOGIN` each subsequent `sync()` is **new TLS and `LOGIN` (19) again** (a second consecutive `LOGIN` isn't accepted on a socket; **`SYNC` (21)** isn't accepted by the TCP server — see "Sessions")
- ✅ **Automatic transport selection** after QR authorization (switch to TCP)
- ✅ **Send and receive messages**
- ✅ **Media upload from disk:** `uploadPhoto`, `uploadVideo`, `uploadFile`, `uploadAudio` → `attachments` in `sendMessage` / `sendMessageChannel` / `reply`
- ✅ **Attachment downloads:** by **`baseUrl`/`url`** — `downloadUrlToTempFile`, `message.downloadAttachment()`; **`FILE`** documents without URL in history — **`requestFileDownloadUrl()`**
- ✅ **Groups and channels:** creation, invites, admins, members, links, mute, subscription — see the API section
- ✅ **Reactions, pins, profile and privacy settings, contacts / blocking**
- ✅ **Device (session) list** and **closing other sessions** (`getSessionsInfo`, `closeAllSessionsExceptCurrent`) — like "Profile → Devices" in Max
- ✅ **2FA details and setting a password by trackId** (`getTwoFADetails`, `setTwoFAPassword`)
- ✅ **Edit and delete messages**
- ✅ **Event-driven architecture**
- ✅ **Incoming calls (TCP):** opcode **`NOTIF_INCOMING_CALL` (137)**, event **`incoming_call`** / **`onIncomingCall`**, helpers **`summarizeIncomingCall`** and others.
- ✅ **Call summary in a chat:** a **`NOTIF_MESSAGE`** may carry a **`_type: "CALL"`** attachment (`hangupType`, `duration`, `conversationId`) — event **`call_log`** / **`onCallLog`**, utilities **`extractCallAttachesFromNotifPayload`**, **`formatCallLogLine`**
- ✅ **Built-in incoming log** (`logIncoming`, `WEBMAX_DEBUG`, `WEBMAX_SILENT`) — JSON to the console without manual handlers
- ✅ **TypeScript** structure

## Installation

```bash
npm install webmaxsocket
```

### Building from source

The library is written in **TypeScript**. To compile it (output to `dist/`):

```bash
npm run build
```

The compiled entry point is `dist/src/index.js`. The examples (in `example/`) can be run directly from TypeScript with **tsx** — no build required:

```bash
npm run example
npm run example:sms
npm run example:download -- 0 30
```

### Socket transport dependencies (ANDROID)

TCP responses contain a payload in **LZ4** blocks (on top of **msgpack**). Decompression uses **`lz4js`** — pure JavaScript, **no node-gyp** or native build, including on Windows without Visual Studio C++. It is a dependency of `webmaxsocket` and is installed with the package. If needed you can install it manually:

```bash
npm install lz4js
```

You can additionally install the native **`lz4`** module if a C++ toolchain is available in the environment:

```bash
npm install lz4
```

**Note:** For normal QR authorization (WEB) no extra dependencies are required. The Socket transport is only used after saving a session or when `deviceType: 'ANDROID'` is set explicitly.

## Incoming calls (TCP / ANDROID)

On an incoming call the server sends **`NOTIF_INCOMING_CALL`** (**opcode 137**): `callerId`, `conversationId`, `type` (`AUDIO` / `VIDEO`), `vcp` (media parameters — don't log them publicly).

After answering / hanging up, the same dialog often receives a regular **`NOTIF_MESSAGE`** with empty text and a **`_type: "CALL"`** attachment:

| `hangupType` | `duration` | Observed meaning |
|--------------|------------|------------------|
| `REJECTED` | `0` | The call didn't turn into a conversation (rejected, dropped before answering, etc.) |
| `HUNGUP` | `> 0` | There was a conversation, then the call was hung up (ms) |

Events of one call can be linked via **`conversationId`**.

**`EventEmitter` events:** `incoming_call` (payload as from the server), `call_log` (`{ chatId, message, callAttaches, summaries }`).

**Paired methods (like `onMessage`):** `onIncomingCall(handler)`, `onCallLog(handler)`.

**Rejecting an incoming call:** the experimental methods **`rejectIncomingCall(payload)`** and **`hangupCall(conversationIdOrPayload, { reason? })`** call the OK API **`vchat.hangupConversation`** (`conversationId`, `reason`, `anonymToken?`). For an incoming call use `reason: 'REJECTED'` (default in `rejectIncomingCall`).

**Utilities:** `summarizeIncomingCall`, `extractCallAttachesFromNotifPayload`, `summarizeCallAttach`, `formatCallLogLine`, `isCallAttach`.

```javascript
const {
  WebMaxClient,
  summarizeIncomingCall,
  formatCallLogLine,
} = require('webmaxsocket');

async function main() {
  const client = new WebMaxClient({ name: 'sms_session', deviceType: 'ANDROID' });

  client.onIncomingCall(async (payload) => {
    console.log('Call:', summarizeIncomingCall(payload));

    // Experimental: reject the incoming call.
    // If the OK API returns an authorization error, pass okApiSessionKey/okApiSessionSecret
    // in the constructor or in the method options.
    await client.rejectIncomingCall(payload);
  });

  client.onCallLog(({ summaries }) => {
    summaries.forEach((s) => console.log(formatCallLogLine(s)));
  });

  await client.start();
}

main().catch(console.error);
```

## Quick Start

### Basic example

```javascript
const { WebMaxClient } = require('webmaxsocket');

async function main() {
  // Initialize the client
  const client = new WebMaxClient({
    name: 'my_session'  // Session name
  });

  // Start handler
  client.onStart(async () => {
    console.log('✅ Bot started!');
    console.log(`👤 Signed in as: ${client.me.fullname}`);
  });

  // Message handler
  client.onMessage(async (message) => {
    // Don't reply to own messages
    if (message.senderId === client.me.id) return;

    console.log(`💬 ${message.getSenderName()}: ${message.text}`);

    // Auto-reply
    await message.reply({
      text: `Hi! I received: "${message.text}"`
    });
  });

  // Start
  await client.start();
}

main().catch(console.error);
```

### Authorization

#### Method 1: QR code (recommended for the first run)

On the first run the client requests a QR code. The QR **link** is delivered to the **`onQrCode(qrLink, small)`** handler — the library itself does **not** print QR codes. To render it in the terminal, use any QR renderer (for example `qrcode-terminal`):

```javascript
const { WebMaxClient } = require('webmaxsocket');
const qrcode = require('qrcode-terminal');

const client = new WebMaxClient({
  name: 'my_session'
});

client.onQrCode((qrLink, small) => {
  return new Promise((resolve) => {
    qrcode.generate(qrLink, { small }, () => resolve());
  });
});

await client.start();
```

Without the callback only the raw link is printed:

```
🔐 QR CODE AUTHORIZATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📱 On the phone: Profile → Devices / Security → Connect device
💡 Or open the link: https://...
```

After scanning:
- The token and clientSessionId are saved automatically
- On the next run the client **automatically switches to TCP Socket** for stability
- Re-authorization is not required

#### Method 2: SMS authorization (ANDROID)

Authorization by phone number with a code from SMS. If the account has **two-factor password protection** enabled, after a correct SMS code the server returns a **`passwordChallenge`**; then a second step is required — **`sendPassword`** (protocol `AUTH_LOGIN_CHECK_PASSWORD`, like the official client).

```javascript
const client = new WebMaxClient({
  name: 'my_session',
  deviceType: 'ANDROID', // Required for SMS
  // saveTwofaPassword: true  // default: save the 2FA password to sessions/*.json
});

await client.connect();

const authSession = await client.authorizeBySMS('+79001234567');
const code = '123456'; // code from SMS

const result = await authSession.sendCode(code);

if (result && typeof result === 'object' && result.needsPassword) {
  // The hint/email may be in result.passwordChallenge
  await result.sendPassword('your_2fa_password');
  // after success the session gets a token; if saveTwofaPassword !== false — the twofaPassword field
} else {
  // Normal login without a password: result is a token string (sync is already done inside sendCode)
}

await client.triggerHandlers(client.handlers.START);
```

**Session:** for repeated runs only the **token** in `sessions/<name>.json` is enough — SMS and the 2FA password aren't needed while the token is valid. The **`twofaPassword`** field (if saving is enabled) is used for a **full** re-login (expired token): you can supply the password without typing it (the examples respect **`TWOFA_PASSWORD`**, **`ASK_TWOFA=1`** to force a console prompt).

Or run the ready example:

```bash
npm run build
npm run example:sms
npm run example:sms -- +79001234567  # with a number argument
```

#### QR after login: linking a second device (ANDROID)

When you are already authorized over **TCP** (SMS and a saved session), **`GET_QR` on the same connection is not available** (server response: invalid session state). For the app-like scenario — **show a QR, the phone scans it** — use the **`showLinkDeviceQR()`** method: the library opens a **separate short-lived WebSocket connection** (like [web.max.ru](https://web.max.ru)), requests a QR, prints it to the console and optionally waits for the scan.

Requirements: an active connection and **`isAuthorized`** (usually after `await client.start()`).

```javascript
await client.start();

// Show the QR and wait until it is scanned in the Max app on the phone
await client.showLinkDeviceQR();

// Only show the QR and return the data (without waiting for the scan)
const data = await client.showLinkDeviceQR({ waitForScan: false });
// data: { qrLink, trackId, pollingInterval, expiresAt }
```

Options: `waitForScan` (default `true`), `small` — compact QR in the terminal.

**Client version:** to issue a QR the server expects a current **`appVersion`** in the User-Agent (at least **25.12.13**). The constructor uses **26.19.2** by default (`buildNumber: 6733`).

If the server replies **`qr_login.disabled`**, check the app version in options, open [web.max.ru](https://web.max.ru) in a browser, or log in on the second device by phone number.

#### Devices (sessions) and account 2FA

After **`start()`** (or `connect` + `sync`) the following are available:

- **`getSessionsInfo()`** — payload with the session list (often the **`sessions`** field). Convenient parsing: **`WebMaxClient.normalizeSessionsList(payload)`** → array of `{ time, client, info, location, current, raw }`.
- **`closeAllSessionsExceptCurrent()`** — close all sessions except the current one (analogous to "Close other sessions"). Only an **explicit list of `times` (and variants `sessionTimes` / `ids`) of other devices** from `getSessionsInfo` is sent. Flags like `allExceptCurrent` are **not used** — on the Max side they invalidated the **current** token. The current session is determined by the **`current`** field and by matching **`deviceId`** with the client (see `normalizeSessionsList`).
- **`closeSessions(payload)`** — low-level `SESSIONS_CLOSE` call with an arbitrary body.
- **`getTwoFADetails()`** — 2FA state and parameters.
- **`setTwoFAPassword({ trackId, password, hint?, email? })`** — enable or change the password by **`trackId`** from the app scenario; you may need to navigate in the official client to get **`trackId`**.

Example:

```javascript
await client.start();

const info = await client.getSessionsInfo();
const devices = WebMaxClient.normalizeSessionsList(info);
console.log(devices);

// optionally — close everything except this session
// await client.closeAllSessionsExceptCurrent();

const twoFA = await client.getTwoFADetails();
// await client.setTwoFAPassword({ trackId: '...', password: '...', hint: '...' });
```

Ready script: **`npm run example:sessions-2fa`** (with the **`--close-others`** flag — with confirmation it closes other sessions).

#### Method 3: Token authorization

If you already have a token (from another service/app):

```javascript
const client = new WebMaxClient({
  name: 'my_session',
  token: 'An_Sx6HQ9HDiftNkVBNf6Q5PG5D8Oyj...',  // Your token
  configPath: 'config/myconfig.json',  // Or from a file
  saveToken: true
});

await client.start();
```

Config format (`config/default.json`):
```json
{
  "token": "An_Sx6HQ9HDiftNk...",
  "ua": "Mozilla/5.0 (Linux; Android 14) ...",
  "device_type": 3,
  "deviceType": "ANDROID",
  "appVersion": "26.19.2",
  "buildNumber": 6733
}
```

#### Transports

- **WEB** (`deviceType: 'WEB'` or `device_type: 1`) → WebSocket (ws-api.oneme.ru)
- **ANDROID** (`deviceType: 'ANDROID'` or `device_type: 2/3`) → TCP Socket (api.oneme.ru)

The client **automatically selects** the right transport based on the saved deviceType.

## API

### WebMaxClient

The main class for working with the Max API.

#### Constructor

```javascript
const client = new WebMaxClient({
  name: 'session',        // Session name (for saving authorization)
  token: 'An_Sx6H...',    // Authorization token (optional)
  configPath: 'myconfig', // Path to the config file (optional)
  deviceType: 'WEB',      // Device type: 'WEB' or 'ANDROID' (optional)
  saveToken: true,        // Save the token to the session (default true)
  debug: false,           // TCP/WebSocket: brief opcode log; also honors WEBMAX_DEBUG=1, DEBUG=1
  // Incoming log (JSON to the console), see below:
  logIncoming: undefined, // false | 'messages' | 'verbose' — default see the table
  logIncomingVerbose: false, // explicitly enable verbose (like logIncoming: 'verbose')
  apiUrl: 'wss://...',    // WebSocket API URL (optional)
  maxReconnectAttempts: 5,// Maximum reconnection attempts
  reconnectDelay: 3000,   // Delay between reconnection attempts (ms)
  // Session and token (see the "Sessions" section):
  sessionRefreshIntervalMs: 0, // Periodic sync (ms), minimum 10_000; 0 — disabled. Alias: autoSyncIntervalMs
  clearSessionOnFailedSync: false, // connectWithSession: on a sync error call session.clear() before authorize() (default false)
  // User-Agent / client (important for GET_QR, see showLinkDeviceQR):
  appVersion: '26.19.2',  // Current Android client version
  ua: 'Mozilla/5.0 ...', // or headerUserAgent
  osVersion: '14',
  screen: '360x780 3.0x',
  timezone: 'Europe/Moscow',
  locale: 'ru',
  buildNumber: 6733,      // optional
  clientSessionId: 1      // optional
});
```

**Incoming log (`logIncoming`):** prints `📥 [incoming:...]` blocks with JSON.

| Value / condition | Behavior |
|-------------------|----------|
| `logIncoming: false` | Off. |
| `logIncoming: 'messages'` | Only incoming messages (`message.rawData`). |
| `logIncoming: 'verbose'` or `logIncomingVerbose: true` | Messages + `connected`, `raw_message`, `message_removed`, `chat_action`, `error`. |
| not set | Default: like `'messages'`; if **`WEBMAX_DEBUG=1`** — like `'verbose'`. Explicit **`logIncoming: 'messages'`** disables the extended mode even with `WEBMAX_DEBUG`. |
| **`WEBMAX_SILENT=1`** | Disable all dumps. |

Manual output in the same format: `client.logIncoming('my_label', data)`. Current mode: `client.incomingLogMode` (`'off' | 'messages' | 'verbose'`). Low-level: `resolveIncomingLogMode(options)`, `printIncomingLog(label, payload)` from the package.

#### Methods

##### `start()`

Starts the client and establishes a connection.

```javascript
await client.start();
```

##### `authorizeBySMS(phone)`

Authorization by phone number via SMS (ANDROID only). Returns an object with the fields **`tempToken`**, **`phone`**, **`sendCode`**.

**`sendCode(code)`** after entering the SMS code:

- if a 2FA password is **not** required — returns a **token string** (session saving and **`sync()`** are already done inside);
- if 2FA is required — returns **`{ needsPassword: true, passwordChallenge, trackId, sendPassword }`**. Call **`await sendPassword(password)`**; on success **`sync()`** runs, and if **`saveTwofaPassword !== false`** (default `true`) the session file gets **`twofaPassword`** for later full logins.

The constructor option **`saveTwofaPassword: false`** disables writing the 2FA password to `sessions/*.json`.

Low-level on TCP: **`sendCode`** → `AUTH` (18) with `authTokenType: 'CHECK_CODE'`; **`sendPassword`** → **`AUTH_LOGIN_CHECK_PASSWORD`** (`0x73`) with fields **`trackId`** and **`password`** (see `MaxSocketTransport.sendLogin2FAPassword`).

```javascript
await client.connect();
const authSession = await client.authorizeBySMS('+79001234567');
const out = await authSession.sendCode('123456');
if (out && out.needsPassword) await out.sendPassword('...');
```

##### `showLinkDeviceQR(options)`

Print a **QR code for linking a device** in the console (like the Max app: the phone scans the QR). Requires **already done authorization** (`start()` or `connect` + `sync`).

- For **WEB** the request is done over the current WebSocket.
- For **ANDROID** after a TCP login a **second** WebSocket connection is used without a repeated `LOGIN` on that session (otherwise `GET_QR` on the same TCP is unavailable).

```javascript
await client.showLinkDeviceQR();
await client.showLinkDeviceQR({ waitForScan: false, small: false });
```

Returns `Promise<{ qrLink, trackId, pollingInterval, expiresAt }>`.

##### `requestQR()`, `checkQRStatus(trackId)`, `loginByQR(trackId)`, `authorizeByQR()`

Low-level QR authorization steps for **WEB** (first login without SMS). Usually `start()` without a token or `authorizeByQR()` is enough.

##### `sendMessage(options)`

Sends a message to a chat with a notification (notify: true).

```javascript
const message = await client.sendMessage({
  chatId: 123,
  text: 'Hello!',
  // cid is optional; on TCP don't use Date.now() (int32 required)
  replyTo: null,        // ID of the message to reply to (optional)
  attachments: []       // Attachments (optional)
});
```

##### `sendMessageChannel(options)`

Sends a message to a channel without a notification (notify: false). The fields **`text`**, **`replyTo`**, **`attachments`** are the same as for `sendMessage` (attachments from `uploadPhoto` / `uploadVideo` / `uploadFile` / `uploadAudio`).

```javascript
const message = await client.sendMessageChannel({
  chatId: 123,
  text: 'Message to the channel',
  replyTo: null,
  attachments: [] // optional: [attach] after upload*
});
```

##### `editMessage(options)`

Edits a message.

```javascript
await client.editMessage({
  messageId: 456,
  chatId: 123,
  text: 'Corrected text',
  attachments: [] // optional, after upload*
});
```

##### Pins, reactions

| Method | Purpose |
|--------|---------|
| `pinMessage({ chatId, messageId, notifyPin })` | Pin a message |
| `setMessageReaction({ chatId, messageId, emoji })` | Emoji reaction |
| `cancelMessageReaction({ chatId, messageId })` | Remove the reaction |
| `getMessageReactions({ chatId, messageId, count })` | List of reactions |

##### Chats, channels, groups

| Method | Purpose |
|--------|---------|
| `getChatInfo(chatIds)` | Info by id (array or a single number) |
| `resolveLink(link)` | Resolve a URL / `join/...` (LINK_INFO) |
| `joinChatByLink(link)` | Join by link |
| `setChatSubscription(chatId, subscribe)` | Channel subscription |
| `createGroup({ title, userIds })` | New group |
| `createChannel({ title })` | New channel |
| `muteChat(chatId, mute)` | Chat notifications (do not disturb) |
| `getChatMembers({ chatId, marker, count, type })` | Members (count ≤ 500) |
| `inviteToChat({ chatId, userIds, showHistory })` | Invite |
| `removeFromChat({ chatId, userIds, cleanMsgPeriod })` | Remove |
| `addChatAdmins({ chatId, userIds, permissions })` | Grant admin (default `permissions: 120`) |
| `removeChatAdmins({ chatId, userIds })` | Revoke admin |
| `transferChatOwnership({ chatId, newOwnerId })` | Transfer ownership |
| `setGroupOptions({ chatId, options })` | Group settings (`ALL_CAN_PIN_MESSAGE`, …) |
| `resolveChannelByUsername(username)` | Channel by @username |
| `joinChannelByUsername(username)` | Join by @username |
| `resolveInviteHash(hash)` | Invite by hash without the `join/` prefix |

##### Contacts and profile

| Method | Purpose |
|--------|---------|
| `getContacts(contactIds)` | Several contacts (array of ids) |
| `addContact(userId)` | Add to contacts |
| `blockUser(userId)` | Block |
| `updateProfile({ firstName, lastName, description })` | Your name / description |
| `setHiddenOnline(hidden)` | Hide "online" |
| `setFindableByPhone(mode)` | `'ALL'` \| `'CONTACTS'` or boolean |
| `setCallsPrivacyMode(mode)` | Who can call you |
| `setChatsInvitePrivacy(mode)` | Who can invite you to chats |

Some methods require chat permissions; server responses depend on the role and chat type.

##### `deleteMessage(options)`

Deletes a message.

```javascript
await client.deleteMessage({
  messageId: 456,
  chatId: 123
});
```

##### `forwardMessage(options)`

Forwards a message.

```javascript
await client.forwardMessage({
  messageId: 456,
  fromChatId: 123,
  toChatId: 789
});
```

##### Uploading media for `attachments`

All methods below return object(s) passed to **`attachments`** of `sendMessage`, **`sendMessageChannel`** and **`message.reply`**. **Node.js 18+** is required (`fetch`, `FormData`). Flow: upload opcode → `UPLOAD_ATTACH_PREP` (65) → HTTP POST to the returned URL. For **video** and **files** after POST the client waits for **`NOTIF_ATTACH` (opcode 136)**.

| Method | Result for `attachments` |
|--------|--------------------------|
| `uploadPhoto(chatId, filePath)` | `{ _type: 'PHOTO', photoToken }` |
| `uploadVideo(chatId, filePath)` | `{ _type: 'VIDEO', videoId, token }` |
| `uploadFile(chatId, filePath, options?)` | `{ _type: 'FILE', fileId }` — documents, archives; `options`: `{ filename, mimeType }` |
| `uploadAudio(chatId, filePath)` | same as `uploadFile` with MIME for `.mp3`, `.ogg`, `.m4a`, `.wav`, … |

```javascript
const photo = await client.uploadPhoto(chatId, './a.png');
const video = await client.uploadVideo(chatId, './b.mp4');
const file = await client.uploadFile(chatId, './doc.pdf');
const audio = await client.uploadAudio(chatId, './track.mp3');

await client.sendMessage({
  chatId,
  text: 'A set of attachments',
  attachments: [photo, video]
});

await client.sendMessageChannel({
  chatId,
  text: 'To the channel with a file',
  attachments: [file]
});
```

##### `sendChatAction(chatId, action)`

Sends a chat action (typing, choosing a sticker, etc.).

```javascript
await client.sendChatAction(123, ChatActions.TYPING);
```

##### `getUser(userId)`

Gets user info.

```javascript
const user = await client.getUser(123);
```

##### `getUserByPhone(phone)` / `getUserIdByPhone(phone)`

User lookup by phone number (`CONTACT_INFO_BY_PHONE`, opcode 46). The number is normalized (`+79001234567`). If the user isn't found or has hidden phone search — `null`.

```javascript
const user = await client.getUserByPhone('+79001234567');
// User { id, firstname, lastname, phone, ... } or null

const id = await client.getUserIdByPhone('89001234567');
// 123456789 or null
```

##### `getChats(limit, offset)`

Gets the chat list.

```javascript
const chats = await client.getChats(50, 0);
```

##### `getHistory(chatId, from?, backward?, forward?)`

Gets message history. Each element in the array will have **`chatId`** matching the requested chat (the server response often omits the field).

```javascript
const messages = await client.getHistory(123, Date.now(), 50, 0);
```

##### `requestFileDownloadUrl({ chatId, messageId, fileId, fileName?, requestId?, attachLocalId? })`

Requests a **temporary HTTPS URL** for a **`FILE`** attachment when there is no **`baseUrl`** in **`attaches`**. The identifiers **`messageId`**, **`fileId`**, **`chatId`** must match the message data (for large ids use the **`bigint`** from the **`Message`** object, don't round to a plain **`Number`**).

Returns **`Promise<string>`** (URL). It is simpler to call **`message.downloadAttachment()`**, which fills the fields itself.

##### `lastSyncPayload` property

After a successful **`sync()`** — the object of the last server response (fields like **`chats`**, **`profile`**, …). Handy if **`getChats()`** returned an empty list on TCP.

##### `stop()`

Stops the client.

```javascript
await client.stop();
```

##### `logout()`

Logs out of the account and deletes the session.

```javascript
await client.logout();
```

#### Event handlers

##### `onStart(handler)`

Registers a start handler.

```javascript
client.onStart(async () => {
  console.log('Client started!');
});
```

##### `onMessage(handler)`

Registers a new-message handler.

```javascript
client.onMessage(async (message) => {
  console.log('New message:', message.text);
});
```

##### `onMessageRemoved(handler)`

Registers a removed-message handler.

```javascript
client.onMessageRemoved(async (message) => {
  console.log('Message removed:', message.text);
});
```

##### `onChatAction(handler)`

Registers a chat-action handler.

```javascript
client.onChatAction(async (action) => {
  console.log('Chat action:', action.type);
});
```

##### `onError(handler)`

Registers an error handler.

```javascript
client.onError(async (error) => {
  console.error('Error:', error.message);
});
```

##### `onQrCode(handler)`

Registers a QR code handler `(qrLink, small)`. The library never prints QR codes itself.

```javascript
client.onQrCode((qrLink, small) => {
  return new Promise((resolve) => {
    qrcode.generate(qrLink, { small }, () => resolve());
  });
});
```

### Message

Class representing a message.

#### Properties

- `id` - message ID
- `cid` - client ID of the message
- `chatId` - chat ID
- `text` - message text
- `senderId` - sender ID
- `sender` - sender object (User)
- `timestamp` - send time
- `type` - message type
- `isEdited` - edit flag
- `replyTo` - ID of the message this is a reply to
- `attachments` - attachments

#### Methods

##### `reply(options)`

Sends text **to the same chat**. By default **without** quoting the original message (`link REPLY`), because on the TCP socket the server often returns a "Validation error" for a quoted reply. To try a quoted reply: `{ text: '...', quote: true }`.

```javascript
await message.reply({ text: 'Reply to the message' });
await message.reply({ text: '...', quote: true });
```

##### `edit(options)`

Edits the message.

```javascript
await message.edit({
  text: 'New text'
});
```

##### `delete()`

Deletes the message.

```javascript
await message.delete();
```

##### `forward(chatId)`

Forwards the message.

```javascript
await message.forward(789);
```

##### `downloadAttachment(index, options?)`

Downloads an attachment to a file (default directory **`os.tmpdir()`**). Logic:

- if the attachment has **`baseUrl`** or **`url`** (often **`PHOTO`**, stickers, etc.) — a regular HTTPS request;
- if **`_type === 'FILE'`** and there is no URL — **`client.requestFileDownloadUrl()`** is called internally (needs **`message.chatId`** and the exact **`message.id`**; after **`getHistory`** they are set, **`id` may be `bigint`**).

Options: **`dir`**, **`filename`** (basename). The extension is chosen from **`Content-Type`** and the attachment type.

Returns `{ path, contentType }`.

```javascript
if (message.attachments.length) {
  const { path, contentType } = await message.downloadAttachment(0);
  console.log('Saved:', path, contentType);
  // after processing you can remove it: fs.unlinkSync(path)
}

// Custom directory or filename:
await message.downloadAttachment(0, {
  dir: './downloads',
  filename: 'photo.webp'
});
```

### Media download helpers

Exported from the package along with `WebMaxClient`:

```javascript
const {
  downloadUrlToTempFile,
  extFromContentType,
  extFromAttachType
} = require('webmaxsocket');
```

##### `downloadUrlToTempFile(url, options?)`

HTTP(S) request with redirect following, writing the response body to a file.

| Option | Description |
|--------|-------------|
| `dir` | Directory (default `os.tmpdir()`) |
| `filename` | Filename (basename only); if not set — `max-media-<time>-<random>.<ext>` |
| `extFallback` | Extension when `Content-Type` can't determine it (e.g. `'.jpg'`) |

```javascript
const { path, contentType } = await downloadUrlToTempFile(
  'https://i.oneme.ru/i?r=...',
  { extFallback: '.jpg' }
);
```

##### `extFromContentType(contentType)` / `extFromAttachType(attachType)`

Helper functions for choosing the extension by MIME or by the attachment `_type` (`PHOTO`, `VIDEO`, …).

### User

Class representing a user.

#### Properties

- `id` - user ID
- `firstname` - first name
- `lastname` - last name
- `username` - username
- `phone` - phone number
- `avatar` - avatar URL
- `status` - status
- `bio` - bio
- `fullname` - full name (getter)

### ChatAction

Class representing a chat action.

#### Properties

- `type` - action type
- `chatId` - chat ID
- `userId` - user ID
- `user` - user object (User)
- `timestamp` - action time

### Constants

#### ChatActions

```javascript
const { ChatActions } = require('webmaxsocket');

ChatActions.TYPING          // Typing
ChatActions.STICKER         // Choosing a sticker
ChatActions.FILE            // Sending a file
ChatActions.RECORDING_VOICE // Recording voice
ChatActions.RECORDING_VIDEO // Recording video
```

### MaxSocketTransport

Low-level TCP Socket transport for ANDROID (api.oneme.ru). Incoming packets with the compression flag are decompressed via **LZ4** (see the **"Socket transport dependencies"** section above).

#### Direct use (advanced)

```javascript
const { MaxSocketTransport } = require('webmaxsocket');

const transport = new MaxSocketTransport({
  deviceType: 'ANDROID',
  ua: 'Mozilla/5.0 (Linux; Android 14) ...',
  deviceId: 'your-device-id',
  debug: true
});

await transport.connect();
await transport.handshake(userAgentPayload);
const syncData = await transport.sync(token, userAgent);
```

**Note:** In most cases use `WebMaxClient`, which automatically selects the right transport.

## Examples

### Example 1: QR authorization (example.ts)

```bash
npm run build
npm run example
```

First run — QR authorization, subsequent runs — automatic login via TCP Socket.

### Example 2: Token authorization (example-token.ts)

```bash
# Via a config file
npm run example:token
npm run example:token -- myconfig  # config/myconfig.json

# Via an environment variable
TOKEN="your_token" npm run example:token
```

### Example 3: SMS authorization (example-sms.ts)

```bash
# Interactive number input
npm run example:sms

# With a number argument
npm run example:sms -- +79001234567
```

### Example 5: Downloading attachments from chat history (example-download-files.ts)

Requires a **saved Android session** (`sessions/<name>.json`). The script calls **`sync()`**, reads history and saves attachments to **`./downloads/`**.

```bash
cd node_modules/webmaxsocket   # or from the repository root

# chatId — a number or 0 (e.g. "Saved messages")
npm run example:download -- 0 30

# Session name and history depth via env
SESSION_NAME=sms_session BACKWARD=50 npm run example:download -- 123456
```

## Project structure

```
webmaxsocket/
├── src/
│   ├── client.ts          # Main client
│   ├── socketTransport.ts # TCP Socket transport
│   ├── session.ts         # Session management
│   ├── userAgent.ts       # UserAgent generator
│   ├── opcodes.ts         # Protocol opcodes
│   ├── constants.ts       # Constants
│   ├── incomingLog.ts     # logIncoming mode / incoming printing
│   ├── qrWebLogin.ts      # QR track id parsing
│   ├── callHelpers.ts     # Call notification parsing
│   ├── index.ts           # Entry point / exports
│   └── entities/
│       ├── User.ts        # User class
│       ├── Message.ts     # Message class
│       ├── ChatAction.ts  # Chat action class
│       ├── downloadMedia.ts # Media download helpers
│       └── index.ts       # Entity exports
├── example/
│   ├── example.ts              # QR authorization
│   ├── example-token.ts        # Token authorization
│   ├── example-sms.ts          # SMS authorization
│   ├── example-sessions-2fa.ts # Sessions / 2FA
│   └── example-download-files.ts # Attachment download from chat history
├── maxclient-bridge.ts         # Experimental JSON bridge for the PC client
├── package.json
├── tsconfig.json
├── api.package.md              # API reference (all methods)
└── README.md
```

## Sessions

The library automatically saves sessions in the `sessions/` directory. On a repeated run with the same session name authorization is not required.

**Token after `sync()`:** on a successful `LOGIN` (a `sync()` call) the server may return a new token in `tokenAttrs.LOGIN.token`. If it differs from the saved one, the library updates `this._token` and the session file (if `saveToken !== false`). This way Max-side rotation isn't lost between restarts.

**TCP (ANDROID) and repeated `sync()`:** on one TLS socket a **second consecutive `LOGIN` (19)** is rejected ("Invalid session state"). The **`SYNC` (21)** request on the same transport reliably gives "Something went wrong" (in the web client a re-sync goes via **`LOGIN` (19)`, not 21). Therefore after the first successful `LOGIN` every subsequent **`sync()`** on TCP: **close the socket → new connection → full `LOGIN` (19)** with the web-like body (`lastLogin`, counters, `presenceSync: -1`, `userAgent`). On **WEB** every `sync()` still goes as `LOGIN` on the same WebSocket.

**Parallel RPC on one TCP:** the transport matches responses by **`seq % 256`**. Don't call **`sendAndWait`** (and methods on top of it: `sync`, `getSessionsInfo`, …) **in parallel** on one client — responses may get mixed up and produce false errors. Run requests **sequentially** or use a queue.

**Periodic refresh:** the option **`sessionRefreshIntervalMs`** (or **`autoSyncIntervalMs`**) — the interval for a repeated `sync()` (minimum **10 s**). On **TCP** each such call usually **opens TLS again** and sends **`LOGIN`**. The timer is removed in **`stop()`**. Manual cleanup: **`client.session.clear()`**.

**Re-login on a token error from config:** when `sync()` fails with a token from **`options.token`** or the **`config`** file, the `sessions/*.json` file is **not cleared** (to keep the current token from the previous authorization). For **`connectWithSession()`** the cleanup before `authorize()` after a sync error is disabled by default; enable **`clearSessionOnFailedSync: true`** if you want the previous "clean slate" behavior.

```javascript
// Create a new session
const client1 = new WebMaxClient({ name: 'account1', phone: '+1234567890' });

// Use an existing session
const client2 = new WebMaxClient({ name: 'account1' }); // phone is not required

// Example: every 45 minutes — sync() to extend the token rotation
const client3 = new WebMaxClient({
  name: 'account1',
  sessionRefreshIntervalMs: 45 * 60 * 1000
});
```

## Error handling

It is recommended to always wrap API calls in try-catch blocks:

```javascript
try {
  const message = await client.sendMessage({
    chatId: 123,
    text: 'Hello!'
  });
} catch (error) {
  console.error('Error:', error.message);
}
```

## Debug

To enable debug output:

```javascript
const client = new WebMaxClient({
  name: 'my_session',
  debug: true  // or process.env.DEBUG = '1'
});
```

Or via an environment variable:

```bash
DEBUG=1 node example.js
```

## Important notes

1. **TCP Socket after QR authorization:** after the first successful QR authorization the client automatically saves `clientSessionId` and switches to the TCP Socket transport on the next run for better stability.

2. **QR for a new device after SMS/TCP login:** use `showLinkDeviceQR()`. This is not a separate protocol opcode, but the same `GET_QR` as the web client; for an already logged-in TCP socket the request is done via an **ephemeral WebSocket connection** (the temporary session file `_link_qr_*` is removed after completion).

3. **`appVersion` and QR/SMS:** a too-old version in the User-Agent gives `qr_login.disabled` or "The app is outdated". Default **26.19.2** / **6733**. Constants: `APP_VERSION`, `BUILD_NUMBER` in `src/constants.ts`.

4. **Difference between sendMessage and sendMessageChannel:**
   - `sendMessage()` - send with notification (notify: true) for regular chats
   - `sendMessageChannel()` - send without notification (notify: false) for channels

5. **Automatic transport selection:** the client automatically determines which transport to use based on `deviceType` in the session or config file.

6. **`cid` when sending messages (TCP/Socket):** the server checks **signed int32**. Don't pass `Date.now()` (milliseconds ~1e12) — you'll get a "Validation error". Either omit `cid` (the client supplies its own) or pass an integer in the range **−2³¹ … 2³¹−1**.

7. **TCP and keep-alive (PING):** the server periodically sends `PING`. On WebSocket the client answers with `sendPong`; on **TCP** the answer to a server `PING` is **`PING` with an empty payload**. Additionally the client can send an outgoing **`PING` with `{ interactive: true }`** every **30 s** (like the web), option **`tcpInteractivePingMs`** (**`0`** — disable).

8. **LZ4:** for ANDROID incoming data is decompressed from LZ4 blocks; **`lz4js`** is a package dependency. If needed you can install the native **`lz4`** (see the **"Socket transport dependencies"** section).

9. **Repeated `sync()` on TCP:** see **"Sessions"** — **new TLS and `LOGIN` (19) again**; a second consecutive **`LOGIN` (19)** on the **same** socket is rejected; **`SYNC` (21)** must not be used on TCP.

10. **`closeAllSessionsExceptCurrent`:** don't pass raw "close all except current" flags to **`closeSessions`** without an explicit session list — there is a risk of invalidating your own token; use the ready method.

## Changelog

### 1.2.7

- **Fingerprint 26.19.2 (6733):** updated `APP_VERSION` / `BUILD_NUMBER` — the server no longer replies "The app is outdated" to SMS `AUTH_REQUEST`.
- **Old sessions:** `appVersion`/`buildNumber` are no longer read from `sessions/*.json` (only options/config/default), so an outdated fingerprint doesn't stick.
- **`getUserByPhone(phone)` / `getUserIdByPhone(phone)`:** user lookup by number via opcode `CONTACT_INFO_BY_PHONE` (46). On `contact.not.found` they return `null`.

### 1.2.6

- **`client.lastSyncPayload`** — stores the last successful **`LOGIN`/`sync()`** response (including the `chats` array). On **TCP** the **`getChats()`** list is sometimes empty; take the chats from **`lastSyncPayload.chats`**.
- **Downloading `FILE` documents without `baseUrl` in history:** **`requestFileDownloadUrl({ chatId, messageId, fileId, fileName?, … })`** — the server returns a temporary HTTPS **`url`** for downloading.
- **`message.downloadAttachment()`** — for **`_type: FILE`** without a URL it calls **`requestFileDownloadUrl`** itself (needs the correct **`chatId`** of the message and **`messageId`**).
- **`getHistory`**: each message is annotated with **`chatId`** from the request argument (raw messages often don't have it).
- **`Message`**: **`chatId === 0`** is handled correctly (e.g. "Saved messages").
- **TCP + msgpack:** if the outgoing payload contains **`BigInt`**, **`useBigInt64`** is enabled when encoding; incoming packets are decoded with **`useBigInt64`**, so **`message.id`** and other int64 values aren't lost (above **`Number.MAX_SAFE_INTEGER`**).
- **`downloadMedia`:** extended MIME → extension map (`text/plain`, `application/pdf`, …).
- New example: **`example-download-files.ts`** (chat history → `downloads/` folder).

### 1.2.5

- **`Opcode.NOTIF_INCOMING_CALL` (137)** — opcode name in `getOpcodeName`; handling in TCP/WebSocket: event **`incoming_call`**, **`onIncomingCall`**, plus **`raw_message`** as before.
- **`onCallLog`** / event **`call_log`**: on **`NOTIF_MESSAGE`** with a **`_type: "CALL"`** attachment (call summary: `hangupType`, `duration`, `conversationId`).
- **`rejectIncomingCall`** / **`hangupCall`**: experimental call drop via the OK API method **`vchat.hangupConversation`** (`conversationId`, `reason=REJECTED`).
- Module **`src/callHelpers.ts`** (exported from the package): `summarizeIncomingCall`, `extractCallAttachesFromNotifPayload`, `summarizeCallAttach`, `formatCallLogLine`, `isCallAttach`.
- **`EventTypes.INCOMING_CALL`**, **`EventTypes.CALL_LOG`**.

### 1.2.4

- **ANDROID by default for SMS/TCP:** `device_type: 2/3` is normalized to `ANDROID`; the default fingerprint is updated to `appVersion: 26.14.1`, `buildNumber: 6686`.
- **Removed the obsolete socket example:** SMS examples and the low-level TCP path now use the Android profile.

### 1.2.3

- **TCP / repeated `sync()`:** after the first `LOGIN` each subsequent `sync()` is **reconnection and a full `LOGIN` (19)** (opcode **21** is rejected on TCP; the LOGIN body has **`lastLogin`** and counters from the session).
- **TCP:** periodic outgoing **`PING` `{ interactive: true }`** (~30 s), option **`tcpInteractivePingMs`**.
- **`closeAllSessionsExceptCurrent`:** closing only by **explicit `times`** of other sessions; without the `allExceptCurrent` / `excludeCurrent` flags; **`deviceId`** and **`current`** are considered when choosing "your" session.
- **`normalizeSessionsList`:** the **`deviceId`** field, extra signs of the current session in the response.
- **`sync()` / LOGIN:** saving the new token from the `tokenAttrs.LOGIN.token` response on server rotation.
- **Token rotation from incoming packets:** recursive parsing of **`tokenAttrs.LOGIN.token`** in any **TCP notification** and in **WebSocket messages** (like the official client on rotation pushes), plus nested arrays in the LOGIN response — so the session file doesn't stay with the old token after a server-side change.
- **`sessionRefreshIntervalMs`** / **`autoSyncIntervalMs`:** periodic `sync()` in the background (minimum 10 s), timer in `stop()`; on TCP a **new TLS** is typical on each tick.
- **`start()`:** on a `sync()` error with a token from config/options the **`session.clear()`** call was removed — the session file isn't lost.
- **`clearSessionOnFailedSync`** (default `false`): for **`connectWithSession()`** — optionally call **`session.clear()`** before re-authorization after a sync error.

### 1.2.1

- Device list and closing other sessions: **`getSessionsInfo`**, **`normalizeSessionsList`**, **`closeSessions`**, **`closeAllSessionsExceptCurrent`**.
- Account 2FA: **`getTwoFADetails`**, **`setTwoFAPassword`**. Example: **`example-sessions-2fa.ts`**.

### 1.2.0

- SMS authorization: **2FA password** support after the SMS code (`passwordChallenge`, `AUTH_LOGIN_CHECK_PASSWORD` / opcode `0x73`).
- Option **`saveTwofaPassword`** (enabled by default): save the 2FA password to the session file **`twofaPassword`**.
- **`MaxSocketTransport`**: method **`sendLogin2FAPassword(trackId, password)`**.

### 1.1.6 and earlier

- See commits and tags in the [repository](https://github.com/Tellarion/webmaxsocket).

## Links

- [GitHub Repository](https://github.com/Tellarion/webmaxsocket)
- [NPM Package](https://www.npmjs.com/package/webmaxsocket)

## License

MIT License - see the LICENSE file for details

## Author

Tellarion - [tellarion.dev](https://tellarion.dev)

## Support

If you like this library and want to support the development:

**USDT (TRC20):** `TXfs1iVbp2aLd3rbc4cenVzMoTevP5RbBE`

Thank you for your support!
