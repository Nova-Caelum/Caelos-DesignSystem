import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const builder = path.join(root, 'scripts/build-lock.mjs');
const generatedCheck = path.join(root, 'scripts/check-generated.mjs');
const generator = path.join(root, 'scripts/generate-components.mjs');
const fixture = path.join(root, 'tests/fixtures/build-lock/token_catalog');
const generatorFixture = path.join(root, 'tests/fixtures/generator/token_catalog');
const templates = path.join(root, 'templates');

function workspace(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'caelos-lock-test-'));
  const catalog = path.join(cwd, 'token_catalog');
  mkdirSync(catalog, { recursive: true });
  cpSync(path.join(fixture, 'recipe.schema.json'), path.join(catalog, 'recipe.schema.json'));
  for (const file of readdirSync(fixture).filter((name) => name.endsWith('.fixture.json'))) {
    cpSync(path.join(fixture, file), path.join(catalog, file.replace('.fixture.json', '.tokens.json')));
  }
  updateJson(path.join(catalog, '00-foundations.tokens.json'), (data) => {
    data.base.color.primary.$value = ['#', '11', '22', '33'].join('');
    data.base.color['same-a'].$value = ['#', '44', '55', '66'].join('');
    data.base.color['same-b'].$value = ['#', '44', '55', '66'].join('');
  });
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, catalog, lock: path.join(catalog, 'versions.lock.json') };
}

function liveWorkspace(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'caelos-live-lock-test-'));
  const catalog = path.join(cwd, 'token_catalog');
  cpSync(path.join(root, 'token_catalog'), catalog, { recursive: true });
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, catalog, lock: path.join(catalog, 'versions.lock.json') };
}

function build({ cwd, catalog, lock }, extra = []) {
  return spawnSync(process.execPath, [
    builder, '--catalog', catalog, '--schema', path.join(catalog, 'recipe.schema.json'), '--out', lock, ...extra,
  ], { cwd, encoding: 'utf8' });
}

function lock(work) {
  return JSON.parse(readFileSync(work.lock, 'utf8'));
}

function fingerprints(document) {
  const result = new Map();
  for (const [entry, record] of Object.entries(document.entries)) {
    result.set(entry, record.fingerprint);
    for (const [variant, variantFingerprint] of Object.entries(record.variants)) {
      result.set(`${entry}#${variant}`, variantFingerprint);
    }
  }
  return result;
}

function contentFingerprints(document) {
  const result = new Map();
  for (const [entry, record] of Object.entries(document.entries)) {
    result.set(entry, record.contentFingerprint);
    for (const [variant, variantFingerprint] of Object.entries(record.variantContentFingerprints)) {
      result.set(`${entry}#${variant}`, variantFingerprint);
    }
  }
  return result;
}

function updateJson(file, update) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  update(value);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('(a) build-lock keeps main-compatible hashes and writes sibling content fingerprints', (t) => {
  const work = workspace(t);
  const result = build(work);
  assert.equal(result.status, 0, result.stderr);
  const document = lock(work);
  assert.match(document.entries['controls.shared.button'].fingerprint, /^[a-f0-9]{64}$/u);
  assert.match(document.entries['controls.shared.button'].contentFingerprint, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(document.entries['controls.shared.button'].variants), [
    'size=large,tone=primary',
    'size=large,tone=quiet',
    'size=small,tone=primary',
    'size=small,tone=quiet',
  ]);
  assert.deepEqual(
    Object.keys(document.entries['controls.shared.button'].variantContentFingerprints),
    Object.keys(document.entries['controls.shared.button'].variants),
  );
  for (const variantFingerprint of Object.values(document.entries['controls.shared.button'].variants)) {
    assert.match(variantFingerprint, /^[a-f0-9]{64}$/u);
  }
  for (const contentFingerprint of Object.values(
    document.entries['controls.shared.button'].variantContentFingerprints,
  )) {
    assert.match(contentFingerprint, /^[a-f0-9]{64}$/u);
  }
});

test('(b) two builds produce byte-identical lock files', (t) => {
  const work = workspace(t);
  assert.equal(build(work).status, 0);
  const first = readFileSync(work.lock);
  assert.equal(build(work).status, 0);
  assert.deepEqual(readFileSync(work.lock), first);
});

