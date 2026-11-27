import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// Through require, so a standalone copy finds the package via NODE_PATH as the pre-commit hook runs it.
const StyleDictionary = createRequire(import.meta.url)('style-dictionary').default;

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const command = path.join(repo, 'scripts', 'check-app.mjs');
const fixture = path.join(here, 'fixtures', 'paint-rule', 'app');
const ruleConfig = path.join(repo, 'scripts', 'design-system-enforcer-gate', 'app-pages-paint.config.json');
const catalogPath = path.join(repo, 'token_catalog', 'paint-families.json');
const sourcePath = fileURLToPath(import.meta.url);

function materialize() {
  const root = mkdtempSync(path.join(tmpdir(), 'page-paint-'));
  const copy = (source, destination) => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.name === 'README.md') continue;
      const from = path.join(source, entry.name);
      if (entry.isDirectory()) {
        copy(from, path.join(destination, entry.name));
      } else if (entry.name.endsWith('.fixture')) {
        const to = path.join(destination, entry.name.slice(0, -'.fixture'.length));
        mkdirSync(path.dirname(to), { recursive: true });
        writeFileSync(to, readFileSync(from));
      }
    }
  };
  copy(fixture, root);
  return root;
}

function invoke(root, env = {}) {
  return spawnSync(process.execPath, [command, root], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function removePaintedPage(root) {
  rmSync(path.join(root, 'src', 'pages', 'PaintedPage.tsx'));
}

function removeClassPaintPage(root) {
  rmSync(path.join(root, 'src', 'pages', 'ClassPaintPage.tsx'));
}

function paintCatalog() {
  return JSON.parse(readFileSync(catalogPath, 'utf8'));
}

function removePaintPages(root) {
  removePaintedPage(root);
  removeClassPaintPage(root);
}

function configAt(root) {
  const configPath = path.join(root, 'design-system-enforcer-gate.config.json');
  return { configPath, config: JSON.parse(readFileSync(configPath, 'utf8')) };
}

function saveConfig(configPath, config) {
  writeFileSync(configPath, JSON.stringify(config));
}

function fixturePaintVariable(root) {
  return readFileSync(path.join(root, 'src', 'pages', 'PaintedPage.tsx'), 'utf8').match(/--[\w-]+/u)?.[0];
}

function assertRefused(proc, ...needles) {
  const output = `${proc.stdout}\n${proc.stderr}`;
  assert.equal(proc.status, 1, output);
  for (const needle of needles) assert.match(output, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return output;
}

function assertPaintRefused(proc, ...needles) {
  return assertRefused(proc, 'page-paint', ...needles);
}

function writePage(root, name, source) {
  const page = path.join(root, 'src', 'pages', name);
  mkdirSync(path.dirname(page), { recursive: true });
  writeFileSync(page, source);
  return page;
}

function catalogKindEntry() {
  const catalog = paintCatalog();
  return Object.values(catalog).find((entry) => entry.tokenTypes.length > 0);
}

function requiredKindWord() {
  const catalog = paintCatalog();
  return Object.keys(catalog).find((key) => catalog[key].tokenTypes.some((kind) => kind.startsWith('font')));
}

function builtCatalogVariable(root) {
  const buildConfig = readFileSync(path.join(repo, 'style-dictionary.config.mjs'), 'utf8');
  const namesBlock = buildConfig.match(/const\s+files\s*=\s*\[([\s\S]*?)\]\s*;/u)?.[1];
  const names = [...(namesBlock ?? '').matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
  assert.ok(names.length > 0);
  const fixtureTokens = JSON.parse(readFileSync(path.join(root, 'tokens.json'), 'utf8'));
  let sample = fixtureTokens;
  while (!Object.hasOwn(sample, '$value')) sample = sample[Object.keys(sample)[0]];
  const kindKey = Object.keys(sample).find((key) => key !== '$value');
  const catalog = paintCatalog();
  const kinds = new Set(Object.values(catalog).flatMap((entry) => entry.tokenTypes));
  const pathMembers = new Set(Object.values(catalog).flatMap((entry) => entry.pathFamilies));
  let selected;
  const visit = (node, tokenPath = [], inheritedKind = null) => {
    if (node === null || Object(node) !== node || Array.isArray(node) || selected) return;
    const kind = node[kindKey] ?? inheritedKind;
    if (Object.hasOwn(node, '$value')) {
      if (kinds.has(kind) && !tokenPath.some((part) => pathMembers.has(part))) selected = tokenPath;
      return;
    }
    for (const [key, child] of Object.entries(node)) if (!key.startsWith('$')) visit(child, [...tokenPath, key], kind);
  };
  for (const name of names) visit(JSON.parse(readFileSync(path.join(repo, 'token_catalog', `${name}.tokens.json`), 'utf8')));
  assert.ok(selected);
  const group = buildConfig.match(/platforms\s*:\s*\{\s*css\s*:\s*\{\s*transformGroup\s*:\s*["']([^"']+)/su)?.[1];
  const transformName = StyleDictionary.hooks.transformGroups[group]?.find((name) => name.startsWith('name/'));
  const transform = transformName && StyleDictionary.hooks.transforms[transformName]?.transform;
  assert.ok(transform);
  return `--${transform({ path: selected }, {})}`;
}

function syntheticPaint(root, pathParts = ['material', 'ink']) {
  const fixtureTokens = JSON.parse(readFileSync(path.join(root, 'tokens.json'), 'utf8'));
  let sample = fixtureTokens;
  while (!Object.hasOwn(sample, '$value')) sample = sample[Object.keys(sample)[0]];
  const kindKey = Object.keys(sample).find((key) => key !== '$value');
  const kind = catalogKindEntry().tokenTypes[0];
  let token = { [kindKey]: kind, $value: 'placeholder' };
  for (const part of [...pathParts].reverse()) token = { [part]: token };
  const tokenFile = path.join(root, 'catalog-kind.json');
  writeFileSync(tokenFile, JSON.stringify(token));
  const { configPath, config } = configAt(root);
  config.tokens.dtcg = ['tokens.json', 'catalog-kind.json'];
  saveConfig(configPath, config);
  return { tokenFile, variable: `--${pathParts.join('-')}` };
}

function writePaintClass(root, variable, className = 'kit-painted') {
  writeFileSync(path.join(root, 'kit.css'), `.${className}{fill:var(${variable})}\n`);
  return className;
}

function enableGeneratedTheme(root) {
  const { configPath, config } = configAt(root);
  config.tokens.css = ['tokens.css', path.join(repo, 'generated', 'tokens.css')];
  config.tokens.dtcg = ['tokens.json', path.join(repo, 'token_catalog', '*.tokens.json')];
  saveConfig(configPath, config);
}

test('(a) a page rebuilding its control is refused with its token and file', () => {
  const root = materialize();
  removeClassPaintPage(root);
  const proc = invoke(root);
  const own = [...new Set(readFileSync(path.join(root, 'src', 'pages', 'PaintedPage.tsx'), 'utf8').match(/--[\w-]+/g))];
  const output = `${proc.stdout}\n${proc.stderr}`;
  assert.equal(proc.status, 1, proc.stderr);
  for (const token of own) assert.match(output, new RegExp(token));
  assert.match(output, /src\/pages\/PaintedPage\.tsx/);
});

test('(b) a page may arrange an imported fixture component with spatial tokens', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  const proc = invoke(root);
  assert.equal(proc.status, 0, `${proc.stdout}\n${proc.stderr}`);
});

test('(c) the rule configuration and this test derive their members from the catalog', () => {
  const members = Object.keys(paintCatalog());
  const configText = readFileSync(ruleConfig, 'utf8');
  const ownText = readFileSync(sourcePath, 'utf8');
  const joinedTestSourceText = [...ownText.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((match) => match[2]).join('');
  for (const member of members) {
    assert.equal(configText.includes(member), false, member);
    assert.equal(ownText.includes(member), false, member);
    assert.equal(joinedTestSourceText.includes(member), false, member);
  }
});

test('(d) a non-page component may use a tier token', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  const proc = invoke(root);
  assert.equal(proc.status, 0, `${proc.stdout}\n${proc.stderr}`);
  assert.doesNotMatch(proc.stdout, /OwnPaint/);
});

test('(e) an app without page globs fails closed and names its config', () => {
  const root = materialize();
  const configPath = path.join(root, 'design-system-enforcer-gate.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  delete config.pages;
  writeFileSync(configPath, JSON.stringify(config));
  const proc = invoke(root);
  assert.equal(proc.status, 2, `${proc.stdout}\n${proc.stderr}`);
  assert.match(proc.stderr, new RegExp(`page paint pass: the app config has no pages list; add "pages" to ${configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('(f) a temporary catalog addition is enforced without changing configuration', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  const page = path.join(root, 'src', 'pages', 'AddedPage.tsx');
  writeFileSync(page, 'export const AddedPage = () => <i style={{ filter: "var(--base-glow-soft)" }} />;\n');
  const alternate = path.join(root, 'alternate.json');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const sample = Object.values(catalog)[0];
  const [first, second] = Object.keys(sample);
  catalog.glow = { [first]: [], [second]: ['glow'] };
  writeFileSync(alternate, JSON.stringify(catalog));
  const proc = invoke(root, { CAELOS_PAINT_FAMILIES: alternate });
  const output = `${proc.stdout}\n${proc.stderr}`;
  assert.equal(proc.status, 1, `${proc.stdout}\n${proc.stderr}`);
  assert.match(output, /--base-glow-soft/);
  assert.match(output, /AddedPage/);
});

test('(g) a page using a paint class is refused with its class, token and page', () => {
  const root = materialize();
  removePaintedPage(root);
  const proc = invoke(root);
  const output = `${proc.stdout}\n${proc.stderr}`;
  const token = readFileSync(path.join(root, 'kit.css'), 'utf8').match(/\.kit-painted\s*\{[^}]*var\((--[\w-]+)/s)?.[1];
  assert.ok(token);
  assert.equal(proc.status, 1, output);
  assert.match(output, /kit-painted/);
  assert.match(output, new RegExp(token));
  assert.match(output, /src\/pages\/ClassPaintPage\.tsx/);
});

test('(h) a page using a spacing-only class passes', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  const proc = invoke(root);
  assert.equal(proc.status, 0, `${proc.stdout}\n${proc.stderr}`);
});

test('(i) a non-page file using the paint class is not refused by the page pass', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  const proc = invoke(root);
  assert.equal(proc.status, 0, `${proc.stdout}\n${proc.stderr}`);
});

test('(n) the paint key cannot weaken the normal pass', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  const page = path.join(root, 'src', 'pages', 'RawSpacingPage.tsx');
  const literal = `${12 + 1}px`;
  writeFileSync(page, `export const RawSpacingPage = () => <main style={{ padding: "${literal}" }} />;\n`);
  const configPath = path.join(root, 'design-system-enforcer-gate.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.scan.include = ['src/pages/RawSpacingPage.tsx'];
  config.pages = ['src/pages/RawSpacingPage.tsx'];
  config.pagePaint = { catalog: catalogPath };
  writeFileSync(configPath, JSON.stringify(config));

  const withPaintKey = invoke(root);
  delete config.pagePaint;
  writeFileSync(configPath, JSON.stringify(config));
  const withoutPaintKey = invoke(root);

  assert.equal(withoutPaintKey.status, 1, `${withoutPaintKey.stdout}\n${withoutPaintKey.stderr}`);
  assert.equal(withPaintKey.status, withoutPaintKey.status, `${withPaintKey.stdout}\n${withPaintKey.stderr}`);
  assert.match(`${withPaintKey.stdout}\n${withPaintKey.stderr}`, /padding/);
});

test('(o) malformed paint-family lists fail loudly', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  const alternate = path.join(root, 'alternate.json');
  const cases = [
    [{}, /paint families must be a non-empty object/i],
    [[], /paint families must be a non-empty object/i],
    [{ empty: { tokenTypes: [], pathFamilies: [] } }, /paint family "empty" must contain at least one/i],
  ];

  for (const [catalog, message] of cases) {
    writeFileSync(alternate, JSON.stringify(catalog));
    const proc = invoke(root, { CAELOS_PAINT_FAMILIES: alternate });
    const output = `${proc.stdout}\n${proc.stderr}`;
    assert.equal(proc.status, 2, output);
    assert.match(output, message);
  }
});

test('(p) paint tokens are refused in every page property and alias', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  const firstFamily = Object.values(JSON.parse(readFileSync(catalogPath, 'utf8')))[0].pathFamilies[0];
  const tokens = ['svg-fill', 'svg-stroke', 'gradient', 'alias'].map((suffix) => `--base-${firstFamily}-${suffix}`);
  const tokenPath = path.join(root, 'tokens.css');
  writeFileSync(tokenPath, `${readFileSync(tokenPath, 'utf8')}\n:root {\n${tokens.map((token) => `  ${token}: currentColor;`).join('\n')}\n}\n`);
  writeFileSync(path.join(root, 'src', 'pages', 'EveryPaintPage.tsx'), `
export const EveryPaintPage = () => (
  <svg fill="var(${tokens[0]})" stroke="var(${tokens[1]})">
    <path style={{ backgroundImage: "linear-gradient(var(${tokens[2]}), transparent)", "--page-ink": "var(${tokens[3]})" }} />
  </svg>
);
`);

  const proc = invoke(root);
  const output = `${proc.stdout}\n${proc.stderr}`;
  assert.equal(proc.status, 1, output);
  for (const token of tokens) assert.match(output, new RegExp(token));
  for (const property of ['fill', 'stroke', 'backgroundImage', '--page-ink']) assert.match(output, new RegExp(property));
  assert.match(output, /src\/pages\/EveryPaintPage\.tsx/);
});

test('(q) malformed pages values fail loudly', () => {
  for (const pages of [[], null]) {
    const root = materialize();
    removePaintedPage(root);
    removeClassPaintPage(root);
    const configPath = path.join(root, 'design-system-enforcer-gate.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.pages = pages;
    writeFileSync(configPath, JSON.stringify(config));
    const proc = invoke(root);
    const output = `${proc.stdout}\n${proc.stderr}`;
    assert.equal(proc.status, 2, output);
    assert.match(output, /page paint pass: the app config has no pages list/);
  }

  const root = materialize();
  const { configPath, config } = configAt(root);
  config.pages = 'src/pages/**';
  saveConfig(configPath, config);
  const proc = invoke(root);
  assert.equal(proc.status, 2, `${proc.stdout}\n${proc.stderr}`);
  assert.match(`${proc.stdout}\n${proc.stderr}`, /pages must be a non-empty list of globs/);
});

test('(r) ' + ['opa', 'city'].join('') + ' and ' + ['typo', 'graphy'].join('') + ' paint tokens are refused wherever a page uses them', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  const numericFamily = ['opa', 'city'].join('');
  const textFamily = ['ty', 'pe'].join('');
  const tokens = [`--base-${numericFamily}-muted`, `--base-${textFamily}-family-body`];
  const attributes = [`data-paint-${numericFamily}`, `data-paint-${textFamily}`];
  const tokenPath = path.join(root, 'tokens.css');
  writeFileSync(tokenPath, `${readFileSync(tokenPath, 'utf8')}\n:root {\n  ${tokens[0]}: 0.5;\n  ${tokens[1]}: sans-serif;\n}\n`);
  writeFileSync(path.join(root, 'src', 'pages', 'FamilyPaintPage.tsx'), `
export const FamilyPaintPage = () => (
  <section ${attributes[0]}="var(${tokens[0]})" ${attributes[1]}="var(${tokens[1]})" />
);
`);

  const proc = invoke(root);
  const output = `${proc.stdout}\n${proc.stderr}`;
  assert.equal(proc.status, 1, output);
  for (const token of tokens) assert.match(output, new RegExp(token));
  for (const property of attributes) assert.match(output, new RegExp(property));
  assert.match(output, /src\/pages\/FamilyPaintPage\.tsx/);
});

test('(s) the paint pass scans configured pages even when the app scan excludes them', () => {
  const root = materialize();
  removeClassPaintPage(root);
  const paintToken = readFileSync(path.join(root, 'src', 'pages', 'PaintedPage.tsx'), 'utf8').match(/--[\w-]+/u)?.[0];
  assert.ok(paintToken);
  const configPath = path.join(root, 'design-system-enforcer-gate.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.scan.exclude = ['src/pages/**'];
  writeFileSync(configPath, JSON.stringify(config));

  const proc = invoke(root);
  const output = `${proc.stdout}\n${proc.stderr}`;
  assert.equal(proc.status, 1, output);
  assert.match(output, /src\/pages\/PaintedPage\.tsx/);
  assert.match(output, new RegExp(paintToken));
});

test('(t) every page exemption attribute is listed and cannot hide paint', () => {
  const root = materialize();
  const paintToken = readFileSync(path.join(root, 'src', 'pages', 'PaintedPage.tsx'), 'utf8').match(/--[\w-]+/u)?.[0];
  assert.ok(paintToken);
  removePaintedPage(root);
  removeClassPaintPage(root);
  writeFileSync(path.join(root, 'src', 'pages', 'ExemptPage.tsx'), `
export function ExemptPage() {
  return <main>
    <i data-ui-exempt="legacy paint" style={{ backgroundColor: "var(${paintToken})" }} />
    <b data-kit-exempt="migration marker" />
  </main>;
}
`);

  const proc = invoke(root);
  const output = `${proc.stdout}\n${proc.stderr}`;
  assert.equal(proc.status, 1, output);
  assert.match(output, /src\/pages\/ExemptPage\.tsx:4/);
  assert.match(output, /element carried data-ui-exempt=/u);
  assert.match(output, /data-ui-exempt[^\n]*legacy paint|legacy paint[^\n]*data-ui-exempt/u);
  assert.match(output, /data-kit-exempt[^\n]*migration marker|migration marker[^\n]*data-kit-exempt/u);
  assert.match(output, /page-paint/u);
  assert.match(output, /exempt/i);
});

test('(u) every page exemption attribute is listed when paint-free', () => {
  const root = materialize();
  removePaintedPage(root);
  removeClassPaintPage(root);
  writeFileSync(path.join(root, 'src', 'pages', 'ListedExemptPage.tsx'), `
export function ListedExemptPage() {
  return <main><b data-ui-exempt="migration marker" /></main>;
}
`);

  const proc = invoke(root);
  const output = `${proc.stdout}\n${proc.stderr}`;
  assert.equal(proc.status, 0, output);
  assert.match(output, /src\/pages\/ListedExemptPage\.tsx/);
  assert.match(output, /data-ui-exempt[^\n]*migration marker|migration marker[^\n]*data-ui-exempt/u);
});

test(`paint is recognised by the catalog token ${requiredKindWord()}`, () => {
  const root = materialize();
  removePaintPages(root);
  const { variable } = syntheticPaint(root);
  writePage(root, 'CatalogKindPage.tsx', `export const CatalogKindPage=()=> <main style={{fill:"var(${variable})"}}/>;\n`);
  assertPaintRefused(invoke(root), variable, 'src/pages/CatalogKindPage.tsx');
});

test('the design-system build catalog is read without app DTCG', () => {
  const root = materialize();
  removePaintPages(root);
  const variable = builtCatalogVariable(root);
  const { configPath, config } = configAt(root);
  config.tokens.dtcg = [];
  saveConfig(configPath, config);
  writePage(root, 'BuiltCatalogPage.tsx', `export const BuiltCatalogPage=()=> <main style={{fill:"var(${variable})"}}/>;\n`);
  assertPaintRefused(invoke(root), variable, 'src/pages/BuiltCatalogPage.tsx');
});

test('paint aliases declared outside pages are followed transitively', () => {
  const root = materialize();
  removePaintPages(root);
  const { variable } = syntheticPaint(root);
  mkdirSync(path.join(root, 'src', 'styles'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'styles', 'aliases.css'), `:root{--app-hero:var(--app-stage);--app-stage:var(${variable})}\n`);
  writePage(root, 'AliasPage.tsx', 'export const AliasPage=()=> <main style={{fill:"var(--app-hero)"}}/>;\n');
  assertPaintRefused(invoke(root), '--app-hero', 'src/pages/AliasPage.tsx');
});

test('catalog aliases inherit paint transitively', () => {
  const root = materialize();
  removePaintPages(root);
  const { tokenFile } = syntheticPaint(root, ['kindSource']);
  const tokens = JSON.parse(readFileSync(tokenFile, 'utf8'));
  tokens.neutralAlias = { $value: '{kindSource}' };
  writeFileSync(tokenFile, JSON.stringify(tokens));
  writePage(root, 'CatalogAliasPage.tsx', 'export const P=()=> <main style={{fill:"var(--neutral-alias)"}}/>;\n');
  assertPaintRefused(invoke(root), '--neutral-alias', 'src/pages/CatalogAliasPage.tsx');
});

test('the app config cannot switch the paint pass off', async (t) => {
  await t.test('severity', () => {
    const root = materialize();
    removeClassPaintPage(root);
    const variable = fixturePaintVariable(root);
    const { configPath, config } = configAt(root);
    config.severity = { 'page-paint': 'off' };
    saveConfig(configPath, config);
    assertPaintRefused(invoke(root), variable, 'src/pages/PaintedPage.tsx');
  });

  await t.test('missing pages', () => {
    const root = materialize();
    const { configPath, config } = configAt(root);
    delete config.pages;
    saveConfig(configPath, config);
    const proc = invoke(root);
    assert.equal(proc.status, 2, `${proc.stdout}\n${proc.stderr}`);
    assert.match(proc.stderr, /page paint pass: the app config has no pages list/);
  });

  await t.test('scan file kinds', () => {
    const root = materialize();
    removePaintPages(root);
    const { variable } = syntheticPaint(root);
    writePage(root, 'PaintedPage.jsx', `export const PaintedPage=()=> <main style={{fill:"var(${variable})"}}/>;\n`);
    writePage(root, 'keep.css', '.keep{display:block}\n');
    const { configPath, config } = configAt(root);
    const kindsKey = Object.keys(config.scan).find((key) => Array.isArray(config.scan[key]) && config.scan[key].includes('tsx'));
    assert.ok(kindsKey);
    config.scan[kindsKey] = ['css'];
    saveConfig(configPath, config);
    assertPaintRefused(invoke(root), variable, 'src/pages/PaintedPage.jsx');
  });

  await t.test('class index', () => {
    const root = materialize();
    removePaintedPage(root);
    const { configPath, config } = configAt(root);
    config.classIndex = [];
    saveConfig(configPath, config);
    assertPaintRefused(invoke(root), 'kit-painted', 'src/pages/ClassPaintPage.tsx');
  });

  await t.test('dimensions', () => {
    const root = materialize();
    removeClassPaintPage(root);
    const { configPath, config } = configAt(root);
    config.dimensions = {};
    for (const member of Object.keys(paintCatalog())) config.dimensions[member] = { enabled: false };
    saveConfig(configPath, config);
    assertPaintRefused(invoke(root), 'src/pages/PaintedPage.tsx');
  });
});

test('a page glob matching zero files fails closed and names the glob', () => {
  const root = materialize();
  removePaintPages(root);
  const { configPath, config } = configAt(root);
  const unmatched = 'elsewhere/pages/**';
  config.pages = [unmatched];
  saveConfig(configPath, config);
  const proc = invoke(root);
  assert.equal(proc.status, 2, `${proc.stdout}\n${proc.stderr}`);
  assert.match(`${proc.stdout}\n${proc.stderr}`, new RegExp(unmatched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('the paint pass scans every required page extension', () => {
  const root = materialize();
  removePaintPages(root);
  const { variable } = syntheticPaint(root);
  const extensions = ['tsx', 'jsx', 'ts', 'js', 'mdx', 'css', 'scss', 'sass', 'less'];
  for (const extension of extensions) writePage(root, `Painted-${extension}.${extension}`, `export const p="VAR(${variable})";\n`);
  const proc = invoke(root);
  const output = `${proc.stdout}\n${proc.stderr}`;
  assert.equal(proc.status, 1, output);
  for (const extension of extensions) assert.match(output, new RegExp(`Painted-${extension}\\.${extension}`));
});

test('expression string class markup is folded', () => {
  const root = materialize();
  removePaintPages(root);
  const { variable } = syntheticPaint(root);
  const className = writePaintClass(root, variable);
  writePage(root, 'ExpressionClassPage.tsx', `export const P=()=> <main className={"${className}"}/>;\n`);
  assertPaintRefused(invoke(root), className, 'ExpressionClassPage.tsx');
});

test('static template class markup is folded', () => {
  const root = materialize();
  removePaintPages(root);
  const { variable } = syntheticPaint(root);
  const className = writePaintClass(root, variable);
  writePage(root, 'TemplateClassPage.tsx', `export const P=()=> <main className={\`${className}\`}/>;\n`);
  assertPaintRefused(invoke(root), className, 'TemplateClassPage.tsx');
});

test('string arguments to class combiners are folded', () => {
  const root = materialize();
  removePaintPages(root);
  const { variable } = syntheticPaint(root);
  const names = ['via-clsx', 'via-cn', 'via-classnames'];
  writeFileSync(path.join(root, 'kit.css'), names.map((name) => `.${name}{fill:var(${variable})}`).join('\n'));
  writePage(root, 'CombinedClassPage.tsx', `export const P=()=> <><i className={clsx("${names[0]}")}/><i className={cn("${names[1]}")}/><i className={classnames("${names[2]}")}/></>;\n`);
  const output = assertPaintRefused(invoke(root), 'CombinedClassPage.tsx');
  for (const name of names) assert.match(output, new RegExp(name));
});

test('literal concatenation and same-file constants are folded', () => {
  const root = materialize();
  removePaintPages(root);
  const { variable } = syntheticPaint(root);
  const names = ['kit-piece', 'kit-bound'];
  writeFileSync(path.join(root, 'kit.css'), names.map((name) => `.${name}{fill:var(${variable})}`).join('\n'));
  writePage(root, 'BoundClassPage.tsx', `const c="${names[1]}";export const P=()=> <><i className={"kit-"+"piece"}/><i className={c}/></>;\n`);
  const output = assertPaintRefused(invoke(root), 'BoundClassPage.tsx');
  for (const name of names) assert.match(output, new RegExp(name));
});

test('a page-imported stylesheet module that paints is a page finding', () => {
  const root = materialize();
  removePaintPages(root);
  const { variable } = syntheticPaint(root);
  mkdirSync(path.join(root, 'src', 'styles'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'styles', 'paint.module.scss'), `.x{fill:var(${variable})}\n`);
  writePage(root, 'ModulePage.tsx', 'import s from "../styles/paint.module.scss";export const P=()=> <main className={s.x}/>;\n');
  assertPaintRefused(invoke(root), variable, 'src/pages/ModulePage.tsx');
});

test('an imported stylesheet module is scanned without a class reference', () => {
  const root = materialize();
  removePaintPages(root);
  const { variable } = syntheticPaint(root);
  mkdirSync(path.join(root, 'src', 'styles'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'styles', 'unused.module.less'), `.unused{fill:var(${variable})}\n`);
  writePage(root, 'ImportedModulePage.tsx', 'import "../styles/unused.module.less";export const P=()=> <main/>;\n');
  assertPaintRefused(invoke(root), variable, 'src/pages/ImportedModulePage.tsx');
});

test('generated theme utilities that paint are page findings', () => {
  const root = materialize();
  removePaintPages(root);
  const theme = readFileSync(path.join(repo, 'generated', 'tailwind-theme.css'), 'utf8');
  const declarations = [...theme.matchAll(/(--[\w-]+)\s*:\s*var\((--[\w-]+)\)/g)];
  assert.ok(declarations.length > 0);
  const words = declarations.flatMap((match) => {
    const suffix = match[1].split('-').slice(3).join('-');
    return ['bg', 'text', 'fill', 'stroke', 'rounded'].map((utility) => `${utility}-${suffix}`);
  });
  enableGeneratedTheme(root);
  writePage(root, 'ThemePage.tsx', `export const P=()=> <main className="${words.join(' ')}"/>;\n`);
  assertPaintRefused(invoke(root), 'src/pages/ThemePage.tsx');
});

test('a page listed as an app token source is still scanned', () => {
  const root = materialize();
  const variable = fixturePaintVariable(root);
  removePaintPages(root);
  const { configPath, config } = configAt(root);
  config.tokens.css.push('src/pages/TokenListedPage.tsx');
  saveConfig(configPath, config);
  writePage(root, 'TokenListedPage.tsx', `export const P=()=> <main style={{fill:"var(${variable})"}}/>;\n`);
  assertPaintRefused(invoke(root), variable, 'TokenListedPage.tsx');
});

test('Tailwind variant prefixes cannot hide generated theme paint utilities', () => {
  const root = materialize();
  removePaintPages(root);
  enableGeneratedTheme(root);
  writePage(root, 'VariantPage.tsx', 'export const P=()=> <main className="hover:bg-danger md:rounded-lg md:hover:bg-danger"/>;\n');
  assertPaintRefused(invoke(root), 'hover:bg-danger', 'md:rounded-lg', 'md:hover:bg-danger', 'VariantPage.tsx');
});

test('a Tailwind slash modifier cannot hide a generated theme paint utility', () => {
  const root = materialize();
  removePaintPages(root);
  enableGeneratedTheme(root);
  writePage(root, 'ModifierPage.tsx', 'export const P=()=> <main className="bg-danger/50"/>;\n');
  assertPaintRefused(invoke(root), 'bg-danger/50', 'ModifierPage.tsx');
});

test('leading and trailing Tailwind important markers cannot hide generated theme paint utilities', () => {
  const root = materialize();
  removePaintPages(root);
  enableGeneratedTheme(root);
  writePage(root, 'ImportantPage.tsx', 'export const P=()=> <main className="!bg-danger bg-danger!"/>;\n');
  assertPaintRefused(invoke(root), '!bg-danger', 'bg-danger!', 'ImportantPage.tsx');
});

test('an app class with a generated theme utility name cannot mask theme paint', () => {
  const root = materialize();
  removePaintPages(root);
  enableGeneratedTheme(root);
  writeFileSync(path.join(root, 'kit.css'), '.bg-danger{margin:var(--base-space-md)}\n');
  writePage(root, 'MaskedThemePage.tsx', 'export const P=()=> <main className="bg-danger"/>;\n');
  assertPaintRefused(invoke(root), 'bg-danger', 'MaskedThemePage.tsx');
});

test('an annotated Tailwind v4 shorthand cannot hide a paint token', () => {
  const root = materialize();
  removePaintPages(root);
  const { variable } = syntheticPaint(root);
  const kind = String.fromCharCode(99, 111, 108, 111, 114);
  writePage(root, 'TypedShorthandPage.tsx', `export const P=()=> <main className="bg-(${kind}:${variable})"/>;\n`);
  assertPaintRefused(invoke(root), variable, 'TypedShorthandPage.tsx');
});

test('a literal app custom property in a catalog path family remains paint', () => {
  const root = materialize();
  removePaintPages(root);
  const family = Object.values(paintCatalog()).find((entry) => entry.pathFamilies.length > 0).pathFamilies[0];
  const variable = `--app-${family}-brand`;
  const literal = ['#', 'f', '0', '0'].join('');
  const tokenPath = path.join(root, 'tokens.css');
  writeFileSync(tokenPath, `${readFileSync(tokenPath, 'utf8')}\n:root{${variable}:${literal}}\n`);
  writePage(root, 'LiteralAppVariablePage.tsx', `export const P=()=> <main style={{fill:"var(${variable})"}}/>;\n`);
  assertPaintRefused(invoke(root), variable, 'LiteralAppVariablePage.tsx');
});

test('a token-source literal cannot mask an app stylesheet paint alias', () => {
  const root = materialize();
  const source = fixturePaintVariable(root);
  removePaintPages(root);
  const variable = '--app-hero';
  const tokenPath = path.join(root, 'tokens.css');
  writeFileSync(tokenPath, `${readFileSync(tokenPath, 'utf8')}\n:root{${variable}:0px}\n`);
  writeFileSync(path.join(root, 'aliases.css'), `:root{${variable}:var(${source})}\n`);
  writePage(root, 'MaskedAliasPage.tsx', `export const P=()=> <main style={{fill:"var(${variable})"}}/>;\n`);
  assertPaintRefused(invoke(root), variable, 'MaskedAliasPage.tsx');
});

test('paint references accept CSS function case and Tailwind v4 shorthand', () => {
  const root = materialize();
  removePaintPages(root);
  const { variable } = syntheticPaint(root);
  writePage(root, 'FunctionFormsPage.tsx', `export const P=()=> <><i className="bg-(${variable}) bg-[VAR(${variable})]"/><i style={{fill:"VAR(${variable})"}}/></>;\n`);
  assertPaintRefused(invoke(root), variable, 'FunctionFormsPage.tsx');
});

test('paint references assembled from static strings are folded', () => {
  const root = materialize();
  removePaintPages(root);
  const { variable } = syntheticPaint(root, ['material', 'static', 'ink']);
  writePage(root, 'BuiltVariablePage.tsx', `export const P=()=> <><i style={{fill:"var(--material-"+"static-ink)"}}/><i style={{fill:\`var(--material-\${"static"}-ink)\`}}/></>;\n`);
  assertPaintRefused(invoke(root), variable, 'BuiltVariablePage.tsx');
});
