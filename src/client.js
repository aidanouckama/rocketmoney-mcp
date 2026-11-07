import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { OPERATIONS, READ_DOCUMENTS, SOURCE } from './operations.js';
import { rotateCookie } from './session.js';
import { SafeError } from './errors.js';
import { transactionConnection, shapeTransaction, shapeAccounts, shapeAccountDetail, shapeCategories, schemaError } from './shapes.js';

const URL = 'https://client-api.rocketmoney.com/graphql';
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function fingerprint(filters) {
  return createHash('sha256').update(JSON.stringify(filters)).digest('hex');
}
function encodeCursor(cursor, filters, key) {
  const payload = Buffer.from(JSON.stringify({ v: 1, cursor, filters: fingerprint(filters) })).toString('base64url');
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}
function decodeCursor(token, filters, key) {
  if (!token) return null;
  try {
    if (token.length > 8192) throw new Error();
    const [payload, mac, extra] = token.split('.');
    if (!payload || !mac || extra) throw new Error();
    const expected = createHmac('sha256', key).update(payload).digest();
    const received = Buffer.from(mac, 'base64url');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error();
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (decoded.v !== 1 || decoded.filters !== fingerprint(filters) || typeof decoded.cursor !== 'string' || !decoded.cursor || decoded.cursor.length > 4096) throw new Error();
    return decoded.cursor;
  } catch { throw new SafeError('INVALID_CURSOR', 'Use the returned nextCursor with the same filters and session. Start again after importing a new session.'); }
}

async function readJson(response) {
  if (!response.body) throw schemaError();
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    await response.body.cancel();
    throw new SafeError('RESPONSE_TOO_LARGE', 'Upstream response exceeded the 8 MiB limit. Use a smaller page size.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new SafeError('RESPONSE_TOO_LARGE', 'Upstream response exceeded the 8 MiB limit. Use a smaller page size.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SafeError('UPSTREAM_FORMAT', 'Rocket Money returned a non-JSON response. Reconnect or check for an upstream API change.'); }
}

