/**
 * Parsing of call notifications (opcode 137 and NOTIF_MESSAGE service messages with a CALL attachment).
 */

/**
 * Brief summary of an incoming call payload (NOTIF_INCOMING_CALL / opcode 137).
 * The `vcp` field is intentionally excluded (sensitive WebRTC / media parameters).
 */
export function summarizeIncomingCall(payload: any = {}): any {
  return {
    callerId: payload.callerId,
    chatId: payload.chatId ?? null,
    conversationId: payload.conversationId,
    type: payload.type,
    isContact: payload.isContact,
    country: payload.country,
    hasVcp: Boolean(payload.vcp)
  };
}

/**
 * Checks whether an attachment is a CALL attachment.
 */
export function isCallAttach(attach: any): boolean {
  if (!attach || typeof attach !== 'object') return false;
  const t = attach._type ?? attach.type;
  return String(t || '').toUpperCase() === 'CALL';
}

/**
 * Extracts CALL attachments from a NOTIF_MESSAGE (128) notification payload.
 * Expects `payload.message.attaches` or `payload.attaches`.
 */
export function extractCallAttachesFromNotifPayload(notifPayload: any = {}): any[] {
  const msg = notifPayload.message || notifPayload;
  const raw = msg.attaches || msg.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isCallAttach);
}

/**
 * Normalized description of a single CALL attachment (call summary in a chat).
 */
export function summarizeCallAttach(attach: any = {}): any {
  const duration = attach.duration;
  const durationMs =
    typeof duration === 'number' && Number.isFinite(duration)
      ? duration
      : Number(duration) || 0;
  return {
    conversationId: attach.conversationId,
    hangupType: attach.hangupType,
    callType: attach.callType,
    durationMs,
    contactIds: Array.isArray(attach.contactIds) ? attach.contactIds : []
  };
}

/**
 * A single line for logs.
 * @param summary — result of summarizeCallAttach
 */
export function formatCallLogLine(summary: any): string {
  if (!summary || typeof summary !== 'object') return '[call] (no summary)';
  const ht = summary.hangupType || '?';
  const cid = summary.conversationId || '?';
  const d = summary.durationMs;
  const durPart = d > 0 ? ` duration=${d}ms` : '';
  return `[call] ${ht} conv=${cid}${durPart}`;
}
