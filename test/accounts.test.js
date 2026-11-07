import test from 'node:test';
import assert from 'node:assert/strict';
import { RocketMoneyClient } from '../src/client.js';
import { createHash } from 'node:crypto';
import { READ_DOCUMENTS } from '../src/operations.js';
import { storeFor, jsonResponse } from './helpers.js';

test('balances and liabilities retain cents, zero values, unknown fields and due dates', async t => {
  const store = await storeFor(t);
  const client = new RocketMoneyClient(store, { fetchImpl: async (_, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.operationName, 'AccountDetailPage');
    assert.equal(request.variables.id, 'Account:1');
    assert.deepEqual(Object.keys(request.variables), ['id']);
    assert.equal(request.query, READ_DOCUMENTS.AccountDetailPage);
    assert.ok(request.query.startsWith('query AccountDetailPage($id: ID!)'));
    assert.equal(/\bmutation\b/.test(request.query), false);
    assert.equal(request.extensions.persistedQuery.sha256Hash,
      createHash('sha256').update(request.query).digest('hex'));
    return jsonResponse({ account: { id: 'Account:1', currentBalance: 98765, available_balance: 0,
      masterAccount: { last_fetch: '2026-11-06T20:00:00Z' },
      liabilityDetails: { remainingStatementBalanceCents: 12345, remainingMinimumPaymentAmountCents: 0,
        adjustedNextPaymentDueDate: '2026-11-17' } } });
  }});
  const result = await client.accountDetail('Account:1');
  assert.equal(result.currentBalanceCents, 98765);
  assert.equal(result.availableBalanceCents, 0);
  assert.equal(result.creditLimitCents, null);
  assert.equal(result.liability.minimumPaymentCents, 0);
  assert.equal(result.liability.nextPaymentDueDate, '2026-11-17');
  assert.equal(result.currency, null);
  assert.equal(result.lastSync, '2026-11-06T20:00:00Z');
  assert.equal(result.source.liveCompatibilityVerified, true);
});

test('account deduplication retains identity and does not claim unproven completeness', async t => {
  const store = await storeFor(t);
  const node = { id: 'Account:1', name: 'Example', displayedBalance: 54321, customType: 'credit', masterAccount: { institution: { name: 'Example bank' }, status: 'connected' } };
  const client = new RocketMoneyClient(store, { fetchImpl: async () => jsonResponse({ viewer: {
    creditAccounts: { edges: [{ node }], pageInfo: { hasNextPage: false } }, otherAccounts: { edges: [{ node }] },
  } }) });
  const result = await client.accounts();
  assert.equal(result.count, 1);
  assert.equal(result.accounts[0].balanceCents, 54321);
  assert.equal(result.completeness, 'unknown');
  assert.equal(result.accounts[0].lastSync, null);
});

test('categories retain spending inclusion semantics; missing data is an error', async t => {
  const store = await storeFor(t);
  const client = new RocketMoneyClient(store, { fetchImpl: async () => jsonResponse({ viewer: { categories: [
    { __typename: 'TransactionCategory', id: 'Category:1', label: 'Transfer', categoryType: 'ignored', includeInSpending: false },
  ] } }) });
  const result = await client.categories();
  assert.equal(result.categories[0].includeInSpending, false);
  assert.equal(result.categories[0].includeInEarnings, null);
  client.fetchImpl = async () => jsonResponse({ viewer: {} });
  await assert.rejects(client.accounts(), { code: 'UPSTREAM_SCHEMA' });
  await assert.rejects(client.accountDetail('Account:1'), { code: 'UPSTREAM_SCHEMA' });
  await assert.rejects(client.categories(), { code: 'UPSTREAM_SCHEMA' });
});
