# Maintaining private API compatibility

Rocket Money does not provide a supported public integration contract for this
connector. Persisted query hashes and response shapes can change independently.
Keep releases labelled experimental and provide known limitations prominently.

## When a query breaks

1. Record the connector version, failing tool and sanitized error code. A
   successful authentication check does not validate account/transaction reads.
2. Inspect the operation from your own signed-in browser or Rocket Money's public
   app bundle. Do not save a HAR or cookie in the repository. Work in a private
   temporary directory and retain only the non-secret query/schema information.
3. Confirm the document is a **query**, selects only needed fields, targets the
   existing fixed API endpoint, and contains no mutation. Never expose arbitrary
   GraphQL, arbitrary URLs or query updates through MCP tool arguments.
4. For URQL-generated documents, the current public app uses formatting before
   hashing: `sha256(stringifyDocument(formatDocument(document)))`. Verify that
   algorithm against an already known query; it is not a permanent API contract.
5. Update the exact allowlisted operation in `src/operations.js`. For the fixed
   account-detail document, the connector computes its matching hash. It sends
   the document explicitly; there is no arbitrary-query or mutation fallback.
6. Review variables, pagination, source units, currency, ignored/pending/status
   fields and account identity. Add sanitized synthetic fixtures that cover the
   changed shape. Do not turn a schema mismatch into an empty successful result.
7. Run `npm run check` and `npm run check:package`. Do a small, explicitly chosen
   live read with your own session outside CI. Validate representative fields
   against the app; do not commit the returned financial data.
8. Update the changelog with build/date, affected tools, limitations and restart
   requirements. Release a patch for compatible repairs; version schema changes
   separately. Never state that a successful read proves global completeness.

## Compatibility notes

- Account queries were repaired against public app build `44836e2b0b` on
  2026-11-06. Transaction/category identifiers initially came from the upstream
  MIT project attributed in THIRD_PARTY_NOTICES.
- Account/category completeness may be unknown. Transactions expose continuation
  metadata but do not provide an atomic multi-page snapshot.
- Fields that Rocket Money does not supply remain null. Do not infer currencies,
  posted status, excluded flags, payment due dates or zero balances.
- Keep a credential-free synthetic test suite; no shared maintainer cookie or
  scheduled live account access belongs in CI.

## Planned offline fallback

A CSV-import backend is a follow-up, not part of this release. Rocket Money
documents [transaction export](https://help.rocketmoney.com/en/articles/10296106-exporting-transactions).
Before implementing it, obtain a redacted header/schema example, document dates,
currency and sign conventions, and distinguish exported snapshots from live
balances. Preserve original IDs where available; never silently guess duplicate
transactions. Treat spreadsheet formulas and merchant text as untrusted data.
The fallback must remain offline and must not imply fresh balance or due-date
coverage from a transaction-only file.
