import * as fs from 'fs';
import * as path from 'path';

/**
 * Storage abstraction for persisting session data.
 * Implement this interface to plug in a custom backend
 * (in-memory, database, encrypted file, ...).
 */
export interface SessionStorage {
  /** Loads the stored session data, or null when nothing is stored. */
  load(): Record<string, any> | null;
  /** Persists the session data. Returns true on success. */
  save(data: Record<string, any>): boolean;
  /** Creates a recovery snapshot of the current data. Returns true on success. */
  backup(): boolean;
  /** Removes the stored session. Returns true on success. */
  remove(): boolean;
}

export interface FileSessionStorageOptions {
  /** Session name used to build the file name. */
  name?: string;
  /** Directory that stores session files (default: <cwd>/sessions). */
  directory?: string;
}

/**
 * Default filesystem-backed session storage.
 * Stores one JSON file per session plus a `.last_ok.json` snapshot.
 */
export class FileSessionStorage implements SessionStorage {
  readonly sessionName: string;
  readonly sessionDir: string;
  readonly sessionFile: string;
  readonly backupFile: string;

  constructor(options: string | FileSessionStorageOptions = 'default') {
    const name = typeof options === 'string' ? options : options.name || 'default';
    const directory = typeof options === 'string' ? undefined : options.directory;
    this.sessionName = name;
    this.sessionDir = directory || path.join(process.cwd(), 'sessions');
    this.sessionFile = path.join(this.sessionDir, `${name}.json`);
    this.backupFile = path.join(this.sessionDir, `${name}.last_ok.json`);
    this.ensureDir();
  }

  /** Creates the session directory if it does not exist. */
  ensureDir(): void {
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  load(): Record<string, any> | null {
    try {
      if (fs.existsSync(this.sessionFile)) {
        const raw = fs.readFileSync(this.sessionFile, 'utf8');
        return JSON.parse(raw) as Record<string, any>;
      }
    } catch (error) {
      console.error('Error loading session:', (error as Error).message);
    }
    return null;
  }

  save(data: Record<string, any>): boolean {
    try {
      fs.writeFileSync(this.sessionFile, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error('Error saving session:', (error as Error).message);
      return false;
    }
  }

  backup(): boolean {
    try {
      if (!fs.existsSync(this.sessionFile)) return false;
      fs.copyFileSync(this.sessionFile, this.backupFile);
      return true;
    } catch (error) {
      console.error('Error backing up session:', (error as Error).message);
      return false;
    }
  }

  remove(): boolean {
    try {
      if (fs.existsSync(this.sessionFile)) {
        fs.unlinkSync(this.sessionFile);
      }
      return true;
    } catch (error) {
      console.error('Error deleting session:', (error as Error).message);
      return false;
    }
  }
}

export interface SessionManagerOptions {
  /** Session name used for identification and as the default file name. */
  name?: string;
  /** Custom storage backend. Defaults to FileSessionStorage. */
  storage?: SessionStorage;
}

/**
 * Session manager for storing authorization data.
 */
export class SessionManager {
  readonly sessionName: string;
  readonly storage: SessionStorage;
  data: Record<string, any>;

  constructor(options: string | SessionManagerOptions = 'default') {
    if (typeof options === 'string') {
      this.sessionName = options;
      this.storage = new FileSessionStorage(options);
    } else {
      this.sessionName = options.name || 'default';
      this.storage = options.storage || new FileSessionStorage(this.sessionName);
    }
    this.data = {};
    this.load();
  }

  /**
   * Loads session data from storage.
   */
  load(): boolean {
    const data = this.storage.load();
    if (data) {
      this.data = data;
      return true;
    }
    return false;
  }

  /**
   * Copies the last known-good state (after a successful sync) for manual recovery:
   * copy `.last_ok.json` over the main session file.
   */
  copyToLastOk(): boolean {
    return this.storage.backup();
  }

  /**
   * Saves session data to storage.
   */
  save(): boolean {
    return this.storage.save(this.data);
  }

  /**
   * Sets a value in the session.
   */
  set(key: string, value: unknown): void {
    this.data[key] = value;
    this.save();
  }

  /**
   * Gets a value from the session.
   */
  get(key: string, defaultValue: any = null): any {
    return this.data[key] !== undefined ? this.data[key] : defaultValue;
  }

  /**
   * Removes a value from the session.
   */
  delete(key: string): void {
    delete this.data[key];
    this.save();
  }

  /**
   * Checks whether the session contains a key.
   */
  has(key: string): boolean {
    return this.data[key] !== undefined;
  }

  /**
   * Clears all session data.
   */
  clear(): void {
    this.data = {};
    this.save();
  }

  /**
   * Removes the stored session.
   */
  destroy(): boolean {
    const ok = this.storage.remove();
    this.data = {};
    return ok;
  }

  /**
   * Checks whether the user is authorized.
   */
  isAuthorized(): boolean {
    return this.has('token') && this.has('userId');
  }
}
