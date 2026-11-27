import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';

function candidateDirectory(args) {
  const index = args.indexOf('--candidate');
  return index < 0 ? undefined : args[index + 1];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  return result;
}

const args = process.argv.slice(2);
const candidate = candidateDirectory(args);
if (args.includes('--candidate')) {
  try {
    if (typeof candidate !== 'string' || !statSync(candidate).isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(`check:generated: candidate directory does not exist: ${candidate}`);
    process.exitCode = 2;
  }
  if (!process.exitCode) {
    console.log("check:generated: skipped for a candidate tree; the pull request's own build is checked by the unit workflow");
  }
} else {
  const build = run('npm', ['run', 'build'], { stdio: 'inherit' });
  if (build.status !== 0) {
    process.exitCode = build.status ?? 1;
  } else {
    const diff = run('git', ['diff', '--exit-code', '--', 'generated/', 'token_catalog/versions.lock.json'], { stdio: 'inherit' });
    if (diff.status !== 0) {
      process.exitCode = diff.status ?? 1;
    } else {
      const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '--', 'generated/'], { encoding: 'utf8' });
      if (untracked.status !== 0) {
        process.exitCode = untracked.status ?? 1;
      } else if (untracked.stdout) {
        process.stdout.write(untracked.stdout);
        process.exitCode = 1;
      }
    }
  }
}
