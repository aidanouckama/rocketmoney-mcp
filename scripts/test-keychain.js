// Opt-in OS integration test. Creates and removes ONLY a randomly named fake
// entry; never reads the default user session or calls Rocket Money.
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/session.js';
if (process.platform !== 'darwin') {
  console.log('Skipped: native Keychain test requires macOS.');
} else {
  const directory = await mkdtemp(join(tmpdir(), 'rocketmoney-keychain-test-'));
  const store = new SessionStore(directory, { backend: 'keychain' });
  try {
    await store.seed('TEST_ONLY_NOT_A_REAL_SESSION');
    assert.equal((await store.read()).cookie, 'tb.auth0.sid=TEST_ONLY_NOT_A_REAL_SESSION');
    await assert.rejects(stat(store.file), { code: 'ENOENT' });
    await store.clear();
    assert.equal(await store.read(), null);
    console.log('Native Keychain write/read/delete passed; no plaintext session was created.');
  } finally {
    // Do not swallow deletion errors or announce successful cleanup on failure.
    await store.keychain.delete();
    await rm(directory, { recursive: true, force: true });
  }
}
