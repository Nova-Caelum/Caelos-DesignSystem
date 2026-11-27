import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globToRegExp, walk } from './design-system-enforcer-gate/lib/util.mjs';

const gate = new URL('./design-system-enforcer-gate/design-system-enforcer-gate.mjs', import.meta.url);
const ratchet = new URL('./check-ratchet.mjs', import.meta.url);
const paintConfigPath = fileURLToPath(new URL('./design-system-enforcer-gate/app-pages-paint.config.json', import.meta.url));

function controls(rawArgs) {
  const gateArgs = [];
  let baseline = null, writeBaseline = false;
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--baseline') {
      if (!rawArgs[i + 1] || rawArgs[i + 1].startsWith('-')) throw new Error('--baseline requires a candidate-relative file');
      baseline = rawArgs[++i];
    } else if (rawArgs[i] === '--write-baseline') writeBaseline = true;
    else gateArgs.push(rawArgs[i]);
  }
  if (writeBaseline && !baseline) throw new Error('--write-baseline requires --baseline <file>');
  return { baseline, gateArgs, writeBaseline };
}

function invocation(args) {
  let configPath = null, rootArg = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config') configPath = args[++i];
    else if (args[i] === '--only') i++;
    else if (!args[i].startsWith('-')) rootArg = args[i];
  }
  const root = resolve(rootArg ?? process.cwd());
  return { root, configPath: configPath ? resolve(configPath) : join(root, 'design-system-enforcer-gate.config.json') };
}

function run(gateArgs, env = process.env) {
  return spawnSync(process.execPath, [fileURLToPath(gate), '--json', ...gateArgs], { encoding: 'utf8', env });
}

function reportFor(result, label) {
  if (result.error || result.status === null) {
    console.error(`check-app: could not run the ${label}: ${result.error?.message ?? 'no exit status'}`);
    return { status: 2 };
  }
  if (result.status !== 0 && result.status !== 1) return { status: result.status };
  try {
    const report = JSON.parse(result.stdout);
    const reasons = [];
    if (report.files === 0) reasons.push('scanned 0 files: check the folder argument and the gate config');
    if (report.tokens === 0) reasons.push('found 0 tokens: check the token-source paths and the gate config');
    if (reasons.length) {
      console.error(`check-app: ${label} ${reasons.join('; ')}`);
      return { status: 2 };
    }
    return { status: result.status, report };
  } catch {
    console.error(`check-app: the ${label} did not return JSON; check the gate configuration`);
    return { status: 2 };
  }
}

function findingCounts(reports) {
  const errors = [];
  for (const [label, report] of reports) {
    if (!Array.isArray(report.findings)) throw new Error(`findingCounts: ${label} has no findings list`);
    const reported = report.findings.filter((finding) => finding.severity === 'error');
    if (reported.length !== report.errors) {
      throw new Error(`findingCounts: ${label} reports errors outside per-file, per-rule findings`);
    }
    for (const finding of reported) {
      if (typeof finding.file !== 'string' || !finding.file || typeof finding.rule !== 'string' || !finding.rule) {
        throw new Error(`findingCounts: ${label} contains an error without file and rule fields`);
      }
      errors.push(finding);
    }
  }
  const counts = {};
  for (const finding of errors.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule))) {
    counts[finding.file] ??= {};
    counts[finding.file][finding.rule] = (counts[finding.file][finding.rule] ?? 0) + 1;
  }
  return counts;
}

function runRatchet(root, baseline, counts) {
  return spawnSync(process.execPath, [
    fileURLToPath(ratchet), '--mode', 'baseline', '--baseline', baseline,
    '--candidate', root, '--git-root', root, '--actual', '-',
  ], { encoding: 'utf8', input: `${JSON.stringify(counts)}\n` });
}

function baselineFile(root, baseline) {
  const file = resolve(root, baseline);
  const fromRoot = relative(root, file);
  if (isAbsolute(baseline) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('--baseline requires a candidate-relative file');
  }
  return file;
}

function main() {
  let selected;
  try {
    selected = controls(process.argv.slice(2));
  } catch (error) {
    console.error(`check-app: ${error.message}`);
    return 2;
  }

  const { baseline, gateArgs: args, writeBaseline } = selected;
  const result = run(args);

  if (result.stdout && !baseline) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (args.includes('-h') || args.includes('--help')) return result.status;

  const normal = reportFor(result, 'normal pass');
  if (normal.status !== 0 && normal.status !== 1) return normal.status;

  const { root, configPath } = invocation(args);
  if (!existsSync(configPath)) {
    console.error(`page paint pass: the app config has no pages list; add "pages" to ${configPath}`);
    return 2;
  }

  const appConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  if (appConfig.pages == null || (Array.isArray(appConfig.pages) && appConfig.pages.length === 0)) {
    console.error(`page paint pass: the app config has no pages list; add "pages" to ${configPath}`);
    return 2;
  }
  if (!Array.isArray(appConfig.pages) || appConfig.pages.some((page) => typeof page !== 'string' || page.trim() === '')) {
    console.error('check-app: pages must be a non-empty list of globs');
    return 2;
  }

  const pageTypes = new Set(['tsx', 'jsx', 'ts', 'js', 'mdx', 'css', 'scss', 'sass', 'less']);
  const candidates = walk(root).filter((file) => pageTypes.has(file.split('.').pop()));
  const unmatched = appConfig.pages.find((page) => !candidates.some((file) => globToRegExp(page).test(file)));
  if (unmatched) {
    console.error(`page paint pass: page glob matched zero files: ${unmatched}`);
    return 2;
  }

  const paint = run(args, {
    ...process.env,
    CAELOS_PAGE_PAINT_CONFIG: paintConfigPath,
    CAELOS_PAGE_PAINT_PAGES: JSON.stringify(appConfig.pages),
  });
  if (paint.stderr) process.stderr.write(paint.stderr);
  const checked = reportFor(paint, 'paint pass');
  for (const exemption of checked.report?.exempt ?? []) {
    console.error(`check-app: paint exemption: ${exemption.file}:${exemption.line} ${exemption.message}; reason: ${exemption.reason}`);
  }
  if (checked.status !== 0 && !baseline && paint.stdout) process.stderr.write(paint.stdout);
  if (checked.status !== 0 && checked.status !== 1) return checked.status;
  if (!baseline) return checked.status || normal.status;

  try {
    const counts = findingCounts([['normal pass', normal.report], ['paint pass', checked.report]]);
    const baselinePath = baselineFile(root, baseline);
    console.log(`check-app: ${normal.report.errors} normal and ${checked.report.errors} paint error(s) checked`);
    if (writeBaseline) {
      if (existsSync(baselinePath)) {
        throw new Error(`${baseline}: refusing to overwrite the existing baseline; fix findings so it shrinks`);
      }
      writeFileSync(baselinePath, `${JSON.stringify(counts, null, 2)}\n`);
      console.log(`check-app: wrote ${baseline}`);
      return 0;
    }

    const ratcheted = runRatchet(root, baseline, counts);
    if (ratcheted.stdout) process.stdout.write(ratcheted.stdout);
    if (ratcheted.stderr) process.stderr.write(ratcheted.stderr);
    return ratcheted.status ?? 2;
  } catch (error) {
    console.error(`check-app: ${error.message}`);
    return 2;
  }
}

process.exitCode = main();
