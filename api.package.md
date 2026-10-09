# WebMaxSocket — API reference

A concise list of capabilities for working with the library. Details and examples are in `README.md`.

**TCP dependencies (ANDROID):** socket responses are compressed with **LZ4**; decompression uses **`lz4js`**. See `README.md` → "Socket transport dependencies".

---

## Package exports (`require('webmaxsocket')`)

| Symbol | Description |
|--------|-------------|
| `WebMaxClient` | Main client |
| `MaxSocketTransport` | Low-level TCP transport |
| `User`, `Message`, `ChatAction` | Entities |
| `ChatActions`, `EventTypes`, `MessageTypes` | Constants |
| `Opcode`, `getOpcodeName` | Protocol opcodes |
| `UserAgentPayload` | User-Agent for the handshake |
| `downloadUrlToTempFile`, `extFromContentType`, `extFromAttachType` | Media download by URL |
| `resolveIncomingLogMode`, `printIncomingLog` | Incoming log mode |
| `summarizeIncomingCall`, `isCallAttach`, `extractCallAttachesFromNotifPayload`, `summarizeCallAttach`, `formatCallLogLine` | Call notification parsing (see README) |

---

## `WebMaxClient`

The client extends `EventEmitter`: `on`, `once`, `emit`, `off` (including `connected`, `raw_message`, **`incoming_call`**, **`call_log`**).

### Call events (TCP)

| Event | When |
|-------|------|
| `incoming_call` | **`NOTIF_INCOMING_CALL`** notification (opcode 137) |
| `call_log` | **`NOTIF_MESSAGE`** with a `_type: "CALL"` attachment (call summary in a chat) |

Paired registrators: **`onIncomingCall(handler)`**, **`onCallLog(handler)`** (same data).

### Properties (useful)

| Property | Description |
|----------|-------------|
| `me` | Profile after authorization |
| `session` | Session manager |
| `isConnected`, `isAuthorized` | State |
| `userAgent` | Current User-Agent |
| `deviceId` | Device ID |
| `incomingLogMode` | `'off'` \| `'messages'` \| `'verbose'` |

### Startup and connection

| Method | Description |
|--------|-------------|
| `start()` | Connection, authorization, `onStart` handlers |
| `connect()` | Connection only (low-level) |
| `connectWithSession()` | Session + sync |
| `handshake()` | Handshake (WebSocket path) |
| `sync()` | On **TCP** the first time — `LOGIN` (19); each subsequent time — **new TLS + `LOGIN` (19) again** (body with `lastLogin`/counters from the session; opcode **21** is not supported on TCP). On **WEB** — `LOGIN` on the same connection. **`tokenAttrs.LOGIN.token`** — from responses and notifications (recursively) |
| `fetchMyProfile()` | Load `me` |
| `stop()` | Close the transport |
| `logout()` | Stop + remove the session |

### Authorization

| Method | Description |
|--------|-------------|
| `authorize(phone?)` | Default authorization scenario |
| `authorizeByQR()` | QR (WEB) |
| `authorizeBySMS(phone)` | SMS; returns `{ tempToken, phone, sendCode }`. `sendCode(code)` — either a token (string), or on 2FA an object `{ needsPassword, passwordChallenge, trackId, sendPassword }` |
| *(options)* | `saveTwofaPassword` (default `true`) — write the 2FA password to the session after a successful `sendPassword` |
| `requestQR()` | Request QR |
| `checkQRStatus(trackId)` | QR status |
| `loginByQR(trackId)` | Complete by QR |
| `pollQRStatus(...)` | Wait for the QR scan |
| `showLinkDeviceQR(options?)` | "Connect device" QR after login |

### Messages

| Method | Description |
|--------|-------------|
| `sendMessage({ chatId, text, cid?, replyTo?, attachments? })` | With notification |
| `sendMessageChannel({ ... })` | Channel, `notify: false` |
| `editMessage({ chatId, messageId, text, attachments? })` | Edit |
| `deleteMessage({ chatId, messageId, forMe? })` | Delete |
| `uploadPhoto(chatId, filePath)` | Photo attachment → `attachments` |
| `uploadVideo(chatId, filePath)` | Video |
| `uploadFile(chatId, filePath, options?)` | File |
| `uploadAudio(chatId, filePath)` | Audio as a file |

### Pins and reactions

| Method | Description |
|--------|-------------|
| `pinMessage({ chatId, messageId, notifyPin? })` | Pin |
| `setMessageReaction({ chatId, messageId, emoji })` | Reaction |
| `cancelMessageReaction({ chatId, messageId })` | Remove the reaction |
| `getMessageReactions({ chatId, messageId, count? })` | Reaction list |

### Chats, channels, groups

