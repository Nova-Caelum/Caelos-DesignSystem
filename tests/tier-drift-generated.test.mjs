import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('(g) var base chains in generated tokens are judged by the existing rules', () => {
  const catalog = { base: { space: {
    first: leaf('dimension', { value: 3, unit: 'px' }),
    second: leaf('dimension', { value: 6, unit: 'px' }),
  } } };
  const result = run({ 'generated/tokens.css': ':root {\n  --base-space-first: var(--base-space-second);\n}\n' }, catalog);
  assert.equal(result.status, 0, output(result));
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

test('(j) a final generated base declaration without a semicolon is still compared', () => {
  const result = run({ 'generated/tokens.css': `:root {\n  --base-color-ground: ${WRONG}\n}\n` });
  assert.equal(result.status, 1, output(result));
  assert.ok(output(result).includes(`generated/tokens.css:2: --base-color-ground generated base value ${WRONG} does not equal catalog value ${GOOD}`), output(result));
});
