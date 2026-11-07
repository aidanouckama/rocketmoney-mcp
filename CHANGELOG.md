# Changelog

## 0.2.0 — Unreleased

- Portable `rocketmoney-mcp` and `rocketmoney-auth` commands; macOS/Linux support
  and platform-appropriate state directories.
- Keychain default for new macOS sessions, explicit file fallback, and verified
  migration that preserves old credentials until the new storage is durable.
- Safe temporary-file cleanup, dead-process lock recovery and interrupted
  terminal-import cleanup.
- Retry lock inspection when normal release unlinks an open owner file,
  avoiding false unsafe-storage errors during concurrent requests.
- Preserve Rocket Money's transactionStatus, with null/missing-data semantics
  documented prominently. No automatic complete financial totals.
- Generic setup examples and fictional test amounts; npm package allowlist and
  installed-artifact checks.
- MIT project license, retained upstream attribution, CI, Dependabot, security
  reporting and private-API maintenance/release documentation.

Existing macOS file sessions continue working. To migrate, stop older connector
processes, run `rocketmoney-auth migrate-keychain`, and restart the host. Keychain
access errors never silently switch a session to plaintext. The macOS state
directory is unchanged. Linux now uses XDG state conventions; see README for
using an old explicitly selected directory.

## 0.1.0 — Local prototype

- Read-only stdio tools for accounts, transactions, categories and session status.
- Session locking, explicit pagination and redacted errors.
- Account queries repaired after initial live compatibility testing.
