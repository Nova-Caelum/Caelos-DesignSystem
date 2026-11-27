import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isRecipeRecord } from '../scripts/check-recipes.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const checker = path.join(root, 'scripts/check-duplicates.mjs');
const builder = path.join(root, 'scripts/build-lock.mjs');
const fixtures = path.join(root, 'tests/fixtures/duplicates');

function run(args, cwd = root, env = {}) {
  return spawnSync(process.execPath, [checker, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
  });
}

function git(cwd, args, input) {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function tree(cwd, directory = '.') {
  const entries = readdirSync(path.join(cwd, directory), { withFileTypes: true })
    .filter((entry) => entry.name !== '.git')
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

function snapshot(cwd) {
  git(cwd, ['init', '-q']);
  const commit = git(cwd, [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit-tree', tree(cwd), '-m', 'fixture base',
  ]);
  git(cwd, ['update-ref', 'HEAD', commit]);
  git(cwd, ['read-tree', 'HEAD']);
}

function baseArgs(work, extra = []) {
  return [
    '--lock', work.lock,
    '--candidate', work.cwd,
    '--base', 'HEAD',
    '--git-root', work.cwd,
    ...extra,
  ];
}

function fixture(name) {
  return path.join(fixtures, name);
}

function materializedReuseCatalog(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'caelos-duplicates-test-'));
  const catalog = path.join(cwd, 'token_catalog');
  cpSync(path.join(fixtures, 'reuse/token_catalog'), catalog, { recursive: true });
  for (const name of readdirSync(catalog)) {
    if (name.endsWith('.fixture.json')) {
      const source = path.join(catalog, name);
      cpSync(source, path.join(catalog, name.replace('.fixture.json', '.tokens.json')));
    }
  }
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, catalog, lock: path.join(catalog, 'versions.lock.json') };
}

function materializedLiveCatalog(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'caelos-live-duplicates-test-'));
  const catalog = path.join(cwd, 'token_catalog');
  cpSync(path.join(root, 'token_catalog'), catalog, { recursive: true });
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, catalog, lock: path.join(catalog, 'versions.lock.json') };
}

function materializedLockCatalog(t, name, { commit = true } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'caelos-duplicates-lock-test-'));
  const catalog = path.join(cwd, 'token_catalog');
  cpSync(path.join(fixtures, 'records/token_catalog'), catalog, { recursive: true });
  for (const file of readdirSync(catalog)) {
    if (file.endsWith('.fixture.json')) {
      cpSync(path.join(catalog, file), path.join(catalog, file.replace('.fixture.json', '.tokens.json')));
    }
  }
  cpSync(fixture(`${name}.lock.json`), path.join(catalog, 'versions.lock.json'));
  const candidateLock = readFileSync(path.join(catalog, 'versions.lock.json'), 'utf8');
  if (commit && name === 'exact-entries') {
    updateJson(path.join(catalog, 'versions.lock.json'), (document) => {
      document.entries['primitives.shared.rebuilt'].contentFingerprint = 'b'.repeat(64);
    });
  }
  if (commit && name === 'exact-variants') {
    updateJson(path.join(catalog, 'versions.lock.json'), (document) => {
      document.entries['controls.shared.beta'].variantContentFingerprints['size=compact'] = 'e'.repeat(64);
    });
  }
  if (commit) {
    snapshot(cwd);
    writeFileSync(path.join(catalog, 'versions.lock.json'), candidateLock);
  }
  else {
    git(cwd, ['init', '-q']);
  }
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, lock: path.join(catalog, 'versions.lock.json') };
}

function buildReuse(work) {
  return spawnSync(process.execPath, [
    builder, '--catalog', work.catalog, '--schema', path.join(work.catalog, 'recipe.schema.json'), '--out', work.lock,
  ], { cwd: work.cwd, encoding: 'utf8' });
}

function baselineReuse(work) {
  const result = buildReuse(work);
  assert.equal(result.status, 0, result.stderr);
  snapshot(work.cwd);
  return result;
}

function addDescriptiveCopy(record, inventoryName) {
  const copy = structuredClone(record);
  copy.$description = `A renamed description for ${inventoryName}.`;
  copy.$extensions ??= {};
  copy.$extensions['app.caelos'] ??= {};
  Object.assign(copy.$extensions['app.caelos'], {
    inventoryName,
    kind: 'component',
    figmaId: '123:456',
  });
  return copy;
}

function updateJson(file, update) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  update(value);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('(g) two leaf tokens with the same fingerprint are not reported', (t) => {
  const work = materializedReuseCatalog(t);
  baselineReuse(work);
  const entries = JSON.parse(readFileSync(work.lock, 'utf8')).entries;
  assert.equal(entries['primitives.shared.surface.fill'].fingerprint, entries['primitives.shared.surface.reused-fill'].fingerprint);
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 0, result.stderr);
});

