import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const temp = mkdtempSync(join(tmpdir(), 'rocketmoney-package-test-'));
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { encoding: 'utf8' }))[0];
  const permitted = /^(?:bin\/[^/]+\.js|src\/[^/]+\.js|docs\/[^/]+\.md|package\.json|README\.md|LICENSE|THIRD_PARTY_NOTICES|SECURITY\.md|CONTRIBUTING\.md|CHANGELOG\.md|mcp-config\.example\.json)$/;
  for (const { path } of packed.files) {
    assert.ok(permitted.test(path), `Unexpected package file: ${path}`);
    const text = readFileSync(path, 'utf8');
    assert.ok(!/\/Users\/[A-Za-z][^/\s]*\//.test(text), `Personal macOS path: ${path}`);
    assert.ok(!/QWNjb3VudDo[0-9A-Za-z+/]{10,}/.test(text), `Possible account identifier: ${path}`);
    assert.ok(!/tb\.auth0\.sid=[A-Za-z0-9_%.-]{40,}/.test(text), `Possible session credential: ${path}`);
  }
  for (const required of ['LICENSE', 'THIRD_PARTY_NOTICES', 'bin/rocketmoney-mcp.js', 'bin/rocketmoney-auth.js']) {
    assert.ok(packed.files.some(f => f.path === required), `Missing package file: ${required}`);
  }
  const install = join(temp, 'install');
  execFileSync('npm', ['install', '--prefix', install, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', join(temp, packed.filename)], { stdio: 'pipe' });
  for (const name of ['rocketmoney-mcp', 'rocketmoney-auth']) {
    const output = execFileSync(join(install, 'node_modules', '.bin', name), ['--help'], { encoding: 'utf8' });
    assert.ok(output.includes(name));
  }
  console.log(`Package allowlist and installed executable checks passed (${packed.files.length} files). No package was published.`);
} finally { rmSync(temp, { recursive: true, force: true }); }
