import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureRoot = path.join(root, 'tests/fixtures/viewer');
const skipLine = "build:viewer: skipped in candidate mode (the PR's own catalog is built by the viewer test in the unit workflow)";
const environment = { ...process.env };
delete environment.NODE_TEST_CONTEXT;
delete environment.CAELOS_CATALOG_GIT_ROOT;
let workspace;
let result;
let html = '';
let css = '';
let javascript = '';
let liveResult;
let liveHtml = '';
let catalogGitRoot;
let catalogRevision;

function run(command, arguments_, options = {}) {
  return spawnSync(command, arguments_, {
    cwd: root,
    encoding: 'utf8',
    ...options,
    env: { ...environment, ...options.env },
  });
}

function catalogOptions(options = {}) {
  return {
    ...options,
    env: { ...options.env, CAELOS_CATALOG_GIT_ROOT: catalogGitRoot },
  };
}

function materializeFixtures(source, target) {
  mkdirSync(target, { recursive: true });
  for (const file of readdirSync(source).filter((name) => name.endsWith('.fixture.json')).sort()) {
    copyFileSync(path.join(source, file), path.join(target, file.replace('.fixture.json', '.tokens.json')));
  }
}

function countLifecycleDrafts(value) {
  if (!value || typeof value !== 'object') return 0;
  const own = value.$extensions?.['app.caelos']?.lifecycle === 'draft' ? 1 : 0;
  return own + Object.values(value).reduce((sum, child) => sum + countLifecycleDrafts(child), 0);
}

function repositoryAt(directory, { remote = true } = {}) {
  mkdirSync(directory, { recursive: true });
  for (const arguments_ of [
    ['init', '-q'],
    ['config', 'user.email', 'viewer@example.test'],
    ['config', 'user.name', 'Viewer Test'],
  ]) {
    const command = run('git', arguments_, { cwd: directory });
    assert.equal(command.status, 0, command.stderr);
  }
  writeFileSync(path.join(directory, 'README.md'), 'viewer test repository\n');
  for (const arguments_ of [['add', 'README.md'], ['commit', '-qm', 'fixture']]) {
    const command = run('git', arguments_, { cwd: directory });
    assert.equal(command.status, 0, command.stderr);
  }
  if (remote) {
    const command = run('git', ['remote', 'add', 'origin', 'https://github.com/example/catalog'], { cwd: directory });
    assert.equal(command.status, 0, command.stderr);
  }
  return run('git', ['rev-parse', 'HEAD'], { cwd: directory }).stdout.trim();
}

function unpackCandidate(folder) {
  const candidate = path.join(folder, 'candidate-tree');
  const skipped = new Set(['.git', 'node_modules', 'dist']);
  cpSync(root, candidate, {
    recursive: true,
    filter: (source) => !skipped.has(path.basename(source)),
  });
  return candidate;
}

function baseArguments(folder, candidate) {
  const head = run('git', ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.status === 0) return ['--base', head.stdout.trim(), '--git-root', root];
  const base = path.join(folder, 'candidate-base');
  cpSync(candidate, base, { recursive: true });
  const git = (...arguments_) => {
    const command = run('git', [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'user.name=viewer-test',
      '-c', 'user.email=viewer@example.test',
      ...arguments_,
    ], { cwd: base });
    assert.equal(command.status, 0, command.stderr || command.stdout);
    return command.stdout.trim();
  };
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return ['--base', git('rev-parse', 'HEAD'), '--git-root', base];
}

function sourcePathAtLine(source, lineNumber) {
  const stack = [];
  const lines = source.split('\n');
  for (let index = 0; index < lineNumber; index += 1) {
    const match = /^(\s*)"((?:\\.|[^"\\])+)"\s*:/u.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    while (stack.at(-1)?.indent >= indent) stack.pop();
    stack.push({ indent, key: JSON.parse(`"${match[2]}"`) });
  }
  return stack.map(({ key }) => key);
}

