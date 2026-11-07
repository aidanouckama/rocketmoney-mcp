#!/usr/bin/env node
import { main } from '../src/server.js';
import { publicError } from '../src/errors.js';
const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  process.stdout.write('rocketmoney-mcp\nLocal read-only MCP over stdio. Configure a session with rocketmoney-auth import.\n');
} else if (args.length) {
  process.stderr.write('No arguments are accepted. Use rocketmoney-mcp --help.\n');
  process.exitCode = 1;
} else {
  main().catch(error => { process.stderr.write(`${JSON.stringify(publicError(error))}\n`); process.exitCode = 1; });
}
