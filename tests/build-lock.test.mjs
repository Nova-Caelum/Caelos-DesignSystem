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
    for (const [variant, fingerprint] of Object.entries(record.variants)) {
      result.set(`${entry}#${variant}`, fingerprint);
    }
  }
  return result;
}

function updateJson(file, update) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  update(value);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('(a) build-lock writes one fingerprint per entry and Cartesian variant', (t) => {
  const work = workspace(t);
  const result = build(work);
  assert.equal(result.status, 0, result.stderr);
  const document = lock(work);
  assert.match(document.entries['controls.shared.button'].fingerprint, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(document.entries['controls.shared.button'].variants), [
    'size=large,tone=primary',
    'size=large,tone=quiet',
    'size=small,tone=primary',
    'size=small,tone=quiet',
  ]);
  for (const fingerprint of Object.values(document.entries['controls.shared.button'].variants)) {
    assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  }
});

test('(b) two builds produce byte-identical lock files', (t) => {
  const work = workspace(t);
  assert.equal(build(work).status, 0);
  const first = readFileSync(work.lock);
  assert.equal(build(work).status, 0);
  assert.deepEqual(readFileSync(work.lock), first);
});

test('(c) a tier-0 change reaches direct references and transitive madeOf only', (t) => {
  const work = workspace(t);
  assert.equal(build(work).status, 0);
  const before = fingerprints(lock(work));
  updateJson(path.join(work.catalog, '00-foundations.tokens.json'), (data) => {
    data.base.color.primary.$value = '#abcdef';
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
    scripts: { build: buildCommand, 'check:generated': `node ${JSON.stringify(generatedCheck)}` },
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
  assert.equal(command(cwd, 'npm', ['run', 'build']).status, 0);
  git(cwd, ['init', '-q']);
  snapshot(cwd);
  return cwd;
}

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

  command(cwd, 'npm', ['run', 'build']);
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
  const cwd = generatedWorkspace(t);
  const packageFile = path.join(cwd, 'package.json');
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
  pkg.scripts.build = 'node -e "throw new Error(\\\'candidate build ran\\\')"';
  writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);

  const result = command(cwd, process.execPath, [generatedCheck, '--candidate', cwd]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout, 'check:generated: skipped for a candidate tree; the pull request\'s own build is checked by the unit workflow\n');
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
