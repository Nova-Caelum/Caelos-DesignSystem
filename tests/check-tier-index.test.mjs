import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const checker = path.join(root, 'scripts/check-tier-index.sh');

test('conversion attributes cannot hide a raw value from the tier-index check', (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'catalog-tier-index-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  const write = (file, value) => {
    const destination = path.join(cwd, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, value);
  };

  git('init', '-q');
  git('config', 'user.email', 'catalog-test@example.invalid');
  git('config', 'user.name', 'Catalog test');
  const raw = `#${'f'.repeat(2)}${'0'.repeat(4)}`;
  write('src/tier-3/bad.css', `.bad { color: ${raw}; }\n`);
  git('add', '.');
  git('commit', '-qm', 'raw source');
  write('.gitattributes', 'src/tier-3/bad.css working-tree-encoding=UTF-16\n');
  git('add', '.gitattributes');
  git('commit', '-qm', 'conversion attribute');

  const result = spawnSync('sh', [checker, cwd], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0, `expected refusal, got ${result.stdout}${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /raw style value/);
});