test('(a) a rebuilt entry with a different inventory name is refused, naming both entries', (t) => {
  const work = materializedReuseCatalog(t);
  baselineReuse(work);
  const primitivesPath = path.join(work.catalog, '01-primitives.tokens.json');
  const primitives = JSON.parse(readFileSync(primitivesPath, 'utf8'));
  primitives.primitives.shared.rebuilt = structuredClone(primitives.primitives.shared.surface);
  primitives.primitives.shared.rebuilt.$extensions = {
    'app.caelos': { inventoryName: 'A differently named surface', lifecycle: 'draft' },
  };
  writeFileSync(primitivesPath, `${JSON.stringify(primitives, null, 2)}\n`);
  const build = buildReuse(work);
  assert.equal(build.status, 0, build.stderr);
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /primitives\.shared\.surface/u);
  assert.match(result.stderr, /primitives\.shared\.rebuilt/u);
});

test('(b) a rebuilt entry with a different description is refused, naming both entries', (t) => {
  const work = materializedReuseCatalog(t);
  baselineReuse(work);
  const primitivesPath = path.join(work.catalog, '01-primitives.tokens.json');
  updateJson(primitivesPath, (data) => {
    data.primitives.shared.rebuilt = structuredClone(data.primitives.shared.surface);
    data.primitives.shared.rebuilt.$description = 'Same component, described differently.';
  });
  const build = buildReuse(work);
  assert.equal(build.status, 0, build.stderr);
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /primitives\.shared\.surface/u);
  assert.match(result.stderr, /primitives\.shared\.rebuilt/u);
});

test('main\'s checker accepts the generated lock shape against the live catalog', (t) => {
  const work = materializedLiveCatalog(t);
  const build = buildReuse(work);
  assert.equal(build.status, 0, build.stderr);
  const mainChecker = path.join(work.cwd, 'main-check-duplicates.mjs');
  writeFileSync(mainChecker, git(root, ['show', 'origin/main:scripts/check-duplicates.mjs']));
  const result = spawnSync(process.execPath, [
    mainChecker, '--lock', work.lock, '--candidate', work.cwd,
  ], { cwd: work.cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('a renamed and re-described live menu copy with new descriptive fields is refused', (t) => {
  const work = materializedLiveCatalog(t);
  baselineReuse(work);
  updateJson(path.join(work.catalog, '03-overlays.tokens.json'), (data) => {
    data.overlays.shared.menuCopy = addDescriptiveCopy(data.overlays.shared.menu, 'renamedMenu');
  });
  assert.equal(buildReuse(work).status, 0);
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /overlays\.shared\.menuCopy/u);
  assert.match(result.stderr, /overlays\.shared\.menu/u);
});

test('a renamed and re-described live button copy with new descriptive fields is refused', (t) => {
  const work = materializedLiveCatalog(t);
  baselineReuse(work);
  updateJson(path.join(work.catalog, '02-controls.tokens.json'), (data) => {
    data.controls.shared.buttonCopy = addDescriptiveCopy(data.controls.shared.button, 'renamedButton');
  });
  assert.equal(buildReuse(work).status, 0);
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /controls\.shared\.buttonCopy/u);
  assert.match(result.stderr, /controls\.shared\.button/u);
});

test('the live pre-existing duplicate group is skipped loudly', (t) => {
  const work = materializedLiveCatalog(t);
  baselineReuse(work);
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    /pre-existing duplicate \(shrink-only\): overlays\.shared\.contextMenu, overlays\.shared\.menu/u,
  );
});

test('a third member joining the live pre-existing duplicate group is refused', (t) => {
  const work = materializedLiveCatalog(t);
  baselineReuse(work);
  updateJson(path.join(work.catalog, '03-overlays.tokens.json'), (data) => {
    data.overlays.shared.thirdMenu = structuredClone(data.overlays.shared.menu);
  });
  assert.equal(buildReuse(work).status, 0);
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /overlays\.shared\.contextMenu/u);
  assert.match(result.stderr, /overlays\.shared\.menu/u);
  assert.match(result.stderr, /overlays\.shared\.thirdMenu/u);
});

test('(c) a rebuilt entry with one resolved value changed passes', (t) => {
  const work = materializedReuseCatalog(t);
  baselineReuse(work);
  const primitivesPath = path.join(work.catalog, '01-primitives.tokens.json');
  updateJson(primitivesPath, (data) => {
    data.primitives.shared.rebuilt = structuredClone(data.primitives.shared.surface);
    data.primitives.shared.rebuilt.fill.$value = 'different-rendered-value';
  });
  const build = buildReuse(work);
  assert.equal(build.status, 0, build.stderr);
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 0, result.stderr);
});

