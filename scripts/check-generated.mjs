import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const generatedDirectory = 'generated';
const lockFile = 'token_catalog/versions.lock.json';

function candidateDirectory(args) {
  const index = args.indexOf('--candidate');
  return index < 0 ? undefined : args[index + 1];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}

function generatedFiles(root) {
  const files = [];
  const directory = path.join(root, generatedDirectory);
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        files.push(path.relative(root, fullPath).split(path.sep).join('/'));
      } else {
        throw new Error(`generated output is not a regular file: ${path.relative(root, fullPath)}`);
      }
    }
  }
  try {
    if (lstatSync(directory).isDirectory()) visit(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    if (lstatSync(path.join(root, lockFile)).isFile()) files.push(lockFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return files;
}

function stagedFiles(gitRoot) {
  const listed = run('git', [
    '-C', gitRoot, 'ls-files', '--stage', '-z', '--', `${generatedDirectory}/`, lockFile,
  ], { encoding: 'utf8' });
  if (listed.status !== 0) {
    if (listed.stderr) process.stderr.write(listed.stderr);
    throw new Error('could not read the staged generated files');
  }
  const files = new Map();
  for (const record of listed.stdout.split('\0').filter(Boolean)) {
    const match = /^(\d+) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/u.exec(record);
    if (!match) throw new Error('could not parse a staged generated file');
    const [, , hash, stage, file] = match;
    if (stage !== '0') throw new Error(`staged generated file is conflicted: ${file}`);
    files.set(file, hash);
  }
  return files;
}

function buildOwnedGeneratedFiles(root) {
  const generated = path.join(root, generatedDirectory);
  const holdingDirectory = mkdtempSync(path.join(root, '.check-generated-owner-'));
  const original = path.join(holdingDirectory, generatedDirectory);
  let moved = false;
  try {
    try {
      if (lstatSync(generated).isDirectory()) {
        renameSync(generated, original);
        moved = true;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const build = run('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('could not determine generated-file ownership from a clean build');
    return new Set(generatedFiles(root).filter((file) => file.startsWith(`${generatedDirectory}/`)));
  } finally {
    rmSync(generated, { recursive: true, force: true });
    if (moved) renameSync(original, generated);
    rmSync(holdingDirectory, { recursive: true, force: true });
  }
}

function compareBuildToIndex(root, gitRoot, ownedGenerated) {
  const staged = stagedFiles(gitRoot);
  const built = new Set(generatedFiles(root));
  const files = [...new Set([...staged.keys(), ...built])].sort();
  let clean = true;
  for (const file of files) {
    if (file.startsWith(`${generatedDirectory}/`) && !ownedGenerated.has(file)) {
      console.error(`check:generated: generated file has no build owner: ${file}`);
      clean = false;
      continue;
    }
    const hash = staged.get(file);
    if (!hash) {
      console.error(`check:generated: generated file is not staged: ${file}`);
      clean = false;
      continue;
    }
    if (!built.has(file)) {
      console.error(`check:generated: staged generated file is not produced by the build: ${file}`);
      clean = false;
      continue;
    }
    const blob = run('git', ['-C', gitRoot, 'cat-file', 'blob', hash]);
    if (blob.status !== 0) throw new Error(`could not read staged generated file: ${file}`);
    if (!blob.stdout.equals(readFileSync(path.join(root, file)))) {
      console.error(`check:generated: built output differs from staged file: ${file}`);
      clean = false;
    }
  }
  return clean;
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
  const build = run('npm', ['run', 'build'], { cwd: process.cwd(), stdio: 'inherit' });
  if (build.status !== 0) {
    process.exitCode = build.status ?? 1;
  } else {
    try {
      const root = process.cwd();
      const gitRoot = path.resolve(process.env.CAELOS_CATALOG_GIT_ROOT || root);
      const ownedGenerated = buildOwnedGeneratedFiles(root);
      if (!compareBuildToIndex(root, gitRoot, ownedGenerated)) process.exitCode = 1;
    } catch (error) {
      console.error(`check:generated: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
