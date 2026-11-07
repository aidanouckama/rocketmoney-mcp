import { mkdir, lstat, open, unlink, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SafeError } from './errors.js';
import { privateError } from './private-file.js';

const missingOK = e => { if (e.code !== 'ENOENT') throw e; };
const busy = () => new SafeError('SESSION_BUSY', 'Another process holds the session lock. Retry, or stop connector processes and run rocketmoney-auth unlock.');
async function ownerPid(path) {
  let handle;
  try {
    handle = await open(join(path, 'owner'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32 || stat.uid !== process.getuid() || stat.nlink !== 1) throw privateError();
    const pid = Number(await handle.readFile('utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    return pid;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  finally { await handle?.close(); }
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; } // Access denied/unknown is not proof of death.
}
async function lockStat(path) {
  const stat = await lstat(path).catch(e => { missingOK(e); return null; });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid())) throw privateError();
  return stat;
}

// Recovery is serialized INSIDE the old lock. New acquirers cannot mkdir the
// lock while it contains the recovery guard. Recheck inode and PID under guard.
// A contender recreating the guard during final rmdir makes rmdir fail safely.
export async function recoverLock(path, { graceMs = 30000 } = {}) {
  const before = await lockStat(path);
  if (!before) return true;
  const pid = await ownerPid(path);
  if (alive(pid) || (!pid && Date.now() - before.mtimeMs < graceMs)) return false;
  const guard = join(path, 'recovery');
  try { await mkdir(guard, { mode: 0o700 }); }
  catch (e) { if (['EEXIST', 'ENOENT'].includes(e.code)) return false; throw e; }
  try {
    const current = await lockStat(path);
    if (!current || before.ino !== current.ino || before.dev !== current.dev || alive(await ownerPid(path))) return false;
    await unlink(join(path, 'owner')).catch(missingOK);
  } finally { await rmdir(guard); }
  try { await rmdir(path); return true; }
  catch (e) { if (['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(e.code)) return false; throw e; }
}

export async function withSessionLock(path, fn, { signal, waitMs = 10000 } = {}) {
  const started = Date.now();
  while (true) {
    signal?.throwIfAborted();
    try { await mkdir(path, { mode: 0o700 }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (await recoverLock(path)) continue;
      if (Date.now() - started >= waitMs) throw busy();
      await delay(40, undefined, { signal });
    }
  }
  try {
    const owner = await open(join(path, 'owner'), 'wx', 0o600);
    try { await owner.writeFile(String(process.pid)); await owner.sync(); } finally { await owner.close(); }
    return await fn();
  } finally {
    await unlink(join(path, 'owner')).catch(missingOK);
    await rmdir(path);
  }
}
