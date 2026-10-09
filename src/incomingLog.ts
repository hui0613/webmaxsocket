/**
 * Incoming event logging mode for WebMaxClient.
 */

/**
 * @param options WebMaxClient constructor options (`logIncoming`, `logIncomingVerbose`, ...)
 * @returns `{ mode: 'off' | 'messages' | 'verbose' }`
 *
 * - `logIncoming: false` — disabled.
 * - `logIncoming: 'verbose'` or `logIncomingVerbose: true` — JSON of messages plus connected, raw_message, removed, chat_action, error.
 * - `logIncoming: 'messages'` — only JSON of incoming messages (even when WEBMAX_DEBUG is set).
 * - `WEBMAX_SILENT=1` — disable dumps.
 * - `WEBMAX_DEBUG=1` — verbose mode, unless `logIncoming: 'messages'` is set explicitly.
 */
export function resolveIncomingLogMode(
  options: any = {}
): { mode: 'off' | 'messages' | 'verbose' } {
  const silent = process.env.WEBMAX_SILENT === '1';
  const envVerbose = process.env.WEBMAX_DEBUG === '1';

  const li = options.logIncoming;

  if (li === false) {
    return { mode: 'off' };
  }
  if (li === 'verbose' || options.logIncomingVerbose === true) {
    return { mode: 'verbose' };
  }
  if (silent) {
    return { mode: 'off' };
  }
  if (li === 'messages') {
    return { mode: 'messages' };
  }
  if (envVerbose) {
    return { mode: 'verbose' };
  }
  return { mode: 'messages' };
}

/**
 * Prints an incoming log block.
 */
export function printIncomingLog(label: string, payload: unknown): void {
  try {
    const s = JSON.stringify(
      payload,
      (k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2
    );
    console.log(`\n📥 [incoming:${label}]\n${s}\n`);
  } catch (_) {
    console.log(`\n📥 [incoming:${label}]`, payload, '\n');
  }
}
