import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(project, 'scripts/check-tier-drift.cjs');

const GOOD = '#100f1c';
const WRONG = GOOD.slice(0, -1) + 'd';
const leaf = ($type, $value) => ({ $type, $value });
const supportedBase = {
  base: {
    color: { ground: leaf('color', { hex: '#100F1C' }) },
    space: { sm: leaf('dimension', { value: 3, unit: 'px' }) },
    opacity: { soft: leaf('number', 0.45) },
    type: {
      weight: { regular: leaf('fontWeight', 400) },
      family: {
        ui: leaf('fontFamily', 'Caelum Sans'),
        stack: leaf('fontFamily', ['Yrsa', 'Caelum Sans']),
      },
    },
    motion: {
      short: leaf('duration', { value: 120, unit: 'ms' }),
      second: leaf('duration', { value: 1, unit: 's' }),
      ease: leaf('cubicBezier', [0, 0, 0.58, 1]),
    },
  },
};

function run(files, catalog = supportedBase) {
  const root = mkdtempSync(path.join(tmpdir(), 'caelos-generated-tier-'));
  try {
    writeFile(root, 'token_catalog/00-foundations.tokens.json', JSON.stringify(catalog));
    for (const [name, source] of Object.entries(files)) {
      const destination = path.join(root, name);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, source);
    }
    return spawnSync(process.execPath, [checker, root], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeFile(root, name, source) {
  const destination = path.join(root, name);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, source);
}

const output = result => result.stderr + result.stdout;

test('(a) generated base declarations equal to every supported catalog type pass', () => {
  const result = run({
    'generated/tokens.css': `:root {
  --base-color-ground: #100f1c;
  --base-space-sm: 3px;
  --base-opacity-soft: 0.45;
  --base-type-weight-regular: 400;
  --base-type-family-ui: 'Caelum Sans';
  --base-type-family-stack: Yrsa, 'Caelum Sans';
  --base-motion-short: 0.12s;
  --base-motion-second: 1s;
  --base-motion-ease: cubic-bezier(0, 0, 0.58, 1);
}
`,
  });
  assert.equal(result.status, 0, output(result));
  assert.doesNotMatch(output(result), /generated\/tokens\.css:.*raw style value/);
});

test('(b) a hand-edited generated base value names the file, line, token and both values', () => {
  const result = run({ 'generated/tokens.css': `:root {\n  --base-color-ground: ${WRONG};\n}\n` });
  assert.equal(result.status, 1, output(result));
  assert.ok(output(result).includes(`generated/tokens.css:2: --base-color-ground generated base value ${WRONG} does not equal catalog value ${GOOD}`), output(result));
  assert.match(output(result), /regenerate with npm run build:tokens, or fix the catalog/);
});

test('(c) a generated raw declaration that is not a catalog base leaf remains flagged', () => {
  const result = run({ 'generated/tokens.css': ':root {\n  --sys-space-x: 5px;\n}\n' });
  assert.equal(result.status, 1, output(result));
  assert.match(output(result), /generated\/tokens\.css:2: raw style value/);
});

test('(d) a generated raw non-base custom declaration remains flagged', () => {
  const result = run({ 'generated/tokens.css': ':root {\n  --theme-gap: 3px;\n}\n' });
  assert.equal(result.status, 1, output(result));
  assert.match(output(result), /generated\/tokens\.css:2: raw style value/);
});

test('(e) an unsupported generated base value type fails closed', () => {
  const catalog = { base: { shadow: leaf('shadow', { layers: 2 }) } };
  const result = run({ 'generated/tokens.css': ':root {\n  --base-shadow: 3px;\n}\n' }, catalog);
  assert.equal(result.status, 1, output(result));
  assert.match(output(result), /generated\/tokens\.css:2: --base-shadow unsupported base value type shadow/);
});

test('(f) matching base declarations in any other CSS file remain raw style values', () => {
  const result = run({ 'src/other.css': ':root {\n  --base-color-ground: #100f1c;\n}\n' });
  assert.equal(result.status, 1, output(result));
  assert.match(output(result), /src\/other\.css:2: raw style value/);
});

test('(h) a generated base declaration without a catalog leaf is an unknown token', () => {
  const result = run({ 'generated/tokens.css': ':root {\n  --base-not-in-catalog: 3px;\n}\n' });
  assert.equal(result.status, 1, output(result));
  assert.match(output(result), /generated\/tokens\.css:2: unknown base token --base-not-in-catalog/);
});

test('(i) plain-identifier font families are bare while spaced families are quoted', () => {
  const catalog = { base: { type: { family: {
    display: leaf('fontFamily', 'Yrsa'),
    ui: leaf('fontFamily', 'Caelum Sans'),
  } } } };
  const accepted = run({
    'generated/tokens.css': ":root {\n  --base-type-family-display: Yrsa;\n  --base-type-family-ui: 'Caelum Sans';\n}\n",
  }, catalog);
  assert.equal(accepted.status, 0, output(accepted));

  const rejected = run({
    'generated/tokens.css': ":root {\n  --base-type-family-display: 'Yrsa';\n  --base-type-family-ui: Caelum Sans;\n}\n",
  }, catalog);
  assert.equal(rejected.status, 1, output(rejected));
  assert.match(output(rejected), /--base-type-family-display generated base value 'Yrsa' does not equal catalog value Yrsa/);
  assert.match(output(rejected), /--base-type-family-ui generated base value Caelum Sans does not equal catalog value 'Caelum Sans'/);
});

test('(j) a final generated declaration without a semicolon is outside the generated shape', () => {
  const result = run({ 'generated/tokens.css': `:root {\n  --base-color-ground: ${WRONG}\n}\n` });
  assertFindings(result, [shape(2, 'declaration without a terminating semicolon')]);
});

// The rest of this file pins the strict shape: one :root block of `--name: value;` declarations,
// parsed once, and every declaration in it verified.
const spaces = { base: { space: {
  sm: leaf('dimension', { value: 3, unit: 'px' }),
  md: leaf('dimension', { value: 6, unit: 'px' }),
} } };
const EVIL = '99px';
const G = 'generated/tokens.css';
const findings = result => result.stderr.split('\n').filter(Boolean);
const shape = (line, reason) => `${G}:${line}: not in generated shape: ${reason}; regenerate with npm run build:tokens`;
const mismatch = (line, name, got, want) => `${G}:${line}: ${name} generated base value ${got} does not equal catalog value ${want}; generated base values must equal their catalog tokens; regenerate with npm run build:tokens, or fix the catalog`;
const OPEN = 'expected the file to be one :root { } block';
const AFTER = 'text after the :root block';
const DECLARATION = 'expected a --name: value declaration with a lower-case name';
function assertFindings(result, expected) {
  assert.deepEqual(findings(result), expected, output(result));
  assert.equal(result.status, 1, output(result));
}
function generated(text, catalog = spaces) {
  return run({ [G]: text }, catalog);
}
const WELL_FORMED = `:root {
  --base-color-ground: #100f1c;
  --base-space-sm: 3px;
  --base-opacity-soft: 0.45;
  --base-type-weight-regular: 400;
  --base-type-family-ui: 'Caelum Sans';
  --base-type-family-stack: Yrsa, 'Caelum Sans';
  --base-motion-short: 0.12s;
  --base-motion-second: 1s;
  --base-motion-ease: cubic-bezier(0, 0, 0.58, 1);
  --sys-gap: var(--base-space-sm);
}
`;

test('(k) a well-formed generated file passes as written, minified and with trailing comments', () => {
  const minified = WELL_FORMED.replace(':root {', ':root{').replace(/\n\s*/g, '').replace(/(--[a-z0-9-]+): /g, '$1:');
  const commented = WELL_FORMED.replace(/;\n/g, '; /** Reusable value. Evidence is kept in provenance. */\n');
  for (const text of [WELL_FORMED, minified, commented]) {
    const result = run({ [G]: text });
    assert.equal(result.status, 0, text + output(result));
    assert.deepEqual(findings(result), [], text);
  }
});

test('(l) a wrong base value directly after a semicolon with no space is compared', () => {
  assertFindings(generated(`:root {\n  --base-space-md: 6px;--base-space-sm: ${EVIL};\n}\n`),
    [mismatch(2, '--base-space-sm', EVIL, '3px')]);
});

test('(m) a wrong base value in a minified block is compared', () => {
  assertFindings(generated(`:root{--base-space-md:6px;--base-space-sm:${EVIL};}`),
    [mismatch(1, '--base-space-sm', EVIL, '3px')]);
});

test('(n) a minified block whose last declaration has no semicolon is outside the shape', () => {
  assertFindings(generated(`:root{--base-space-md:6px;--base-space-sm:${EVIL}}`),
    [shape(1, 'declaration without a terminating semicolon')]);
});

test('(o) a second :root block is outside the shape', () => {
  assertFindings(generated(`:root {\n  --base-space-sm: 3px;\n}\n:root {\n  --base-space-md: ${EVIL};\n}\n`),
    [shape(4, AFTER)]);
});

test('(p) a block with another selector is outside the shape, with a wrong or a right value', () => {
  assertFindings(generated(`:root {\n  --base-space-sm: 3px;\n}\n.x {\n  --base-space-sm: ${EVIL};\n}\n`),
    [shape(4, AFTER)]);
  assertFindings(generated(':root {\n  --base-space-sm: 3px;\n}\nhtml.light {\n  --base-space-sm: 3px;\n}\n'),
    [shape(4, AFTER)]);
  assertFindings(generated(`html.light {\n  --base-space-sm: ${EVIL};\n}\n`), [shape(1, OPEN)]);
});

test('(q) @media and @supports wrappers are outside the shape, spaced and minified', () => {
  assertFindings(generated('@media (prefers-color-scheme: light) {\n  :root {\n    --base-space-sm: 3px;\n  }\n}\n'), [shape(1, OPEN)]);
  assertFindings(generated('@media screen{:root{--base-space-sm:3px;}}'), [shape(1, OPEN)]);
  assertFindings(generated('@supports (--base-evil: 3px) {\n  :root {\n    --base-space-sm: 3px;\n  }\n}\n'), [shape(1, OPEN)]);
  assertFindings(generated('@supports (--base-evil:3px){:root{--base-space-sm:3px;}}'), [shape(1, OPEN)]);
  assertFindings(generated(`:root{--base-space-sm:3px;}@media screen{:root{--base-space-md:6px;--base-space-sm:${EVIL};}}`), [shape(1, AFTER)]);
});

test('(r) text or a stray brace before or after the block is outside the shape', () => {
  assertFindings(generated('--base-space-sm: 3px;\n:root {\n  --base-space-md: 6px;\n}\n'), [shape(1, OPEN)]);
  assertFindings(generated('}\n:root {\n  --base-space-sm: 3px;\n}\n'), [shape(1, OPEN)]);
  assertFindings(generated(`:root {\n  --base-space-sm: 3px;\n}\n--base-space-md: ${EVIL};\n`), [shape(4, AFTER)]);
  assertFindings(generated(':root {\n  --base-space-sm: 3px;\n}\n}\n'), [shape(4, AFTER)]);
  assertFindings(generated(`:root {\n}--base-space-sm: ${EVIL};\n`), [shape(2, AFTER)]);
  assertFindings(generated(':root {\n  --base-space-sm: 3px {}\n}\n'), [shape(2, 'a block inside :root')]);
  assertFindings(generated(':root {\n  --base-space-sm: 3px;\n'), [shape(1, ':root block is not closed')]);
});

test('(s) a duplicate name is outside the shape', () => {
  assertFindings(generated(':root {\n  --base-space-sm: 3px;\n  --base-space-sm: 3px;\n}\n'),
    [shape(3, 'duplicate declaration --base-space-sm')]);
});

test('(t) an upper-case or mixed-case name is outside the shape', () => {
  assertFindings(generated(':root {\n  --BASE-space-sm: 3px;\n}\n'), [shape(2, DECLARATION)]);
  assertFindings(generated(':root {\n  --base-Space-sm: 3px;\n}\n'), [shape(2, DECLARATION)]);
});

test('(u) !important is not a catalog value and not a plain reference', () => {
  assertFindings(generated(':root {\n  --base-space-sm: 3px !important;\n}\n'),
    [mismatch(2, '--base-space-sm', '3px !important', '3px')]);
  assertFindings(generated(':root {\n  --sys-gap: var(--base-space-sm) !important;\n}\n'),
    [`${G}:2: raw style value`]);
});

test('(v) a quoted value is not a catalog value and not a plain reference', () => {
  assertFindings(generated(":root {\n  --base-space-sm: '3px';\n}\n"),
    [mismatch(2, '--base-space-sm', "'3px'", '3px')]);
  assertFindings(generated(":root {\n  --sys-label: 'Caelum Sans';\n}\n"), [`${G}:2: raw style value`]);
});

test('(w) a non-base raw value, an unknown base name and a value from another token are flagged', () => {
  assertFindings(generated(':root {\n  --sys-gap: 6px;\n}\n'), [`${G}:2: raw style value`]);
  assertFindings(generated(':root {\n  --base-space-lg: 6px;\n}\n'), [`${G}:2: unknown base token --base-space-lg`]);
  assertFindings(generated(':root {\n  --base-space-sm: 6px;\n}\n'), [mismatch(2, '--base-space-sm', '6px', '3px')]);
});

test('(x) only the regular file at generated/tokens.css gets the generated rule', () => {
  const right = ':root {\n  --base-space-sm: 3px;\n}\n';
  assertFindings(run({ 'assets/generated/tokens.css': right }, spaces), ['assets/generated/tokens.css:2: raw style value']);
  assertFindings(run({ 'Generated/tokens.css': right }, spaces), ['Generated/tokens.css:2: raw style value']);
  const root = mkdtempSync(path.join(tmpdir(), 'caelos-generated-link-'));
  try {
    writeFile(root, 'token_catalog/00-foundations.tokens.json', JSON.stringify(spaces));
    writeFile(root, 'elsewhere/tokens.txt', right);
    mkdirSync(path.join(root, 'generated'));
    symlinkSync('../elsewhere/tokens.txt', path.join(root, G));
    assertFindings(spawnSync(process.execPath, [checker, root], { encoding: 'utf8' }), [`${G}: unsupported tracked symlink`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(y) raw values in any other CSS file are flagged as before', () => {
  const text = `:root {\n  --base-space-sm: 3px;\n  --base-space-md: 6px;--base-space-sm: ${EVIL};\n}\n.x{--sys-gap:6px;--sys-pad:var(--base-space-sm)}\n`;
  assertFindings(run({ 'styles/other.css': text }, spaces), [
    'styles/other.css:2: raw style value',
    'styles/other.css:3: raw style value',
    'styles/other.css:5: raw style value',
  ]);
});

test('(z) only CSS whitespace separates tokens; a no-break space is not whitespace', () => {
  const nbsp = String.fromCharCode(0xa0);
  assertFindings(generated(`${nbsp}:root {\n  --base-space-sm: 3px;\n}\n`), [shape(1, OPEN)]);
  assertFindings(generated(`:root {\n  --base-space-sm: 3px${nbsp};\n}\n`), [mismatch(2, '--base-space-sm', `3px${nbsp}`, '3px')]);
  assertFindings(generated(`:root {\n  --sys-gap: var(${nbsp}--base-space-sm);\n}\n`), [`${G}:2: raw style value`]);
});

// A base value is the catalog's raw value. A var() reference on a base name is never that value,
// whatever it points at; only names outside base may carry a reference.
const baseReference = (line, name, raw) => `${G}:${line}: ${name} base value ${raw} is a reference; a base value must be the catalog's raw value, not a reference; regenerate with npm run build:tokens`;
const withSystem = { base: spaces.base, sys: { gap: leaf('dimension', ['{', 'base.space.md', '}'].join('')) } };

test('(g1) a base name whose value refers to another base token is flagged', () => {
  assertFindings(generated(':root {\n  --base-space-sm: var(--base-space-md);\n}\n'),
    [baseReference(2, '--base-space-sm', 'var(--base-space-md)')]);
});

test('(g2) a base name whose value refers to itself is flagged', () => {
  assertFindings(generated(':root {\n  --base-space-sm: var(--base-space-sm);\n}\n'),
    [baseReference(2, '--base-space-sm', 'var(--base-space-sm)')]);
});

test('(g3) a base name whose value refers to a non-base token is flagged', () => {
  assertFindings(generated(':root {\n  --base-space-sm: var(--sys-gap);\n}\n', withSystem),
    [baseReference(2, '--base-space-sm', 'var(--sys-gap)')]);
});

test('(g4) a non-base name with one var() reference to a known token still passes', () => {
  const result = generated(':root {\n  --base-space-md: 6px;\n  --sys-gap: var(--base-space-md);\n  --sys-pad: var(--sys-gap);\n}\n', withSystem);
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(findings(result), []);
});

test('(g5) a generated-file comment cannot define an unknown token', () => {
  assertFindings(generated(":root {\n  /* '--ghost': */ --sys-x: var(--ghost);\n}\n"),
    [`${G}:2: unknown token --ghost`]);
});

test('(g6) an ordinary tier CSS comment cannot define an unknown token', () => {
  assertFindings(run({ 'tier-1/attack.css': ":root {\n  /* '--ghost': */ --sys-x: var(--ghost);\n}\n" }, spaces),
    ['tier-1/attack.css:2: unknown token --ghost']);
});

test('(g7) a Vue local token entry outside a comment remains accepted', () => {
  const result = run({ 'tier-1/local.vue': "<script>const local = { '--ghost': true };</script>\n<style>:root { --sys-x: var(--ghost); }</style>\n" }, spaces);
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(findings(result), []);
});