test('tier-zero owner: --tier0-report lists a catalog entry that stops above tier 0', (t) => {
  const work = workspace(t);
  updateJson(path.join(work.catalog, '01-primitives.tokens.json'), (data) => {
    data.primitives.shared.empty = {};
    data.primitives.shared.orphan = { $type: 'dimension', $value: '7px' };
  });
  const reportFile = path.join(work.cwd, 'tier-zero-report.json');
  const result = build(work, ['--tier0-report', reportFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(reportFile, 'utf8')), {
    namesNotReachingTier0: [{
      name: 'primitives.shared.orphan',
      file: '01-primitives.tokens.json',
      line: 0,
      stopsAt: '7px',
    }],
  });
});

test('tier-zero owner: the real catalog has no valued entry that stops above tier 0', (t) => {
  const work = liveWorkspace(t);
  const reportFile = path.join(work.cwd, 'tier-zero-report.json');
  const result = build(work, ['--tier0-report', reportFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(reportFile, 'utf8')), { namesNotReachingTier0: [] });
});

test('tier-zero owner: an undefined token name is the reported stop', (t) => {
  const work = workspace(t);
  updateJson(path.join(work.catalog, '01-primitives.tokens.json'), (data) => {
    data.primitives.shared.unknown = { $type: 'dimension', $value: '{missing.shared.token}' };
  });
  const reportFile = path.join(work.cwd, 'tier-zero-report.json');
  const result = build(work, ['--tier0-report', reportFile]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown token reference: missing\.shared\.token/);
  assert.deepEqual(JSON.parse(readFileSync(reportFile, 'utf8')), {
    namesNotReachingTier0: [{
      name: 'primitives.shared.unknown',
      file: '01-primitives.tokens.json',
      line: 0,
      stopsAt: 'missing.shared.token',
    }],
  });
});

test('(c) a tier-0 change reaches direct references and transitive madeOf only', (t) => {
  const work = workspace(t);
  assert.equal(build(work).status, 0);
  const before = fingerprints(lock(work));
  updateJson(path.join(work.catalog, '00-foundations.tokens.json'), (data) => {
    data.base.color.primary.$value = ['#', 'ab', 'cd', 'ef'].join('');
  });
  assert.equal(build(work).status, 0);
  const after = fingerprints(lock(work));
  const changed = [...before].filter(([name, value]) => after.get(name) !== value).map(([name]) => name).sort();
  assert.deepEqual(changed, [
    'base.color.primary',
    'controls.shared.button',
    'controls.shared.button#size=large,tone=primary',
    'controls.shared.button#size=large,tone=quiet',
    'controls.shared.button#size=small,tone=primary',
    'controls.shared.button#size=small,tone=quiet',
    'overlays.shared.panel',
    'primitives.shared.surface',
    'primitives.shared.surface.fill',
  ]);
});

test('(d) schema-marked annotations do not change fingerprints', (t) => {
  const work = workspace(t);
  assert.equal(build(work).status, 0);
  const before = fingerprints(lock(work));
  updateJson(path.join(work.catalog, '01-primitives.tokens.json'), (data) => {
    const record = data.primitives.shared.surface.$extensions['app.caelos'];
    record.lifecycle = 'promoted';
    record.draftedBy = 'changed annotation';
    record.gapFill = 'nearest';
  });
  assert.equal(build(work).status, 0);
  assert.deepEqual(fingerprints(lock(work)), before);
});

test('(e) dependents walk references, including madeOf, without value-based false positives', (t) => {
  const work = workspace(t);
  const primary = build(work, ['--dependents', 'base.color.primary']);
  assert.equal(primary.status, 0, primary.stderr);
  assert.deepEqual(primary.stdout.trim().split('\n'), [
    'base.color.primary',
    'controls.shared.button',
    'controls.shared.button#size=large,tone=primary',
    'controls.shared.button#size=large,tone=quiet',
    'controls.shared.button#size=small,tone=primary',
    'controls.shared.button#size=small,tone=quiet',
    'overlays.shared.panel',
    'primitives.shared.surface',
    'primitives.shared.surface.fill',
  ]);
  const same = build(work, ['--dependents', 'base.color.same-a']);
  assert.equal(same.status, 0, same.stderr);
  assert.deepEqual(same.stdout.trim().split('\n'), [
    'base.color.same-a',
    'controls.shared.same-value-a',
    'primitives.shared.equal-a',
    'primitives.shared.equal-a.fill',
  ]);
});

