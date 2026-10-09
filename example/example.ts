/**
 * WebMax client usage example.
 * Demonstrates the main capabilities of the library.
 */

import { WebMaxClient } from '../src/index';

const qrcode = require('qrcode-terminal');

async function main(): Promise<void> {
  // Initialize the client
  const client = new WebMaxClient({
    name: 'example_session', // Session name
    appVersion: '26.19.2'
  });

  // QR handler — the library does not print QR codes itself; render the link here.
  client.onQrCode((qrLink: string, small: boolean) => {
    return new Promise<void>((resolve) => {
      qrcode.generate(qrLink, { small }, () => resolve());
    });
  });

  // Start handler
  client.onStart(async () => {
    if (client.me) {
      console.log(`👤 Signed in as: ${client.me.fullname || client.me.firstname}`);
      console.log(`🆔 ID: ${client.me.id}`);
      console.log(`📱 Phone: +${client.me.phone}\n`);
    }
  });

  // Incoming message handler
  client.onMessage(async (message: any) => {
    const senderName = message.getSenderName();
    console.log(`\n💬 Message from ${senderName}:`);
    console.log(`📝 ${message.text}`);
    console.log(`🕐 ${new Date(message.timestamp).toLocaleString()}`);

    // Don't reply to our own messages
    if (message.senderId === client.me.id) {
      return;
    }

    // Command handling
    const text = message.text.trim().toLowerCase();

    if (text === '/start' || text === '/help') {
      await message.reply({
        text: '🤖 Available commands:\n' +
              '/start - Show this menu\n' +
              '/info - Bot information\n' +
              '/ping - Check the connection\n' +
              '/echo <text> - Repeat the text',
        cid: Date.now()
      });
      console.log('✅ Command menu sent');
    } else if (text === '/info') {
      await message.reply({
        text: '📊 WebMax Node.js Client\n' +
              'Version: 1.0.0\n' +
              'GitHub: https://github.com/Tellarion/webmaxsocket',
        cid: Date.now()
      });
      console.log('✅ Info sent');
    } else if (text === '/ping') {
      await message.reply({
        text: '🏓 Pong!',
        cid: Date.now()
      });
      console.log('✅ Pong sent');
    } else if (text.startsWith('/echo ')) {
      const echoText = message.text.substring(6);
      await message.reply({
        text: echoText,
        cid: Date.now()
      });
      console.log('✅ Echo sent');
    } else {
      // Regular auto-reply
      await message.fetchSender();
      const name = message.sender ? message.sender.firstname || 'friend' : 'friend';

      await message.reply({
        text: `Hi, ${name}! 👋\nSend /help to see the available commands.`,
        cid: Date.now()
      });
      console.log('✅ Greeting reply sent');
    }
  });

  // Removed message handler
  client.onMessageRemoved(async (message: any) => {
    console.log(`\n🗑️  Message removed (ID: ${message.id})`);
  });

  // Chat action handler
  client.onChatAction(async (action: any) => {
    console.log('\n👁️  Chat action:', action);
  });

  // Error handler
  client.onError(async (error: any) => {
    console.error('\n❌ Error:', error.message);
  });

  // Start the client
  try {
    await client.start();
    console.log('🤖 Bot is ready. Press Ctrl+C to exit.\n');
  } catch (error: any) {
    console.error('❌ Startup error:', error);
    process.exit(1);
  }
}

// Shutdown handling
process.on('SIGINT', async () => {
  console.log('\n\n👋 Shutting down...');
  console.log('\n💝 Like the library? Support the development:');
  console.log('   USDT (TRC20): TXfs1iVbp2aLd3rbc4cenVzMoTevP5RbBE');
  process.exit(0);
});

// Run
main().catch(console.error);
