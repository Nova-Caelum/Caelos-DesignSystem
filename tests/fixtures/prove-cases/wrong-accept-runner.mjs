import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadProofCases, runProofCases } from '../../../scripts/prove-tier-drift.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const casesFolder = path.join(root, 'proof-cases');
const rebuilt = (await loadProofCases(casesFolder))
  .filter((entry) => entry.name === 'rebuilt-component');

try {
  await runProofCases({
    cases: rebuilt,
    projectRoot: root,
    checkRunner: async () => ({ status: 0, stdout: '', stderr: '' }),
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
