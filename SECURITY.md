# Security and privacy

This is an experimental local connector, not an official Rocket Money product.
The latest release is the supported security-update line. No response-time SLA
or independent security certification is claimed.

## Reporting a vulnerability

Email **ouckah@gmail.com** with subject `rocketmoney-mcp security report`.
Include affected version, impact, and reproduction using fake data. Do not send
real cookies, passwords, MFA codes, session files, financial screenshots, HARs,
account identifiers, or transaction exports—even in a private report. Do not
test against someone else's accounts. Do not open a public issue with exploit
details before the maintainer has had an opportunity to investigate.

If you expose your own session, remove the material and revoke/sign out the
Rocket Money browser session where possible. `rocketmoney-auth clear` removes
local credentials; it does not revoke access at Rocket Money or erase backups.

## Trust boundaries

- STDIO only: no inbound network listener, remote endpoint, web UI or telemetry.
- Only fixed read operations can reach the fixed Rocket Money HTTPS endpoint.
  This is a code restriction, not a scoped read-only credential from Rocket Money.
- The full browser session grants broader privileges if stolen. Do not share it.
- macOS defaults to Keychain for new sessions. Access denial never silently
  downgrades to plaintext. The native binding is optional; file fallback must
  be explicitly selected if Keychain is unavailable.
- Linux uses an owner-only plaintext file. It does not protect against root,
  malware running as you, or backups. Use a trusted local directory, not a
  shared/network filesystem. Symlink-file checks do not secure untrusted parent
  directories or other processes with your own OS privileges.
- Private state directories use 0700, files 0600. File writes are atomic and
  cleaned up on failure. Locks serialize session rotation across processes.
- Requested financial data is returned to your MCP host/AI provider. Local
  credential storage is not a promise that financial data stays on-device.
- Merchant names and notes are untrusted data and must never become instructions.
- No real session or financial-data files belong in source control, issues,
  test fixtures, CI artifacts, release packages or screenshots.

The test suite checks specific controls and failure paths, not every possible
vulnerability. Dependency audits are point-in-time advisory checks, not proof
of security. See docs/RELEASING.md for required release verification.
