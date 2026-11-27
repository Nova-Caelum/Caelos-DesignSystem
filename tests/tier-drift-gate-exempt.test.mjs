import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(project, 'scripts/check-tier-drift.cjs');
const dash = String.fromCharCode(45);
const fontFamily = ['font', 'family'].join(dash);
const family = ['fam', 'ily'].join('');

function vocabulary(extra = '') {
  return [
    'export const propertyKinds = {',
    `  ${JSON.stringify(fontFamily)}: ${JSON.stringify(family)},`,
    extra,
    '};',
    '',
  ].filter(Boolean).join('\n');
}

function run(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'caelos-tier-gate-exempt-'));
  try {
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

const output = result => result.stderr + result.stdout;
const finding = (name, rule) => name + ':2: ' + rule;

test('(a) the named gate vocabulary file does not report raw font family', () => {
  const name = 'scripts/design-system-enforcer-gate/lib/config.mjs';
  const result = run({ [name]: vocabulary() });
  assert.equal(result.status, 0, output(result));
  assert.ok(!output(result).includes(finding(name, 'raw font family')), output(result));
});

test('(b) another gate file still reports raw font family', () => {
  const name = 'scripts/design-system-enforcer-gate/lib/other.mjs';
  const result = run({ [name]: vocabulary() });
  assert.equal(result.status, 1, output(result));
  assert.ok(output(result).includes(finding(name, 'raw font family')), output(result));
});

test('(c) source and library config files still report raw font family', () => {
  const source = vocabulary();
  const result = run({ 'src/config.mjs': source, 'lib/config.mjs': source });
  assert.equal(result.status, 1, output(result));
  for (const name of ['src/config.mjs', 'lib/config.mjs']) {
    assert.ok(output(result).includes(finding(name, 'raw font family')), output(result));
  }
});

test('(d) the named file still reports raw styles and suppression comments', () => {
  const name = 'scripts/design-system-enforcer-gate/lib/config.mjs';
  const rawLength = [String(13), 'px'].join('');
  const suppression = ['token', 'exempt(bogus)'].join(dash);
  const source = vocabulary(`  width: ${JSON.stringify(rawLength)},`) + `// ${suppression}\nexport const clean = true;\n`;
  const result = run({ [name]: source });
  assert.equal(result.status, 1, output(result));
  assert.ok(output(result).includes(name + ':3: raw style value'), output(result));
  assert.ok(output(result).includes(name + ':4: suppression comment'), output(result));
  assert.ok(!output(result).includes(finding(name, 'raw font family')), output(result));
});

test('(e) a path ending with the named path still reports raw font family', () => {
  const name = 'x/scripts/design-system-enforcer-gate/lib/config.mjs';
  const result = run({ [name]: vocabulary() });
  assert.equal(result.status, 1, output(result));
  assert.ok(output(result).includes(finding(name, 'raw font family')), output(result));
});
