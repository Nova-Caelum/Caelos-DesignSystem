import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(repository, 'engine', 'cli.mjs');
const fixtureRoot = path.join(repository, 'tests', 'fixtures', 'engine');
const fixtureCommit = '1234567890abcdef1234567890abcdef12345678';

function json(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function events(folder) {
  return readFileSync(path.join(folder, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

function makeJob(inputs = {}, chain = 'fixture-script') {
  const folder = mkdtempSync(path.join(tmpdir(), 'caelos-engine-core-'));
  writeFileSync(path.join(folder, 'job.json'), `${JSON.stringify({ chain, inputs }, null, 2)}\n`);
  const bin = path.join(folder, 'bin');
  mkdirSync(bin);
  const npm = path.join(bin, 'npm');
  writeFileSync(npm, `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const log = process.env.ENGINE_FIXTURE_CHECK_LOG;
appendFileSync(log, process.argv.slice(2).join(' ') + '\\n');
const count = readFileSync(log, 'utf8').trim().split('\\n').length;
if (Number(process.env.ENGINE_FIXTURE_FAIL_CHECK_AT || 0) === count) {
  console.error('induced catalog failure; fix: repair the catalog');
  process.exit(17);
}
`);
  chmodSync(npm, 0o755);
  const git = path.join(bin, 'git');
  writeFileSync(git, `#!/bin/sh
if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then
  printf '%s\\n' '${fixtureCommit}'
  exit 0
fi
exec /usr/bin/git "$@"
`);
  chmodSync(git, 0o755);
  return { folder, bin, checkLog: path.join(folder, 'checks.log') };
}

function invoke(command, job, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, command, ...(command === 'step' ? ['prepare'] : []), '--job', job.folder], {
    cwd: repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${job.bin}${path.delimiter}${process.env.PATH}`,
      ENGINE_FIXTURE_CHECK_LOG: job.checkLog,
      ...extraEnv,
    },
  });
}

test('(a, d) run executes three commands in order and records the source commit', () => {
  const job = makeJob({ value: 'hello' });
  const result = invoke('run', job);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(json(path.join(job.folder, 'finish.json')), { value: 'HELLO', complete: true });
  assert.deepEqual(events(job.folder).map(({ kind, node }) => [kind, node]), [
    ['run.start', null],
    ['node.enter', 'prepare'], ['node.exit', 'prepare'],
    ['node.enter', 'convert'], ['node.exit', 'convert'],
    ['node.enter', 'finish'], ['node.exit', 'finish'],
    ['run.end', null],
  ]);
  assert.deepEqual(readFileSync(job.checkLog, 'utf8').trim().split('\n'), [
    'run check:catalog', 'run check:catalog', 'run check:catalog',
  ]);
  const snapshot = json(path.join(job.folder, 'chain.json'));
  assert.equal(snapshot.chain, 'fixture-script');
  assert.equal(snapshot.commit, fixtureCommit);
  assert.equal(snapshot.steps.length, 3);
});

test('(b) a failing script writes node.fail and names the step and fix', () => {
  const job = makeJob({ failStep: 'convert' });
  const result = invoke('run', job);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /convert/);
  assert.match(result.stderr, /fix/i);
  const records = events(job.folder);
  assert.deepEqual(records.map(({ kind, node }) => [kind, node]), [
    ['run.start', null],
    ['node.enter', 'prepare'], ['node.exit', 'prepare'],
    ['node.enter', 'convert'], ['node.fail', 'convert'],
    ['run.end', null],
  ]);
  assert.match(records.find(({ kind }) => kind === 'node.fail').error, /fix/i);
});

test('(c) resume starts at the failed step and leaves finished steps untouched', () => {
  const job = makeJob({ failStep: 'convert' });
  assert.notEqual(invoke('run', job).status, 0);
  writeFileSync(path.join(job.folder, 'job.json'), `${JSON.stringify({
    chain: 'fixture-script', inputs: { value: 'resumed' },
  }, null, 2)}\n`);
  const result = invoke('run', job);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(json(path.join(job.folder, 'step-runs.json')), {
    prepare: 1, convert: 2, finish: 1,
  });
  const records = events(job.folder);
  const resume = records.findIndex(({ kind }) => kind === 'run.resume');
  assert.ok(resume > 0);
  assert.equal(records[resume + 1].kind, 'node.enter');
  assert.equal(records[resume + 1].node, 'convert');
  assert.equal(records.filter(({ kind, node }) => kind === 'node.enter' && node === 'prepare').length, 1);
  assert.equal(new Set(records.map(({ run_id: runId }) => runId)).size, 1);
});

test('running a finished step directly changes nothing', () => {
  const job = makeJob();
  assert.equal(invoke('run', job).status, 0);
  const beforeEvents = readFileSync(path.join(job.folder, 'events.jsonl'), 'utf8');
  const beforeRuns = readFileSync(path.join(job.folder, 'step-runs.json'), 'utf8');
  const result = invoke('step', job);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(job.folder, 'events.jsonl'), 'utf8'), beforeEvents);
  assert.equal(readFileSync(path.join(job.folder, 'step-runs.json'), 'utf8'), beforeRuns);
});

test('(e) a missing named chain is refused by name', () => {
  const job = makeJob({}, 'missing-fixture');
  const result = invoke('run', job);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing-fixture/);
});

test('(f) duplicate step names are refused', async () => {
  const { validateChain } = await import(pathToFileURL(path.join(repository, 'engine', 'lib', 'chain.mjs')));
  assert.throws(
    () => validateChain(json(path.join(fixtureRoot, 'duplicate.chain.json')), 'duplicate.chain.json'),
    /duplicate step name same/,
  );
});

test('(g) a catalog check failure is node.fail, never node.exit', () => {
  const job = makeJob();
  const result = invoke('run', job, { ENGINE_FIXTURE_FAIL_CHECK_AT: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prepare/);
  assert.match(result.stderr, /fix/i);
  const records = events(job.folder);
  assert.ok(records.some(({ kind, node }) => kind === 'node.fail' && node === 'prepare'));
  assert.ok(!records.some(({ kind, node }) => kind === 'node.exit' && node === 'prepare'));
});

test('a corrupt events.jsonl line is refused loudly and never skipped', () => {
  const job = makeJob();
  writeFileSync(path.join(job.folder, 'events.jsonl'), `${JSON.stringify({
    seq: 1,
    kind: 'run.start',
    run_id: 'attack-fixture',
    node: null,
    ts: new Date().toISOString(),
  })}\nnot json\n`);
  const result = invoke('run', job);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /events\.jsonl line 2/);
});
