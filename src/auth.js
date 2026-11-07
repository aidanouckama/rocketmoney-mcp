import { pathToFileURL } from 'node:url';
import { SessionStore } from './session.js';
import { RocketMoneyClient } from './client.js';
import { SafeError, publicError } from './errors.js';

export async function readSecret({ piped = false, input = process.stdin, output = process.stderr, signals = process } = {}) {
  if (piped) {
    if (input.isTTY) throw new SafeError('AUTH_INPUT', 'Use the hidden prompt without --stdin when typing in a terminal.');
    const chunks = [];
    let size = 0;
    for await (const chunk of input) {
      size += chunk.length;
      if (size > 16386) throw new SafeError('INVALID_COOKIE', 'Session input exceeds 16 KiB.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  if (!input.isTTY || !input.setRawMode) throw new SafeError('AUTH_INPUT', 'Run the import command in your terminal for a hidden prompt, or supply input through --stdin. Never pass a cookie as a command argument.');
  output.write('Paste the Rocket Money session cookie (hidden), then press Enter: ');
  const priorRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let secret = '';
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onEnd);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) signals.off(signal, onEnd);
      try { input.setRawMode(priorRaw); }
      catch { error ??= new SafeError('AUTH_CANCELLED', 'The terminal disconnected; session import cancelled.'); }
      input.pause();
      output.write('\n');
      if (error) reject(error); else resolve(secret);
      secret = '';
    };
    const onEnd = () => finish(new SafeError('AUTH_CANCELLED', 'Session import cancelled.'));
    const onData = chunk => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\u0003' || ch === '\u0004') return onEnd();
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u007f' || ch === '\b') secret = secret.slice(0, -1);
        else secret += ch;
        if (secret.length > 16384) return finish(new SafeError('INVALID_COOKIE', 'Session input exceeds 16 KiB.'));
      }
    };
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onEnd);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) signals.once(signal, onEnd);
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    process.stdout.write('rocketmoney-auth import [--stdin] | status | verify | clear | unlock | migrate-keychain\nDefault: macOS Keychain; Linux private file. Set ROCKETMONEY_STORAGE=file explicitly for file storage.\n');
    return;
  }
  const [command, ...flags] = args;
  if (!['import', 'status', 'verify', 'clear', 'unlock', 'migrate-keychain'].includes(command) ||
      flags.some(f => f !== '--stdin') || flags.length > 1 || (flags.length && command !== 'import')) {
    throw new SafeError('USAGE', 'Usage: rocketmoney-auth import [--stdin] | status | verify | clear | unlock | migrate-keychain. Cookies are never accepted as arguments.');
  }
  const store = new SessionStore();
  switch (command) {
    case 'import':
      await store.seed(await readSecret({ piped: flags.includes('--stdin') }));
      process.stdout.write('Session saved privately. Run rocketmoney-auth verify to test the connection.\n');
      break;
    case 'status': process.stdout.write(`${JSON.stringify(await store.status(), null, 2)}\n`); break;
    case 'verify': process.stdout.write(`${JSON.stringify(await new RocketMoneyClient(store).verify(), null, 2)}\n`); break;
    case 'clear': await store.clear(); process.stdout.write('Local session removed. This does not revoke the browser session at Rocket Money.\n'); break;
    case 'unlock': await store.unlock(); process.stdout.write('No stale session lock remains.\n'); break;
    case 'migrate-keychain': await store.migrateKeychain(); process.stdout.write('Session verified in Keychain; the old plaintext session file was removed.\n'); break;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
    process.exitCode = 1;
  });
}
