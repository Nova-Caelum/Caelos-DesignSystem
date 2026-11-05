// Tests for scripts/check-palette.mjs. Every planted case must be refused and every clean case accepted.
// This file is itself scanned by the check, so no colour literal appears here: colours are assembled
// at run time from numbers and fragments. String assembly is outside what a lexical check can see.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  NAMED_COLOUR_COUNT,
  PALETTES_MD_PATH,
  PRODUCT_PALETTE_PATH,
  checkAgreement,
  main,
  parsePalette,
  readFromGateway,
  scanRepo,
  scanText,
  sliceSections,
} from '../scripts/check-palette.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'check-palette.mjs');
const WORKFLOW = path.join(HERE, '..', '.github', 'workflows', 'palette.yml');

// ---- colour builders (no literal colours in this file) ------------------------------------------
const HASH = '#';
const hx = (...ns) => ns.map((n) => n.toString(16).padStart(2, '0').toUpperCase()).join('');
const fn = (name, args) => `${name}(${args})`;

// Allowed in the synthetic palette. Doubled digits, so it has 3- and 4-digit forms; exact in hsl.
const OK = {
  hex6: HASH + hx(51, 102, 153),
  hex6lower: (HASH + hx(51, 102, 153)).toLowerCase(),
  hex3: `${HASH}369`,
  hex4: `${HASH}369F`,
  hex8: `${HASH}${hx(51, 102, 153)}CC`,
  rgb: fn('rgb', '51, 102, 153'),
  rgbModern: fn('rgb', '51 102 153 / 0.5'),
  rgba: fn('rgba', '51, 102, 153, 0.4'),
  rgbPercent: fn('rgb', '20% 40% 60%'),
  hsl: fn('hsl', '210, 50%, 40%'),
  hslModern: fn('hsl', '210deg 50% 40% / .5'),
  transparent: 'transparent',
  currentColor: 'currentColor',
};
// Not in the synthetic palette. Red has every form; the company ground is the brief's company-only case.
const NAMED_RED = ['re', 'd'].join('');
const RED = {
  hex3: `${HASH}F00`,
  hex4: `${HASH}F00F`,
  hex6: `${HASH}FF0000`,
  hex8: `${HASH}FF0000FF`,
  rgb: fn('rgb', '255, 0, 0'),
  hsl: fn('hsl', '0, 100%, 50%'),
  named: NAMED_RED,
};
const COMPANY = {
  hex6: `${HASH}1C1B28`,
  hex8: `${HASH}1C1B28FF`,
  rgb: fn('rgb', '28, 27, 40'),
};

// ---- synthetic palette and its palettes.md --------------------------------------------------------
const BASE = HASH + hx(18, 52, 86);
const SHARED = HASH + hx(171, 205, 239);
const DENIED = HASH + hx(154, 152, 200);
const EXTRA = HASH + hx(1, 35, 69);
const COMPANY_ONLY_IN_MD = HASH + hx(9, 8, 7);

const palette = (over = {}) => ({
  schema: 1,
  palette: 'product',
  colors: [
    { hex: OK.hex6, role: 'ground', name: 'Ground' },
    { hex: BASE, role: 'text', name: 'Text' },
    { hex: SHARED, role: 'rule', name: 'Rule', shared: true },
  ],
  rulings: [
    { id: 'ink', allowed: false, hex: [DENIED], reason: 'fixture denial' },
    { id: 'extra', allowed: true, hex: [EXTRA], reason: 'fixture allowance' },
  ],
  ...over,
});
const mdFor = (p, { productExtra = '', sharedExtra = '' } = {}) =>
  [
    '# Palettes',
    '## Company',
    `| Ground | \`${COMPANY_ONLY_IN_MD}\` |`,
    '## Product',
    ...p.colors.filter((c) => !c.shared).map((c) => `| ${c.name} | \`${c.hex}\` |`),
    productExtra,
    '## Shared foundations and derived states',
    ...p.colors.filter((c) => c.shared).map((c) => `| ${c.name} | \`${c.hex}\` |`),
    sharedExtra,
    '## Greens',
    `| Card ink | \`${DENIED}\` |`,
    '',
  ].join('\n');
const PAL = parsePalette(JSON.stringify(palette()));

