/**
 * WebMaxSocket - Node.js library for working with the Max Messenger API.
 * tellarion.dev
 *
 * @module webmaxsocket
 */

import { WebMaxClient } from './client';
import { MaxSocketTransport } from './socketTransport';
import { SessionManager, SessionStorage, FileSessionStorage } from './session';
import { User, Message, ChatAction } from './entities';
import { ChatActions, EventTypes, MessageTypes, APP_VERSION, BUILD_NUMBER } from './constants';
import { Opcode, getOpcodeName } from './opcodes';
import { UserAgentPayload } from './userAgent';
import { downloadUrlToTempFile, extFromContentType, extFromAttachType } from './entities/downloadMedia';
import { resolveIncomingLogMode, printIncomingLog } from './incomingLog';
import { parseQrTrackId } from './qrWebLogin';
import {
  summarizeIncomingCall,
  isCallAttach,
  extractCallAttachesFromNotifPayload,
  summarizeCallAttach,
  formatCallLogLine
} from './callHelpers';

export {
  WebMaxClient,
  MaxSocketTransport,
  SessionManager,
  SessionStorage,
  FileSessionStorage,
  User,
  Message,
  ChatAction,
  ChatActions,
  EventTypes,
  MessageTypes,
  APP_VERSION,
  BUILD_NUMBER,
  Opcode,
  getOpcodeName,
  UserAgentPayload,
  downloadUrlToTempFile,
  extFromContentType,
  extFromAttachType,
  resolveIncomingLogMode,
  printIncomingLog,
  parseQrTrackId,
  summarizeIncomingCall,
  isCallAttach,
  extractCallAttachesFromNotifPayload,
  summarizeCallAttach,
  formatCallLogLine
};
