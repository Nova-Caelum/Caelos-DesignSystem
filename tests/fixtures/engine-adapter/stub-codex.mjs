#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

if (process.argv[2] === '--version') {
  process.stdout.write('stub-codex 1.0\n');
  process.exit(0);
}

const checkoutIndex = process.argv.indexOf('--cd');
const messageIndex = process.argv.indexOf('--output-last-message');
if (process.argv[2] !== 'exec' || checkoutIndex < 0 || messageIndex < 0) process.exit(64);
const checkout = process.argv[checkoutIndex + 1];
const output = path.join(checkout, process.env.ENGINE_STUB_OUTPUT || 'result.json');
const action = process.env.ENGINE_STUB_ACTION || 'valid';
if (process.env.ENGINE_STUB_LOG) appendFileSync(process.env.ENGINE_STUB_LOG, `${process.argv.slice(1).join('\0')}\n`);

writeFileSync(output, `${JSON.stringify(action === 'invalid-schema' ? { answer: 42 } : { answer: 'ok' }, null, 2)}\n`);
writeFileSync(process.argv[messageIndex + 1], 'stub complete\n');
if (action === 'extra') writeFileSync(path.join(checkout, 'surprise.txt'), 'not declared\n');
if (action === 'commit') {
  const git = (...args) => spawnSync('git', args, { cwd: checkout, encoding: 'utf8' });
  let result = git('add', '-A');
  if (result.status === 0) result = git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'model commit');
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'git commit failed');
    process.exit(result.status || 1);
  }
}