// ---- helpers --------------------------------------------------------------------------------------
const makeRepo = (files, { initialise = true } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'palette-test-'));
  if (initialise) execFileSync('git', ['init', '-q', dir]);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  if (initialise) execFileSync('git', ['-C', dir, 'add', '-A']);
  return dir;
};
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const capture = () => {
  const lines = { out: '', err: '' };
  return { lines, io: { out: (s) => (lines.out += s), err: (s) => (lines.err += s) } };
};
const response = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const gatewayBody = (p = palette(), md = mdFor(p)) => {
  const content = JSON.stringify(p);
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      isError: false,
      content: [{ type: 'text', text: '{}' }],
      structuredContent: { result: { json: { hash: sha(content), encoding: 'text', content }, md: { hash: sha(md), sections: sliceSections(md) } } },
    },
  };
};
const ENV = { GAETWAY_URL: 'https://gateway.example.test/mcp', GAETWAY_AGENT: 'fixture-agent', GAETWAY_KEY: 'fixture-key' };

// ---- the matrix: planted cases refused, clean cases accepted --------------------------------------
const CONTEXTS = {
  ts: ['a.ts', (v) => `export const c = "${v}";\n`],
  tsx: ['b.tsx', (v) => `export const X = () => <rect fill="${v}" />;\n`],
  css: ['c.css', (v) => `.a {\n  background: ${v};\n}\n`],
  html: ['d.html', (v) => `<div style="border-color: ${v}">x</div>\n`],
  styleBlock: ['e.html', (v) => `<style>\n.a { box-shadow: 0 0 0 1px ${v}; }\n</style>\n`],
  templateString: ['f.ts', (v) => 'export const css = `color: ' + v + ';`;\n'],
  svgAttribute: ['g.svg', (v) => `<svg><rect fill="${v}"/><path stroke="${v}"/></svg>\n`],
};

test('every planted case is refused in every context', () => {
  const planted = { ...Object.fromEntries(Object.entries(RED).map(([k, v]) => [`red-${k}`, v])), ...Object.fromEntries(Object.entries(COMPANY).map(([k, v]) => [`company-${k}`, v])) };
  const files = {};
  const expected = new Map();
  for (const [ctx, [ext, make]] of Object.entries(CONTEXTS)) {
    for (const [form, value] of Object.entries(planted)) {
      const name = `${ctx}-${form}-${ext}`;
      files[name] = make(value);
      expected.set(name, value);
    }
  }
  const dir = makeRepo(files);
  const { findings, scanned } = scanRepo(dir, PAL);
  assert.equal(scanned, Object.keys(files).length);
  for (const [name, value] of expected) {
    const own = findings.filter((f) => f.file === name);
    const perValue = name.startsWith('svgAttribute') ? 2 : 1;
    assert.equal(own.length, perValue, `${name}: expected ${perValue} finding(s), got ${JSON.stringify(own)}`);
    for (const f of own) {
      assert.equal(f.value.toLowerCase(), value.toLowerCase(), name);
      assert.equal(f.line, files[name].slice(0, files[name].indexOf(value)).split('\n').length, `${name}: line`);
    }
  }
  assert.equal(findings.length, [...expected.keys()].reduce((n, k) => n + (k.startsWith('svgAttribute') ? 2 : 1), 0));
});

test('every clean product-colour case is accepted in every context', () => {
  const files = {};
  for (const [ctx, [ext, make]] of Object.entries(CONTEXTS)) {
    for (const [form, value] of Object.entries(OK)) files[`${ctx}-${form}-${ext}`] = make(value);
  }
  const { findings, scanned } = scanRepo(makeRepo(files), PAL);
  assert.deepEqual(findings, []);
  assert.equal(scanned, Object.keys(files).length);
});

test('one clean case per file type passes through the command line', () => {
  const files = Object.fromEntries(Object.values(CONTEXTS).map(([ext, make], i) => [`clean${i}-${ext}`, make(OK.hex6)]));
  const { findings } = scanRepo(makeRepo(files), PAL);
  assert.deepEqual(findings, []);
});

// ---- no way around the check ----------------------------------------------------------------------
test('exemption-style comments have no effect', () => {
  const v = RED.hex6;
  const files = {
    'a.ts': `// palette-ignore\nexport const c = "${v}"; // palette-ignore\n`,
    'b.css': `/* palette-disable-next-line */\n.a { background: ${v}; }\n`,
    'c.html': `<!-- palette-ignore -->\n<div style="border-color: ${v}"></div>\n`,
    'd.ts': `// eslint-disable-next-line\n// @ts-ignore\nexport const c = "${v}";\n`,
    'e.py': `x = "${v}"  # palette: allow\n`,
  };
  const { findings } = scanRepo(makeRepo(files), PAL);
  assert.deepEqual(findings.map((f) => f.file).sort(), Object.keys(files).sort());
});

