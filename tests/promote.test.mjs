import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
  materializeFixture(fixture, catalog);
  return { directory, catalog, tier: path.join(catalog, '04-promote.tokens.json'), record: path.join(directory, 'signoff.json') };
}

function materializeFixture(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const targetName = entry.name.endsWith('.fixture') ? entry.name.slice(0, -'.fixture'.length) : entry.name;
    const target = path.join(destination, targetName);
    if (entry.isDirectory()) materializeFixture(path.join(source, entry.name), target);
    else cpSync(path.join(source, entry.name), target);
  }
}

function run({ catalog, record }, args = []) {
  return spawnSync(process.execPath, [script, '--job', 'job-test', '--record', record,
    '--signer-words', 'Approved exactly as reviewed.', '--catalog', catalog, ...args], { encoding: 'utf8' });
}

function hash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function catalogHashes(catalog) {
  return Object.fromEntries(readdirSync(catalog).filter((name) => name.endsWith('.tokens.json')).sort()
    .map((name) => [name, hash(path.join(catalog, name))]));
}

function makeGapFillPlaceholder(work) {
  const data = JSON.parse(readFileSync(work.tier, 'utf8'));
  const record = data.library.placeholder.$extensions['app.caelos'];
  record.lifecycle = 'draft';
  record.gapFill = 'placeholder';
  writeFileSync(work.tier, `${JSON.stringify(data, null, 2)}\n`);
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

test('(g) a missing record directory leaves every tier file byte-identical', () => {
  const work = sandbox();
  work.record = path.join(work.directory, 'missing', 'signoff.json');
  const before = catalogHashes(work.catalog);
  const result = run(work);
  assert.notEqual(result.status, 0);
  assert.deepEqual(catalogHashes(work.catalog), before);
  assert.equal(existsSync(work.record), false);
});

test('(g2) a failure after the first tier write restores every catalog file byte-identically', () => {
  const work = sandbox();
  const before = catalogHashes(work.catalog);
  const result = spawnSync(process.execPath, [script, '--job', 'job-test', '--record', work.record,
    '--signer-words', 'Approved exactly as reviewed.', '--catalog', work.catalog], {
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8', CAELOS_PROMOTE_TEST_FAIL_AFTER_TIER_WRITES: '1' },
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /injected tier write failure/i);
  assert.deepEqual(catalogHashes(work.catalog), before);
  assert.equal(existsSync(work.record), false);
});

test('(h) a different record path cannot sign off a job left with only placeholder drafts', () => {
  const work = sandbox();
  makeGapFillPlaceholder(work);
  assert.equal(run(work).status, 0);
  const secondRecord = path.join(work.directory, 'second-signoff.json');
  const before = { tier: hash(work.tier), record: hash(work.record) };
  const result = run({ ...work, record: secondRecord });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /already signed off/i);
  assert.match(`${result.stdout}${result.stderr}`, /library\.placeholder/);
  assert.match(`${result.stdout}${result.stderr}`, /need(?:s)? (?:a )?value/i);
  assert.deepEqual({ tier: hash(work.tier), record: hash(work.record) }, before);
  assert.equal(existsSync(secondRecord), false);
});

test('(i) the default token_catalog path promotes only a temporary catalog copy', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'promote-default-catalog-'));
  const catalog = path.join(directory, 'token_catalog');
  const record = path.join(directory, 'signoff.json');
  materializeFixture(fixture, catalog);
  const repositoryCatalog = catalogHashes(path.join(root, 'token_catalog'));
  const result = spawnSync(process.execPath, [script, '--job', 'job-test', '--record', record,
    '--signer-words', 'Approved exactly as reviewed.'], { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(catalog, '04-promote.tokens.json'), 'utf8'))
    .library.entry.$extensions['app.caelos'].lifecycle, 'promoted');
  assert.deepEqual(catalogHashes(path.join(root, 'token_catalog')), repositoryCatalog);
});

test('(j) a draft gap-fill placeholder is skipped and reported', () => {
  const work = sandbox();
  makeGapFillPlaceholder(work);
  const result = run(work);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skipped 1 placeholder/i);
  const tier = JSON.parse(readFileSync(work.tier, 'utf8'));
  assert.equal(tier.library.placeholder.$extensions['app.caelos'].lifecycle, 'draft');
  assert.equal(tier.library.placeholder.$extensions['app.caelos'].gapFill, 'placeholder');
  assert.deepEqual(JSON.parse(readFileSync(work.record, 'utf8')).skipped,
    [{ id: 'library.placeholder', reason: 'placeholder' }]);
});

test('(k) signer words preserve leading, trailing, and repeated inner whitespace verbatim', () => {
  const work = sandbox();
  const signerWords = '  Approved  exactly as reviewed.  ';
  const result = spawnSync(process.execPath, [script, '--job', 'job-test', '--record', work.record,
    '--signer-words', signerWords, '--catalog', work.catalog], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const source = readFileSync(work.record, 'utf8');
  assert.equal(JSON.parse(source).signerWords, signerWords);
  assert.ok(source.includes(`"signerWords": ${JSON.stringify(signerWords)}`));
});

test('(l) the documented repository-root command shape succeeds against a temporary catalog', () => {
  const work = sandbox();
  const signerWords = 'Approved exactly as reviewed.';
  const result = spawnSync('node', ['scripts/promote.mjs', '--job', 'job-test', '--record', work.record,
    '--signer-words', signerWords, '--catalog', work.catalog], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(work.record, 'utf8')).signerWords, signerWords);
});

test('invalid catalog JSON names the file and leaves every output untouched', () => {
  const work = sandbox();
  const catalog = path.join(work.directory, 'invalid-catalog');
  materializeFixture(invalidFixture, catalog);
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
