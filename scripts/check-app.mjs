import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const gate = new URL('./design-system-enforcer-gate/design-system-enforcer-gate.mjs', import.meta.url);
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [fileURLToPath(gate), '--json', ...args], { encoding: 'utf8' });

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error || result.status === null) {
  console.error(`check-app: could not run the gate: ${result.error?.message ?? 'no exit status'}`);
  process.exitCode = 2;
} else if ((result.status === 0 || result.status === 1) && !args.includes('-h') && !args.includes('--help')) {
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    console.error('check-app: the gate did not return JSON; check the gate configuration');
    process.exitCode = 2;
  }
  if (report) {
    const reasons = [];
    if (report.files === 0) reasons.push('scanned 0 files: check the folder argument and the gate config');
    if (report.tokens === 0) reasons.push('found 0 tokens: check the token-source paths and the gate config');
    if (reasons.length) {
      console.error(`check-app: ${reasons.join('; ')}`);
      process.exitCode = 2;
    } else {
      process.exitCode = result.status;
    }
  }
} else {
  process.exitCode = result.status;
}