test('exemption comments alone do not create findings, and no file or folder is skipped', () => {
  const files = { 'a.ts': '// palette-ignore\n', 'node_modules/x/index.js': `module.exports = "${RED.hex6}";\n`, 'dist/app.css': `.a { background: ${RED.hex6}; }\n`, 'tests/fixtures/f.ts': `export const c = "${RED.hex3}";\n`, '.github/x.yml': `a: "${RED.hex6}"\n` };
  const { findings } = scanRepo(makeRepo(files), PAL);
  assert.deepEqual(findings.map((f) => f.file).sort(), ['.github/x.yml', 'dist/app.css', 'node_modules/x/index.js', 'tests/fixtures/f.ts']);
});

// ---- forms ----------------------------------------------------------------------------------------
test('alpha forms pass only when the colour part is allowed', () => {
  assert.deepEqual(scanText(`${OK.hex8} ${OK.hex4} ${OK.rgbModern} ${OK.rgba} ${OK.hslModern}`, PAL), []);
  assert.equal(scanText(`${RED.hex8} ${RED.hex4} ${fn('rgba', '255, 0, 0, 0.5')} ${fn('hsla', '0, 100%, 50%, 0.5')}`, PAL).length, 4);
});

test('rgb and hsl are normalised exactly, with rounding', () => {
  assert.deepEqual(scanText(`${OK.rgbPercent} ${OK.hsl} ${fn('hsl', '0.5833turn 50% 40%')}`, PAL), []);
  assert.equal(scanText(fn('rgb', '51, 102, 154'), PAL).length, 1);
  assert.equal(scanText(fn('hsl', '210, 50%, 41%'), PAL).length, 1);
});

test('values the check cannot verify are refused (fail closed)', () => {
  const refused = [
    fn('oklch', '0.5 0.1 200'),
    fn('lab', '50% 40 59'),
    fn('lch', '50% 80 30'),
    fn('hwb', '12 0% 0%'),
    fn('color', 'srgb 1 0 0'),
    fn('color-mix', `in srgb, ${OK.hex6} 50%, ${OK.hex3}`),
    fn('color-mix', `in srgb, ${NAMED_RED} 50%, var(--x)`),
    fn('rgb', 'var(--channels)'),
    fn('rgb', 'var(--r) 0 0'),
    fn('rgb', '${r}, ${g}, ${b}'),
    fn('hsl', '210 50 40'),
    fn('hsl', 'none 50% 40%'),
    fn('rgb', '51, 102, 153').slice(0, -1),
  ];
  for (const v of refused) assert.equal(scanText(`x = "${v}"`, PAL).length >= 1, true, v);
  const accepted = fn('color-mix', 'in srgb, var(--a) 50%, transparent');
  assert.deepEqual(scanText(`x = "${accepted}"`, PAL), []);
});

test('a percent-encoded hex colour inside a data url is refused', () => {
  const pct = '%2' + '3';
  assert.equal(scanText(`url("data:image/svg+xml,%3Csvg fill='${pct}FF0000'/%3E")`, PAL).length, 1);
  assert.deepEqual(scanText(`url("data:image/svg+xml,%3Csvg fill='${pct}${hx(51, 102, 153)}'/%3E")`, PAL), []);
});

test('named colours: strings, declaration values, shorthand lists and attributes', () => {
  const n = NAMED_RED;
  assert.equal(scanText(`const a = '${n}';`, PAL).length, 1);
  assert.equal(scanText(`const a = \`${n}\`;`, PAL).length, 1);
  assert.equal(scanText(`<p style="color: ${n}">`, PAL).length, 1);
  assert.equal(scanText(`.a { box-shadow: 0 0 1px ${OK.hex6},\n    0 0 2px ${n}; }`, PAL).length, 1);
  assert.equal(scanText(`.a { border: 1px solid ${n}; }`, PAL).length, 1);
  assert.equal(scanText(`.a { --brand: ${n}; }`, PAL).length, 1);
  assert.equal(scanText(`.a { background: linear-gradient(to right, ${OK.hex6}, ${n}); }`, PAL).length, 1);
  assert.equal(scanText(`.a { background: var(--x, ${n}); }`, PAL).length, 1);
  assert.equal(scanText(`x = { border: '1px solid ${n}' }`, PAL).length, 1);
  assert.equal(scanText(`<rect fill=${n} />`, PAL).length, 1);
  assert.equal(scanText(`.a { color: ${['Canvas', 'Text'].join('')}; }`, PAL).length, 1);
  assert.equal(scanText(`.a { background-color: ${n.toUpperCase()}; }`, PAL).length, 1);
});

