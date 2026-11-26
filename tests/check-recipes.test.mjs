import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const checker = path.join(root, 'scripts/check-recipes.mjs');
const catalog = 'token_catalog';
const pattern = 'patterns.shared.notice';

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CI;
  return env;
}

function fixture(t, {
  baseFields = {}, basePaint = false, checkerPath = checker, commit = true, tier = 4,
} = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'catalog-recipe-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = (file, value) => {
    const destination = path.join(cwd, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const tierFile = `${catalog}/0${tier}-${tier === 3 ? 'overlays' : 'patterns'}.tokens.json`;
  function entry(fields = {}, description, paint = basePaint, paintValue = '{base.shared.ink}', tokenName = 'ink') {
    const notice = { $extensions: { 'app.caelos': { lifecycle: 'promoted', ...fields } } };
    if (description) notice.$description = description;
    if (paint) {
      notice[tokenName] = {
        $type: 'color', $value: paintValue,
        $extensions: { 'app.caelos': { lifecycle: 'promoted' } },
      };
    }
    write(tierFile, { [tier === 3 ? 'overlays' : 'patterns']: { shared: { notice } } });
  }
  mkdirSync(path.join(cwd, catalog));
  for (const file of ['recipe.schema.json', 'paint-families.json']) {
    copyFileSync(path.join(root, catalog, file), path.join(cwd, catalog, file));
  }
  write(`${catalog}/tier-line.exceptions.json`, basePaint ? [`${pattern}.ink`] : []);
  write(`${catalog}/00-foundations.tokens.json`, {
    base: { shared: {
      ink: {
        $type: 'color', $value: '#000000',
        $extensions: { 'app.caelos': { lifecycle: 'promoted' } },
      },
      space: { 'px-4': {
        $type: 'dimension', $value: '4px',
        $extensions: { 'app.caelos': { lifecycle: 'promoted' } },
      } },
    } },
  });
  write(`${catalog}/01-primitives.tokens.json`, {
    primitives: { shared: { ink: {
      $extensions: { 'app.caelos': { lifecycle: 'promoted' } },
      default: {
        $type: 'color', $value: '{base.shared.ink}',
        $extensions: { 'app.caelos': { lifecycle: 'promoted' } },
      },
    } } },
  });
  entry(baseFields);
  git('init', '-q');
  git('config', 'user.email', 'catalog-test@example.invalid');
  git('config', 'user.name', 'Catalog test');
  let base;
  if (commit) {
    git('add', '.');
    git('commit', '-qm', 'base');
    base = git('rev-parse', 'HEAD^{tree}');
  }
  const run = (...args) => spawnSync(process.execPath, [
    checkerPath, '--base', base ?? 'none', '--candidate', cwd, '--git-root', cwd, ...args,
  ], { cwd: root, encoding: 'utf8', env: cleanEnv() });
  const runNone = (...args) => spawnSync(process.execPath, [
    checkerPath, '--base', 'none', '--git-root', cwd, ...args,
  ], { cwd, encoding: 'utf8', env: cleanEnv({ CAELOS_CATALOG_GIT_ROOT: cwd }) });
  return { base, cwd, entry, git, run, runNone, tierFile, write };
}

function refused(result, rule, name = pattern) {
  assert.equal(result.status, 1, `expected refusal for ${rule}, got ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, new RegExp(`${name.replaceAll('.', '\\.')}.*${rule}`));
}

function trustedFixture(t, requiredFields) {
  const trusted = mkdtempSync(path.join(tmpdir(), 'catalog-trusted-test-'));
  t.after(() => rmSync(trusted, { recursive: true, force: true }));
  mkdirSync(path.join(trusted, 'scripts'), { recursive: true });
  mkdirSync(path.join(trusted, catalog), { recursive: true });
  mkdirSync(path.join(trusted, 'templates'), { recursive: true });
  copyFileSync(checker, path.join(trusted, 'scripts/check-recipes.mjs'));
  for (const file of ['recipe.schema.json', 'paint-families.json']) {
    copyFileSync(path.join(root, catalog, file), path.join(trusted, catalog, file));
  }
  const marker = path.join(trusted, 'template-executed');
  writeFileSync(path.join(trusted, 'templates/notice.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(marker)}, 'executed');`,
    `export const requiredFields = ${JSON.stringify(requiredFields)};`,
    "throw new Error('template executed');",
  ].join('\n'));
  return { checkerPath: path.join(trusted, 'scripts/check-recipes.mjs'), marker, trusted };
}

test('A1 reads tier data from an explicit candidate outside the trusted root', (t) => {
  const { entry, run } = fixture(t);
  entry({ kind: 'notice', madeOf: ['primitives.shared.ink'] }, undefined, true);
  refused(run(), 'paint enters only at tiers 0 to 2');
});

