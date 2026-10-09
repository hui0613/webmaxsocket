import * as fs from 'fs';
import * as path from 'path';

/**
 * Session manager for storing authorization data.
 */
export class SessionManager {
  sessionName: string;
  sessionDir: string;
  sessionFile: string;
  data: Record<string, any>;

  constructor(sessionName: string = 'default') {
    this.sessionName = sessionName;
    this.sessionDir = path.join(process.cwd(), 'sessions');
    this.sessionFile = path.join(this.sessionDir, `${sessionName}.json`);
    this.data = {};

    this.ensureSessionDir();
    this.load();
  }

  /**
   * Creates the sessions directory if it does not exist.
   */
  ensureSessionDir(): void {
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  /**
   * Loads session data from file.
   */
  load(): boolean {
    try {
      if (fs.existsSync(this.sessionFile)) {
        const data = fs.readFileSync(this.sessionFile, 'utf8');
        this.data = JSON.parse(data);
        return true;
      }
    } catch (error: any) {
      console.error('Error loading session:', error.message);
    }
    return false;
  }

  /**
   * Copies the last known-good state (after a successful sync) for manual recovery:
   * copy `.last_ok.json` over the main session file.
   */
  copyToLastOk(): boolean {
    try {
      if (!fs.existsSync(this.sessionFile)) return false;
      const okPath = path.join(this.sessionDir, `${this.sessionName}.last_ok.json`);
      fs.copyFileSync(this.sessionFile, okPath);
      return true;
    } catch (error: any) {
      console.error('Error backing up session:', error.message);
      return false;
    }
  }

  /**
   * Saves session data to file.
   */
  save(): boolean {
    try {
      fs.writeFileSync(
        this.sessionFile,
        JSON.stringify(this.data, null, 2),
        'utf8'
      );
      return true;
    } catch (error: any) {
      console.error('Error saving session:', error.message);
      return false;
    }
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
   * Removes the session file.
   */
  destroy(): boolean {
    try {
      if (fs.existsSync(this.sessionFile)) {
        fs.unlinkSync(this.sessionFile);
      }
      this.data = {};
      return true;
    } catch (error: any) {
      console.error('Error deleting session:', error.message);
      return false;
    }
  }

  /**
   * Checks whether the user is authorized.
   */
  isAuthorized(): boolean {
    return this.has('token') && this.has('userId');
  }
}
