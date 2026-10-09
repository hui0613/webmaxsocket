/**
 * SMS authorization (ANDROID). The session is saved to sessions/<name>.json
 * (token, deviceId, ua-fields; on successful 2FA — optionally twofaPassword).
 */

import * as readline from 'readline';
import { WebMaxClient, EventTypes } from '../src/index';

const SESSION_NAME =
  process.env.WEBMAX_SESSION || process.argv[3] || 'sms_session';

const SESSION_REFRESH_MS_RAW = process.env.SESSION_REFRESH_MS;
const sessionRefreshIntervalMs =
  SESSION_REFRESH_MS_RAW === undefined || SESSION_REFRESH_MS_RAW === ''
    ? 45 * 60 * 1000
    : Number(SESSION_REFRESH_MS_RAW);

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  let phone = process.argv[2];

  if (!phone) {
    phone = await ask('📱 Enter the phone number (+79001234567): ');
  }

  const digitsOnly = phone.replace(/\s/g, '');
  if (!/^\+?\d{10,15}$/.test(digitsOnly)) {
    console.error('❌ Invalid phone number format');
    process.exit(1);
  }

  console.log(`\n📁 Session: ${SESSION_NAME} → sessions/${SESSION_NAME}.json\n`);
  console.log('🚀 Starting the client (SMS / saved token)...\n');

  const client = new WebMaxClient({
    name: SESSION_NAME,
    deviceType: 'ANDROID',
    saveToken: true,
    saveTwofaPassword: process.env.SAVE_TWOFA_TO_SESSION !== '0',
    debug: process.env.DEBUG === '1',
    sessionRefreshIntervalMs:
      Number.isFinite(sessionRefreshIntervalMs) && sessionRefreshIntervalMs > 0
        ? sessionRefreshIntervalMs
        : 0
  });

  client.onStart(async () => {
    if (client.me) {
      console.log('\n📋 USER DATA:');
      console.log('─'.repeat(40));
      console.log(`👤 Name: ${client.me.fullname || client.me.firstname}`);
      console.log(`🆔 ID: ${client.me.id}`);
      console.log(`📱 Phone: +${client.me.phone || '—'}`);
    }

    try {
      const chats = await client.getChats();
      console.log(`\n📂 Chats: ${chats.length}`);
    } catch (e: any) {
      console.log('⚠️ Failed to load chats:', e.message);
    }
  });

  client.onMessage(async (message: any) => {
    if (message.senderId === client.me?.id) return;
    console.log(`\n💬 ${message.getSenderName()}: ${message.text}`);

    await message.reply({
      text: 'Auto-reply: message received!',
      cid: Date.now()
    });
    console.log('✅ Auto-reply sent');
  });

  client.onError((err: any) => console.error('❌', err.message));

  try {
    await client.connect();

    const savedToken = client.session.get('token');

    if (savedToken) {
      console.log('✅ Saved session found, signing in with the token from file...\n');
      client._token = savedToken;
      await client.sync();
      client.isAuthorized = true;
    } else {
      console.log('📱 No token in the session — SMS authorization\n');
      const authSession = await client.authorizeBySMS(phone);

      const code = await ask('\n📲 Enter the code from SMS (6 digits): ');

      if (!/^\d{6}$/.test(code)) {
        console.error('❌ Invalid code format');
        process.exit(1);
      }

      const afterCode = await authSession.sendCode(code);
      if (
        afterCode &&
        typeof afterCode === 'object' &&
        afterCode.needsPassword &&
        typeof afterCode.sendPassword === 'function'
      ) {
        let pwd = process.env.TWOFA_PASSWORD || process.env.TWOFa_PASSWORD;
        const saved = client.session.get('twofaPassword');
        if (
          !pwd &&
          saved &&
          process.env.ASK_TWOFA !== '1' &&
          process.env.ASK_TWOFa !== '1'
        ) {
          pwd = saved;
          console.log('\n🔒 The 2FA password was taken from the session (twofaPassword).');
        }
        if (!pwd) {
          pwd = await ask('\n🔒 Enter the 2FA password: ');
        }
        await afterCode.sendPassword(pwd);
      }
    }

    if (typeof client._scheduleSessionRefreshIfNeeded === 'function') {
      client._scheduleSessionRefreshIfNeeded();
    }

    await client.triggerHandlers(EventTypes.START);

    console.log('\n✅ Client started successfully!');
    console.log('🤖 Bot is running (Ctrl+C — exit)\n');
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down...');
  console.log('\n💝 Like the library? Support the development:');
  console.log('   USDT (TRC20): TXfs1iVbp2aLd3rbc4cenVzMoTevP5RbBE');
  process.exit(0);
});

main().catch((error) => {
  console.error('❌ Critical error:', error);
  process.exit(1);
});
