import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = path.join(root, 'tests');
const engineTests = readdirSync(tests, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /^engine-.*\.test\.mjs$/.test(entry.name))
  .map((entry) => path.join(tests, entry.name))
  .sort();

if (engineTests.length === 0) {
  console.error(`check:engine: no engine tests found under ${tests}`);
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ['--test', ...engineTests], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
