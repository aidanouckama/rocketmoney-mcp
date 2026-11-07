import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SafeError } from './errors.js';

export const privateError = () => new SafeError('UNSAFE_STORAGE', 'Session storage must be owned by you, private, and free of symbolic links.');
export async function readPrivate(file) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 32768) throw privateError();
    return await handle.readFile('utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e.code === 'ELOOP') throw privateError();
    throw e;
  } finally { await handle?.close(); }
}

// io injection is only for failure-path tests. No tool input controls it.
export async function atomicWrite(directory, file, value, io = fs) {
  const temp = join(directory, `.session-${randomBytes(12).toString('hex')}`);
  let handle;
  try {
    handle = await io.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(value);
    await handle.sync();
    await handle.close(); handle = undefined;
    await io.rename(temp, file);
    const dir = await io.open(directory, constants.O_RDONLY);
    try { await dir.sync(); } finally { await dir.close(); }
  } finally {
    try { await handle?.close(); }
    finally { await io.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
}
