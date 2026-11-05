// Tests for scripts/check-palette.mjs. Every planted case must be refused and every clean case accepted.
// This file is itself scanned by the check, so no colour literal appears here: colours are assembled
// at run time from numbers and fragments. String assembly is outside what a lexical check can see.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  NAMED_COLOUR_COUNT,
  PALETTES_MD_PATH,
  PRODUCT_PALETTE_PATH,
  hexLineNumbers,
  main,
  parsePalette,
  readFromGateway,
  scanRepo,
  scanText,
} from '../scripts/check-palette.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'check-palette.mjs');
const WORKFLOW = path.join(HERE, '..', '.github', 'workflows', 'palette.yml');
const UNIT_WORKFLOW = path.join(HERE, '..', '.github', 'workflows', 'unit.yml');

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
const MARK = 'zz-marker-zz';

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
const mdFor = (p, { hexLine = '' } = {}) =>
  [
    '# Palettes',
    '## Company',
    '| Ground | Midnight |',
    '## Product',
    ...p.colors.filter((c) => !c.shared).map((c) => `| ${c.name} | Approved |`),
    hexLine,
    '## Shared foundations and derived states',
    ...p.colors.filter((c) => c.shared).map((c) => `| ${c.name} | Approved |`),
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
      structuredContent: { result: { json: { hash: sha(content), encoding: 'text', content }, md: { hash: sha(md), hexLines: hexLineNumbers(md) } } },
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
test('rulings: a denied colour is refused like any other, with no ruling text; an allowed ruling adds a colour', () => {
  const [denied] = scanText(`x = "${DENIED}"`, PAL);
  const [unknown] = scanText(`x = "${RED.hex6}"`, PAL);
  assert.equal(denied.reason, unknown.reason);
  assert.doesNotMatch(denied.reason, /ink|ruling|fixture/);
  assert.deepEqual(scanText(`x = "${EXTRA}"`, PAL), []);
  const flipped = parsePalette(JSON.stringify(palette({ rulings: [{ id: 'ink', allowed: true, hex: [DENIED], reason: 'flipped' }] })));
  assert.deepEqual(scanText(`x = "${DENIED}"`, flipped), []);
});

test('the palette record is validated, and its errors carry none of its text', () => {
  assert.throws(() => parsePalette('nope'), ConfigError);
  assert.throws(() => parsePalette(JSON.stringify(palette({ palette: 'company' }))), /not the product palette/);
  assert.throws(() => parsePalette(JSON.stringify(palette({ schema: 2 }))), ConfigError);
  assert.throws(() => parsePalette(JSON.stringify(palette({ colors: [] }))), ConfigError);
  const bad = JSON.stringify(palette({ colors: [{ hex: 'nothex', role: MARK, name: MARK }] }));
  assert.throws(() => parsePalette(bad), (e) => e instanceof ConfigError && !e.message.includes(MARK) && !e.message.includes('nothex'));
  const clash = JSON.stringify(palette({ rulings: [{ id: MARK, allowed: false, hex: [OK.hex6], reason: MARK }] }));
  assert.throws(() => parsePalette(clash), (e) => /also a palette colour/.test(e.message) && !e.message.includes(MARK) && !e.message.includes(OK.hex6));
});

test('palettes.md may hold no hex code: the line numbers are found, the text is not kept', () => {
  assert.deepEqual(hexLineNumbers(mdFor(palette())), []);
  const lines = ['# Palettes', `Ground ${HASH}369`, '| a | b |', `see ${HASH}FF00FF and ${HASH}12345678`, `${HASH}123`, `${HASH}ab`, '## Heading', `${HASH}12345678901`];
  assert.deepEqual(hexLineNumbers(lines.join('\n')), [2, 4, 5]);
  assert.deepEqual(hexLineNumbers(`${HASH}abcde`), [1]);
  assert.deepEqual(hexLineNumbers(`${HASH}abcdefg`), []);
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

test('the program sent to the gateway returns the record and only line numbers from palettes.md', async () => {
  const p = palette();
  const md = mdFor(p, { hexLine: `${MARK} ${HASH}369` });
  const files = { [PRODUCT_PALETTE_PATH]: JSON.stringify(p), [PALETTES_MD_PATH]: md };
  let code;
  await readFromGateway({ url: ENV.GAETWAY_URL, agent: 'a', key: 'k', fetchImpl: async (u, init) => ((code = JSON.parse(init.body).params.arguments.code), response(200, gatewayBody())) });
  const vault = { read: async ({ path: p2 }) => ({ hash: sha(files[p2]), encoding: 'text', content: files[p2] }) };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const result = await new AsyncFunction('vault', code)(vault);
  assert.equal(result.json.content, files[PRODUCT_PALETTE_PATH]);
  assert.deepEqual(result.md, { hash: sha(md), hexLines: hexLineNumbers(md) });
  assert.equal(result.md.hexLines.length, 1);
  assert.equal(JSON.stringify(result.md).includes(MARK), false);
});

test('the gateway read fails closed', async () => {
  const cfg = { url: ENV.GAETWAY_URL, agent: 'a', key: 'k', retryDelayMs: 0 };
  const read = (fetchImpl, over = {}) => readFromGateway({ ...cfg, ...over, fetchImpl });
  await assert.rejects(read(async () => response(401, { code: 'key_mismatch', reason: MARK })), (e) => /HTTP 401 \(key_mismatch\)/.test(e.message) && !e.message.includes(MARK));
  await assert.rejects(read(async () => response(200, { result: { isError: true, structuredContent: { error: { code: 'upstream_error', reason: `not found: ${MARK}` } } } })), (e) => /upstream_error/.test(e.message) && !e.message.includes(MARK));
  await assert.rejects(read(async () => response(200, { result: { isError: false, structuredContent: { result: null } } })), /truncated/);
  const bad = gatewayBody();
  bad.result.structuredContent.result.json.hash = 'f'.repeat(64);
  await assert.rejects(read(async () => response(200, bad)), /hash check/);
  await assert.rejects(read(async () => response(200, 'not an object')), ConfigError);
  const noLines = gatewayBody();
  delete noLines.result.structuredContent.result.md.hexLines;
  await assert.rejects(read(async () => response(200, noLines)), /no palette/);
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

test('main: a hex code in palettes.md fails (1), naming line numbers and nothing else', async () => {
  const p = palette();
  const md = mdFor(p, { hexLine: `${MARK} ${HASH}369` });
  const r = await run({ 'a.ts': `export const c = "${OK.hex6}";\n` }, { fetchImpl: async () => response(200, gatewayBody(p, md)) });
  assert.equal(r.code, 1);
  assert.match(r.err, /FAIL palettes.md: hex code at line 7; palettes.md must name colours only/);
  assert.equal((r.out + r.err).includes(MARK), false);
});

test('main: the log never holds palette or vault text', async () => {
  const p = palette({
    colors: [{ hex: OK.hex6, role: MARK, name: MARK }, { hex: BASE, role: MARK, name: MARK }],
    rulings: [{ id: MARK, allowed: false, hex: [DENIED], reason: MARK }, { id: MARK, allowed: true, hex: [EXTRA], reason: MARK }],
  });
  const md = `${MARK}\n${mdFor(p, { hexLine: `${MARK} ${HASH}369` })}`;
  const gateway = async () => response(200, gatewayBody(p, md));
  const files = { 'a.ts': `export const c = "${RED.hex6}"; export const d = "${DENIED}"; export const e = "${OK.hex6}";\n` };
  const failing = await run(files, { fetchImpl: gateway });
  const passing = await run({ 'a.ts': `export const c = "${OK.hex6}";\n` }, { fetchImpl: async () => response(200, gatewayBody(p, mdFor(p))) });
  const refused = await run(files, { fetchImpl: async () => response(200, { result: { isError: true, structuredContent: { error: { code: 'upstream_error', reason: MARK } } } }) });
  const log = [failing, passing, refused].map((r) => r.out + r.err).join('\n');
  assert.equal(failing.code, 1);
  assert.equal(passing.code, 0);
  assert.equal(refused.code, 2);
  for (const secret of [MARK, BASE, EXTRA, OK.hex6.toLowerCase().slice(1, 5)]) assert.equal(log.includes(secret), false, `log holds ${secret}`);
  assert.match(log, new RegExp(`FAIL a.ts:1:\\d+  ${RED.hex6}  `));
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

test('scan root: a link is read as a link and never followed out of the root', () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'palette-outside-'));
  writeFileSync(path.join(outside, 'secret.txt'), `"${RED.hex6}" ${MARK}\n`);
  const dir = makeRepo({ 'a.ts': `export const c = "${OK.hex6}";\n` });
  symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'leak.txt'));
  execFileSync('git', ['-C', dir, 'add', '-A']);
  const { findings, scanned } = scanRepo(dir, PAL);
  assert.deepEqual(findings, []);
  assert.equal(scanned, 2);
});

test('scan root: a tracked path whose directory was swapped for a link out of the root is refused', () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'palette-outside-'));
  writeFileSync(path.join(outside, 'x.txt'), `"${RED.hex6}"\n`);
  const dir = makeRepo({ 'a.ts': 'export const c = 1;\n', 'd/x.txt': 'clean\n' });
  rmSync(path.join(dir, 'd'), { recursive: true });
  symlinkSync(outside, path.join(dir, 'd'));
  assert.throws(() => scanRepo(dir, PAL), (e) => e instanceof ConfigError && /outside the scan root/.test(e.message));
});

