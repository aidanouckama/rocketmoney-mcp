# Contributing

Use macOS or Linux and Node 22.12+ (CI targets 22.12 and 24).

```sh
npm ci --ignore-scripts
npm run check
npm run check:package
```

All standard tests use synthetic financial data and isolated temporary storage.
Never run tests against your normal session. On macOS, `npm run test:keychain`
separately tests a disposable fake Keychain entry and deletes it afterward. It
never calls Rocket Money. A native Keychain error is a failure, not a skipped
security check. The OS may require local Keychain access permission.

Keep changes small and explain observable behavior and relevant tests. Preserve
read-only operations, credential redaction, completeness metadata and source
money semantics. Unknown is not zero/false. Include failure-path tests when
changing storage, authentication, pagination or schema handling.

Use obviously fictional amounts and names. Never commit HARs, cookies, API
responses from a real account, session files, personal absolute paths or exports.
The package privacy scan is a guardrail, not a substitute for reviewing changes.

For API compatibility fixes, follow docs/API-MAINTENANCE.md. For vulnerabilities,
follow SECURITY.md. Keep the project MIT license and upstream notices intact.

The optional native Keychain binding is loaded only for Keychain storage. No
install-time scripts, downloaded executables, hosted auth service or automatic
account-changing tools should be added without a separately reviewed design.
