import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [step, flag, folder] = process.argv.slice(2);
if (!step || flag !== '--job' || !folder) {
  console.error('usage: step.mjs <step> --job <folder>');
  process.exit(2);
}

const job = path.resolve(folder);
const readJson = (name) => JSON.parse(readFileSync(path.join(job, name), 'utf8'));
const writeJson = (name, value) => {
  const target = path.join(job, name);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(target) && readFileSync(target, 'utf8') === text) return;
  writeFileSync(`${target}.tmp`, text);
  renameSync(`${target}.tmp`, target);
};

const definition = readJson('job.json');
const runsFile = path.join(job, 'step-runs.json');
const runs = existsSync(runsFile) ? readJson('step-runs.json') : {};
runs[step] = (runs[step] ?? 0) + 1;
writeJson('step-runs.json', runs);

if (definition.inputs?.failStep === step) {
  throw new Error(`induced ${step} failure; fix: clear job.inputs.failStep`);
}

if (step === 'prepare') {
  writeJson('prepare.json', { value: definition.inputs?.value ?? 'fixture' });
} else if (step === 'convert') {
  writeJson('convert.json', { value: readJson('prepare.json').value.toUpperCase() });
} else if (step === 'finish') {
  writeJson('finish.json', { value: readJson('convert.json').value, complete: true });
} else {
  throw new Error(`unknown fixture step ${step}`);
}
