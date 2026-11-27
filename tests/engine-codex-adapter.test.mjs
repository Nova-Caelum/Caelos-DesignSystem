import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildCodexCommand, runCodexStep,
} from '../engine/adapters/codex.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(repository, 'engine', 'cli.mjs');
const fixtures = path.join(repository, 'tests', 'fixtures', 'engine-adapter');

function command(cwd, args) {
  const result = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
  return result.stdout.trim();
}

function makeRepository(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'engine-adapter-repo-'));
  const gitRoot = path.join(root, 'source');
  const jobFolder = path.join(root, 'job');
  mkdirSync(gitRoot);
  mkdirSync(jobFolder);
  for (const name of ['instructions.md', 'output.schema.json']) cpSync(path.join(fixtures, name), path.join(gitRoot, name));
  cpSync(path.join(fixtures, 'input.json'), path.join(jobFolder, 'input.json'));
  command(gitRoot, ['git', 'init', '-q']);
  command(gitRoot, ['git', 'add', '-A']);
  command(gitRoot, ['git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'base']);
  const baseCommit = command(gitRoot, ['git', 'rev-parse', 'HEAD']);
  const stub = path.join(root, 'codex');
  cpSync(path.join(fixtures, 'stub-codex.mjs'), stub);
  chmodSync(stub, 0o755);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, gitRoot, jobFolder, baseCommit, stub };
}

function stepOptions(work, action) {
  return {
    gitRoot: work.gitRoot,
    baseCommit: work.baseCommit,
    jobFolder: work.jobFolder,
    command: work.stub,
    env: { ...process.env, ENGINE_STUB_ACTION: action },
    step: {
      step: 'fixture-model',
      kind: 'model',
      instructions: 'instructions.md',
      schema: 'output.schema.json',
      inputs: ['input.json'],
      outputs: ['result.json'],
      check: 'npm run check:catalog',
    },
  };
}

test('a step whose output fails its schema is refused, naming the field', (t) => {
  const work = makeRepository(t);
  assert.throws(() => runCodexStep(stepOptions(work, 'invalid-schema')), /answer/);
  assert.equal(existsSync(path.join(work.jobFolder, 'result.json')), false);
});

test('a step that writes outside its declared outputs is refused, naming the file', (t) => {
  const work = makeRepository(t);
  assert.throws(() => runCodexStep(stepOptions(work, 'extra')), /surprise\.txt/);
  assert.equal(existsSync(path.join(work.jobFolder, 'result.json')), false);
  assert.equal(existsSync(path.join(work.jobFolder, 'surprise.txt')), false);
});

test('a step that commits is refused, naming the commit', (t) => {
  const work = makeRepository(t);
  assert.throws(() => runCodexStep(stepOptions(work, 'commit')), /model commit/);
  assert.equal(existsSync(path.join(work.jobFolder, 'result.json')), false);
});

test('a missing harness is refused before any step runs, naming the command', (t) => {
  const folder = mkdtempSync(path.join(tmpdir(), 'engine-adapter-missing-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(path.join(folder, 'job.json'), `${JSON.stringify({ chain: 'fixture-model' })}\n`);
  writeFileSync(path.join(folder, 'chain.json'), `${JSON.stringify({
    chain: 'fixture-model',
    commit: '1234567890abcdef1234567890abcdef12345678',
    steps: [
      {
        step: 'prepare', kind: 'script', script: 'tests/fixtures/engine/step.mjs',
        inputs: ['job.json'], outputs: ['prepare.json'], check: 'npm run check:catalog',
      },
      {
        step: 'model', kind: 'model', instructions: 'instructions.md', schema: 'output.schema.json',
        inputs: ['prepare.json'], outputs: ['result.json'], check: 'npm run check:catalog',
      },
    ],
  }, null, 2)}\n`);
  const missing = 'codex-command-that-does-not-exist';
  const result = spawnSync(process.execPath, [cli, 'run', '--job', folder], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, CAELOS_CODEX_COMMAND: missing },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(missing));
  assert.equal(existsSync(path.join(folder, 'prepare.json')), false);
  assert.equal(existsSync(path.join(folder, 'events.jsonl')), false);
});

test('a valid step passes and only its declared outputs come back', (t) => {
  const work = makeRepository(t);
  const log = path.join(work.root, 'harness.log');
  const options = stepOptions(work, 'valid');
  options.env.ENGINE_STUB_LOG = log;
  const result = runCodexStep(options);
  assert.deepEqual(result.outputs, ['result.json']);
  assert.deepEqual(JSON.parse(readFileSync(path.join(work.jobFolder, 'result.json'), 'utf8')), { answer: 'ok' });
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\0').slice(0, 2), [work.stub, 'exec']);
  assert.deepEqual(
    [...new Set(['input.json', 'result.json'].filter((name) => existsSync(path.join(work.jobFolder, name))))].sort(),
    ['input.json', 'result.json'],
  );
});

test('the built Codex command contains no banned flag or environment override', () => {
  const built = buildCodexCommand({
    command: 'codex', checkout: '/checkout', lastMessageFile: '/last-message', prompt: 'prompt',
  });
  const rendered = [built.command, ...built.args].join(' ');
  for (const banned of [
    '--dangerously-bypass-approvals-and-sandbox', 'model_reasoning_effort=ultra', 'CODEX_HOME',
  ]) assert.doesNotMatch(rendered, new RegExp(banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('attack: a declared output cannot escape through a committed symbolic link', (t) => {
  const work = makeRepository(t);
  const outside = path.join(work.root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, path.join(work.gitRoot, 'linked'));
  command(work.gitRoot, ['git', 'add', 'linked']);
  command(work.gitRoot, [
    'git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-q', '-m', 'add linked output',
  ]);
  work.baseCommit = command(work.gitRoot, ['git', 'rev-parse', 'HEAD']);
  const options = stepOptions(work, 'valid');
  options.step.outputs = ['linked/result.json'];
  options.env.ENGINE_STUB_OUTPUT = 'linked/result.json';
  assert.throws(() => runCodexStep(options), /symbolic link.*linked\/result\.json/i);
  assert.equal(existsSync(path.join(outside, 'result.json')), false);
  assert.equal(existsSync(path.join(work.jobFolder, 'linked', 'result.json')), false);
});
