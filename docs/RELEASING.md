# Release procedure

Publishing is a separate, explicit maintainer action. CI never publishes or
uses Rocket Money credentials. This workspace is prepared locally; a public
repository and package listing are not created by the checks below.

## Before a release

1. Review the final diff and all files for credentials, real financial data,
   personal paths and unintended artifacts. Use fictional demo data.
2. Confirm ownership/availability of the intended package name and repository.
   Add the real repository/bugs/homepage metadata only after those exist.
3. Keep LICENSE and THIRD_PARTY_NOTICES. Enable GitHub private vulnerability
   reporting where available; SECURITY.md also provides a contact route.
4. Update version in package.json, package-lock.json and MCP server metadata;
   update CHANGELOG.md with compatibility and migration notes.
5. Run `npm ci --ignore-scripts`, `npm run check`, `npm run check:package`, and
   `npm audit`. Review advisories instead of blindly applying major upgrades.
6. Require green macOS/Linux CI on supported Node versions. CI configuration
   alone is not evidence that those jobs have run. The native Keychain job uses
   a disposable fake entry, never a user's credentials.
7. Inspect `npm pack --dry-run --ignore-scripts --json`. Only approved runtime
   code, documentation, license/notices and generic configuration should ship.
   Tests, local audit snapshots, session/state files and CI files must not ship.
8. Test a fresh install and both executable commands. Have beta testers verify
   installation without your machine's paths. Confirm documented file fallback,
   expiry and migration recovery. Record the platforms actually tested.
9. Review the private API's current compatibility with an opt-in small live read.
   Never upload its output to CI artifacts or issue trackers.

## Publish only after approval

Create the intended public repository, review its contents, and publish the
approved package/tag using the maintainer's authenticated account. Use a
prerelease tag for early beta distribution. Do not promise general availability
before testing with independent users. Protect publishing credentials with the
registry's supported account-security controls; never store them in this repo.

Pin examples to a reviewed release. Release descriptions must call out
experimental/private API status, financial-data limitations, supported platforms
and any required restart/migration. For compatibility regressions, document a
known-good version and the corresponding limitations; do not remove read-only
or credential protections to restore connectivity.
