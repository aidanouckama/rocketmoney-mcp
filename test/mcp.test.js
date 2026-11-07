import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { transactionsSchema } from '../src/server.js';
import { storeFor } from './helpers.js';

test('real SDK client launches stdio, lists only reads and receives safe missing-auth errors', async t => {
  const store = await storeFor(t, false);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../bin/rocketmoney-mcp.js', import.meta.url))],
    env: { ROCKETMONEY_STORAGE: 'file', ROCKETMONEY_STATE_DIR: store.directory, PATH: process.env.PATH }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', c => stderr += c);
  const client = new Client({ name: 'connector-security-test', version: '1.0.0' });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  const list = await client.listTools();
  assert.deepEqual(list.tools.map(t => t.name).sort(), ['session_status', 'verify_connection', 'list_accounts', 'get_account', 'list_categories', 'list_transactions'].sort());
  assert.ok(list.tools.every(tool => tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false));
  const status = await client.callTool({ name: 'session_status', arguments: {} });
  assert.equal(status.structuredContent.status, 'missing');
  const accounts = await client.callTool({ name: 'list_accounts', arguments: {} });
  assert.equal(accounts.isError, true);
  assert.equal(accounts.structuredContent.error.code, 'AUTH_REQUIRED');
  const invalid = await client.callTool({ name: 'list_transactions', arguments: { since: '2026-02-30', before: '2026-12-01' } });
  assert.equal(invalid.isError, true);
  assert.equal(stderr, '');
});

test('2025 MCP clients can initialize and call tools without modern metadata', async t => {
  const store = await storeFor(t, false);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url))], {
    env: { PATH: process.env.PATH, ROCKETMONEY_STORAGE: 'file', ROCKETMONEY_STATE_DIR: store.directory }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', c => {
    buffer += c;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`MCP request timed out: ${method}`)), 4000);
    pending.set(id, m => { clearTimeout(timeout); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const initialized = await request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1' } });
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const result = await request(2, 'tools/call', { name: 'session_status', arguments: {} });
  assert.equal(result.result.structuredContent.status, 'missing');
  child.stdin.end();
});

test('tool input rejects impossible dates, oversized scans and arbitrary arguments', () => {
  const good = { since: '2026-11-01', before: '2026-12-01' };
  assert.equal(transactionsSchema.safeParse(good).success, true);
  for (const value of [
    { ...good, since: '2026-02-30' }, { ...good, before: good.since },
    { ...good, page_size: 100000 }, { ...good, query: '\r\n' },
    { ...good, cookie: 'not-accepted' }, { ...good, operation: 'mutation' },
  ]) assert.equal(transactionsSchema.safeParse(value).success, false);
});

test('auth CLI refuses command-line cookies and never echoes them', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/auth.js', import.meta.url)), 'import', 'VERY_PRIVATE_FAKE_COOKIE'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', c => output += c);
  child.stderr.on('data', c => output += c);
  assert.equal(await new Promise(r => child.on('close', r)), 1);
  assert.equal(output.includes('VERY_PRIVATE_FAKE_COOKIE'), false);
  assert.ok(output.includes('USAGE'));
});