test('a sharedConstruction selector remap moves the button fingerprint', (t) => {
  const work = liveWorkspace(t);
  assert.equal(build(work).status, 0);
  const before = lock(work).entries['controls.shared.button'].fingerprint;
  updateJson(path.join(work.catalog, '02-controls.tokens.json'), (data) => {
    data.controls.$extensions['app.caelos'].sharedConstruction.parameters.spacing['15px'] =
      '{base.space.px-12}';
  });
  const result = build(work);
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(lock(work).entries['controls.shared.button'].fingerprint, before);
});

test('--dependents includes a control reached only through sharedConstruction', (t) => {
  const work = liveWorkspace(t);
  const result = build(work, ['--dependents', 'base.space.px-15']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim().split('\n').includes('controls.shared.button'));
});

test('(f) description edits change the change fingerprint but not the content fingerprint', (t) => {
  const work = workspace(t);
  assert.equal(build(work).status, 0);
  const before = lock(work).entries['primitives.shared.surface'];
  updateJson(path.join(work.catalog, '01-primitives.tokens.json'), (data) => {
    data.primitives.shared.surface.$description = 'A new description of the same rendered surface.';
  });
  assert.equal(build(work).status, 0);
  const after = lock(work).entries['primitives.shared.surface'];
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.equal(after.contentFingerprint, before.contentFingerprint);
});

test('(g) variant content includes the axis-to-resolved-value pairing', (t) => {
  const work = workspace(t);
  updateJson(path.join(work.catalog, '01-primitives.tokens.json'), (data) => {
    const original = data.primitives.shared.surface;
    original.$extensions['app.caelos'].variants = {
      bodyMaterial: ['cloud', 'glass'],
      stripMaterial: ['cloud', 'glass'],
    };
    data.primitives.shared.rebuilt = structuredClone(original);
    data.primitives.shared.changed = structuredClone(original);
    data.primitives.shared.changed.fill.$value = 'different-rendered-value';
  });
  assert.equal(build(work).status, 0);
  const entries = lock(work).entries;
  assert.equal(
    entries['primitives.shared.surface'].variantContentFingerprints['bodyMaterial=cloud,stripMaterial=glass'],
    entries['primitives.shared.rebuilt'].variantContentFingerprints['bodyMaterial=cloud,stripMaterial=glass'],
  );
  assert.notEqual(
    entries['primitives.shared.surface'].variantContentFingerprints['bodyMaterial=cloud,stripMaterial=glass'],
    entries['primitives.shared.surface'].variantContentFingerprints['bodyMaterial=glass,stripMaterial=cloud'],
  );
  assert.notEqual(
    entries['primitives.shared.surface'].variantContentFingerprints['bodyMaterial=cloud,stripMaterial=glass'],
    entries['primitives.shared.changed'].variantContentFingerprints['bodyMaterial=cloud,stripMaterial=glass'],
  );
});

test('(h) empty is written only for entries and variants with no resolved token or madeOf name', (t) => {
  const work = workspace(t);
  updateJson(path.join(work.catalog, '01-primitives.tokens.json'), (data) => {
    data.primitives.shared.empty = {
      $extensions: {
        'app.caelos': {
          states: ['idle'],
          variants: { tone: ['quiet', 'loud'] },
        },
      },
    };
  });
  assert.equal(build(work).status, 0);
  const entries = lock(work).entries;
  assert.equal(entries['primitives.shared.empty'].empty, true);
  assert.deepEqual(entries['primitives.shared.empty'].emptyVariants, ['tone=loud', 'tone=quiet']);
  assert.equal(Object.hasOwn(entries['primitives.shared.surface'], 'empty'), false);
  assert.equal(Object.hasOwn(entries['controls.shared.button'], 'empty'), false);
});

function command(cwd, commandName, args = [], env = {}) {
  return spawnSync(commandName, args, {
    cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024,
  });
}