test('scan root: the root is an argument and the script itself is never the scanned tree', async () => {
  const dir = makeRepo({ 'a.ts': `export const c = "${RED.hex6}";\n` });
  const here = process.cwd();
  const { code, err } = await (async () => {
    const { lines, io } = capture();
    const c = await main(['--root', dir], ENV, { ...io, fetchImpl: async () => response(200, gatewayBody()), retryDelayMs: 0 });
    return { code: c, err: lines.err };
  })();
  assert.equal(code, 1);
  assert.match(err, /FAIL a.ts:1:/);
  assert.equal(process.cwd(), here);
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
test('the check and the workflows contain no absolute, home-relative or machine-specific path', () => {
  const forbidden = [
    /\/(Users|home|root|var|tmp|etc|opt|mnt|private|Volumes|usr)\//,
    /\b[A-Za-z]:\\/,
    /~\//,
    /\$HOME|homedir|USERPROFILE|APPDATA|VAULT_ROOT|NOVA_VAULT/i,
    /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/,
    /file:\/\//,
  ];
  for (const file of [SCRIPT, WORKFLOW, UNIT_WORKFLOW]) {
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

test('palette.yml: main runs the script, the change is data, secrets are in one step and behind an environment', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  assert.match(text, /^on:\n {2}pull_request_target:\n {2}push:\n {4}branches: \[main\]$/m);
  assert.doesNotMatch(text, /^ {2}pull_request:/m);
  assert.match(text, /^ {2}palette:\n {4}name: palette\n {4}runs-on: ubuntu-latest\n {4}environment: palette$/m);
  assert.match(text, /^permissions:\n {2}contents: read$/m);
  const checkouts = text.match(/uses: actions\/checkout@[0-9a-f]{40} # v\S+/g);
  assert.equal(checkouts.length, 2);
  assert.equal(text.match(/persist-credentials: false/g).length, 2);
  assert.match(text, /GIT_LFS_SKIP_SMUDGE: '1'/);
  assert.match(text, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}\n {10}path: pr\n/);
  const runs = text.match(/^ +run: .*$/gm);
  assert.deepEqual(runs.map((r) => r.trim()), ['run: node scripts/check-palette.mjs --root pr']);
  assert.doesNotMatch(text, /npm|pnpm|yarn|pip |make |node --test|working-directory|cd pr|\.\/pr|--palette/);
  const [before, after] = text.split('- name: Palette check');
  assert.doesNotMatch(before, /secrets\./);
  assert.equal(after.match(/secrets\./g).length, 3);
  assert.match(after, /GAETWAY_URL: \$\{\{ secrets\.PALETTE_GAETWAY_URL \}\}/);
  assert.match(after, /GAETWAY_AGENT: \$\{\{ secrets\.PALETTE_GAETWAY_AGENT \}\}/);
  assert.match(after, /GAETWAY_KEY: \$\{\{ secrets\.PALETTE_GAETWAY_KEY \}\}/);
});

test('unit.yml: the tests run on pull_request with no secret and no environment', () => {
  const text = readFileSync(UNIT_WORKFLOW, 'utf8');
  assert.match(text, /^on:\n {2}pull_request:$/m);
  assert.doesNotMatch(text, /pull_request_target|secrets|environment|push:/);
  assert.match(text, /^ {2}unit:\n {4}name: unit$/m);
  assert.deepEqual(text.match(/^ +- run: .*$/gm).map((r) => r.trim()), ['- run: node --test']);
});