test('an entry composed through madeOf has a different content fingerprint and passes', (t) => {
  const work = materializedReuseCatalog(t);
  baselineReuse(work);
  const entries = JSON.parse(readFileSync(work.lock, 'utf8')).entries;
  assert.notEqual(
    entries['primitives.shared.surface'].contentFingerprint,
    entries['controls.shared.composed-surface'].contentFingerprint,
  );
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 0, result.stderr);
});

test('(d) variants with identical axis-to-value pairs and entry content are refused', (t) => {
  const work = materializedLockCatalog(t, 'exact-variants');
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /controls\.shared\.alpha#size=compact/u);
  assert.match(result.stderr, /controls\.shared\.beta#size=compact/u);
});

test('(d) variants with matching labels but different content pass', (t) => {
  const work = materializedLockCatalog(t, 'different-variants');
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 0, result.stderr);
});

test('(d) a near duplicate is advisory JSON and exits zero', (t) => {
  const work = materializedLockCatalog(t, 'near');
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [{
    entries: ['primitives.shared.alpha', 'primitives.shared.beta'],
    kind: 'entry',
  }]);
});

test('(e) a missing candidate lock exits 2 and names the problem', (t) => {
  const work = materializedLockCatalog(t, 'near');
  const missing = path.join(work.cwd, 'token_catalog/missing.lock.json');
  const result = run(baseArgs({ ...work, lock: missing }), work.cwd);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing\.lock\.json/u);
});

test('the --near file receives advisory JSON instead of stdout', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'caelos-near-test-'));
  const near = path.join(directory, 'near.json');
  const work = materializedLockCatalog(t, 'near');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = run(baseArgs(work, ['--near', near]), work.cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(readFileSync(near, 'utf8')), [{
    entries: ['primitives.shared.alpha', 'primitives.shared.beta'],
    kind: 'entry',
  }]);
});

test('a malformed fingerprint field exits 2', (t) => {
  const work = materializedLockCatalog(t, 'malformed-fingerprint');
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /fingerprint/u);
});

test('a missing content fingerprint exits 2 and names the entry', (t) => {
  const work = materializedLockCatalog(t, 'missing-content-fingerprint');
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /content fingerprint/iu);
  assert.match(result.stderr, /primitives\.shared\.bad/u);
});

test('(f) the shared record rule includes depth-3 $value nodes only above tier 0', () => {
  const segments = ['family', 'shared', 'record'];
  assert.equal(isRecipeRecord(0, segments), false);
  assert.equal(isRecipeRecord(1, segments), true);
});

test('(1) base-and-candidate empty records pass and every skipped record is counted', (t) => {
  const work = materializedReuseCatalog(t);
  baselineReuse(work);
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
  assert.match(result.stderr, /not comparable \(empty in base and candidate\): 1 entries, 2 variants/u);
});

test('(1) --verbose names every skipped empty entry and variant', (t) => {
  const work = materializedReuseCatalog(t);
  baselineReuse(work);
  const result = run(baseArgs(work, ['--verbose']), work.cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /primitives\.shared\.empty-record/u);
  assert.match(result.stderr, /primitives\.shared\.empty-record#tone=loud/u);
  assert.match(result.stderr, /primitives\.shared\.empty-record#tone=quiet/u);
});

test('(2) an added empty record is refused and named', (t) => {
  const work = materializedReuseCatalog(t);
  baselineReuse(work);
  updateJson(path.join(work.catalog, '01-primitives.tokens.json'), (data) => {
    data.primitives.shared.addedEmpty = { $extensions: { 'app.caelos': { states: ['idle'] } } };
  });
  assert.equal(buildReuse(work).status, 0);
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /added empty.*primitives\.shared\.addedEmpty/iu);
});

test('(3) a record stripped to empty is refused and named', (t) => {
  const work = materializedReuseCatalog(t);
  baselineReuse(work);
  updateJson(path.join(work.catalog, '01-primitives.tokens.json'), (data) => {
    delete data.primitives.shared.surface.fill;
    delete data.primitives.shared.surface['reused-fill'];
  });
  assert.equal(buildReuse(work).status, 0);
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /newly emptied.*primitives\.shared\.surface/iu);
});

test('(4) identical non-empty records are refused and both are named', (t) => {
  const work = materializedLockCatalog(t, 'exact-entries');
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /primitives\.shared\.existing/u);
  assert.match(result.stderr, /primitives\.shared\.rebuilt/u);
});

