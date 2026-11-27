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
if (process.env.ENGINE_STUB_ENV_LOG) {
  writeFileSync(process.env.ENGINE_STUB_ENV_LOG, JSON.stringify({
    hasCodexHome: Object.hasOwn(process.env, 'CODEX_HOME'),
    codexHome: process.env.CODEX_HOME,
  }));
}

const git = (...args) => spawnSync('git', args, { cwd: checkout, encoding: 'utf8' });
function requireGit(...args) {
  const result = git(...args);
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
    process.exit(result.status || 1);
  }
}

if (action === 'schema-assume-unchanged' || action === 'schema-skip-worktree') {
  writeFileSync(path.join(checkout, 'output.schema.json'), `${JSON.stringify({
    type: 'object', required: [], properties: {},
  })}\n`);
  requireGit('update-index', action === 'schema-assume-unchanged' ? '--assume-unchanged' : '--skip-worktree', 'output.schema.json');
}
if (action === 'head-ancestor') requireGit('reset', '-q', '--hard', 'HEAD~1');
if (action === 'head-state' && process.env.ENGINE_STUB_HEAD_LOG) {
  const symbolic = git('symbolic-ref', '-q', 'HEAD');
  const head = git('rev-parse', 'HEAD');
  writeFileSync(process.env.ENGINE_STUB_HEAD_LOG, JSON.stringify({
    detached: symbolic.status !== 0,
    head: head.stdout.trim(),
  }));
}

const invalid = action === 'invalid-schema' || action === 'schema-assume-unchanged' ||
  action === 'schema-skip-worktree';
writeFileSync(output, `${JSON.stringify(invalid ? { answer: 42 } : { answer: 'ok' }, null, 2)}\n`);
writeFileSync(process.argv[messageIndex + 1], 'stub complete\n');
if (action === 'extra') writeFileSync(path.join(checkout, 'surprise.txt'), 'not declared\n');
if (action === 'ignored-extra') writeFileSync(path.join(checkout, 'debug.log'), 'ignored but undeclared\n');
if (action === 'second-invalid') writeFileSync(path.join(checkout, 'second.json'), '{"answer":42}\n');
if (action === 'forge-job') writeFileSync(path.join(process.env.ENGINE_STUB_JOB, 'forged.json'), '{}\n');
if (action === 'commit') {
  let result = git('add', '-A');
  if (result.status === 0) result = git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'model commit');
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'git commit failed');
    process.exit(result.status || 1);
  }
}
process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' })}\n`);
if (action === 'tool-model') {
  process.stdout.write(`${JSON.stringify({
    type: 'item.completed',
    item: { type: 'mcp_tool_call', arguments: { model: process.env.ENGINE_STUB_STREAM_MODEL } },
  })}\n`);
}
process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