function sourceLinks(document) {
  return [...document.matchAll(/<a href="([^"]+)"(?: [^>]*)?>/gu)]
    .map((match) => match[1])
    .filter((href) => /\/token_catalog\/[^#]+#L\d+$/u.test(href));
}

function tokenSourceLinks(document) {
  return [...document.matchAll(/<a href="([^"]+)" data-token-path="([^"]+)"/gu)]
    .map(([, link, tokenPath]) => ({ link, tokenPath }));
}

function familySourceLinks(document) {
  return [...document.matchAll(/<section[^>]+data-family="([^"]+)"[\s\S]*?<p class="source-line">Source: <a href="([^"]+)"/gu)]
    .map(([, familyPath, link]) => ({ familyPath, link }));
}

function assertLinkResolves(link, catalogFolder) {
  const match = /\/token_catalog\/([^#]+)#L(\d+)$/u.exec(link);
  assert.ok(match, `source link is not resolved: ${link}`);
  const [, file, lineText] = match;
  const line = Number.parseInt(lineText, 10);
  const source = readFileSync(path.join(catalogFolder, file), 'utf8');
  const linkedPath = sourcePathAtLine(source, line);
  assert.ok(linkedPath.length >= 3, `${file}:L${line} does not identify a family or token path`);
  return linkedPath;
}

before(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'caelos-viewer-test-'));
  const catalog = path.join(workspace, 'token_catalog');
  const generated = path.join(workspace, 'generated/components');
  const out = path.join(workspace, 'dist');
  materializeFixtures(fixtureRoot, catalog);
  catalogGitRoot = path.join(workspace, 'catalog-repository');
  catalogRevision = repositoryAt(catalogGitRoot);

  const generation = run(process.execPath, [
    path.join(root, 'scripts/generate-components.mjs'),
    '--catalog', catalog,
    '--templates', path.join(root, 'templates'),
    '--out', generated,
  ]);
  assert.equal(generation.status, 0, generation.stderr);

  result = run(process.execPath, [
    path.join(root, 'viewer/build.mjs'),
    '--catalog', catalog,
    '--generated', generated,
    '--out', out,
    '--now', '2026-11-26T00:00:00.000Z',
  ], catalogOptions());
  if (result.status === 0) {
    html = readFileSync(path.join(out, 'index.html'), 'utf8');
    css = readFileSync(path.join(out, 'app.css'), 'utf8');
    javascript = readFileSync(path.join(out, 'app.js'), 'utf8');
  }

  liveResult = run(process.execPath, [
    path.join(root, 'viewer/build.mjs'),
    '--catalog', path.join(root, 'token_catalog'),
    '--generated', path.join(workspace, 'live-generated/components'),
    '--out', path.join(workspace, 'live-dist'),
  ], catalogOptions());
  if (liveResult.status === 0) liveHtml = readFileSync(path.join(workspace, 'live-dist/index.html'), 'utf8');
});

after(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

function assertBuildPassed() {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('(a) the built viewer has one page per tier file', () => {
  assertBuildPassed();
  const expected = readdirSync(fixtureRoot)
    .filter((name) => name.endsWith('.fixture.json'))
    .map((name) => name.replace('.fixture.json', '.tokens.json'))
    .sort();
  const actual = [...html.matchAll(/data-tier-file="([^"]+)"/gu)].map((match) => match[1]).sort();
  assert.deepEqual(actual, expected);
});

test('(b) Button has a live attributed button for every state', () => {
  assertBuildPassed();
  const family = html.match(/<section[^>]+data-family="controls\.shared\.Button"[\s\S]*?<\/section>/u)?.[0] ?? '';
  const states = [...family.matchAll(/data-state-card="([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(states, ['default', 'hover', 'pressed', 'success', 'focus', 'disabled']);
  assert.equal((family.match(/<button\b[^>]*data-entry="controls\.shared\.Button"/gu) ?? []).length, states.length);
});

test('(c) every Button card lists token path, value and tier', () => {
  assertBuildPassed();
  const family = html.match(/<section[^>]+data-family="controls\.shared\.Button"[\s\S]*?<\/section>/u)?.[0] ?? '';
  const cards = family.split(/data-state-card=/u).slice(1);
  assert.equal(cards.length, 6);
  for (const card of cards) {
    assert.match(card, /data-token-path="controls\.shared\.Button\.foreground"/u);
    assert.match(card, /data-token-value="\{primitives\.shared\.typography\.tone\.default\}"/u);
    assert.match(card, /data-token-tier="2"/u);
  }
});

test('(d) the first screen counts lifecycle drafts, never status drafts', () => {
  assertBuildPassed();
  const expected = readdirSync(fixtureRoot)
    .filter((name) => name.endsWith('.fixture.json'))
    .map((name) => JSON.parse(readFileSync(path.join(fixtureRoot, name), 'utf8')))
    .reduce((sum, document) => sum + countLifecycleDrafts(document), 0);
  const button = html.match(/<section[^>]+data-family="controls\.shared\.Button"[\s\S]*?<\/section>/u)?.[0] ?? '';
  assert.match(html, new RegExp(`data-draft-count="${expected}"`, 'u'));
  assert.match(button, /data-lifecycle="promoted"/u);
  assert.doesNotMatch(button, /data-lifecycle="draft"/u);
});

test('(e) the first screen shows the oldest age and all generator gaps', () => {
  assertBuildPassed();
  assert.match(html, /data-oldest-draft-days="56"/u);
  assert.match(html, /data-gap-count="2"/u);
});

test('(f) state cards use a token-based responsive grid without horizontal clipping', () => {
  assertBuildPassed();
  const rule = css.match(/\.state-cards\s*\{([^}]*)\}/su)?.[1] ?? '';
  assert.match(rule, /repeat\(auto-fit, minmax\(var\(--sys-space-grid-column-min\), auto\)\)/u);
  assert.doesNotMatch(rule, /overflow-x/u);
});

test('(g) skipped live entries are named with generator reasons', () => {
  assertBuildPassed();
  assert.match(html, /not generated: missing or empty required field &quot;layerOrder&quot;/u);
  assert.match(html, /not generated: no template for kind &quot;viewer-fixture-unknown&quot;/u);
});

test('(attack) a tier > 0 record without $extensions is labelled incomplete', () => {
  assertBuildPassed();
  assert.match(html, /data-family="overlays\.shared\.IncompleteRecord"[\s\S]*?incomplete record/u);
});

test('tier 0 groups without recipe extensions have no lifecycle or incomplete label', () => {
  assertBuildPassed();
  const family = html.match(/<section[^>]+data-family="base\.grouped\.scale"[\s\S]*?<\/section>/u)?.[0] ?? '';
  assert.ok(family);
  assert.doesNotMatch(family, /Lifecycle:|data-lifecycle=|incomplete record/u);
});

test('duplicate leaf keys resolve to their exact JSON paths', () => {
  assertBuildPassed();
  const space = html.match(/href="([^"]+#L16)"[^>]+data-token-path="base\.space\.repeat"/u)?.[1];
  const blur = html.match(/href="([^"]+#L33)"[^>]+data-token-path="base\.blur\.repeat"/u)?.[1];
  assert.ok(space, 'base.space.repeat should link to line 16');
  assert.ok(blur, 'base.blur.repeat should link to line 33');
});

test('every fixture token and family source line resolves to its full JSON path', () => {
  assertBuildPassed();
  const catalog = path.join(workspace, 'token_catalog');
  for (const link of sourceLinks(html)) {
    assert.match(link, new RegExp(`/blob/${catalogRevision}/token_catalog/`, 'u'));
  }
  for (const { link, tokenPath } of tokenSourceLinks(html)) {
    assert.deepEqual(assertLinkResolves(link, catalog), tokenPath.split('.'));
  }
  for (const { familyPath, link } of familySourceLinks(html)) {
    assert.deepEqual(assertLinkResolves(link, catalog), familyPath.split('.'));
  }
});

test('the repository live catalog builds in temporary folders with resolved source lines', () => {
  assert.equal(liveResult.status, 0, liveResult.stderr || liveResult.stdout);
  assert.equal(existsSync(path.join(root, 'live-generated')), false);
  const expected = readdirSync(path.join(root, 'token_catalog')).filter((file) => /^0[0-5]-.*\.tokens\.json$/u.test(file));
  const tiers = [...liveHtml.matchAll(/data-tier-file="([^"]+)"/gu)];
  assert.equal(tiers.length, expected.length);
  const catalog = path.join(root, 'token_catalog');
  const links = sourceLinks(liveHtml);
  assert.ok(links.length > 0);
  for (const link of links) {
    assert.match(link, new RegExp(`/blob/${catalogRevision}/token_catalog/`, 'u'));
  }
  for (const { link, tokenPath } of tokenSourceLinks(liveHtml)) {
    assert.deepEqual(assertLinkResolves(link, catalog), tokenPath.split('.'));
  }
  for (const { familyPath, link } of familySourceLinks(liveHtml)) {
    assert.deepEqual(assertLinkResolves(link, catalog), familyPath.split('.'));
  }
});

test('candidate mode emits exactly the skip line and writes nothing', () => {
  const out = path.join(workspace, 'candidate-direct-out');
  const generated = path.join(workspace, 'candidate-direct-generated');
  const candidate = run(process.execPath, [
    path.join(root, 'viewer/build.mjs'),
    '--candidate', workspace,
    '--base', 'HEAD',
    '--git-root', root,
    '--out', out,
    '--generated', generated,
  ]);
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(candidate.stdout, `${skipLine}\n`);
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(generated), false);
});

test('a first commit (--base none) skips the viewer build out loud and writes nothing', () => {
  const out = path.join(workspace, 'first-commit-out');
  const generated = path.join(workspace, 'first-commit-generated');
  const result = run(process.execPath, [
    path.join(root, 'viewer/build.mjs'),
    '--base', 'none',
    '--out', out,
    '--generated', generated,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^build:viewer: skipped for a repository's first commit/u);
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(generated), false);
});

test('the catalog candidate attack cannot evaluate planted generated code', () => {
  const candidate = unpackCandidate(workspace);
  const marker = path.join(workspace, 'candidate-code-ran');
  const planted = path.join(candidate, 'generated/components/index.ts');
  mkdirSync(path.dirname(planted), { recursive: true });
  writeFileSync(planted, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'executed');\nexport {};\n`);
  const attack = run('npm', [
    'run', 'check:catalog', '--', '--candidate', candidate, ...baseArguments(workspace, candidate),
  ], catalogOptions());
  assert.equal(attack.status, 0, attack.stderr || attack.stdout);
  assert.equal(existsSync(marker), false);
  assert.equal(attack.stdout.split(skipLine).length - 1, 1, attack.stdout);
});

test('the browser bundle is a deferred classic script with hydratable server markup', () => {
  assertBuildPassed();
  assert.match(html, /<script defer src="\.\/app\.js"><\/script>/u);
  assert.doesNotMatch(html, /type="module"/u);
  assert.doesNotMatch(javascript, /^(?:import|export)\s/mu);
  assert.match(javascript, /^\(\(\) => \{/u);
  assert.match(html, /<!-- -->/u);
});

test('a missing GitHub remote fails loudly', () => {
  const repository = path.join(workspace, 'no-remote-repository');
  repositoryAt(repository, { remote: false });
  const missing = run(process.execPath, [
    path.join(root, 'viewer/build.mjs'),
    '--catalog', path.join(workspace, 'token_catalog'),
    '--generated', path.join(workspace, 'no-remote-generated'),
    '--out', path.join(workspace, 'no-remote-out'),
  ], { env: { CAELOS_CATALOG_GIT_ROOT: repository } });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read a GitHub remote for source links; set remote\.origin\.url or pass --repository <https:\/\/github\.com\/owner\/repo>/u);
});

test('--repository supplies source links and the build repository HEAD', () => {
  const repository = path.join(workspace, 'explicit-repository');
  const head = repositoryAt(repository);
  const out = path.join(workspace, 'explicit-repository-out');
  const explicit = run(process.execPath, [
    path.join(root, 'viewer/build.mjs'),
    '--catalog', path.join(workspace, 'token_catalog'),
    '--generated', path.join(workspace, 'explicit-repository-generated'),
    '--out', out,
    '--repository', 'https://github.com/example/viewer',
  ], { env: { CAELOS_CATALOG_GIT_ROOT: repository } });
  assert.equal(explicit.status, 0, explicit.stderr || explicit.stdout);
  const document = readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(document, new RegExp(`https://github\\.com/example/viewer/blob/${head}/token_catalog/00-foundations\\.tokens\\.json#L`, 'u'));
  assert.doesNotMatch(document, /\/blob\/main\//u);
});

test('an empty catalog folder fails and names the folder', () => {
  const catalog = path.join(workspace, 'empty-catalog');
  mkdirSync(catalog);
  const empty = run(process.execPath, [
    path.join(root, 'viewer/build.mjs'),
    '--catalog', catalog,
    '--generated', path.join(workspace, 'empty-generated'),
    '--out', path.join(workspace, 'empty-out'),
  ]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, new RegExp(`catalog folder has no tier files: ${catalog.replaceAll('\\', '\\\\')}`, 'u'));
});

test('viewer runtime versions are exact and equal to the lockfile', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  for (const dependency of ['esbuild', 'react', 'react-dom']) {
    assert.doesNotMatch(manifest.devDependencies[dependency], /^[~^]/u);
    assert.equal(manifest.devDependencies[dependency], lock.packages[`node_modules/${dependency}`].version);
  }
});