test('(5) no --base fails closed with exit 2 and an instruction', (t) => {
  const work = materializedReuseCatalog(t);
  baselineReuse(work);
  const result = run(['--lock', work.lock, '--candidate', work.cwd], work.cwd);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /pass --base/iu);
});

test('(5) --base none skips empty-record comparison but still refuses content duplicates', (t) => {
  const passing = materializedReuseCatalog(t);
  git(passing.cwd, ['init', '-q']);
  assert.equal(buildReuse(passing).status, 0);
  const skipped = run(['--base', 'none'], passing.cwd, { CAELOS_CATALOG_GIT_ROOT: passing.cwd });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(
    skipped.stderr,
    'no base given: empty-record comparison skipped (1 entries, 2 variants not compared)\n',
  );

  const duplicate = materializedLockCatalog(t, 'exact-entries', { commit: false });
  const refused = run(['--base', 'none'], duplicate.cwd, { CAELOS_CATALOG_GIT_ROOT: duplicate.cwd });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /Duplicate entries: primitives\.shared\.existing and primitives\.shared\.rebuilt/u);
});

test('(5) a base without a lock fails closed with exit 2 and an instruction', (t) => {
  const work = materializedReuseCatalog(t);
  const build = buildReuse(work);
  assert.equal(build.status, 0, build.stderr);
  const candidateLock = readFileSync(work.lock, 'utf8');
  rmSync(work.lock);
  snapshot(work.cwd);
  writeFileSync(work.lock, candidateLock);
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /base.*lock|lock.*base/iu);
  assert.match(result.stderr, /pass --base/iu);
});

test('(6) swapped-axis variants are not duplicates', (t) => {
  const work = materializedReuseCatalog(t);
  updateJson(path.join(work.catalog, '01-primitives.tokens.json'), (data) => {
    data.primitives.shared.surface.$extensions = {
      'app.caelos': {
        variants: {
          bodyMaterial: ['cloud', 'glass'],
          stripMaterial: ['cloud', 'glass'],
        },
      },
    };
  });
  baselineReuse(work);
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 0, result.stderr);
});

test('(7) generated variants with identical pairs and content are duplicates', (t) => {
  const work = materializedReuseCatalog(t);
  updateJson(path.join(work.catalog, '01-primitives.tokens.json'), (data) => {
    data.primitives.shared.surface.$extensions = {
      'app.caelos': { variants: { tone: ['primary'] } },
    };
  });
  baselineReuse(work);
  updateJson(path.join(work.catalog, '01-primitives.tokens.json'), (data) => {
    data.primitives.shared.rebuilt = structuredClone(data.primitives.shared.surface);
  });
  assert.equal(buildReuse(work).status, 0);
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /primitives\.shared\.surface#tone=primary/u);
  assert.match(result.stderr, /primitives\.shared\.rebuilt#tone=primary/u);
});

test('a markerless base lock bootstraps emptiness from base tier files', (t) => {
  const work = materializedReuseCatalog(t);
  const build = buildReuse(work);
  assert.equal(build.status, 0, build.stderr);
  const candidateLock = readFileSync(work.lock, 'utf8');
  updateJson(work.lock, (document) => {
    for (const entry of Object.values(document.entries)) {
      delete entry.contentFingerprint;
      delete entry.variantContentFingerprints;
      delete entry.empty;
      delete entry.emptyVariants;
    }
  });
  snapshot(work.cwd);
  writeFileSync(work.lock, candidateLock);
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /base lock predates empty markers; base emptiness read from base tier files/u);
  assert.match(result.stderr, /not comparable \(empty in base and candidate\): 1 entries, 2 variants/u);
});

test('a markerless base lock bootstraps madeOf as non-empty content', (t) => {
  const work = materializedReuseCatalog(t);
  const build = buildReuse(work);
  assert.equal(build.status, 0, build.stderr);
  updateJson(work.lock, (document) => {
    for (const entry of Object.values(document.entries)) {
      delete entry.contentFingerprint;
      delete entry.variantContentFingerprints;
      delete entry.empty;
      delete entry.emptyVariants;
    }
  });
  snapshot(work.cwd);
  updateJson(path.join(work.catalog, '02-controls.tokens.json'), (data) => {
    delete data.controls.shared['composed-surface'].$extensions['app.caelos'].madeOf;
  });
  assert.equal(buildReuse(work).status, 0);
  const result = run(baseArgs(work), work.cwd);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /newly emptied.*controls\.shared\.composed-surface/iu);
});

test('check:catalog configures the duplicate check', () => {
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['check:duplicates'], 'node scripts/check-duplicates.mjs');
  assert.match(packageJson.scripts['check:catalog'], /\bcheck:duplicates\b/u);
});
