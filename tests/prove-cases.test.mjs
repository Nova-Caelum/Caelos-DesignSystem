import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadProofCases, runProofCases } from '../scripts/prove-tier-drift.mjs';

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

test('(criterion 1) the required runner passes four local cases and records the merge case as not-run', async () => {
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
  assert.equal(result.cases.filter((entry) => entry.status === 'passed').length, 4);
  assert.deepEqual(
    result.cases.find((entry) => entry.name === 'non-token-merge'),
    { name: 'non-token-merge', kind: 'non-token-merge', status: 'not-run', mode: 'on-demand' },
  );
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), result);
});

test('(reviewer repro) stack traces and non-refusal exit codes are crashes, not refusals', async () => {
  const definitions = await loadProofCases(casesFolder);
  const rebuilt = definitions.filter((entry) => entry.name === 'rebuilt-component');
  for (const crash of [
    { status: 1, stdout: '', stderr: 'Error: CRASH-PROBE\n    at checkRecipes (check-recipes.mjs:1:1)\n' },
    { status: 2, stdout: '', stderr: 'CRASH-PROBE\n' },
  ]) {
    await assert.rejects(
      runProofCases({
        cases: rebuilt,
        projectRoot: root,
        checkRunner: async () => crash,
      }),
      /rebuilt-component.*catalog.*crash/iu,
    );
  }
});

test('(reviewer repro) changing empty-required-value to slots refuses for the wrong reason', async () => {
  const definitions = await loadProofCases(casesFolder);
  const emptyRequired = structuredClone(
    definitions.find((entry) => entry.name === 'empty-required-value'),
  );
  emptyRequired.plants.find((entry) => entry.surface === 'catalog').field = 'slots';
  await assert.rejects(
    runProofCases({ cases: [emptyRequired], projectRoot: root }),
    /empty-required-value.*catalog.*wrong reason.*requires kind/isu,
  );
});

test('(mutation guard) a refusal for an unrelated reason fails the named case', async () => {
  const definitions = await loadProofCases(casesFolder);
  const rebuilt = definitions.filter((entry) => entry.name === 'rebuilt-component');
  await assert.rejects(
    runProofCases({
      cases: rebuilt,
      projectRoot: root,
      checkRunner: async () => ({ status: 1, stdout: '', stderr: 'unrelated refusal\n' }),
    }),
    /rebuilt-component.*catalog.*wrong reason.*unrelated refusal/isu,
  );
});

test('(criterion 1) an accepted case fails if output matches a refusal pattern', async () => {
  const definitions = await loadProofCases(casesFolder);
  const reused = definitions.find((entry) => entry.name === 'reused-component');
  const emptyRequired = definitions.find((entry) => entry.name === 'empty-required-value');
  await assert.rejects(
    runProofCases({
      cases: [reused, emptyRequired],
      projectRoot: root,
      checkRunner: async () => ({
        status: 0,
        stdout: 'tier 3 entry overlays.shared.menu: lifecycle violates its schema\n',
        stderr: '',
      }),
    }),
    /reused-component.*catalog.*refusal pattern/isu,
  );
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
