/** Device sessions and 2FA. Requires a token (example-sms.js / test-sms-2fa.js). WEBMAX_SESSION or the name sms_session. */

import * as readline from 'readline';
import { WebMaxClient } from 'webmaxsocket';

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  const closeOthers = process.argv.includes('--close-others');

  const client = new WebMaxClient({
    name: process.env.WEBMAX_SESSION || 'sms_session',
    deviceType: 'ANDROID',
    debug: process.env.DEBUG === '1'
  });

  await client.connectWithSession();
  if (!client.isAuthorized) {
    console.error('No valid session. Sign in first: npm run example:sms');
    process.exit(1);
  }

  console.log('\n📱 Active sessions (devices)\n');
  const raw = await client.getSessionsInfo();
  const rows = WebMaxClient.normalizeSessionsList(raw || {});

  if (!rows.length && raw && typeof raw === 'object') {
    console.log('Raw server response (the list format may differ):');
    console.log(JSON.stringify(raw, null, 2));
  } else {
    rows.forEach((r: any, i: number) => {
      const mark = r.current ? ' (current)' : '';
      console.log(
        `${i + 1}. ${r.client || '?'}${mark}\n   time=${r.time}  info=${r.info || '—'}  location=${r.location || '—'}`
      );
    });
  }

  console.log('\n🔐 2FA details (as returned by the server):');
  try {
    const twoFA = await client.getTwoFADetails();
    console.log(JSON.stringify(twoFA, null, 2));
  } catch (e: any) {
    console.error('getTwoFADetails:', e.message || e);
  }

  if (closeOthers) {
    const ok = await ask('\nClose all sessions except the current one? (yes/no): ');
    if (ok.toLowerCase() === 'yes' || ok.toLowerCase() === 'y') {
      try {
        const result = await client.closeAllSessionsExceptCurrent();
        console.log('Result:', JSON.stringify(result, null, 2));
      } catch (e: any) {
        console.error('closeAllSessionsExceptCurrent:', e.message || e);
      }
    }
  } else {
    console.log('\nHint: npm run example:sessions-2fa -- --close-others — close other sessions.');
    console.log(
      'Setting the 2FA password: client.setTwoFAPassword({ trackId, password, hint?, email? }) — trackId from the scenario in the Max app.'
    );
  }

  await client.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