test('A2 reads trusted templates statically and never executes candidate or trusted modules', (t) => {
  const trusted = trustedFixture(t, ['tone']);
  const { cwd, entry, run } = fixture(t, { checkerPath: trusted.checkerPath });
  const candidateMarker = path.join(cwd, 'candidate-template-executed');
  mkdirSync(path.join(cwd, 'templates'));
  writeFileSync(path.join(cwd, 'templates/notice.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(candidateMarker)}, 'executed');`,
    'export const requiredFields = ["wrongField"];',
  ].join('\n'));
  entry({ kind: 'notice', madeOf: ['primitives.shared.ink'] }, 'changed');
  refused(run(), 'template requires tone');
  assert.equal(existsSync(trusted.marker), false);
  assert.equal(existsSync(candidateMarker), false);
  entry({ kind: 'notice', madeOf: ['primitives.shared.ink'], tone: 'neutral' }, 'changed');
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});

test('A2 refuses a template declaration that is not a JSON string array', (t) => {
  const trusted = trustedFixture(t, ['tone']);
  writeFileSync(path.join(trusted.trusted, 'templates/notice.mjs'), 'export const requiredFields = getFields();\n');
  const { entry, run } = fixture(t, { checkerPath: trusted.checkerPath });
  entry({ kind: 'notice', madeOf: ['primitives.shared.ink'] }, 'changed');
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /export const requiredFields = \[<JSON array of strings>\];/);
});

test('A3 refuses an unsupported keyword in the candidate schema', (t) => {
  const { cwd, run, write } = fixture(t);
  const schema = JSON.parse(readFileSync(path.join(cwd, catalog, 'recipe.schema.json')));
  schema.properties.lifecycle.maxLength = 20;
  write(`${catalog}/recipe.schema.json`, schema);
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /maxLength.*lifecycle.*does not implement/);
});

test('A3 refuses a candidate schema required-list shrink', (t) => {
  const { cwd, run, write } = fixture(t);
  const schema = JSON.parse(readFileSync(path.join(cwd, catalog, 'recipe.schema.json')));
  schema.required = [];
  write(`${catalog}/recipe.schema.json`, schema);
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required.*lifecycle.*restore/);
});

test('A3 refuses removed candidate paint families', (t) => {
  const { run, write } = fixture(t);
  write(`${catalog}/paint-families.json`, {
    type: { tokenTypes: ['fontFamily'], pathFamilies: ['type'] },
  });
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /paint family color.*restore/);
});

test('A4 refuses a symlinked candidate tier file without following it', (t) => {
  const { cwd, run, tierFile } = fixture(t);
  const outside = path.join(path.dirname(cwd), `${path.basename(cwd)}-tier.json`);
  t.after(() => rmSync(outside, { force: true }));
  writeFileSync(outside, '{}');
  unlinkSync(path.join(cwd, tierFile));
  symlinkSync(outside, path.join(cwd, tierFile));
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symlink.*replace the symlink with a regular file/i);
});

test('A2 uses the trusted paint families when candidate rules try to redefine paint', (t) => {
  const { entry, runNone, write } = fixture(t, { commit: false });
  write(`${catalog}/paint-families.json`, {
    neutral: { tokenTypes: [], pathFamilies: ['neutral'] },
  });
  entry({}, undefined, true);
  refused(runNone(), 'paint enters only at tiers 0 to 2');
});

test('A2 uses the trusted schema when the candidate schema omits recipe rules', (t) => {
  const { runNone, write } = fixture(t, { commit: false });
  write(`${catalog}/recipe.schema.json`, {
    type: 'object', required: ['lifecycle'], properties: { lifecycle: { type: 'string' } },
  });
  write('match.json', { notice: pattern });
  refused(runNone('--paired', 'match.json'), 'requires madeOf');
});

test('B adding layerOrder makes an incomplete entry changed', (t) => {
  const { entry, run } = fixture(t);
  entry({ layerOrder: ['surface'] });
  refused(run(), 'requires madeOf');
});

test('B deleting madeOf makes an incomplete entry changed', (t) => {
  const { entry, run } = fixture(t, { baseFields: { madeOf: ['primitives.shared.ink'] } });
  entry();
  refused(run(), 'requires madeOf');
});

test('B adding gapFill makes an incomplete entry changed', (t) => {
  const { entry, run } = fixture(t);
  entry({ gapFill: 'reference' });
  refused(run(), 'requires madeOf');
});

