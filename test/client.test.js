import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RocketMoneyClient } from '../src/client.js';
import { publicError } from '../src/errors.js';
import { SessionStore } from '../src/session.js';
import { storeFor, FAKE, jsonResponse, transaction, page, filters } from './helpers.js';

test('reads 1,401 transactions over eight pages with no silent global cap', async t => {
  const store = await storeFor(t);
  const calls = [];
  const client = new RocketMoneyClient(store, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://client-api.rocketmoney.com/graphql');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.cookie, FAKE);
    const body = JSON.parse(options.body);
    assert.equal(body.operationName, 'TransactionsPageTransactionTable');
    assert.equal(body.query, undefined);
    assert.equal(body.variables.ltDate, filters.before);
    calls.push(body.variables.cursor);
    const start = body.variables.cursor ? Number(body.variables.cursor) : 0;
    const end = Math.min(start + 200, 1401);
    return jsonResponse(page(Array.from({ length: end-start }, (_, i) => transaction(start+i)), end < 1401, String(end)));
  }});
  let cursor, count = 0, last;
  do {
    last = await client.transactions({ ...filters, ...(cursor ? { cursor } : {}) });
    count += last.count;
    cursor = last.pagination.nextCursor;
  } while (cursor);
  assert.equal(count, 1401);
  assert.equal(calls.length, 8);
  assert.equal(last.pagination.endReached, true);
  assert.equal(last.pagination.windowCompleteInThisResponse, false);
});

test('empty windows require explicit pagination metadata', async t => {
  const store = await storeFor(t);
  const client = new RocketMoneyClient(store, { fetchImpl: async () => jsonResponse(page([])) });
  const result = await client.transactions(filters);
  assert.equal(result.count, 0);
  assert.equal(result.pagination.windowCompleteInThisResponse, true);
  client.fetchImpl = async () => jsonResponse({ viewer: {} });
  await assert.rejects(client.transactions(filters), { code: 'UPSTREAM_SCHEMA' });
});

test('cursor cannot be tampered with, reused with different filters or after reauth', async t => {
  const store = await storeFor(t);
  let calls = 0;
  const client = new RocketMoneyClient(store, { fetchImpl: async () => { calls++; return jsonResponse(page([transaction(1)], true, 'next')); } });
  const cursor = (await client.transactions(filters)).pagination.nextCursor;
  for (const args of [{ ...filters, cursor: cursor + 'x' }, { ...filters, cursor, since: '2026-10-01' }, { ...filters, cursor, account_ids: ['other'] }]) {
    await assert.rejects(client.transactions(args), { code: 'INVALID_CURSOR' });
  }
  await store.seed('replacement');
  await assert.rejects(client.transactions({ ...filters, cursor }), { code: 'INVALID_CURSOR' });
  assert.equal(calls, 1);
});

test('missing/stalled cursors and ambiguous connections fail rather than claiming completion', async t => {
  const store = await storeFor(t);
  const client = new RocketMoneyClient(store, { fetchImpl: async () => jsonResponse(page([transaction(1)], true, null)) });
  await assert.rejects(client.transactions(filters), { code: 'PAGINATION_STALLED' });
  client.fetchImpl = async () => jsonResponse(page([transaction(1)], true, 'same'));
  const cursor = (await client.transactions(filters)).pagination.nextCursor;
  await assert.rejects(client.transactions({ ...filters, cursor }), { code: 'PAGINATION_STALLED' });
  client.fetchImpl = async () => jsonResponse({ ...page([transaction(1)]), otherTransactions: page([transaction(2)]).viewer.transactions });
  await assert.rejects(client.transactions(filters), { code: 'UPSTREAM_SCHEMA' });
});

test('unrelated pageInfo does not control transaction pagination', async t => {
  const store = await storeFor(t);
  const client = new RocketMoneyClient(store, { fetchImpl: async () => jsonResponse({
    unrelated: { pageInfo: { hasNextPage: false } }, ...page([transaction(1)], true, 'next'),
  }) });
  assert.equal((await client.transactions(filters)).pagination.hasMore, true);
});

test('preserves flags, integer amounts and account ids; missing metadata stays unknown', async t => {
  const store = await storeFor(t);
  const client = new RocketMoneyClient(store, { fetchImpl: async () => jsonResponse(page([
    transaction(1, { amount: -345, pending: true, isExcluded: false, isTransfer: true, currencyCode: 'USD', transactionStatus: 'pending-review', status: 'legacy', category: { label: 'Transfer', includeInSpending: false } }),
    transaction(2), transaction(2),
  ])) });
  const result = await client.transactions(filters);
  assert.equal(result.count, 2);
  assert.equal(result.transactions[0].amountCents, -345);
  assert.equal(result.transactions[0].pending, true);
  assert.equal(result.transactions[0].sourceStatus, 'pending-review');
  assert.equal(result.transactions[1].sourceStatus, null);
  assert.equal(result.transactions[0].excluded, false);
  assert.equal(result.transactions[0].transfer, true);
  assert.equal(result.transactions[0].category.includeInSpending, false);
  assert.equal(result.transactions[0].account.id, 'Account:1');
  assert.equal(result.transactions[1].pending, null);
  assert.equal(result.transactions[1].currency, null);
  assert.equal(result.transactions[1].excluded, null);
});

