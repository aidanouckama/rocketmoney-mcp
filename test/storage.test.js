import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { defaultStateDirectory } from '../src/paths.js';
import { MacKeychain } from '../src/keychain.js';
import { SessionStore } from '../src/session.js';
import { atomicWrite } from '../src/private-file.js';
import { readSecret } from '../src/auth.js';
import { recoverLock } from '../src/lock.js';
import { storeFor, FAKE } from './helpers.js';

function fakeVault() {
  let secret = null;
  return { get: async () => secret, set: async value => { secret = value; }, delete: async () => { secret = null; } };
}

test('state paths follow macOS and Linux/XDG conventions; relative overrides and Windows fail', () => {
  assert.equal(defaultStateDirectory({ platform: 'darwin', home: '/example', env: {} }), '/example/Library/Application Support/rocketmoney-mcp-local');
  assert.equal(defaultStateDirectory({ platform: 'linux', home: '/example', env: {} }), '/example/.local/state/rocketmoney-mcp-local');
  assert.equal(defaultStateDirectory({ platform: 'linux', home: '/example', env: { XDG_STATE_HOME: '/state' } }), '/state/rocketmoney-mcp-local');
  assert.equal(defaultStateDirectory({ platform: 'linux', home: '/example', env: { XDG_STATE_HOME: 'relative' } }), '/example/.local/state/rocketmoney-mcp-local');
  assert.throws(() => defaultStateDirectory({ platform: 'linux', env: { ROCKETMONEY_STATE_DIR: 'relative' } }), { code: 'INVALID_CONFIG' });
  assert.throws(() => defaultStateDirectory({ platform: 'win32' }), { code: 'UNSUPPORTED_PLATFORM' });
});

test('new macOS sessions default to Keychain without writing plaintext', async t => {
  const base = await storeFor(t, false), keychain = fakeVault();
  const store = new SessionStore(base.directory, { platform: 'darwin', keychain });
  assert.equal(await store.backend(), 'keychain');
  await store.seed(FAKE);
  assert.equal((await store.read()).cookie, FAKE);
  await assert.rejects(fs.stat(store.file), { code: 'ENOENT' });
  assert.equal((await fs.readFile(store.marker, 'utf8')).includes('TEST_SECRET'), false);
  assert.equal((await store.status()).storage, 'keychain');
  await store.clear();
  assert.equal(await keychain.get(), null);
});

test('Keychain failures do not downgrade to plaintext', async t => {
  const base = await storeFor(t, false);
  const keychain = new MacKeychain(base.directory, { platform: 'darwin', load: async () => { throw new Error('SECRET backend error'); } });
  const store = new SessionStore(base.directory, { platform: 'darwin', keychain });
  await assert.rejects(store.seed(FAKE), e => e.code === 'KEYCHAIN_UNAVAILABLE' && !e.message.includes('SECRET'));
  await assert.rejects(fs.stat(store.file), { code: 'ENOENT' });
});

test('native adapter verifies writes and deletion instead of trusting success booleans', async () => {
  class Entry {
    secret = null;
    async getPassword() { return this.secret; }
    async setPassword(v) { this.secret = v; }
    async deleteCredential() { return true; } // Simulate buggy deletion.
  }
  const vault = new MacKeychain('/fictional', { platform: 'darwin', load: async () => ({ AsyncEntry: Entry }) });
  await vault.set('FAKE');
  assert.equal(await vault.get(), 'FAKE');
  await assert.rejects(vault.delete(), { code: 'KEYCHAIN_UNAVAILABLE' });
  vault.instance.setPassword = async () => {};
  await assert.rejects(vault.set('NEW_FAKE'), { code: 'KEYCHAIN_UNAVAILABLE' });
});

test('migration preserves session identity then removes plaintext; backend mismatch fails', async t => {
  const original = await storeFor(t);
  const row = await original.read(), keychain = fakeVault();
  const store = new SessionStore(original.directory, { platform: 'darwin', keychain });
  assert.equal(await store.backend(), 'file');
  await store.migrateKeychain();
  assert.equal(await store.backend(), 'keychain');
  assert.deepEqual(await store.read(), row);
  await assert.rejects(fs.stat(store.file), { code: 'ENOENT' });
  await assert.rejects(new SessionStore(store.directory, { backend: 'file', keychain }).read(), { code: 'STORAGE_MISMATCH' });
});

