import { mkdir, lstat, chmod, unlink, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { SafeError } from './errors.js';
import { defaultStateDirectory } from './paths.js';
import { readPrivate, atomicWrite, privateError } from './private-file.js';
import { MacKeychain } from './keychain.js';
import { withSessionLock, recoverLock } from './lock.js';

const MAX_COOKIE_BYTES = 16384;
const ALLOWED_COOKIES = new Set(['tb.auth0.sid', 'AWSALB', 'AWSALBCORS']);

export function normalizeCookie(input) {
  if (typeof input !== 'string' || input.length > MAX_COOKIE_BYTES || /[^\x20-\x7e]/.test(input)) {
    throw new SafeError('INVALID_COOKIE', 'Paste a single-line session value or Cookie header, at most 16 KiB.');
  }
  let value = input.trim().replace(/^cookie:\s*/i, '');
  if (!value.includes('tb.auth0.sid=')) value = `tb.auth0.sid=${value}`;
  const jar = new Map();
  for (const pair of value.split(';')) {
    const i = pair.indexOf('=');
    if (i < 1) throw new SafeError('INVALID_COOKIE', 'Invalid Cookie header.');
    const name = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (!ALLOWED_COOKIES.has(name)) continue;
    if (jar.has(name) || !v || /[\s;,]/.test(v)) throw new SafeError('INVALID_COOKIE', 'Invalid or duplicate session cookie.');
    jar.set(name, v);
  }
  if (!jar.get('tb.auth0.sid')) throw new SafeError('INVALID_COOKIE', 'The tb.auth0.sid session cookie is required.');
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

export function rotateCookie(cookie, headers, now = Date.now()) {
  const jar = new Map(cookie.split('; ').map(p => {
    const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)];
  }));
  for (const header of headers) {
    if (typeof header !== 'string' || header.length > MAX_COOKIE_BYTES) continue;
    const parts = header.split(';').map(p => p.trim());
    const i = parts[0].indexOf('=');
    const name = parts[0].slice(0, i);
    if (i < 1 || !ALLOWED_COOKIES.has(name)) continue;
    const value = parts[0].slice(i + 1);
    const attrs = new Map(parts.slice(1).map(p => {
      const eq = p.indexOf('=');
      return [p.slice(0, eq < 0 ? p.length : eq).toLowerCase(), eq < 0 ? '' : p.slice(eq + 1)];
    }));
    const maxAge = attrs.has('max-age') ? Number(attrs.get('max-age')) : null;
    const expires = Date.parse(attrs.get('expires') ?? '');
    const deleted = !value || value.toLowerCase() === 'deleted' ||
      (maxAge !== null && Number.isFinite(maxAge) ? maxAge <= 0 : Number.isFinite(expires) && expires <= now);
    if (deleted) jar.delete(name);
    else {
      if (/[^\x21-\x7e]|[;,]/.test(value)) throw new SafeError('UPSTREAM_SCHEMA', 'Invalid session rotation received. Reconnect your session.');
      jar.set(name, value);
    }
  }
  if (!jar.has('tb.auth0.sid')) return null;
  return normalizeCookie([...jar].map(([k, v]) => `${k}=${v}`).join('; '));
}

export class SessionStore {
  constructor(directory = defaultStateDirectory(), { backend = process.env.ROCKETMONEY_STORAGE, platform = process.platform, keychain } = {}) {
    if (!['darwin', 'linux'].includes(platform)) throw new SafeError('UNSUPPORTED_PLATFORM', 'Supported platforms: macOS and Linux.');
    if (backend && !['file', 'keychain'].includes(backend)) throw new SafeError('INVALID_CONFIG', 'ROCKETMONEY_STORAGE must be file or keychain.');
    if (backend === 'keychain' && platform !== 'darwin') throw new SafeError('INVALID_CONFIG', 'Keychain storage requires macOS. Use file storage on Linux.');
    this.platform = platform;
    this.requestedBackend = backend;
    this.directory = resolve(directory);
    this.file = join(this.directory, 'session.json');
    this.marker = join(this.directory, 'storage.json');
    this.migration = join(this.directory, 'migration.json');
    this.lock = join(this.directory, '.lock');
    this.keychain = keychain ?? new MacKeychain(this.directory, { platform });
  }

