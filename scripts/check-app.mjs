import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globToRegExp, walk } from './design-system-enforcer-gate/lib/util.mjs';

const gate = new URL('./design-system-enforcer-gate/design-system-enforcer-gate.mjs', import.meta.url);
const args = process.argv.slice(2);
const paintConfigPath = fileURLToPath(new URL('./design-system-enforcer-gate/app-pages-paint.config.json', import.meta.url));

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

const result = run(args);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (args.includes('-h') || args.includes('--help')) {
  process.exitCode = result.status;
} else {
  const normal = reportFor(result, 'normal pass');
  if (normal.status !== 0 && normal.status !== 1) {
    process.exitCode = normal.status;
  } else {
    const { root, configPath } = invocation(args);
    if (!existsSync(configPath)) {
      console.error(`page paint pass: the app config has no pages list; add "pages" to ${configPath}`);
      process.exitCode = 2;
    } else {
      const appConfig = JSON.parse(readFileSync(configPath, 'utf8'));
      if (appConfig.pages == null || (Array.isArray(appConfig.pages) && appConfig.pages.length === 0)) {
        console.error(`page paint pass: the app config has no pages list; add "pages" to ${configPath}`);
        process.exitCode = 2;
      } else if (!Array.isArray(appConfig.pages)) {
        console.error('check-app: pages must be a non-empty list of globs');
        process.exitCode = 2;
      } else if (appConfig.pages.some((page) => typeof page !== 'string' || page.trim() === '')) {
        console.error('check-app: pages must be a non-empty list of globs');
        process.exitCode = 2;
      } else {
        const pageTypes = new Set(['tsx', 'jsx', 'ts', 'js', 'mdx', 'css', 'scss', 'sass', 'less']);
        const candidates = walk(root).filter((file) => pageTypes.has(file.split('.').pop()));
        const unmatched = appConfig.pages.find((page) => !candidates.some((file) => globToRegExp(page).test(file)));
        if (unmatched) {
          console.error(`page paint pass: page glob matched zero files: ${unmatched}`);
          process.exitCode = 2;
        } else {
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
          if (checked.status !== 0 && paint.stdout) process.stderr.write(paint.stdout);
          process.exitCode = checked.status || normal.status;
        }
      }
    }
  }
}
