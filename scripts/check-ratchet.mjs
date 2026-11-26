import { createHash } from 'node:crypto';
import path from 'node:path';
import { baseTree, exceptionNames, exceptionsFile, legacyPaintNames, object, options, readJson, treeFiles } from './check-recipes.mjs';

// The first guarded change introduces the list. Only the original, verified
// base tree may use paint already present in its catalog as the ceiling.
const preRatchetTree = '93e9d8a89d831d7a06dbba25d75815752896c195';
const preRatchetPaintDigest = '2af7877ca2d97a6bc9b0d22477ca2ea435fd588867cfe7ea53338e3e32710f05';

function baseExceptions(tree) {
  if (tree !== preRatchetTree || treeFiles(tree, exceptionsFile).has(exceptionsFile)) {
    return exceptionNames(readJson(exceptionsFile, tree), `${exceptionsFile} at base ${tree}`);
  }
  const names = legacyPaintNames(tree);
  const digest = createHash('sha256').update(JSON.stringify(names)).digest('hex');
  if (digest !== preRatchetPaintDigest) {
    throw new Error(`${exceptionsFile}: the initial paint ceiling differs from the verified base; restore the original paint definitions`);
  }
  return new Set(names);
}

function baselineCounts(data, label) {
  if (!object(data)) throw new Error(`${label}: expected counts by file and rule; fix the baseline format`);
  for (const [file, counts] of Object.entries(data)) {
    if (!file.trim() || !object(counts)) throw new Error(`${label}: expected rule counts for ${file}; fix the baseline entry`);
    for (const [rule, count] of Object.entries(counts)) {
      if (!rule.trim() || !Number.isSafeInteger(count) || count < 0) {
        throw new Error(`${label}: invalid count for ${file} (${rule}); use a nonnegative integer`);
      }
    }
  }
  return data;
}

function checkBaseline(file, tree, errors) {
  const relative = path.relative(process.cwd(), path.resolve(file));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${file}: baseline must be inside the checkout; pass the path to the tracked baseline`);
  }
  const current = baselineCounts(readJson(relative), relative);
  const previous = baselineCounts(readJson(relative, tree), `${relative} at base ${tree}`);
  for (const [fileName, counts] of Object.entries(current)) {
    if (!Object.hasOwn(previous, fileName)) {
      errors.push(`${relative}: file ${fileName} was added; remove the added baseline entry and fix new gate errors`);
      continue;
    }
    for (const [rule, count] of Object.entries(counts)) {
      if (!Object.hasOwn(previous[fileName], rule)) {
        errors.push(`${relative}: rule ${rule} was added for ${fileName}; remove the added rule and fix new gate errors`);
      } else if (count > previous[fileName][rule]) {
        errors.push(`${relative}: ${fileName} (${rule}) count rose from ${previous[fileName][rule]} to ${count}; fix the new gate errors and restore or lower the count`);
      }
    }
  }
}

try {
  const { base, baseline } = options(process.argv.slice(2), ['--base', '--baseline']);
  const current = exceptionNames(readJson(exceptionsFile), exceptionsFile);
  const tree = baseTree(base);
  const previous = baseExceptions(tree);
  const errors = [];
  for (const name of current) {
    if (!previous.has(name)) {
      errors.push(`${exceptionsFile}: ${name} was added; remove the exception and move its paint to tier 1 or 2`);
    }
  }
  if (baseline) checkBaseline(baseline, tree, errors);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Shrink-only catalog ratchet passed.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
