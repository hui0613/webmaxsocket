/**
 * Constants for the WebMax library.
 */

/**
 * Current appVersion / buildNumber of the official Max client.
 * Update when a new version is released — otherwise the server replies
 * "The app is outdated, please update" to SMS / SESSION_INIT.
 */
export const APP_VERSION = '26.19.2';
export const BUILD_NUMBER = 6733;

export const ChatActions = {
  TYPING: 'typing',
  STICKER: 'sticker',
  FILE: 'file',
  RECORDING_VOICE: 'recording_voice',
  RECORDING_VIDEO: 'recording_video'
};

export const EventTypes = {
  START: 'start',
  MESSAGE: 'message',
  MESSAGE_REMOVED: 'message_removed',
  CHAT_ACTION: 'chat_action',
  INCOMING_CALL: 'incoming_call',
  CALL_LOG: 'call_log',
  QR_CODE: 'qr_code',
  ERROR: 'error',
  DISCONNECT: 'disconnect'
};

export const MessageTypes = {
  TEXT: 'text',
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document',
  STICKER: 'sticker'
};