export class RocketMoneyClient {
  constructor(store, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(operation, variables, options = {}) {
    if (!Object.hasOwn(OPERATIONS, operation)) throw new SafeError('READ_ONLY', 'This connector only supports its fixed read-operation allowlist.');
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
    try {
      return await this.store.withLock(async () => {
        const row = await this.store.read();
        if (!row || row.status !== 'active') throw new SafeError('AUTH_REQUIRED', 'Import a Rocket Money session locally with: rocketmoney-auth import. Never paste credentials into chat.');
        const vars = typeof variables === 'function' ? variables(row) : variables;
        const response = await this.fetchImpl(URL, {
          method: 'POST', redirect: 'manual', signal,
          headers: { accept: 'application/graphql+json, application/json', 'content-type': 'application/json',
            origin: 'https://app.rocketmoney.com', referer: 'https://app.rocketmoney.com/',
            'x-truebill-web-client-version': '44836e2b0b',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
            cookie: row.cookie },
          body: JSON.stringify({ operationName: operation, variables: vars ?? {},
            ...(Object.hasOwn(READ_DOCUMENTS, operation) ? { query: READ_DOCUMENTS[operation] } : {}),
            extensions: { persistedQuery: { version: 1, sha256Hash: OPERATIONS[operation] } } }),
        });
        // Save rotation even on a GraphQL/rate-limit error; never retain a deleted
        // authentication cookie. Persist before consuming a potentially slow body.
        const rotated = rotateCookie(row.cookie, response.headers.getSetCookie?.() ?? []);
        const expired = !rotated || [401, 403].includes(response.status) || (response.status >= 300 && response.status < 400);
        const updated = { ...row, cookie: expired ? null : rotated, status: expired ? 'expired' : 'active', updatedAt: new Date().toISOString() };
        await this.store.write(updated);
        if (expired) {
          await response.body?.cancel();
          throw new SafeError('AUTH_REQUIRED', 'Rocket Money rejected or expired the session. Import a fresh browser session locally.');
        }
        if (response.status === 429) {
          await response.body?.cancel();
          throw new SafeError('RATE_LIMITED', 'Rocket Money rate limited this request. Wait before retrying the same page.');
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new SafeError('UPSTREAM_HTTP', 'Rocket Money returned an unsuccessful HTTP response. Retry later.');
        }
        const json = await readJson(response);
        if (json.errors?.length) {
          if (json.errors.some(e => e?.extensions?.code === 'UNAUTHENTICATED' || /unauthenticated|unauthorized|not authenticated/i.test(e?.message ?? ''))) {
            await this.store.write({ ...updated, cookie: null, status: 'expired' });
            throw new SafeError('AUTH_REQUIRED', 'Rocket Money authentication expired. Import a fresh session locally.');
          }
          if (json.errors.some(e => /PersistedQueryNotFound/i.test(e?.message ?? '') || e?.extensions?.code === 'PERSISTED_QUERY_NOT_FOUND')) {
            throw new SafeError('QUERY_OUTDATED', 'Rocket Money changed this private API query. Update the reviewed read-operation hash in src/operations.js. No partial data was returned.');
          }
          throw new SafeError('UPSTREAM_GRAPHQL', 'Rocket Money reported a query error. Partial data was withheld.');
        }
        if (!json.data || typeof json.data !== 'object') throw schemaError();
        signal.throwIfAborted();
        if (operation === 'AuthenticationCheck' && typeof json.data.viewer?.id === 'string' && json.data.viewer.id) {
          await this.store.write({ ...updated, verifiedAt: new Date().toISOString() });
        }
        return { data: json.data, cursorKey: row.cursorKey, retrievedAt: new Date().toISOString() };
      }, { signal });
    } catch (e) {
      if (signal.aborted) throw new SafeError('REQUEST_CANCELLED', 'Request timed out or was cancelled. Retry the same page.');
      if (e instanceof SafeError) throw e;
      throw new SafeError('REQUEST_FAILED', 'The request failed. No upstream response body or credentials were logged.');
    }
  }

  envelope(value, retrievedAt) {
    return { ...value, retrievedAt, source: { ...SOURCE, liveCompatibilityVerified: true },
      money: { unit: 'integer cents as returned by Rocket Money', currency: 'Use the row currency; null means unavailable.', signConvention: 'Preserved from source; do not infer expense/income from sign alone.' } };
  }

  async verify(signal) {
    const { data } = await this.request('AuthenticationCheck', {}, { signal });
    if (typeof data.viewer?.id !== 'string' || !data.viewer.id) throw new SafeError('AUTH_REQUIRED', 'Rocket Money did not confirm a signed-in viewer.');
    // Do not return the viewer identifier to the assistant.
    return { authenticated: true, readOnly: true, checkedAt: new Date().toISOString() };
  }

  async accounts(signal) {
    const r = await this.request('AccountDetailAccountListPage', {}, { signal });
    return this.envelope(shapeAccounts(r.data), r.retrievedAt);
  }

  async accountDetail(id, signal) {
    const r = await this.request('AccountDetailPage', { id }, { signal });
    const shaped = shapeAccountDetail(r.data);
    if (shaped.id !== id) throw schemaError();
    return this.envelope(shaped, r.retrievedAt);
  }

  async categories(signal) {
    const r = await this.request('TransactionCategories', {}, { signal });
    return this.envelope(shapeCategories(r.data), r.retrievedAt);
  }

  async transactions({ since, before, query = null, account_ids = [], page_size = 100, cursor = null }, signal) {
    const filters = { since, before, query, account_ids: [...new Set(account_ids)].sort(), page_size };
    let upstreamCursor;
    const r = await this.request('TransactionsPageTransactionTable', row => {
      upstreamCursor = decodeCursor(cursor, filters, row.cursorKey);
      return { query, order: 'reverse:date', accountIds: filters.account_ids, transactionCategoryIds: [],
        gteDate: since, ltDate: before, cursor: upstreamCursor, pageSize: page_size, metaCategory: null };
    }, { signal });
    const { nodes, pageInfo } = transactionConnection(r.data);
    if (nodes.length > page_size) throw schemaError();
    const hasMore = pageInfo.hasNextPage;
    if (hasMore && (typeof pageInfo.endCursor !== 'string' || !pageInfo.endCursor || pageInfo.endCursor.length > 4096 || pageInfo.endCursor === upstreamCursor)) {
      throw new SafeError('PAGINATION_STALLED', 'Rocket Money says more transactions exist but supplied no usable continuation. This window is incomplete.');
    }
    const transactions = [...new Map(nodes.map(shapeTransaction).map(t => [t.id, t])).values()];
    for (const t of transactions) {
      const date = t.date.slice(0, 10);
      if (date < since || date >= before || (filters.account_ids.length && !filters.account_ids.includes(t.account.id))) {
        throw new SafeError('FILTER_MISMATCH', 'Rocket Money returned transactions outside the requested date/account filters. Results were withheld.');
      }
    }
    return this.envelope({ transactions, count: transactions.length, filters,
      pagination: { hasMore, nextCursor: hasMore ? encodeCursor(pageInfo.endCursor, filters, r.cursorKey) : null,
        startedFromBeginning: cursor === null, endReached: !hasMore,
        windowCompleteInThisResponse: cursor === null && !hasMore },
      warnings: [
        'Follow nextCursor with identical filters until hasMore is false; deduplicate by transaction id across pages.',
        'Pages are not an atomic snapshot. New or edited transactions can change results during a scan.',
        'Null pending, excluded, transfer or currency fields mean unavailable, never false. Do not present unqualified spending totals when classification is unknown.',
      ] }, r.retrievedAt);
  }
}