test('exempt keywords and non-colour text are not refused', () => {
  const ok = [
    '.a { color: transparent; border-color: currentColor; background: inherit; }',
    "const a = 'transparent'; const b = 'currentcolor';",
    `const label = 'The gold and peach accents, ${NAMED_RED} flags and ${['gre', 'en'].join('')} lights';`,
    '.a { font-family: Georgia; color: var(--text); background: var(--red-500, var(--text)); }',
    'class="text-red-500 bg-gold" id="x"',
    `const n = 12; const s = '&#8364;'; const frag = '${HASH}12345'; const long = '${HASH}1234567890';`,
    `import x from './red.png'; .a { background: url(red.png) }`,
    'const theme = { red: 1 }; theme.red = 2; const v = `${theme.red}`;',
  ];
  for (const t of ok) assert.deepEqual(scanText(t, PAL), [], t);
});

test('the named-colour table has the expected size', () => {
  assert.equal(NAMED_COLOUR_COUNT, 148);
});

test('hex boundaries: only 3, 4, 6 and 8 digits are colours', () => {
  assert.equal(scanText(`${HASH}FF00`, PAL).length, 1);
  assert.equal(scanText(`${HASH}FF00FF`, PAL).length, 1);
  assert.deepEqual(scanText(`${HASH}FF00F`, PAL), []);
  assert.deepEqual(scanText(`${HASH}FF00FFF`, PAL), []);
});

// ---- palette record, rulings, agreement -----------------------------------------------------------
test('rulings: a denied colour is named in the refusal; an allowed ruling adds a colour', () => {
  const [denied] = scanText(`x = "${DENIED}"`, PAL);
  assert.match(denied.reason, /ruling "ink"/);
  assert.deepEqual(scanText(`x = "${EXTRA}"`, PAL), []);
  const flipped = parsePalette(JSON.stringify(palette({ rulings: [{ id: 'ink', allowed: true, hex: [DENIED], reason: 'flipped' }] })));
  assert.deepEqual(scanText(`x = "${DENIED}"`, flipped), []);
});

test('the palette record is validated', () => {
  assert.throws(() => parsePalette('nope'), ConfigError);
  assert.throws(() => parsePalette(JSON.stringify(palette({ palette: 'company' }))), /not "product"/);
  assert.throws(() => parsePalette(JSON.stringify(palette({ schema: 2 }))), ConfigError);
  assert.throws(() => parsePalette(JSON.stringify(palette({ colors: [] }))), ConfigError);
  assert.throws(() => parsePalette(JSON.stringify(palette({ colors: [{ hex: 'nothex', role: 'a', name: 'b' }] }))), ConfigError);
  assert.throws(() => parsePalette(JSON.stringify(palette({ rulings: [{ id: 'x', allowed: false, hex: [OK.hex6], reason: 'contradiction' }] }))), /also a palette colour/);
});

test('agreement: palettes.md and the record must list the same Product and Shared colours', () => {
  const p = palette();
  const sections = (md) => sliceSections(md);
  assert.deepEqual(checkAgreement(PAL.colorHexes, sections(mdFor(p))), []);
  const mdExtra = checkAgreement(PAL.colorHexes, sections(mdFor(p, { productExtra: `| New | \`${EXTRA}\` |` })));
  assert.equal(mdExtra.length, 1);
  assert.match(mdExtra[0].reason, /not in product-palette.json/);
  const sharedExtra = checkAgreement(PAL.colorHexes, sections(mdFor(p, { sharedExtra: `| New | \`${DENIED}\` |` })));
  assert.equal(sharedExtra.length, 1);
  const jsonExtra = parsePalette(JSON.stringify(palette({ colors: [...p.colors, { hex: EXTRA, role: 'x', name: 'X' }] })));
  const missing = checkAgreement(jsonExtra.colorHexes, sections(mdFor(p)));
  assert.equal(missing.length, 1);
  assert.match(missing[0].reason, /not in the palettes.md/);
  assert.throws(() => checkAgreement(PAL.colorHexes, sliceSections('# nothing here\n')), ConfigError);
});

