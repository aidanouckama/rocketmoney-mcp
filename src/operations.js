// Read-operation identifiers from 312-dev/rocketmoney-mcp, MIT licensed.
// Upstream commit a1c701b93a36c68b8b88a827c50a271b57dc48d0, capture 2026-09-13.
import { createHash } from 'node:crypto';

// Account queries refreshed from public app build 44836e2b0b on 2026-11-06.
// Hashed with URQL formatDocument + stringifyDocument, verified against the
// existing AuthenticationCheck hash. No automatic query fallback or mutation.
// The account-detail persisted query is not registered upstream. This fixed,
// minimal READ document selects only fields observed in that public app build.
// It is never supplied by a tool caller and cannot accept arbitrary GraphQL.
export const READ_DOCUMENTS = Object.freeze({
  AccountDetailPage: `query AccountDetailPage($id: ID!) {
  account: node(id: $id) {
    id
    ... on Account {
      name
      currentBalance
      available_balance
      displayedBalance
      credit_limit
      institution { name }
      masterAccount { last_fetch }
      liabilityDetails {
        nextStatementDate
        adjustedNextPaymentDueDate
        remainingStatementBalanceCents
        remainingMinimumPaymentAmountCents
        lastStatementBalanceCents
        minimumPaymentAmountCents
      }
    }
  }
}`,
});
export const OPERATIONS = Object.freeze({
  AuthenticationCheck: '5fe578b1917c4601cb63948f580ad3bdadded0fefa985fdd2fe2d1b913cce2d0',
  AccountDetailAccountListPage: 'f9dd7e4512fbc8b3f43a3fdcf46ed97aa88538498d63f8f2d7104ecc075c02ce',
  AccountDetailPage: createHash('sha256').update(READ_DOCUMENTS.AccountDetailPage).digest('hex'),
  TransactionsPageTransactionTable: '5bc74a0e8d2c33efe103eeb87d6ec09d9b57fb34795597ef2e3f7d892d76a056',
  TransactionCategories: 'b8734a0ec18579870ec0e707beca2a05450193c99e55df6f165be9d18a53e6b4',
});
export const SOURCE = Object.freeze({
  provider: 'Rocket Money private web API',
  queryCaptureDate: '2026-09-13',
  accountQueriesUpdatedAt: '2026-11-06',
  liveCompatibilityVerified: false,
});
