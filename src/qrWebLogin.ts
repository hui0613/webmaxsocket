/**
 * Extracts the QR login identifier: a UUID trackId or an opaque token (qr_...).
 * Supported forms:
 * - https://max.ru/qr/v1/auth?token=qr_...
 * - https://max.ru/login/qr/<uuid> or :auth/<uuid>
 * - web.max / trackId in the query string
 * - a bare UUID or a qr_... string
 */
export function parseQrTrackId(qrUrlOrTrackId: string | null | undefined): string | null {
  const s = String(qrUrlOrTrackId == null ? '' : qrUrlOrTrackId).trim();
  if (!s) return null;

  let decoded = s;
  try {
    decoded = decodeURIComponent(s);
  } catch (_) {
    decoded = s;
  }

  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const qrTokenRe = /^qr_[a-zA-Z0-9_-]+$/i;

  if (qrTokenRe.test(decoded)) {
    return decoded;
  }

  try {
    if (/^https?:\/\//i.test(decoded)) {
      const u = new URL(decoded);
      const tokenParam = u.searchParams.get('token');
      if (tokenParam && qrTokenRe.test(tokenParam.trim())) {
        return tokenParam.trim();
      }
      for (const key of ['trackId', 'track_id', 'track', 'tid']) {
        const v = u.searchParams.get(key);
        if (v) {
          const m = String(v).match(uuidRe);
          if (m) return m[0];
        }
      }
      // https://max.ru/auth/<uuid> or max.ru/:auth/<uuid> (as in the QR).
      const pathSegs = u.pathname.split('/').filter(Boolean);
      for (const seg of pathSegs) {
        if (uuidRe.test(seg)) {
          const m = seg.match(uuidRe);
          if (m) return m[0];
        }
      }
    }
  } catch (_) {}

  const m = decoded.match(uuidRe);
  return m ? m[0] : null;
}
