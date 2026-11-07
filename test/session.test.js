import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile, chmod, symlink, writeFile, unlink, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { SessionStore, normalizeCookie, rotateCookie } from '../src/session.js';
import { storeFor, FAKE } from './helpers.js';

test('storage is 0700/0600; status and expired state do not expose credentials', async t => {
  const store = await storeFor(t);
  assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(store.file)).mode & 0o777, 0o600);
  assert.equal((await store.read()).cookie, FAKE);
  assert.equal(JSON.stringify(await store.status()).includes('TEST_SECRET'), false);
  await store.clear();
  assert.equal((await store.status()).status, 'missing');
});

test('rejects insecure session files, symlinks and symlink directories', async t => {
  const store = await storeFor(t);
  await chmod(store.file, 0o644);
  await assert.rejects(store.read(), { code: 'UNSAFE_STORAGE' });
  await unlink(store.file);
  const target = join(dirname(store.directory), 'target');
  await writeFile(target, 'sensitive', { mode: 0o600 });
  await symlink(target, store.file);
  await assert.rejects(store.read(), { code: 'UNSAFE_STORAGE' });
  const linkedDir = join(dirname(store.directory), 'linked');
  await symlink(store.directory, linkedDir);
  await assert.rejects(new SessionStore(linkedDir).read(), { code: 'UNSAFE_STORAGE' });
  assert.equal(await readFile(target, 'utf8'), 'sensitive');
});

test('atomic saves leave no temp files and reseeding invalidates cursor keys', async t => {
  const store = await storeFor(t);
  const key = (await store.read()).cursorKey;
  await store.seed('new-fake-session');
  assert.notEqual((await store.read()).cursorKey, key);
  assert.deepEqual(await readdir(store.directory), ['session.json']);
});

test('cookie validation removes unrelated cookies and rejects control characters/duplicates', () => {
  assert.equal(normalizeCookie('fake'), 'tb.auth0.sid=fake');
  assert.equal(normalizeCookie('Cookie: unrelated=tracking; tb.auth0.sid=fake; AWSALB=sticky'), 'tb.auth0.sid=fake; AWSALB=sticky');
  for (const v of ['', 'abc\r\nheader: injected', 'tb.auth0.sid=a; tb.auth0.sid=b', 'x'.repeat(17000)]) {
    assert.throws(() => normalizeCookie(v), { code: 'INVALID_COOKIE' });
  }
});

test('rotation honors deletion, expiry and max-age precedence', () => {
  assert.equal(rotateCookie(FAKE, ['tb.auth0.sid=new; Secure; HttpOnly']), 'tb.auth0.sid=new');
  assert.equal(rotateCookie(FAKE, ['tb.auth0.sid=; Max-Age=0']), null);
  assert.equal(rotateCookie(FAKE, ['tb.auth0.sid=old; Expires=Thu, 01 Jan 1970 00:00:00 GMT']), null);
  assert.equal(rotateCookie(FAKE, ['tb.auth0.sid=new; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT']), 'tb.auth0.sid=new');
  assert.equal(rotateCookie(FAKE, ['unrelated=secret']), FAKE);
});

test('lock serializes multiple instances and releases after failure', async t => {
  const store = await storeFor(t);
  const second = new SessionStore(store.directory);
  const order = [];
  await Promise.all([
    store.withLock(async () => { order.push('start'); await new Promise(r => setTimeout(r, 70)); order.push('end'); }),
    second.withLock(async () => { order.push('second'); }),
  ]);
  assert.ok(order.indexOf('end') === order.indexOf('start') + 1);
  await assert.rejects(store.withLock(() => { throw new Error('failure'); }));
  await second.withLock(() => Promise.resolve());
});

test('a second process cannot use or forcibly unlock a live lock', async t => {
  const store = await storeFor(t);
  await store.withLock(async () => {
    await assert.rejects(store.unlock(), { code: 'SESSION_BUSY' });
    const moduleUrl = new URL('../src/session.js', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import {SessionStore} from ${JSON.stringify(moduleUrl)}; const s=new SessionStore(process.argv[1]); try { await s.withLock(async()=>{}, {waitMs:80}); process.exitCode=2; } catch(e) { process.stdout.write(e.code); }`, store.directory], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', c => output += c);
    assert.equal(await new Promise(r => child.on('close', r)), 0);
    assert.equal(output, 'SESSION_BUSY');
  });
});