test('B adding siblings makes an incomplete entry changed', (t) => {
  const { entry, run } = fixture(t);
  entry({ siblings: ['notice-alt'] });
  refused(run(), 'requires madeOf');
});

test('B lifecycle, draftedBy and draftedAt alone do not make an entry changed', (t) => {
  const { entry, run } = fixture(t);
  entry({ lifecycle: 'draft', draftedBy: 'catalog', draftedAt: '2026-02-28T00:00:00Z' });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});

test('C refuses tier 4 madeOf that names tier 0 paint', (t) => {
  const { entry, run } = fixture(t);
  entry({ kind: 'notice', madeOf: ['base.shared.ink'] });
  refused(run(), 'madeOf names base.shared.ink.*list a tier 1 or 2 entry instead');
});

test('C permits tier 0 paint in madeOf only for an exact excepted token reference', (t) => {
  const { entry, run, write } = fixture(t);
  entry({ kind: 'notice', madeOf: ['base.shared.ink'] }, undefined, true);
  write(`${catalog}/tier-line.exceptions.json`, [`${pattern}.ink`]);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});

test('D1 refuses a stale paint exception', (t) => {
  const { run, write } = fixture(t);
  write(`${catalog}/tier-line.exceptions.json`, [`${pattern}.missing`]);
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stale exception patterns\.shared\.notice\.missing.*remove it from token_catalog\/tier-line\.exceptions\.json/);
});

test('D2 refuses changing the paint of an excepted token', (t) => {
  const { entry, run } = fixture(t, { baseFields: { kind: 'notice', madeOf: ['base.shared.ink'] }, basePaint: true });
  entry({ kind: 'notice', madeOf: ['base.shared.ink'] }, undefined, true, '{primitives.shared.ink.default}');
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /excepted token may not change its paint; move it to tier 1 or 2/);
});

const schemaCases = [
  ['type', { lifecycle: 3 }, /lifecycle violates its schema; expected string/],
  ['enum', { lifecycle: 'unknown' }, /lifecycle violates its schema; use one of/],
  ['minLength', { draftedBy: '' }, /draftedBy violates its schema; supply a non-empty string/],
  ['pattern', { kind: '123', madeOf: ['primitives.shared.ink'] }, /kind violates its schema; supply a structured identifier/],
  ['date-time format', { draftedAt: 'yesterday' }, /draftedAt violates its schema; supply a date and time with a timezone/],
  ['impossible calendar date', { draftedAt: '2026-02-30T00:00:00Z' }, /draftedAt violates its schema; supply a real calendar date/],
  ['minItems', { madeOf: [] }, /madeOf violates its schema; list at least one lower-tier entry/],
  ['uniqueItems', { madeOf: ['primitives.shared.ink', 'primitives.shared.ink'] }, /madeOf violates its schema; remove duplicate items/],
  ['items', { madeOf: [3] }, /madeOf violates its schema; expected string/],
];

for (const [keyword, fields, message] of schemaCases) {
  test(`E enforces ${keyword}`, (t) => {
    const { entry, run } = fixture(t);
    entry(fields, 'changed');
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  });
}

test('E enforces minProperties', (t) => {
  const { entry, run } = fixture(t, { tier: 3 });
  entry({ contents: {} }, 'changed');
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contents violates its schema; describe the accepted contents as structured data/);
});