test('failed migration retains old credentials and interrupted migration can resume', async t => {
  const original = await storeFor(t), keychain = fakeVault();
  const store = new SessionStore(original.directory, { platform: 'darwin', keychain });
  const set = keychain.set;
  keychain.set = async () => { throw new Error('simulated failure'); };
  await assert.rejects(store.migrateKeychain());
  assert.equal((await original.read()).cookie, FAKE);
  keychain.set = set;
  await keychain.set(await fs.readFile(original.file, 'utf8'));
  await atomicWrite(store.directory, store.marker, JSON.stringify({ version: 1, backend: 'keychain' }));
  await assert.rejects(store.read(), { code: 'MIGRATION_REQUIRED' });
  await store.migrateKeychain();
  assert.equal((await store.read()).cookie, FAKE);
  await assert.rejects(fs.stat(store.file), { code: 'ENOENT' });
});

test('clearing an interrupted migration removes orphan Keychain credentials too', async t => {
  const original = await storeFor(t), keychain = fakeVault();
  const store = new SessionStore(original.directory, { platform: 'darwin', keychain });
  await atomicWrite(store.directory, store.migration, JSON.stringify({ version: 1, target: 'keychain' }));
  await keychain.set(await fs.readFile(store.file, 'utf8'));
  await store.clear();
  assert.equal(await keychain.get(), null);
  assert.equal(await store.read(), null);
  assert.deepEqual(await fs.readdir(store.directory), []);
});

for (const failure of ['write', 'sync', 'rename']) {
  test(`atomic ${failure} failure removes temporary files and preserves prior session`, async t => {
    const store = await storeFor(t), before = await fs.readFile(store.file, 'utf8');
    const io = { ...fs, open: async (...args) => {
      const h = await fs.open(...args);
      if (!String(args[0]).includes('.session-')) return h;
      return {
        close: () => h.close(),
        writeFile: async value => { await h.writeFile(value); if (failure === 'write') throw new Error('disk full'); },
        sync: async () => { if (failure === 'sync') throw new Error('sync failed'); await h.sync(); },
      };
    }, rename: async (...args) => { if (failure === 'rename') throw new Error('rename failed'); await fs.rename(...args); } };
    await assert.rejects(atomicWrite(store.directory, store.file, 'new-secret', io));
    assert.equal(await fs.readFile(store.file, 'utf8'), before);
    assert.deepEqual(await fs.readdir(store.directory), ['session.json']);
  });
}

test('crashed process lock is recovered and leftover temp files removed', async t => {
  const store = await storeFor(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import{SessionStore}from ${JSON.stringify(new URL('../src/session.js', import.meta.url).href)};await new SessionStore(process.argv[1],{backend:'file'}).withLock(async()=>{process.stdout.write('locked');await new Promise(()=>{setInterval(()=>{},1000)})});`, store.directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL'); await exited;
  await fs.writeFile(join(store.directory, '.session-' + 'a'.repeat(24)), 'orphan', { mode: 0o600 });
  await store.withLock(async () => assert.equal((await store.read()).cookie, FAKE));
  assert.deepEqual(await fs.readdir(store.directory), ['session.json']);
});

test('ownerless locks get a grace period and concurrent recovery cannot steal a fresh lock', async t => {
  const store = await storeFor(t);
  await fs.mkdir(store.lock, { mode: 0o700 });
  assert.equal(await recoverLock(store.lock), false);
  await fs.utimes(store.lock, new Date(0), new Date(0));
  await Promise.all([recoverLock(store.lock), recoverLock(store.lock)]);
  await store.withLock(async () => assert.equal(await recoverLock(store.lock), false));
});

for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP', 'end']) {
  test(`hidden import restores terminal and clears listeners after ${event}`, async () => {
    const input = new PassThrough(), signals = new EventEmitter(), output = new PassThrough();
    input.isTTY = true; input.isRaw = false; input.setRawMode = v => { input.isRaw = v; };
    let printed = ''; output.on('data', c => printed += c);
    const result = readSecret({ input, output, signals });
    input.write('FAKE_PRIVATE_INPUT');
    if (event === 'end') input.emit('end'); else signals.emit(event);
    await assert.rejects(result, { code: 'AUTH_CANCELLED' });
    assert.equal(input.isRaw, false);
    assert.equal(printed.includes('FAKE_PRIVATE_INPUT'), false);
    assert.equal(signals.eventNames().length, 0);
    assert.equal(input.listenerCount('data'), 0);
  });
}
