import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies'];

function defaultReinstall({ appFolder }) {
  execFileSync('npm', ['install'], { cwd: appFolder, stdio: 'inherit' });
}

const defaultGit = {
  async commit({ appFolder, files, message }) {
    execFileSync('git', ['add', '--', ...files], { cwd: appFolder, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', message], { cwd: appFolder, stdio: 'pipe' });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appFolder, encoding: 'utf8' }).trim();
  },
};

function pinnedSpecifier(current, commit) {
  const hash = current.lastIndexOf('#');
  return `${hash < 0 ? current : current.slice(0, hash)}#${commit}`;
}

export async function pinApp({
  appFolder, designSystemCommit, dependency, reinstall = defaultReinstall, git = defaultGit,
}) {
  if (typeof designSystemCommit !== 'string' || !designSystemCommit.trim()) {
    throw new Error('pin step requires the design-system merge commit; wait for that pull request to merge');
  }
  if (typeof dependency !== 'string' || !dependency.trim()) {
    throw new Error('pin step requires the app dependency name; add it to job.json finish.app.dependency');
  }
  const packageFile = path.join(appFolder, 'package.json');
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
  let found = false;
  for (const group of dependencyGroups) {
    if (typeof pkg[group]?.[dependency] === 'string') {
      pkg[group][dependency] = pinnedSpecifier(pkg[group][dependency], designSystemCommit);
      found = true;
    }
  }
  if (!found) throw new Error(`pin step cannot find dependency ${dependency} in package.json`);
  writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
  await reinstall({ appFolder, dependency, designSystemCommit });
  const lockNames = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];
  const files = ['package.json', ...lockNames.filter((name) => existsSync(path.join(appFolder, name)))];
  const commit = await git.commit({
    appFolder, files, message: `Pin ${dependency} to ${designSystemCommit}`,
  });
  return { commit, dependency, designSystemCommit, files };
}
