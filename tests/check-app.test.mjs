import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const CHECK_APP = path.join(REPO, 'scripts', 'check-app.mjs');
const FIXTURE = path.join(HERE, 'fixtures', 'gate-app');
const EMPTY_SCAN_MESSAGE = /scanned 0 files: check the folder argument and the gate config/;

const makeTemp = (prefix = 'check-app-') => mkdtempSync(path.join(tmpdir(), prefix));
const configForNoSources = (tokens) => ({
  scan: { include: ['src/**'], types: ['css'] },
  tokens: { css: tokens },
});

function invoke(root) {
  return spawnSync(process.execPath, [CHECK_APP, root], { encoding: 'utf8' });
}

function materializeFixture() {
  const root = makeTemp('check-app-fixture-');
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
  copy(FIXTURE, root);
  return root;
}

test('an app with no scan candidates is refused', () => {
  const root = makeTemp();
  writeFileSync(path.join(root, 'design-system-enforcer-gate.config.json'), JSON.stringify(configForNoSources([])));
  const proc = invoke(root);
  assert.equal(proc.status, 2, proc.stderr);
  assert.match(proc.stderr, EMPTY_SCAN_MESSAGE);
});

test('an app with tokens but no matching files is refused', () => {
  const root = makeTemp();
  writeFileSync(path.join(root, 'tokens.css'), ':root { --base-space-px-4: 4px; }\n');
  writeFileSync(path.join(root, 'design-system-enforcer-gate.config.json'), JSON.stringify(configForNoSources(['tokens.css'])));
  const proc = invoke(root);
  assert.equal(proc.status, 2, proc.stderr);
  assert.match(proc.stderr, EMPTY_SCAN_MESSAGE);
});

test('an app with files but no tokens is refused', () => {
  const root = makeTemp();
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'a.css'), '.a { padding: var(--base-space-px-4); }\n');
  writeFileSync(path.join(root, 'design-system-enforcer-gate.config.json'), JSON.stringify(configForNoSources([])));
  const proc = invoke(root);
  assert.equal(proc.status, 2, proc.stderr);
  assert.match(proc.stderr, /found 0 tokens: check the token-source paths and the gate config/);
  assert.doesNotMatch(proc.stderr, EMPTY_SCAN_MESSAGE);
});

test('an app with a violation keeps the gate failure', () => {
  const proc = invoke(materializeFixture());
  assert.equal(proc.status, 1, proc.stderr);
  assert.match(proc.stdout, /"errors": 2/);
});

test('a clean app keeps the gate success', () => {
  const root = materializeFixture();
  writeFileSync(path.join(root, 'src', 'raw.css'), '.raw { padding: var(--base-space-px-12); }\n.motion { transition: opacity var(--base-motion-duration-fast) var(--base-motion-easing-out); }\n');
  writeFileSync(path.join(root, 'src', 'required.tsx'), 'export const Required = () => <button type="button" className="motion">Save</button>;\n');
  const proc = invoke(root);
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /"errors": 0/);
});