function git(cwd, args, input) {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function tree(cwd, directory = '.') {
  const entries = readdirSync(path.join(cwd, directory), { withFileTypes: true })
    .filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules')
    .sort((left, right) => left.name.localeCompare(right.name));
  const rows = entries.map((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return `040000 tree ${tree(cwd, relative)}\t${entry.name}`;
    assert.ok(entry.isFile(), `fixture path must be a file: ${relative}`);
    const mode = statSync(path.join(cwd, relative)).mode & 0o111 ? '100755' : '100644';
    const hash = git(cwd, ['hash-object', '-w', '--', relative]);
    return `${mode} blob ${hash}\t${entry.name}`;
  });
  return git(cwd, ['mktree'], rows.length ? `${rows.join('\n')}\n` : '');
}

function snapshot(cwd, message = 'fixture snapshot') {
  const commit = git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit-tree', tree(cwd), '-m', message], undefined);
  git(cwd, ['update-ref', 'HEAD', commit]);
  git(cwd, ['read-tree', 'HEAD']);
}

function generatedWorkspace(t, { components = false } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'caelos-generated-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, 'generated/components'), { recursive: true });
  mkdirSync(path.join(cwd, 'token_catalog'), { recursive: true });
  const buildCommand = components
    ? `node ${JSON.stringify(generator)} --catalog token_catalog --templates ${JSON.stringify(templates)} --out generated/components && node build-rest.mjs`
    : 'node build-rest.mjs';
  writeFileSync(path.join(cwd, 'package.json'), `${JSON.stringify({
    private: true,
    scripts: { 'build:all': buildCommand, 'check:generated': `node ${JSON.stringify(generatedCheck)}` },
  }, null, 2)}\n`);
  writeFileSync(path.join(cwd, 'source.txt'), 'expected\n');
  writeFileSync(path.join(cwd, 'lock-source.txt'), 'lock expected\n');
  writeFileSync(path.join(cwd, 'build-rest.mjs'), [
    "import { copyFileSync, mkdirSync } from 'node:fs';",
    "if (process.env.FAIL_BUILD === '1') throw new Error('planted build failure');",
    "mkdirSync('generated', { recursive: true });",
    "copyFileSync('source.txt', 'generated/tokens.css');",
    "copyFileSync('lock-source.txt', 'token_catalog/versions.lock.json');",
    '',
  ].join('\n'));
  if (components) {
    for (const file of readdirSync(generatorFixture).filter((name) => name.endsWith('.fixture.json'))) {
      cpSync(path.join(generatorFixture, file), path.join(cwd, 'token_catalog', file.replace('.fixture.json', '.tokens.json')));
    }
  }
  assert.equal(command(cwd, 'npm', ['run', 'build:all']).status, 0);
  git(cwd, ['init', '-q']);
  snapshot(cwd);
  return cwd;
}

function noCommitGeneratedWorkspace(t) {
  const cwd = generatedWorkspace(t);
  git(cwd, ['update-ref', '-d', 'HEAD']);
  return cwd;
}

function indexSnapshot(t, cwd) {
  const snapshotDirectory = mkdtempSync(path.join(tmpdir(), 'caelos-generated-snapshot-'));
  t.after(() => rmSync(snapshotDirectory, { recursive: true, force: true }));
  git(cwd, ['checkout-index', '--all', `--prefix=${snapshotDirectory}${path.sep}`]);
  return snapshotDirectory;
}

test('(s) check:generated accepts a clean staged build in a repository with no commits', (t) => {
  const cwd = noCommitGeneratedWorkspace(t);
  const result = command(indexSnapshot(t, cwd), 'npm', ['run', 'check:generated'], {
    CAELOS_CATALOG_GIT_ROOT: cwd,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('(t) check:generated refuses a staged hand edit in a repository with no commits', (t) => {
  const cwd = noCommitGeneratedWorkspace(t);
  writeFileSync(path.join(cwd, 'generated/tokens.css'), 'staged hand edit\n');
  git(cwd, ['add', '--', 'generated/tokens.css']);
  const result = command(indexSnapshot(t, cwd), 'npm', ['run', 'check:generated'], {
    CAELOS_CATALOG_GIT_ROOT: cwd,
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /generated\/tokens\.css/u);
});

test('(u) check:generated refuses a staged stale lock in a repository with no commits', (t) => {
  const cwd = noCommitGeneratedWorkspace(t);
  writeFileSync(path.join(cwd, 'token_catalog/versions.lock.json'), 'staged stale lock\n');
  git(cwd, ['add', '--', 'token_catalog/versions.lock.json']);
  const result = command(indexSnapshot(t, cwd), 'npm', ['run', 'check:generated'], {
    CAELOS_CATALOG_GIT_ROOT: cwd,
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /token_catalog\/versions\.lock\.json/u);
});

test('(j) check:generated refuses a committed hand edit and names the generated file', (t) => {
  const cwd = generatedWorkspace(t);
  writeFileSync(path.join(cwd, 'generated/tokens.css'), 'hand edit\n');
  snapshot(cwd, 'hand edit');
  const result = command(cwd, 'npm', ['run', 'check:generated']);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /generated\/tokens\.css/u);
});

test('(g) check:generated refuses a stale lock and names it', (t) => {
  const cwd = generatedWorkspace(t);
  writeFileSync(path.join(cwd, 'token_catalog/versions.lock.json'), 'stale lock\n');
  snapshot(cwd, 'stale lock');
  const result = command(cwd, 'npm', ['run', 'check:generated']);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /token_catalog\/versions\.lock\.json/u);
});

test('(h) skipped component output is removed, and untracked generated output is refused', (t) => {
  const cwd = generatedWorkspace(t, { components: true });
  const catalogFile = path.join(cwd, 'token_catalog/02-controls.tokens.json');
  updateJson(catalogFile, (data) => {
    delete data.controls.shared.Button.$extensions['app.caelos'].kind;
  });
  snapshot(cwd, 'entry skipped with stale generated files');
  const stale = command(cwd, 'npm', ['run', 'check:generated']);
  assert.notEqual(stale.status, 0, `${stale.stdout}\n${stale.stderr}`);
  assert.match(`${stale.stdout}\n${stale.stderr}`, /generated\/components\/Button\.(?:css|tsx)/u);

  command(cwd, 'npm', ['run', 'build:all']);
  snapshot(cwd, 'clean skipped output');
  writeFileSync(path.join(cwd, 'generated/components/Untracked.txt'), 'untracked output\n');
  const untracked = command(cwd, 'npm', ['run', 'check:generated']);
  assert.notEqual(untracked.status, 0, `${untracked.stdout}\n${untracked.stderr}`);
  assert.match(`${untracked.stdout}\n${untracked.stderr}`, /generated\/components\/Untracked\.txt/u);
});

test('(i) check:generated fails closed when the build fails', (t) => {
  const cwd = generatedWorkspace(t);
  const result = command(cwd, 'npm', ['run', 'check:generated'], { FAIL_BUILD: '1' });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /planted build failure/u);
});

test('(k) check:generated skips a candidate tree without running its build', (t) => {
  const work = workspace(t);
  assert.equal(build(work).status, 0);
  writeFileSync(path.join(work.cwd, 'package.json'), `${JSON.stringify({
    private: true,
    scripts: { build: 'node -e "throw new Error(\\\'candidate build ran\\\')"' },
  }, null, 2)}\n`);

  const result = command(work.cwd, process.execPath, [generatedCheck, '--candidate', work.cwd]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(
    result.stdout,
    'check:generated: candidate lock matches trusted rebuild; component outputs skipped\n',
  );
  assert.equal(result.stderr, '');
});

test('(l) check:generated rejects a missing candidate directory with exit 2', (t) => {
  const cwd = generatedWorkspace(t);
  const result = command(cwd, process.execPath, [generatedCheck, '--candidate', path.join(cwd, 'missing')]);
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
});

test('(m) the unit workflow checks generated files after installing dependencies', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/unit.yml'), 'utf8');
  const install = workflow.indexOf('- run: npm ci --ignore-scripts');
  const generated = workflow.indexOf('- run: npm run check:generated');
  assert.notEqual(generated, -1, 'unit.yml must run check:generated');
  assert.ok(generated > install, 'check:generated must follow npm ci');
});

test('(attack) a madeOf cycle exits non-zero and names the cycle', (t) => {
  const work = workspace(t);
  updateJson(path.join(work.catalog, '01-primitives.tokens.json'), (data) => {
    data.primitives.shared.surface.$extensions['app.caelos'].madeOf = ['controls.shared.button'];
  });
  const result = build(work);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /madeOf cycle:/u);
  assert.match(result.stderr, /primitives\.shared\.surface/u);
  assert.match(result.stderr, /controls\.shared\.button/u);
});
