import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'tests', 'fixtures', 'promote', 'catalog');
const invalidFixture = path.join(root, 'tests', 'fixtures', 'promote', 'invalid-catalog');
const script = path.join(root, 'scripts', 'promote.mjs');

function sandbox() {
  const directory = mkdtempSync(path.join(tmpdir(), 'promote-test-'));
  const catalog = path.join(directory, 'catalog');
  cpSync(fixture, catalog, { recursive: true });
  return { directory, catalog, tier: path.join(catalog, '04-promote.tokens.json'), record: path.join(directory, 'signoff.json') };
}

function run({ catalog, record }, args = []) {
  return spawnSync(process.execPath, [script, '--job', 'job-test', '--record', record,
    '--signer-words', 'Approved exactly as reviewed.', '--catalog', catalog, ...args], { encoding: 'utf8' });
}

function hash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

test('(a), (b), and (d) promote only the job drafts, record the result, and preserve the tier format', () => {
  const work = sandbox();
  const before = readFileSync(work.tier, 'utf8');
  const result = run(work);
  assert.equal(result.status, 0, result.stderr);

  const data = JSON.parse(readFileSync(work.tier, 'utf8'));
  const entry = data.library.entry.$extensions['app.caelos'];
  const variant = data.library.entry.variants.compact.$extensions['app.caelos'];
  assert.equal(entry.lifecycle, 'promoted');
  assert.equal(variant.lifecycle, 'promoted');
  assert.equal(data.library.placeholder.$extensions['app.caelos'].lifecycle, 'placeholder');
  assert.equal(data.library.other.$extensions['app.caelos'].lifecycle, 'draft');

  const record = JSON.parse(readFileSync(work.record, 'utf8'));
  assert.equal(record.jobId, 'job-test');
  assert.equal(record.signerWords, 'Approved exactly as reviewed.');
  assert.equal(record.promoted.length, 2);
  assert.deepEqual(record.skipped, [{ id: 'library.placeholder', reason: 'placeholder' }]);
  assert.match(record.signedAt, /^\d{4}-\d\d-\d\dT/);

  const after = readFileSync(work.tier, 'utf8');
  const changes = before.split('\n').map((line, index) => [line, after.split('\n')[index]]).filter(([left, right]) => left !== right);
  assert.deepEqual(changes, [
    ['          "lifecycle": "draft",', '          "lifecycle": "promoted",'],
    ['              "lifecycle": "draft",', '              "lifecycle": "promoted",'],
  ]);
});

test('(c) refuses a second sign-off without changing the tier or record', () => {
  const work = sandbox();
  assert.equal(run(work).status, 0);
  const before = { tier: hash(work.tier), record: hash(work.record) };
  const result = run(work);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /already signed off/i);
  assert.deepEqual({ tier: hash(work.tier), record: hash(work.record) }, before);
});

test('(e) refuses a job with no drafts and no sign-off record', () => {
  const work = sandbox();
  const result = spawnSync(process.execPath, [script, '--job', 'job-missing', '--record', work.record,
    '--signer-words', 'Approved exactly as reviewed.', '--catalog', work.catalog], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /nothing was drafted by that job/i);
  assert.equal(existsSync(work.record), false);
});

test('(f) requires a record path and signer words', () => {
  const work = sandbox();
  for (const args of [
    ['--job', 'job-test', '--signer-words', 'words', '--catalog', work.catalog],
    ['--job', 'job-test', '--record', work.record, '--catalog', work.catalog],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(`${result.stdout}${result.stderr}`, /usage:/i);
  }
});

test('invalid catalog JSON names the file and leaves every output untouched', () => {
  const work = sandbox();
  const catalog = path.join(work.directory, 'invalid-catalog');
  cpSync(invalidFixture, catalog, { recursive: true });
  const malformed = path.join(catalog, '04-promote.tokens.json');
  const valid = path.join(catalog, '03-valid.tokens.json');
  writeFileSync(malformed, JSON.parse(readFileSync(malformed, 'utf8')).malformed);
  const before = { malformed: hash(malformed), valid: hash(valid) };
  const result = run({ catalog, record: work.record });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /04-promote\.tokens\.json/);
  assert.deepEqual({ malformed: hash(malformed), valid: hash(valid) }, before);
  assert.equal(existsSync(work.record), false);
});