| Method | Description |
|--------|-------------|
| `getChats(marker?)` | Chat list |
| `getHistory(chatId, from?, backward?, forward?)` | History; each `Message` gets `chatId` |
| `requestFileDownloadUrl({ chatId, messageId, fileId, fileName?, … })` | Temporary download URL for **FILE**, when there is no `baseUrl` |
| `getChatInfo(chatIds)` | Info by id |
| `resolveLink(link)` | LINK_INFO |
| `joinChatByLink(link)` | Join by link |
| `setChatSubscription(chatId, subscribe)` | Channel subscription |
| `createGroup({ title, userIds })` | New group |
| `createChannel({ title })` | New channel |
| `muteChat(chatId, mute?)` | Do not disturb for a chat |
| `getChatMembers({ chatId, marker?, count?, type? })` | Members |
| `inviteToChat({ chatId, userIds, showHistory? })` | Invite |
| `removeFromChat({ chatId, userIds, cleanMsgPeriod? })` | Remove |
| `addChatAdmins({ chatId, userIds, permissions? })` | Admins |
| `removeChatAdmins({ chatId, userIds })` | Revoke admins |
| `transferChatOwnership({ chatId, newOwnerId })` | Change owner |
| `setGroupOptions({ chatId, options })` | Group settings |
| `resolveChannelByUsername(username)` | Channel by @ |
| `joinChannelByUsername(username)` | Join by @ |
| `resolveInviteHash(hash)` | `join/...` invite |

### Contacts and profile

| Method | Description |
|--------|-------------|
| `getUser(userId)` | One contact → `User` |
| `getUserByPhone(phone)` | Search by phone (`CONTACT_INFO_BY_PHONE`) → `User` \| `null` |
| `getUserIdByPhone(phone)` | Only the id by phone → `id` \| `null` |
| `getContacts(contactIds)` | Several contacts (raw response) |
| `addContact(userId)` | Add to contacts |
| `blockUser(userId)` | Block |
| `updateProfile({ firstName?, lastName?, description? })` | Profile |
| `setHiddenOnline(hidden)` | Hide online |
| `setFindableByPhone(mode)` | Search by phone |
| `setCallsPrivacyMode(mode)` | Calls |
| `hangupCall(call, options?)` | Experimental: end a call via `vchat.hangupConversation` |
| `rejectIncomingCall(call, options?)` | Experimental: reject an incoming call (`reason=REJECTED`) |
| `setChatsInvitePrivacy(mode)` | Chat invites |

### Sessions (devices) and 2FA

| Method | Description |
|--------|-------------|
| `getSessionsInfo()` | Session list; returns the **payload** |
| `WebMaxClient.normalizeSessionsList(payload)` | Array of `{ time, client, info, location, current, raw }` |
| `closeSessions(payload)` | Close sessions by request body |
| `closeAllSessionsExceptCurrent()` | Close all except the current one: only explicit **`times`** of other sessions (without `allExceptCurrent` flags); returns the **payload** or `{ skipped: true }` |
| `getTwoFADetails()` | 2FA parameters |
| `setTwoFAPassword({ trackId, password, hint?, email? })` | Set or change the 2FA password |

### Event handlers

| Method | Event |
|--------|-------|
| `onStart(handler)` | Successful start |
| `onMessage(handler)` | New message |
| `onMessageRemoved(handler)` | Message removed |
| `onChatAction(handler)` | Chat action |
| `onIncomingCall(handler)` | Incoming call (opcode 137) |
| `onCallLog(handler)` | Call record in a chat (`CALL` in message attachments) |
| `onError(handler)` | Errors |
| `onQrCode(handler)` | QR link for rendering `(qrLink, small)` |

### State after `sync()`

| Field | Description |
|-------|-------------|
| `lastSyncPayload` | Last successful `LOGIN`/`sync()` response (`chats`, `profile`, …). On TCP, if `getChats()` is empty, use `lastSyncPayload.chats` |

### Misc

| Method | Description |
|--------|-------------|
| `logIncoming(label, payload)` | Manual `[incoming:...]` log |
| `sendAndWait(opcode, payload, cmd?, timeout?)` | Low-level RPC |
| `triggerHandlers(eventType, data?)` | Internal handler invocation (rarely needed outside) |

---

## `MaxSocketTransport` (TCP)

| Method | Description |
|--------|-------------|
| `requestCode(phone, language?)` | Request SMS (`AUTH_REQUEST`) |
| `sendCode(tempToken, code)` | Code from SMS (`AUTH` + `CHECK_CODE`) |
| `sendLogin2FAPassword(trackId, password)` | 2FA password after `passwordChallenge` |
| `handshake(userAgent)`, `sendAndWait`, `sync`, `getChats`, `getHistory`, `close` | See `src/socketTransport.ts` |

---

## `Message`

| Method / property | Description |
|-------------------|-------------|
| `id`, `cid`, `chatId`, `text`, `senderId`, `sender`, `attachments`, `rawData`, … | Fields |
| `fetchSender()` | Load the sender |
| `getSenderName()` | Name for logging |
| `reply({ text, cid?, attachments?, quote? })` | Reply in the chat |
| `edit({ text, ... })` | Edit |
| `delete()` | Delete |
