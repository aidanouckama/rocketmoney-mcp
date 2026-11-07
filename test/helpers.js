import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session.js';
export const FAKE = 'tb.auth0.sid=TEST_SECRET_NOT_A_REAL_COOKIE';
export async function storeFor(t, seeded = true) {
  const base = await mkdtemp(join(tmpdir(), 'rocketmoney-local-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const store = new SessionStore(join(base, 'state'), { backend: 'file' });
  if (seeded) await store.seed(FAKE);
  return store;
}
export const jsonResponse = (data, options = {}) => new Response(JSON.stringify({ data }), { status: 200, ...options });
export const transaction = (id, extra = {}) => ({
  __typename: 'Transaction', id: String(id), amount: 1234, date: '2026-11-02',
  longName: 'Example merchant', account: { id: 'Account:1', name: 'Example card' }, ...extra,
});
export const page = (nodes, hasNextPage = false, endCursor = null) => ({
  viewer: { transactions: { edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage, endCursor } } },
});
export const filters = { since: '2026-11-01', before: '2026-12-01', page_size: 200 };
