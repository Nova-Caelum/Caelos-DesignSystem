import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const checker = path.join(root, 'scripts', 'check-generated.mjs');
const builder = path.join(root, 'scripts', 'build-lock.mjs');
const lockFixture = path.join(root, 'tests/fixtures/build-lock/token_catalog');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function workspace(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'check-generated-owner-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, 'generated', 'components'), { recursive: true });
  mkdirSync(path.join(cwd, 'token_catalog'), { recursive: true });
  mkdirSync(path.join(cwd, 'templates'), { recursive: true });
  writeFileSync(path.join(cwd, 'templates', 'Button.fixture'), 'export const Button = "fresh";\n');
  writeFileSync(path.join(cwd, 'build.mjs'), `
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('generated/components', { recursive: true });
copyFileSync('templates/Button.fixture', 'generated/components/Button.tsx');
writeFileSync('generated/tokens.css', ':root {}\\n');
writeFileSync('generated/tailwind-theme.css', '@theme {}\\n');
writeFileSync('token_catalog/versions.lock.json', '{}\\n');
`);
  writeFileSync(path.join(cwd, 'package.json'), `${JSON.stringify({
    private: true,
    scripts: { 'build:all': 'node build.mjs', 'check:generated': `node ${JSON.stringify(checker)}` },
  }, null, 2)}\n`);
  const built = spawnSync('npm', ['run', 'build:all'], { cwd, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  git(cwd, ['init', '-q']);
  git(cwd, ['add', '.']);
  git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  return cwd;
}

function check(cwd) {
  return spawnSync('npm', ['run', 'check:generated'], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function candidateWorkspace(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'check-generated-candidate-'));
  const catalog = path.join(cwd, 'token_catalog');
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(catalog, { recursive: true });
  cpSync(path.join(lockFixture, 'recipe.schema.json'), path.join(catalog, 'recipe.schema.json'));
  for (const file of readdirSync(lockFixture).filter((name) => name.endsWith('.fixture.json'))) {
    cpSync(path.join(lockFixture, file), path.join(catalog, file.replace('.fixture.json', '.tokens.json')));
  }
  const result = spawnSync(process.execPath, [
    builder,
    '--catalog', catalog,
    '--schema', path.join(catalog, 'recipe.schema.json'),
    '--out', path.join(catalog, 'versions.lock.json'),
  ], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return cwd;
}

test('a candidate lock that differs from the rebuild is refused, naming the entry', (t) => {
  const cwd = candidateWorkspace(t);
  const lockPath = path.join(cwd, 'token_catalog/versions.lock.json');
  const document = JSON.parse(readFileSync(lockPath, 'utf8'));
  document.entries['controls.shared.button'].fingerprint = 'f'.repeat(64);
  writeFileSync(lockPath, `${JSON.stringify(document, null, 2)}\n`);

  const result = spawnSync(process.execPath, [checker, '--candidate', cwd], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /controls\.shared\.button/u);
});

test('a committed generated component with no build owner is refused by file name', (t) => {
  const cwd = workspace(t);
  const extra = path.join(cwd, 'generated', 'components', 'Extra.tsx');
  writeFileSync(extra, 'export const Extra = true;\n');
  git(cwd, ['add', 'generated/components/Extra.tsx']);
  git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'hand-added output']);

  const result = check(cwd);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /generated\/components\/Extra\.tsx/u);
  assert.match(`${result.stdout}\n${result.stderr}`, /owner|not produced/u);
});

test('token files created by the build remain owned without a hand-maintained owner list', (t) => {
  const cwd = workspace(t);
  const result = check(cwd);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('a committed component stale after a template change is refused by file name', (t) => {
  const cwd = workspace(t);
  writeFileSync(path.join(cwd, 'templates', 'Button.fixture'), 'export const Button = "changed";\n');
  git(cwd, ['add', 'templates/Button.fixture']);
  git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'template changed without regeneration']);

  const result = check(cwd);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /generated\/components\/Button\.tsx/u);
  assert.match(`${result.stdout}\n${result.stderr}`, /differs/u);
  assert.equal(readFileSync(path.join(cwd, 'generated', 'components', 'Button.tsx'), 'utf8'),
    'export const Button = "changed";\n');
});
