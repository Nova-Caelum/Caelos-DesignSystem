import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runProofCases } from '../scripts/prove-tier-drift.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const casesFolder = path.join(root, 'proof-cases');
const fixtures = path.join(root, 'tests/fixtures/prove-cases');
const mergeProof = path.join(root, 'scripts/prove-merge-block.mjs');

function invokeMerge(args, env = {}) {
  return spawnSync(process.execPath, [mergeProof, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('(criterion 1) the required runner executes all five visible cases and writes evidence', async () => {
  const output = path.join(mkdtempSync(path.join(tmpdir(), 'caelos-proof-evidence-')), 'cases.json');
  const result = await runProofCases({ casesFolder, evidenceOutput: output, projectRoot: root });
  assert.equal(result.cases.length, 5);
  assert.deepEqual(result.cases.map((entry) => entry.name).sort(), [
    'empty-required-value',
    'non-token-merge',
    'raw-value-equal-to-token',
    'rebuilt-component',
    'reused-component',
  ]);
  assert.ok(result.cases.every((entry) => entry.status === 'passed'));
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), result);
});

test('(criterion 2) a check that wrongly accepts a planted rebuild exits nonzero and names the case', () => {
  const result = spawnSync(process.execPath, [path.join(fixtures, 'wrong-accept-runner.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /rebuilt-component.*wrongly accepted/iu);
});

test('(criterion 3) merge-block dry-run prints branch, file, and expected check without pushing', () => {
  const result = invokeMerge([
    '--dry-run',
    '--case', path.join(casesFolder, 'non-token-merge.case.json'),
  ], { PATH: '' });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /proof\/non-token-merge/u);
  assert.match(output, /token_catalog\/01-primitives\.tokens\.json/u);
  assert.match(output, /tier-proof/u);
  assert.doesNotMatch(output, /pushed|opened pull request/iu);
});

test('(criterion 4) a used-cases list refuses reuse and names the case', () => {
  const result = invokeMerge([
    '--case', path.join(casesFolder, 'non-token-merge.case.json'),
    '--used-cases', path.join(fixtures, 'used-cases.json'),
  ], { PATH: '' });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /non-token-merge/u);
  assert.match(output, /already used/iu);
});

test('(attack) validate-only refuses an unsafe planted-case path before running a check', () => {
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/prove-tier-drift.mjs'),
    '--validate-only',
    '--cases', path.join(fixtures, 'unsafe'),
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: '' } });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /unsafe-path\.case\.json/u);
  assert.match(output, /path.*inside|unsafe path/iu);
});
