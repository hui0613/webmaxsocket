import { User } from './User';

/**
 * Class representing a chat action.
 */
export class ChatAction {
  client: any;
  type: any;
  chatId: any;
  userId: any;
  user: any;
  timestamp: any;
  rawData: any;

  constructor(data: any, client: any) {
    this.client = client;
    this.type = data.type || data.action || null;
    this.chatId = data.chatId || data.chat_id || null;
    this.userId = data.userId || data.user_id || null;
    this.user = data.user ? new User(data.user) : null;
    this.timestamp = data.timestamp || Date.now();
    this.rawData = data;
  }

  /**
   * Returns a string representation of the action.
   */
  toString(): string {
    return `ChatAction(type=${this.type}, user=${this.userId}, chat=${this.chatId})`;
  }

  /**
   * Returns a JSON representation.
   */
  toJSON(): any {
    return {
      type: this.type,
      chatId: this.chatId,
      userId: this.userId,
      user: this.user ? this.user.toJSON() : null,
      timestamp: this.timestamp
    };
  }
}
