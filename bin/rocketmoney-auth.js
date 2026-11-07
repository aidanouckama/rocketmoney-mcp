#!/usr/bin/env node
import { main } from '../src/auth.js';
import { publicError } from '../src/errors.js';
main().catch(error => { process.stderr.write(`${JSON.stringify(publicError(error))}\n`); process.exitCode = 1; });
