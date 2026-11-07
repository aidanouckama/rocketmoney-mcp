import { SafeError } from './errors.js';

export const schemaError = () => new SafeError('UPSTREAM_SCHEMA', 'Rocket Money returned an unrecognized data shape. Results were withheld rather than treating missing data as zero.');
const text = v => typeof v === 'string' ? v : null;
const bool = v => typeof v === 'boolean' ? v : null;
const cents = v => Number.isSafeInteger(v) ? v : null;
const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};

export function walk(value, visit, path = [], depth = 0) {
  if (depth > 40) throw schemaError();
  if (!value || typeof value !== 'object') return;
  visit(value, path);
  for (const [key, child] of Object.entries(value)) walk(child, visit, [...path, key], depth + 1);
}

export function transactionConnection(data) {
  const candidates = [];
  walk(data, (o, path) => {
    if (Array.isArray(o)) return;
    const nodes = Array.isArray(o.edges) ? o.edges.map(e => e?.node) : Array.isArray(o.nodes) ? o.nodes : null;
    if (!nodes) return;
    const hasTransactions = nodes.some(n => n?.__typename === 'Transaction');
    if (!hasTransactions && !/transaction/i.test(path.at(-1) ?? '')) return;
    if (!o.pageInfo || typeof o.pageInfo.hasNextPage !== 'boolean') throw schemaError();
    if (nodes.some(n => !n || n.__typename !== 'Transaction')) throw schemaError();
    candidates.push({ nodes, pageInfo: o.pageInfo });
  });
  // Never accidentally take the first pageInfo from a different connection.
  if (candidates.length !== 1) throw schemaError();
  return candidates[0];
}

export function shapeTransaction(t) {
  if (typeof t.id !== 'string' || !t.id || !Number.isSafeInteger(t.amount) ||
      typeof t.date !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(t.date)) throw schemaError();
  const parsedDate = new Date(`${t.date.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0,10) !== t.date.slice(0,10)) throw schemaError();
  const c = obj(t.category), a = obj(t.account);
  return {
    id: t.id, date: t.date, amountCents: t.amount,
    currency: text(t.currencyCode) ?? text(t.currency) ?? text(a.currencyCode),
    merchant: text(t.longName) ?? text(t.shortName), note: text(t.note),
    account: { id: text(a.id), name: text(a.name) ?? text(a.defaultName) },
    category: { id: text(c.id), label: text(c.label), categoryType: text(c.categoryType),
      includeInSpending: bool(c.includeInSpending), includeInEarnings: bool(c.includeInEarnings) },
    pending: bool(t.pending) ?? bool(t.isPending),
    excluded: bool(t.excluded) ?? bool(t.isExcluded),
    transfer: bool(t.isTransfer),
    sourceStatus: text(t.transactionStatus) ?? text(t.status),
    // Keep source flags separate so absent fields never become false/posted.
    sourceFlags: Object.fromEntries(Object.entries(t).filter(([k,v]) =>
      /pending|posted|exclud|ignor|transfer|spending|earning/i.test(k) &&
      (typeof v === 'boolean' || typeof v === 'string' || v === null))),
  };
}

const ACCOUNT_BUCKETS = ['checkingAccounts', 'savingsAccounts', 'creditAccounts', 'investmentAccounts', 'savingsPlanAccounts', 'otherAccounts'];
export function shapeAccounts(data) {
  const viewer = obj(data?.viewer);
  const found = ACCOUNT_BUCKETS.filter(k => viewer[k] && Array.isArray(viewer[k].edges));
  if (!found.length) throw schemaError();
  const accounts = new Map(), unknown = [], incomplete = [];
  const missing = ACCOUNT_BUCKETS.filter(k => !found.includes(k));
  for (const key of found) {
    const bucket = viewer[key];
    if (bucket.pageInfo?.hasNextPage === true) incomplete.push(key);
    else if (bucket.pageInfo?.hasNextPage !== false) unknown.push(key);
    for (const edge of bucket.edges) {
      const a = edge?.node;
      if (!a || typeof a.id !== 'string') throw schemaError();
      if (accounts.has(a.id)) continue;
      accounts.set(a.id, {
        id: a.id, name: text(a.name) ?? text(a.defaultName), type: text(a.customType),
        balanceCents: cents(a.displayedBalance), currency: text(a.currencyCode) ?? text(a.currency),
        enabled: bool(a.enabled), institution: text(a.masterAccount?.institution?.name),
        connectionStatus: text(a.masterAccount?.status),
        lastSync: text(a.lastSyncDate) ?? text(a.masterAccount?.lastSyncDate) ?? text(a.masterAccount?.last_fetch),
      });
    }
  }
  return { accounts: [...accounts.values()], count: accounts.size,
    completeness: incomplete.length ? 'partial' : unknown.length || missing.length ? 'unknown' : 'complete',
    warnings: [...incomplete.map(k => `The ${k} connection has additional accounts.`),
      ...unknown.map(k => `Pagination metadata absent for ${k}; account-list completeness cannot be verified.`),
      ...missing.map(k => `The expected ${k} bucket is absent; account-list completeness cannot be verified.`)] };
}

export function shapeAccountDetail(data) {
  const a = data?.account;
  if (!a || typeof a.id !== 'string') throw schemaError();
  const l = obj(a.liabilityDetails);
  return { id: a.id, name: text(a.name), institution: text(a.institution?.name),
    currentBalanceCents: cents(a.currentBalance), availableBalanceCents: cents(a.available_balance),
    displayedBalanceCents: cents(a.displayedBalance), creditLimitCents: cents(a.credit_limit),
    currency: text(a.currencyCode) ?? text(a.currency),
    lastSync: text(a.lastSyncDate) ?? text(a.masterAccount?.last_fetch),
    liability: {
      nextStatementDate: text(l.nextStatementDate), nextPaymentDueDate: text(l.adjustedNextPaymentDueDate),
      remainingStatementBalanceCents: cents(l.remainingStatementBalanceCents),
      lastStatementBalanceCents: cents(l.lastStatementBalanceCents),
      minimumPaymentCents: cents(l.remainingMinimumPaymentAmountCents) ?? cents(l.minimumPaymentAmountCents),
    } };
}

export function shapeCategories(data) {
  const categories = new Map();
  walk(data, o => {
    if (o.__typename !== 'TransactionCategory') return;
    if (typeof o.id !== 'string') throw schemaError();
    categories.set(o.id, { id: o.id, label: text(o.label), categoryType: text(o.categoryType),
      includeInSpending: bool(o.includeInSpending), includeInEarnings: bool(o.includeInEarnings) });
  });
  if (!categories.size) throw schemaError();
  return { categories: [...categories.values()], completeness: 'unknown',
    warning: 'Private API category-list completeness is not independently verified.' };
}