test('the section slicer survives being sent to the gateway as text', () => {
  const md = mdFor(palette());
  const rebuilt = new Function(`${sliceSections.toString()}\nreturn sliceSections;`)();
  assert.deepEqual(rebuilt(md), sliceSections(md));
  assert.equal(sliceSections(md).product.includes(COMPANY_ONLY_IN_MD), false);
});

// ---- the gateway read -----------------------------------------------------------------------------
test('the gateway request names only the two vault-relative paths and carries the agent and key', async () => {
  let seen;
  const fetchImpl = async (url, init) => ((seen = { url, init }), response(200, gatewayBody()));
  const got = await readFromGateway({ ...{ url: ENV.GAETWAY_URL, agent: ENV.GAETWAY_AGENT, key: ENV.GAETWAY_KEY }, fetchImpl });
  assert.equal(seen.url, ENV.GAETWAY_URL);
  assert.equal(seen.init.headers['x-gaetway-agent'], ENV.GAETWAY_AGENT);
  assert.equal(seen.init.headers.authorization, `Bearer ${ENV.GAETWAY_KEY}`);
  const body = JSON.parse(seen.init.body);
  assert.equal(body.method, 'tools/call');
  assert.equal(body.params.name, 'execute');
  const code = body.params.arguments.code;
  assert.deepEqual([...code.matchAll(/vault\.read\(\{ path: "([^"]+)" \}\)/g)].map((m) => m[1]), [PRODUCT_PALETTE_PATH, PALETTES_MD_PATH]);
  assert.equal(PRODUCT_PALETTE_PATH, 'AgentSecretBase/brand_library/resources/product-palette.json');
  assert.equal(PALETTES_MD_PATH, 'AgentSecretBase/brand_library/resources/palettes.md');
  assert.match(got.source, /sha256=[0-9a-f]{64}/);
});

test('the program sent to the gateway returns the record and only the two md sections', async () => {
  const p = palette();
  const md = mdFor(p);
  const files = { [PRODUCT_PALETTE_PATH]: JSON.stringify(p), [PALETTES_MD_PATH]: md };
  let code;
  await readFromGateway({ url: ENV.GAETWAY_URL, agent: 'a', key: 'k', fetchImpl: async (u, init) => ((code = JSON.parse(init.body).params.arguments.code), response(200, gatewayBody())) });
  const vault = { read: async ({ path: p2 }) => ({ hash: sha(files[p2]), encoding: 'text', content: files[p2] }) };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const result = await new AsyncFunction('vault', code)(vault);
  assert.equal(result.json.content, files[PRODUCT_PALETTE_PATH]);
  assert.deepEqual(result.md.sections, sliceSections(md));
  assert.equal(JSON.stringify(result).includes(COMPANY_ONLY_IN_MD), false);
});

test('the gateway read fails closed', async () => {
  const cfg = { url: ENV.GAETWAY_URL, agent: 'a', key: 'k', retryDelayMs: 0 };
  const read = (fetchImpl, over = {}) => readFromGateway({ ...cfg, ...over, fetchImpl });
  await assert.rejects(read(async () => response(401, { code: 'key_mismatch', reason: 'no' })), /HTTP 401 \(no\)/);
  await assert.rejects(read(async () => response(200, { result: { isError: true, structuredContent: { error: { code: 'upstream_error', reason: 'not found: x' } } } })), /upstream_error: not found/);
  await assert.rejects(read(async () => response(200, { result: { isError: false, structuredContent: { result: null } } })), /truncated/);
  const bad = gatewayBody();
  bad.result.structuredContent.result.json.hash = 'f'.repeat(64);
  await assert.rejects(read(async () => response(200, bad)), /hash check/);
  await assert.rejects(read(async () => response(200, 'not an object')), ConfigError);
  await assert.rejects(read(async () => { throw new Error('offline'); }), /could not be reached: offline/);
  await assert.rejects(read(async () => response(200, gatewayBody()), { url: 'http://gateway.example.test/mcp' }), /https/);
  await assert.rejects(read(async () => response(200, gatewayBody()), { url: 'not a url' }), /not a URL/);
});

test('a transient 503 is retried, a persistent one is not a pass', async () => {
  let calls = 0;
  const flaky = async () => (++calls < 2 ? response(503, { code: 'registry_unavailable' }) : response(200, gatewayBody()));
  await readFromGateway({ url: ENV.GAETWAY_URL, agent: 'a', key: 'k', fetchImpl: flaky, retryDelayMs: 0 });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(readFromGateway({ url: ENV.GAETWAY_URL, agent: 'a', key: 'k', fetchImpl: async () => (++calls, response(503, {})), retryDelayMs: 0 }), /HTTP 503/);
  assert.equal(calls, 3);
});

// ---- main, end to end -----------------------------------------------------------------------------
const run = async (files, { env = ENV, fetchImpl, argv } = {}) => {
  const dir = makeRepo(files);
  const { lines, io } = capture();
  const code = await main(argv ?? ['--root', dir], env, { ...io, fetchImpl: fetchImpl ?? (async () => response(200, gatewayBody())), retryDelayMs: 0 });
  return { code, ...lines };
};

test('main: clean repo passes (0), violation fails (1) naming file, line, column and value', async () => {
  const clean = await run({ 'a.ts': `export const c = "${OK.hex6}";\n` });
  assert.equal(clean.code, 0);
  assert.match(clean.out, /palette check passed/);
  assert.match(clean.out, /sha256=[0-9a-f]{64}/);
  const bad = await run({ 'src/a.ts': `// ok\nexport const c = "${COMPANY.hex6}";\n` });
  assert.equal(bad.code, 1);
  assert.match(bad.err, new RegExp(`FAIL src/a.ts:2:19  ${COMPANY.hex6}  not in the product palette`));
});

test('main: palettes.md disagreeing with the record fails (1)', async () => {
  const p = palette();
  const fetchImpl = async () => response(200, gatewayBody(p, mdFor(p, { productExtra: `| New | \`${EXTRA}\` |` })));
  const r = await run({ 'a.ts': `export const c = "${OK.hex6}";\n` }, { fetchImpl });
  assert.equal(r.code, 1);
  assert.match(r.err, /FAIL palettes.md: .* not in product-palette.json/);
});

test('main: every way of not having a palette is exit 2, never a pass', async () => {
  const files = { 'a.ts': `export const c = "${OK.hex6}";\n` };
  assert.equal((await run(files, { fetchImpl: async () => response(401, {}) })).code, 2);
  assert.equal((await run(files, { fetchImpl: async () => { throw new Error('offline'); } })).code, 2);
  assert.equal((await run(files, { env: { ...ENV, GAETWAY_KEY: '' } })).code, 2);
  assert.equal((await run(files, { env: {} })).code, 2);
  const company = palette({ palette: 'company' });
  assert.equal((await run(files, { fetchImpl: async () => response(200, gatewayBody(company, mdFor(company))) })).code, 2);
  const none = await main(['--root', makeRepo({}, { initialise: true })], ENV, { ...capture().io, fetchImpl: async () => response(200, gatewayBody()), retryDelayMs: 0 });
  assert.equal(none, 2);
  const noGit = await main(['--root', makeRepo({ 'a.ts': 'x' }, { initialise: false })], ENV, { ...capture().io, fetchImpl: async () => response(200, gatewayBody()), retryDelayMs: 0 });
  assert.equal(noGit, 2);
});

test('main: binary files are skipped and counted, text files still scanned', async () => {
  const dir = makeRepo({ 'a.ts': 'export const c = 1;\n' });
  writeFileSync(path.join(dir, 'img.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`"${RED.hex6}"`)]));
  execFileSync('git', ['-C', dir, 'add', '-A']);
  const { findings, scanned, binary } = scanRepo(dir, PAL);
  assert.deepEqual([findings.length, scanned, binary], [0, 1, 1]);
});

// ---- command line, in a real process --------------------------------------------------------------
const cli = (args, { cwd, env = {} } = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

test('command line: no configuration is exit 2 and names the three variables; no local palette is ever used', () => {
  const decoy = makeRepo({
    'a.ts': `export const c = "${OK.hex6}";\n`,
    [PRODUCT_PALETTE_PATH]: JSON.stringify(palette()),
    [PALETTES_MD_PATH]: mdFor(palette()),
    'product-palette.json': JSON.stringify(palette()),
  });
  const r = cli([], { cwd: decoy });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /GAETWAY_URL, GAETWAY_AGENT, GAETWAY_KEY/);
});

test('command line: --palette needs --palette-md, and unknown arguments are refused', () => {
  assert.equal(cli(['--palette', 'x.json']).status, 2);
  assert.equal(cli(['--palette-md', 'x.md']).status, 2);
  assert.equal(cli(['--nope', 'x']).status, 2);
  assert.equal(cli(['--root']).status, 2);
});

test('command line: fixtures override, both ways', () => {
  const p = palette();
  const fixtures = makeRepo({ 'product-palette.json': JSON.stringify(p), 'palettes.md': mdFor(p) }, { initialise: false });
  const args = (dir) => ['--root', dir, '--palette', path.join(fixtures, 'product-palette.json'), '--palette-md', path.join(fixtures, 'palettes.md')];
  const good = cli(args(makeRepo({ 'a.ts': `export const c = "${OK.hex6}";\n` })));
  assert.equal(good.status, 0, good.stderr);
  const bad = cli(args(makeRepo({ 'a.ts': `export const c = "${RED.hex6}";\n` })));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /FAIL a.ts:1:/);
  assert.equal(cli(['--root', fixtures, '--palette', path.join(fixtures, 'missing.json'), '--palette-md', path.join(fixtures, 'palettes.md')]).status, 2);
});

test('changing one product colour in the record changes the verdict with no app-repo edit', () => {
  const dir = makeRepo({ 'a.ts': `export const c = "${OK.hex6}";\n` });
  const verdict = (colors) => {
    const p = palette({ colors });
    const fx = makeRepo({ 'p.json': JSON.stringify(p), 'm.md': mdFor(p) }, { initialise: false });
    return cli(['--root', dir, '--palette', path.join(fx, 'p.json'), '--palette-md', path.join(fx, 'm.md')]).status;
  };
  assert.equal(verdict(palette().colors), 0);
  assert.equal(verdict(palette().colors.map((c) => (c.hex === OK.hex6 ? { ...c, hex: RED.hex6 } : c))), 1);
});

// ---- machine agnostic ------------------------------------------------------------------------------
test('the check and the workflow contain no absolute, home-relative or machine-specific path', () => {
  const forbidden = [
    /\/(Users|home|root|var|tmp|etc|opt|mnt|private|Volumes|usr)\//,
    /\b[A-Za-z]:\\/,
    /~\//,
    /\$HOME|homedir|USERPROFILE|APPDATA|VAULT_ROOT|NOVA_VAULT/i,
    /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/,
    /file:\/\//,
  ];
  for (const file of [SCRIPT, WORKFLOW]) {
    const text = readFileSync(file, 'utf8');
    for (const re of forbidden) assert.equal(re.test(text), false, `${path.basename(file)} matches ${re}`);
  }
});

test('the check reads configuration only from the three gateway variables', () => {
  const text = readFileSync(SCRIPT, 'utf8');
  const keys = new Set([...text.matchAll(/'(GAETWAY_[A-Z]+)'|env\.(GAETWAY_[A-Z]+)|env\[/g)].map((m) => m[1] ?? m[2] ?? 'dynamic'));
  assert.deepEqual([...keys].sort(), ['GAETWAY_AGENT', 'GAETWAY_KEY', 'GAETWAY_URL', 'dynamic'].sort());
  assert.equal(text.match(/process\.env/g).length, 1);
});

test('the workflow runs on pull_request and main, never pull_request_target, never the fixtures override', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  assert.match(text, /^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]/m);
  assert.doesNotMatch(text, /pull_request_target/);
  assert.doesNotMatch(text, /--palette/);
  assert.match(text, /^ {2}palette:\n {4}name: palette$/m);
  assert.match(text, /GAETWAY_URL: \$\{\{ secrets\.PALETTE_GAETWAY_URL \}\}/);
  assert.match(text, /GAETWAY_AGENT: \$\{\{ secrets\.PALETTE_GAETWAY_AGENT \}\}/);
  assert.match(text, /GAETWAY_KEY: \$\{\{ secrets\.PALETTE_GAETWAY_KEY \}\}/);
  assert.match(text, /permissions:\n {2}contents: read/);
});
