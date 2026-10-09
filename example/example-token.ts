/**
 * Token login example (token auth).
 *
 * Config: config/default.json — token, agent
 *   npm run example:token
 *   npm run example:token -- other  — config/other.json
 * Option 3 — TOKEN in env: TOKEN="..." npm run example:token
 */

import { WebMaxClient } from 'webmaxsocket';

const CONFIG_NAME = process.argv[2] || process.env.CONFIG || 'default';

async function main(): Promise<void> {
  let client: any;
  try {
    client = new WebMaxClient({
      name: 'token_session',
      configPath: CONFIG_NAME,
      token: process.env.TOKEN,
      saveToken: true,
      debug: process.env.DEBUG === '1'
    });
  } catch (e: any) {
    console.error('❌ Failed to load the config:', e.message);
    console.error('   Create config/default.json (see config/example.json)');
    process.exit(1);
  }

  if (!client._providedToken || client._providedToken.length < 50) {
    console.error('❌ Set the token in config/default.json (the "token" field)');
    console.error('   Or: TOKEN="your_token" npm run example:token');
    process.exit(1);
  }

  client.onStart(async () => {
    if (client.me) {
      console.log('\n📋 USER DATA:');
      console.log('─'.repeat(40));
      console.log(`👤 Name: ${client.me.fullname || client.me.firstname}`);
      console.log(`🆔 ID: ${client.me.id}`);
      console.log(`📱 Phone: +${client.me.phone || '—'}`);
      console.log(`🖼  Avatar: ${client.me.avatar ? 'yes' : 'no'}`);
    }

    try {
      const chats = await client.getChats();
      console.log('\n📂 CHATS (' + chats.length + '):');
      console.log('─'.repeat(40));
      chats.slice(0, 15).forEach((chat: any, i: number) => {
        const chatId = chat.id ?? chat.chatId;
        const title = chat.title || chat.name || `Chat ${chatId}`;
        const lastMsg = chat.lastMessage?.text || chat.lastMessage?.message || '—';
        const preview = String(lastMsg).slice(0, 40) + (String(lastMsg).length > 40 ? '…' : '');
        console.log(`${i + 1}. [${chatId}] ${title}`);
        console.log(`   Last: ${preview}`);
      });
      if (chats.length > 15) console.log(`   ... and ${chats.length - 15} more`);

      if (chats.length > 0) {
        const firstChat = chats[0];
        const firstChatId = firstChat.id ?? firstChat.chatId;
        const history = await client.getHistory(firstChatId, Date.now(), 5, 0);
        console.log(`\n💬 Last 5 messages in "${firstChat.title || firstChat.id}":`);
        console.log('─'.repeat(40));
        history.reverse().forEach((m: any, i: number) => {
          const from = m.senderId === client.me?.id ? 'You' : `User ${m.senderId}`;
          console.log(`   ${i + 1}. ${from}: ${String(m.text || '').slice(0, 50)}`);
        });
      }
      console.log('\n');
    } catch (e: any) {
      console.log('⚠️ Failed to load chats:', e.message);
    }
  });

  client.onMessage(async (message: any) => {
    if (message.senderId === client.me?.id) return;
    console.log(`💬 ${message.getSenderName()}: ${message.text}`);
    await message.reply({ text: 'Received!', cid: Date.now() });
  });

  client.onError(async (err: any) => console.error('❌', err.message));

  try {
    await client.start();
    console.log('🤖 Token authorization successful. Bot is running.\n');
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
main().catch(console.error);
