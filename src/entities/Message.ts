import { User } from './User';
import { downloadUrlToTempFile, extFromAttachType } from './downloadMedia';

/**
 * Class representing a message.
 */
export class Message {
  client: any;
  id: any;
  cid: any;
  chatId: any;
  text: any;
  senderId: any;
  sender: any;
  timestamp: any;
  type: any;
  isEdited: any;
  replyTo: any;
  attachments: any;
  rawData: any;

  constructor(data: any, client: any) {
    this.client = client;
    this.id =
      data.id ??
      data.messageId ??
      data.message_id ??
      (data.message && (data.message.id ?? data.message.messageId)) ??
      null;
    this.cid = data.cid || null;
    this.chatId =
      data.chatId !== undefined && data.chatId !== null
        ? data.chatId
        : data.chat_id !== undefined && data.chat_id !== null
          ? data.chat_id
          : null;

    // text handling: may be a string or an object
    if (typeof data.text === 'string') {
      this.text = data.text;
    } else if (typeof data.text === 'object' && data.text !== null) {
      // If text is an object, look for the text inside
      this.text = data.text.text || JSON.stringify(data.text);
    } else {
      this.text = data.message || '';
    }

    // sender handling: may be a User object or just an ID
    if (data.sender) {
      if (typeof data.sender === 'object') {
        this.senderId = data.sender.id;
        this.sender = new User(data.sender);
      } else {
        // If sender is just an ID (number)
        this.senderId = data.sender;
        this.sender = null; // Will be loaded later when needed
      }
    } else {
      this.senderId = data.senderId || data.sender_id || data.from_id || null;
      this.sender = null;
    }

    this.timestamp = data.timestamp || data.time || Date.now();
    this.type = data.type || 'text';
    this.isEdited = data.isEdited || data.is_edited || false;
    this.replyTo = data.replyTo || data.reply_to || null;
    this.attachments = data.attaches || data.attachments || [];
    this.rawData = data;
  }

  /**
   * Gets sender information.
   */
  async fetchSender(): Promise<any> {
    if (!this.sender && this.senderId) {
      try {
        this.sender = await this.client.getUser(this.senderId);
      } catch (error: any) {
        console.error('Error loading sender information:', error);
      }
    }
    return this.sender;
  }

  /**
   * Gets the sender name.
   */
  getSenderName(): string {
    if (this.sender) {
      return this.sender.fullname || this.sender.firstname || 'User';
    }
    return this.senderId ? `User ${this.senderId}` : 'Unknown';
  }

  /**
   * Sends text to the same chat (as a reply to the counterpart).
   * By default without a quote (without link REPLY): the TCP server often rejects MSG_SEND with a link.
   * Quote/thread: reply({ text, quote: true }) — if the server returns an error, keep quote: false.
   */
  async reply(options: any): Promise<any> {
    if (typeof options === 'string') {
      options = { text: options };
    }

    const { text, cid, attachments, quote = false } = options;
    const payload: any = {
      chatId: this.chatId,
      text,
      cid,
      attachments
    };
    if (quote && this.id != null && this.id !== '') {
      payload.replyTo = this.id;
    }
    return await this.client.sendMessage(payload);
  }

  /**
   * Edits the message.
   */
  async edit(options: any): Promise<any> {
    if (typeof options === 'string') {
      options = { text: options };
    }

    return await this.client.editMessage({
      messageId: this.id,
      chatId: this.chatId,
      text: options.text,
      ...options
    });
  }

  /**
   * Deletes the message.
   */
  async delete(): Promise<any> {
    return await this.client.deleteMessage({
      messageId: this.id,
      chatId: this.chatId
    });
  }

  /**
   * Downloads an attachment by its baseUrl (HTTPS) to a temp file.
   * Default directory: {@link https://nodejs.org/api/os.html#ostmpdir os.tmpdir()}.
   *
   * @param index index in the attachments array
   * @param options
   * @returns `{ path, contentType }`
   */
  async downloadAttachment(index: number = 0, options: any = {}): Promise<{ path: string; contentType: string }> {
    const att = this.attachments[index];
    if (!att) {
      throw new Error(`No attachment at index ${index}`);
    }
    let url = att.baseUrl || att.url;
    const t = String(att._type || att.type || '').toUpperCase();
    const chatIdForFile =
      this.chatId != null
        ? this.chatId
        : options.chatId != null
          ? options.chatId
          : this.rawData && (this.rawData.chatId ?? this.rawData.chat_id);

    if (
      (!url || typeof url !== 'string') &&
      t === 'FILE' &&
      att.fileId != null &&
      this.client &&
      typeof this.client.requestFileDownloadUrl === 'function' &&
      chatIdForFile != null
    ) {
      const msgId = this.rawData && this.rawData.id != null ? this.rawData.id : this.id;
      url = await this.client.requestFileDownloadUrl({
        chatId: chatIdForFile,
        messageId: msgId,
        fileId: att.fileId,
        fileName: att.name || att.fileName || att.filename || '',
        attachLocalId: att.attachLocalId || att.localId || ''
      });
    }
    if (!url || typeof url !== 'string') {
      throw new Error('The attachment has no baseUrl/url and the file link could not be obtained');
    }
    const extFallback = extFromAttachType(att._type || att.type);
    return downloadUrlToTempFile(url, { ...options, extFallback });
  }

  /**
   * Forwards the message.
   */
  async forward(chatId: any): Promise<any> {
    return await this.client.forwardMessage({
      messageId: this.id,
      fromChatId: this.chatId,
      toChatId: chatId
    });
  }

  /**
   * Returns a string representation of the message.
   */
  toString(): string {
    return `Message(id=${this.id}, from=${this.senderId}, text="${this.text.substring(0, 50)}")`;
  }

  /**
   * Returns a JSON representation.
   */
  toJSON(): any {
    return {
      id: this.id,
      cid: this.cid,
      chatId: this.chatId,
      text: this.text,
      senderId: this.senderId,
      sender: this.sender ? this.sender.toJSON() : null,
      timestamp: this.timestamp,
      type: this.type,
      isEdited: this.isEdited,
      replyTo: this.replyTo,
      attachments: this.attachments
    };
  }
}