test('rejects filter mismatches and malformed amounts instead of silently dropping rows', async t => {
  const store = await storeFor(t);
  const client = new RocketMoneyClient(store, { fetchImpl: async () => jsonResponse(page([transaction(1, { date: '2026-12-01' })])) });
  await assert.rejects(client.transactions(filters), { code: 'FILTER_MISMATCH' });
  client.fetchImpl = async () => jsonResponse(page([transaction(1)]));
  await assert.rejects(client.transactions({ ...filters, account_ids: ['wrong'] }), { code: 'FILTER_MISMATCH' });
  client.fetchImpl = async () => jsonResponse(page([transaction(1, { amount: 1.01 })]));
  await assert.rejects(client.transactions(filters), { code: 'UPSTREAM_SCHEMA' });
});

test('missing credentials and arbitrary GraphQL mutations cause no network requests', async t => {
  const store = await storeFor(t, false);
  let calls = 0;
  const client = new RocketMoneyClient(store, { fetchImpl: async () => { calls++; throw new Error(); } });
  await assert.rejects(client.accounts(), { code: 'AUTH_REQUIRED' });
  await assert.rejects(client.request('UpdateSubscription', {}), { code: 'READ_ONLY' });
  await assert.rejects(client.request('toString', {}), { code: 'READ_ONLY' });
  assert.equal(calls, 0);
});

for (const status of [401, 403, 302]) {
  test(`HTTP ${status} clears credentials and never follows a redirect`, async t => {
    const store = await storeFor(t);
    let calls = 0;
    const client = new RocketMoneyClient(store, { fetchImpl: async (_, opts) => {
      calls++; assert.equal(opts.redirect, 'manual');
      return new Response('private upstream text', { status, headers: { location: 'https://untrusted.invalid/' } });
    } });
    await assert.rejects(client.verify(), { code: 'AUTH_REQUIRED' });
    await assert.rejects(client.verify(), { code: 'AUTH_REQUIRED' });
    assert.equal(calls, 1);
    assert.equal((await store.read()).cookie, null);
    assert.equal((await readFile(store.file, 'utf8')).includes('TEST_SECRET'), false);
  });
}

test('cookie rotation is serialized across clients sharing the same store', async t => {
  const store = await storeFor(t);
  let calls = 0;
  const fakeFetch = async (_, opts) => {
    const call = ++calls;
    assert.equal(opts.headers.cookie, call === 1 ? FAKE : `tb.auth0.sid=rotated-${call-1}`);
    await new Promise(r => setTimeout(r, 15));
    return jsonResponse({ viewer: { id: 'fake-viewer' } }, { headers: { 'set-cookie': `tb.auth0.sid=rotated-${call}; Secure; HttpOnly` } });
  };
  const a = new RocketMoneyClient(store, { fetchImpl: fakeFetch });
  const b = new RocketMoneyClient(new SessionStore(store.directory), { fetchImpl: fakeFetch });
  await Promise.all([a.verify(), b.verify()]);
  assert.equal((await store.read()).cookie, 'tb.auth0.sid=rotated-2');
  assert.ok((await store.status()).verifiedAt);
});

test('a deleted session cookie stops requests even on a 200 response', async t => {
  const store = await storeFor(t);
  const client = new RocketMoneyClient(store, { fetchImpl: async () => jsonResponse({ viewer: { id: 'fake' } }, { headers: { 'set-cookie': 'tb.auth0.sid=; Max-Age=0' } }) });
  await assert.rejects(client.verify(), { code: 'AUTH_REQUIRED' });
  assert.equal((await store.read()).cookie, null);
});

test('timeouts release the lock and do not poison later requests', async t => {
  const store = await storeFor(t);
  const client = new RocketMoneyClient(store, { timeoutMs: 50, fetchImpl: async (_, { signal }) =>
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('test guard')), 1000); signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); }) });
  await assert.rejects(client.verify(), { code: 'REQUEST_CANCELLED' });
  // The retry checks recovery, not disk speed on a shared CI runner.
  client.timeoutMs = 20000;
  client.fetchImpl = async () => jsonResponse({ viewer: { id: 'fake' } });
  assert.equal((await client.verify()).authenticated, true);
});

test('query failures with partial data do not leak upstream messages or cookies', async t => {
  const store = await storeFor(t);
  const client = new RocketMoneyClient(store, { fetchImpl: async () => new Response(JSON.stringify({
    errors: [{ message: `PersistedQueryNotFound ${FAKE}` }], data: page([transaction(1)]),
  })) });
  try { await client.transactions(filters); assert.fail(); }
  catch (e) { assert.equal(e.code, 'QUERY_OUTDATED'); assert.equal(JSON.stringify(publicError(e)).includes('TEST_SECRET'), false); }
  client.fetchImpl = async () => { throw new Error(`network failed ${FAKE}`); };
  await assert.rejects(client.verify(), { code: 'REQUEST_FAILED' });
});

test('rate limits, non-JSON responses and oversized responses fail explicitly', async t => {
  const store = await storeFor(t);
  const client = new RocketMoneyClient(store, { fetchImpl: async () => new Response('slow down', { status: 429 }) });
  await assert.rejects(client.verify(), { code: 'RATE_LIMITED' });
  client.fetchImpl = async () => new Response('<html>private</html>');
  await assert.rejects(client.verify(), { code: 'UPSTREAM_FORMAT' });
  client.fetchImpl = async () => new Response('{}', { headers: { 'content-length': String(9 * 1024 * 1024) } });
  await assert.rejects(client.verify(), { code: 'RESPONSE_TOO_LARGE' });
});