  async ensure() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw privateError();
    if ((stat.mode & 0o777) !== 0o700) await chmod(this.directory, 0o700);
  }

  async backend() {
    await this.ensure();
    const marker = await readPrivate(this.marker);
    if (marker !== null) {
      let stored;
      try { stored = JSON.parse(marker); } catch { throw new SafeError('INVALID_STATE', 'Storage configuration is invalid.'); }
      if (stored.version !== 1 || stored.backend !== 'keychain') throw new SafeError('INVALID_STATE', 'Storage configuration is invalid.');
      if (this.requestedBackend && this.requestedBackend !== stored.backend) throw new SafeError('STORAGE_MISMATCH', 'This session uses Keychain. Clear it with Keychain selected before switching storage backends.');
      return stored.backend;
    }
    if (this.requestedBackend) return this.requestedBackend;
    // Compatibility with pre-Keychain installs: do not lose an existing session
    // or silently migrate while an older connector process may still be using it.
    if (await readPrivate(this.file) !== null) return 'file';
    return this.platform === 'darwin' ? 'keychain' : 'file';
  }

  parse(raw) {
    if (raw === null) return null;
    let row;
    try { row = JSON.parse(raw); } catch { throw new SafeError('INVALID_STATE', 'Session storage is invalid. Import a fresh session.'); }
    if (row.version !== 1 || !['active', 'expired'].includes(row.status) || !/^[a-f0-9]{64}$/.test(row.cursorKey ?? '') || typeof row.updatedAt !== 'string') {
      throw new SafeError('INVALID_STATE', 'Session storage is invalid. Import a fresh session.');
    }
    if (row.status === 'active') row.cookie = normalizeCookie(row.cookie);
    return row;
  }

  async read() {
    const backend = await this.backend();
    if (backend === 'file') return this.parse(await readPrivate(this.file));
    if (await readPrivate(this.file) !== null) throw new SafeError('MIGRATION_REQUIRED', 'A file session still exists. Stop older connector processes and run rocketmoney-auth migrate-keychain to finish migration.');
    return this.parse(await this.keychain.get());
  }

  // Caller holds withLock for every read-modify-write operation.
  async write(row) {
    const backend = await this.backend();
    if (backend === 'file') return atomicWrite(this.directory, this.file, JSON.stringify(row));
    if (await readPrivate(this.file) !== null) throw new SafeError('MIGRATION_REQUIRED', 'Migrate the existing file session before using Keychain.');
    await atomicWrite(this.directory, this.marker, JSON.stringify({ version: 1, backend: 'keychain' }));
    await this.keychain.set(JSON.stringify(row));
  }

  async withLock(fn, options) {
    await this.ensure();
    return withSessionLock(this.lock, async () => {
      // Old temporary files can only belong to a finished/crashed writer while
      // this process owns the lock. Never follow symlinks or remove other files.
      for (const name of await readdir(this.directory)) {
        if (!/^\.session-[a-f0-9]{24}$/.test(name)) continue;
        const path = join(this.directory, name), stat = await lstat(path);
        if (stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1) await unlink(path);
      }
      return fn();
    }, options);
  }

  async seed(cookie) {
    const normalized = normalizeCookie(cookie);
    return this.withLock(() => this.write({ version: 1, status: 'active', cookie: normalized,
      cursorKey: randomBytes(32).toString('hex'), updatedAt: new Date().toISOString(), verifiedAt: null }));
  }

  async clear() {
    return this.withLock(async () => {
      if (await this.backend() === 'keychain' || await readPrivate(this.migration) !== null) await this.keychain.delete();
      await unlink(this.file).catch(e => { if (e.code !== 'ENOENT') throw e; });
      await unlink(this.marker).catch(e => { if (e.code !== 'ENOENT') throw e; });
      await unlink(this.migration).catch(e => { if (e.code !== 'ENOENT') throw e; });
    });
  }

  async status() {
    const backend = await this.backend();
    const row = await this.read();
    return { status: row?.status ?? 'missing', verifiedAt: row?.verifiedAt ?? null,
      updatedAt: row?.updatedAt ?? null, readOnly: true, transport: 'stdio', storage: backend,
      migrationAvailable: this.platform === 'darwin' && backend === 'file',
      authentication: 'browser_session_cookie', liveCheckPerformed: false };
  }

  async migrateKeychain() {
    if (this.platform !== 'darwin') throw new SafeError('UNSUPPORTED_PLATFORM', 'Keychain migration requires macOS.');
    return this.withLock(async () => {
      const legacy = await readPrivate(this.file);
      if (legacy === null) {
        if (await readPrivate(this.marker) !== null) {
          if (!this.parse(await this.keychain.get())) throw new SafeError('AUTH_REQUIRED', 'No Keychain session was found.');
          await unlink(this.migration).catch(e => { if (e.code !== 'ENOENT') throw e; });
          return;
        }
        throw new SafeError('AUTH_REQUIRED', 'No existing file session to migrate.');
      }
      const row = this.parse(legacy);
      // Journal BEFORE writing Keychain, so clear can remove an orphan entry if
      // the process dies before the backend marker is committed.
      await atomicWrite(this.directory, this.migration, JSON.stringify({ version: 1, target: 'keychain' }));
      await this.keychain.set(JSON.stringify(row)); // Adapter verifies round trip.
      await atomicWrite(this.directory, this.marker, JSON.stringify({ version: 1, backend: 'keychain' }));
      // Delete plaintext only after Keychain write AND durable marker succeed.
      await unlink(this.file);
      await unlink(this.migration);
      this.requestedBackend = undefined;
    });
  }

  async unlock() {
    await this.ensure();
    if (!await recoverLock(this.lock)) throw new SafeError('SESSION_BUSY', 'The lock has a live/unknown owner or is being recovered. Stop connector processes, wait 30 seconds and retry. Never delete a live lock.');
  }
}