test('F refuses base none in a repository with commits', (t) => {
  const { cwd } = fixture(t);
  const result = spawnSync(process.execPath, [checker, '--base', 'none', '--git-root', cwd], {
    cwd, encoding: 'utf8', env: cleanEnv({ CAELOS_CATALOG_GIT_ROOT: cwd }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--base none is only for a repository's first commit; pass --base <ref>/);
});

test('F refuses base none when CI is set', (t) => {
  const { cwd } = fixture(t, { commit: false });
  const result = spawnSync(process.execPath, [checker, '--base', 'none', '--git-root', cwd], {
    cwd, encoding: 'utf8', env: { ...cleanEnv({ CAELOS_CATALOG_GIT_ROOT: cwd }), CI: '1' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--base none is only for a repository's first commit/);
});

test('F refuses base none without the hook marker', (t) => {
  const { cwd } = fixture(t, { commit: false });
  const result = spawnSync(process.execPath, [checker, '--base', 'none', '--git-root', cwd], {
    cwd, encoding: 'utf8', env: cleanEnv(),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--base none is only for a repository's first commit/);
});

test('F accepts base none in a marked repository with no commits', (t) => {
  const { runNone } = fixture(t, { commit: false });
  const result = runNone();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no base given: changed-entry rule skipped/);
});

test('F refuses base none with a candidate different from cwd', (t) => {
  const { cwd } = fixture(t, { commit: false });
  const result = spawnSync(process.execPath, [
    checker, '--base', 'none', '--candidate', cwd, '--git-root', cwd,
  ], { cwd: root, encoding: 'utf8', env: cleanEnv({ CAELOS_CATALOG_GIT_ROOT: cwd }) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--base none is only for a repository's first commit/);
});

test('J1 does not split camelCase paint-family substrings', (t) => {
  const { entry, run, write } = fixture(t);
  entry({ kind: 'notice', madeOf: ['primitives.shared.ink'] }, 'changed', false);
  write(`${catalog}/04-patterns.tokens.json`, { patterns: { shared: { notice: {
    $extensions: { 'app.caelos': { lifecycle: 'promoted', kind: 'notice', madeOf: ['primitives.shared.ink'] } },
    inputType: {
      $type: 'dimension', $value: '{base.shared.space.px-4}',
      $extensions: { 'app.caelos': { lifecycle: 'promoted' } },
    },
  } } } });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});

for (const name of ['fill-opacity', 'backdrop-blur', 'shell-radius']) {
  test(`J1 treats ${name} as a whole-word paint family`, (t) => {
    const { run, write } = fixture(t);
    write(`${catalog}/04-patterns.tokens.json`, { patterns: { shared: { notice: {
      $extensions: { 'app.caelos': { lifecycle: 'promoted', kind: 'notice', madeOf: ['primitives.shared.ink'] } },
      [name]: {
        $type: 'dimension', $value: '{base.shared.space.px-4}',
        $extensions: { 'app.caelos': { lifecycle: 'promoted' } },
      },
    } } } });
    refused(run(), 'paint enters only at tiers 0 to 2');
  });
}

test('J2 permits display text keys but refuses prose sources and prose field names', (t) => {
  const trusted = trustedFixture(t, ['label', 'spec']);
  const { entry, run } = fixture(t, { checkerPath: trusted.checkerPath });
  const complete = { kind: 'notice', madeOf: ['primitives.shared.ink'], label: 'Visible label' };
  entry({ ...complete, spec: { label: 'Visible label', text: 'Visible text', title: 'Visible title', placeholder: 'Type here' } }, 'changed');
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  entry({ ...complete, spec: { source: 'unstructured prose' } }, 'changed');
  refused(run(), 'uses prose as a source');
  entry({ ...complete, spec: { description: 'neutral' } }, 'changed');
  refused(run(), 'uses prose as a source');
});

test('K requires contents only when the kind template requires it', (t) => {
  const noContents = trustedFixture(t, ['tone']);
  const first = fixture(t, { checkerPath: noContents.checkerPath, tier: 3 });
  first.entry({ kind: 'notice', madeOf: ['primitives.shared.ink'], tone: 'neutral' }, 'changed');
  let result = first.run();
  assert.equal(result.status, 0, result.stderr);

  const withContents = trustedFixture(t, ['contents']);
  const second = fixture(t, { checkerPath: withContents.checkerPath, tier: 3 });
  second.entry({ kind: 'notice', madeOf: ['primitives.shared.ink'] }, 'changed');
  refused(second.run(), 'template requires contents', 'overlays.shared.notice');
});

test('F4 refuses a missing recipe record', (t) => {
  const { run, write } = fixture(t);
  write(`${catalog}/04-patterns.tokens.json`, { patterns: { shared: { notice: {
    ink: { $type: 'dimension', $value: '{base.shared.space.px-4}' },
  } } } });
  refused(run(), 'missing recipe record');
});

test('F4 follows paint through an untyped neutral alias chain', (t) => {
  const { run, write } = fixture(t);
  write(`${catalog}/02-controls.tokens.json`, { controls: { shared: { neutral: {
    $value: '{base.shared.ink}',
    $extensions: { 'app.caelos': { lifecycle: 'promoted' } },
  } } } });
  // The tier 4 token has no $type and a neutral name: only the reference chain makes it paint.
  write(`${catalog}/04-patterns.tokens.json`, { patterns: { shared: { notice: {
    $description: 'changed',
    $extensions: { 'app.caelos': { lifecycle: 'promoted', kind: 'notice', madeOf: ['primitives.shared.ink'] } },
    ground: { $value: '{controls.shared.neutral}', $extensions: { 'app.caelos': { lifecycle: 'promoted' } } },
  } } } });
  refused(run(), 'declares paint token patterns\\.shared\\.notice\\.ground');
});

test('F4 requires kind on an active recipe', (t) => {
  const { entry, run } = fixture(t);
  entry({ madeOf: ['primitives.shared.ink'] }, 'changed');
  refused(run(), 'requires kind');
});
