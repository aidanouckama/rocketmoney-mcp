import { createHash } from 'node:crypto';
import { SafeError } from './errors.js';

export const keychainError = () => new SafeError('KEYCHAIN_UNAVAILABLE', 'macOS Keychain is unavailable or access was denied. Unlock/allow Keychain access, or explicitly configure ROCKETMONEY_STORAGE=file for a new file session. No automatic plaintext fallback was used.');

export class MacKeychain {
  constructor(directory, { platform = process.platform, load = () => import('@napi-rs/keyring') } = {}) {
    this.platform = platform;
    this.load = load;
    this.account = createHash('sha256').update(directory).digest('hex');
  }
  async entry() {
    if (this.platform !== 'darwin') throw keychainError();
    try {
      if (!this.instance) {
        const { AsyncEntry } = await this.load();
        this.instance = new AsyncEntry('rocketmoney-mcp-local.session', this.account);
      }
      return this.instance;
    } catch { throw keychainError(); }
  }
  async get() {
    try { return await (await this.entry()).getPassword(); }
    catch { throw keychainError(); }
  }
  async set(value) {
    try {
      const entry = await this.entry();
      await entry.setPassword(value);
      if (await entry.getPassword() !== value) throw keychainError();
    } catch { throw keychainError(); }
  }
  async delete() {
    try {
      const entry = await this.entry();
      await entry.deleteCredential();
      // Do not trust a boolean alone: confirm the entry is absent.
      if (await entry.getPassword() !== null) throw keychainError();
    } catch { throw keychainError(); }
  }
}
