#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromViewer = createRequire(import.meta.url);
const { build } = requireFromViewer('esbuild');
const dependencyPaths = [path.join(root, 'node_modules'), ...(process.env.NODE_PATH?.split(path.delimiter).filter(Boolean) ?? [])];

function argumentsFor(argv) {
  const result = {
    catalog: path.join(root, 'token_catalog'),
    generated: path.join(root, 'generated/components'),
    out: path.join(root, 'viewer/dist'),
    now: new Date().toISOString(),
    candidate: false,
    firstCommit: false,
  };
  const names = new Set(['catalog', 'generated', 'out', 'now', 'repository']);
  const ignoredCatalogCheckNames = new Set(['base', 'git-root']);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/u, '');
    if (name === 'candidate' && argv[index + 1] !== undefined) {
      result.candidate = true;
      continue;
    }
    if (name === 'base' && argv[index + 1] === 'none') result.firstCommit = true;
    if (ignoredCatalogCheckNames.has(name) && argv[index + 1] !== undefined) continue;
    if (!names.has(name) || argv[index + 1] === undefined) throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    result[name] = name === 'now' || name === 'repository' ? argv[index + 1] : path.resolve(argv[index + 1]);
  }
  return result;
}

function command(...args) {
  return execFileSync('git', args, {
    cwd: process.env.CAELOS_CATALOG_GIT_ROOT || root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function optionalCommand(...args) {
  try {
    return command(...args);
  } catch {
    return undefined;
  }
}

function githubRepository(remote) {
  const normalized = remote
    .replace(/^git@github\.com:/u, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//u, 'https://github.com/')
    .replace(/\.git$/u, '');
  return normalized.startsWith('https://github.com/') ? normalized : undefined;
}

function componentName(value) {
  const words = value.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').split(/[^A-Za-z0-9]+/u).filter(Boolean);
  const name = words.map((word) => word[0].toUpperCase() + word.slice(1)).join('');
  return /^\d/u.test(name) ? `Component${name}` : name;
}

function titleFromFile(file) {
  return file.replace(/\.tokens\.json$/u, '').replace(/^\d+-/u, '').replaceAll('-', ' ');
}

function jsonPathLines(source) {
  const lines = new Map();
  let index = 0;
  let line = 1;

  function advance() {
    if (source[index] === '\n') line += 1;
    index += 1;
  }

  function skipWhitespace() {
    while (/\s/u.test(source[index] ?? '')) advance();
  }

  function parseString() {
    const start = index;
    const keyLine = line;
    if (source[index] !== '"') throw new Error(`Expected a JSON string at line ${line}`);
    advance();
    let escaped = false;
    while (index < source.length) {
      if (escaped) {
        escaped = false;
        advance();
      } else if (source[index] === '\\') {
        escaped = true;
        advance();
      } else if (source[index] === '"') {
        advance();
        return { keyLine, value: JSON.parse(source.slice(start, index)) };
      } else {
        advance();
      }
    }
    throw new Error(`Unterminated JSON string at line ${keyLine}`);
  }

  function parseValue(pathSegments) {
    skipWhitespace();
    if (source[index] === '{') {
      advance();
      skipWhitespace();
      while (source[index] !== '}') {
        const key = parseString();
        const nextPath = [...pathSegments, key.value];
        lines.set(JSON.stringify(nextPath), key.keyLine);
        skipWhitespace();
        if (source[index] !== ':') throw new Error(`Expected a colon at line ${line}`);
        advance();
        parseValue(nextPath);
        skipWhitespace();
        if (source[index] === ',') {
          advance();
          skipWhitespace();
        } else if (source[index] !== '}') {
          throw new Error(`Expected a comma or closing brace at line ${line}`);
        }
      }
      advance();
      return;
    }
    if (source[index] === '[') {
      advance();
      skipWhitespace();
      while (source[index] !== ']') {
        parseValue(pathSegments);
        skipWhitespace();
        if (source[index] === ',') {
          advance();
          skipWhitespace();
        } else if (source[index] !== ']') {
          throw new Error(`Expected a comma or closing bracket at line ${line}`);
        }
      }
      advance();
      return;
    }
    if (source[index] === '"') {
      parseString();
      return;
    }
    while (index < source.length && !/[\s,}\]]/u.test(source[index])) advance();
  }

  parseValue([]);
  return lines;
}

function lineOf(pathLines, pathSegments) {
  const line = pathLines.get(JSON.stringify(pathSegments));
  if (line === undefined) throw new Error(`Cannot locate JSON path ${pathSegments.join('.')}`);
  return line;
}

function tokensIn(node, prefix, tier, file, pathLines, sourceUrl) {
  const tokens = [];
  function visit(value, segments) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (Object.hasOwn(value, '$value')) {
      const tokenPath = segments.join('.');
      const line = lineOf(pathLines, segments);
      tokens.push({
        path: tokenPath,
        value: typeof value.$value === 'string' ? value.$value : JSON.stringify(value.$value),
        tier,
        source: `${file}:L${line}`,
        href: `${sourceUrl}#L${line}`,
      });
      return;
    }
    for (const key of Object.keys(value).filter((key) => !key.startsWith('$')).sort()) visit(value[key], [...segments, key]);
  }
  visit(node, prefix);
  return tokens;
}

function lifecycleEvidence(value, drafts = []) {
  if (!value || typeof value !== 'object') return drafts;
  const extension = value.$extensions?.['app.caelos'];
  if (extension?.lifecycle === 'draft') drafts.push(extension.draftedAt);
  for (const child of Object.values(value)) lifecycleEvidence(child, drafts);
  return drafts;
}

async function generatorResult(options) {
  const run = spawnSync(process.execPath, [
    path.join(root, 'scripts/generate-components.mjs'),
    '--catalog', options.catalog,
    '--templates', path.join(root, 'templates'),
    '--out', options.generated,
    '--job', 'viewer-build',
  ], { cwd: root, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr || 'Component generator failed');
  return JSON.parse(run.stdout);
}

async function catalogData(options, generation, files) {
  const revision = optionalCommand('rev-parse', 'HEAD');
  if (!revision) throw new Error("cannot read the build's Git commit for source links");
  const repository = githubRepository(options.repository ?? optionalCommand('config', '--get', 'remote.origin.url') ?? '');
  if (!repository) {
    throw new Error('cannot read a GitHub remote for source links; set remote.origin.url or pass --repository <https://github.com/owner/repo>');
  }
  const gaps = new Map(generation.gaps.map((gap) => [gap.entry, gap.reason]));
  const generated = new Set(generation.generated);
  const allDrafts = [];
  const tiers = [];

  for (const file of files) {
    const source = await readFile(path.join(options.catalog, file), 'utf8');
    const pathLines = jsonPathLines(source);
    const document = JSON.parse(source);
    lifecycleEvidence(document, allDrafts);
    const tier = Number.parseInt(file.slice(0, 2), 10);
    const repositoryPath = `token_catalog/${file}`;
    const sourceUrl = `${repository}/blob/${revision}/${repositoryPath}`;
    const categories = [];
    for (const [rootName, rootNode] of Object.entries(document).filter(([key]) => !key.startsWith('$')).sort()) {
      if (!rootNode || typeof rootNode !== 'object') continue;
      for (const [categoryName, categoryNode] of Object.entries(rootNode).filter(([key]) => !key.startsWith('$')).sort()) {
        if (!categoryNode || typeof categoryNode !== 'object') continue;
        const families = [];
        for (const [familyName, familyNode] of Object.entries(categoryNode).filter(([key]) => !key.startsWith('$')).sort()) {
          if (!familyNode || typeof familyNode !== 'object') continue;
          const familyPath = `${rootName}.${categoryName}.${familyName}`;
          const extension = familyNode.$extensions?.['app.caelos'];
          const familySegments = [rootName, categoryName, familyName];
          const line = lineOf(pathLines, familySegments);
          // Mirrors readCatalog() in scripts/check-recipes.mjs: tokens at any tier and
          // tier > 0 groups at three path segments are recipe records.
          const isRecipeRecord = Object.hasOwn(familyNode, '$value') || (tier > 0 && familySegments.length === 3);
          const isGenerated = generated.has(familyPath);
          families.push({
            path: familyPath,
            title: familyName,
            lifecycle: tier > 0 && isRecipeRecord ? extension?.lifecycle ?? '' : '',
            states: Array.isArray(extension?.states) && extension.states.length > 0 ? extension.states : ['default'],
            tokens: tokensIn(familyNode, familySegments, tier, file, pathLines, sourceUrl),
            source: `${file}:L${line}`,
            sourceHref: `${sourceUrl}#L${line}`,
            recipe: JSON.stringify({ $description: familyNode.$description, $extensions: familyNode.$extensions }, null, 2),
            ...(isGenerated ? { componentName: componentName(familyName) } : {}),
            ...(gaps.has(familyPath) ? { skipReason: gaps.get(familyPath) } : {}),
            incomplete: tier > 0 && isRecipeRecord && extension === undefined,
          });
        }
        categories.push({ name: `${rootName}.${categoryName}`, families });
      }
    }
    tiers.push({ file, id: `tier-${file.replace(/[^a-z0-9]+/giu, '-')}`, title: titleFromFile(file), categories });
  }

  const now = new Date(options.now).getTime();
  const dates = allDrafts.map((value) => Date.parse(value)).filter(Number.isFinite);
  const oldestDraftDays = dates.length === 0 ? null : Math.floor((now - Math.min(...dates)) / 86_400_000);
  return { tiers, draftCount: allDrafts.length, oldestDraftDays, gaps: generation.gaps };
}

function dataPlugin(catalog, generated) {
  return {
    name: 'viewer-data',
    setup(buildContext) {
      buildContext.onResolve({ filter: /^viewer:data$/ }, () => ({ path: 'viewer:data', namespace: 'viewer-data' }));
      buildContext.onLoad({ filter: /.*/, namespace: 'viewer-data' }, () => ({
        loader: 'ts',
        resolveDir: path.dirname(generated),
        contents: `import * as components from ${JSON.stringify(generated)};\nexport { components };\nexport const catalog = ${JSON.stringify(catalog)};`,
      }));
    },
  };
}

async function bundle(options, catalog) {
  await mkdir(options.out, { recursive: true });
  const generatedIndex = path.join(options.generated, 'index.ts');
  const plugin = dataPlugin(catalog, generatedIndex);
  await build({
    absWorkingDir: root,
    bundle: true,
    entryNames: 'app',
    entryPoints: [path.join(root, 'viewer/src/main.tsx')],
    format: 'iife',
    jsx: 'automatic',
    nodePaths: dependencyPaths,
    outdir: options.out,
    plugins: [plugin],
    platform: 'browser',
    sourcemap: false,
  });
  const server = await build({
    absWorkingDir: root,
    bundle: true,
    entryPoints: [path.join(root, 'viewer/src/render.tsx')],
    format: 'cjs',
    jsx: 'automatic',
    nodePaths: dependencyPaths,
    loader: { '.css': 'empty' },
    plugins: [plugin],
    platform: 'node',
    write: false,
  });
  const source = server.outputFiles.find((file) => file.path.endsWith('.js'))?.text ?? server.outputFiles[0]?.text;
  if (!source) throw new Error('Server renderer did not emit JavaScript');
  const serverModule = { exports: {} };
  const evaluate = new Function('module', 'exports', 'require', source);
  evaluate(serverModule, serverModule.exports, requireFromViewer);
  const app = serverModule.exports.render();
  const template = await readFile(path.join(root, 'viewer/index.html'), 'utf8');
  const html = template
    .replace('<!--VIEWER_HEAD-->', '<link rel="stylesheet" href="./app.css" /><script defer src="./app.js"></script>')
    .replace('<!--VIEWER_APP-->', app);
  await writeFile(path.join(options.out, 'index.html'), html);
}

try {
  const options = argumentsFor(process.argv.slice(2));
  if (options.candidate) {
    process.stdout.write("build:viewer: skipped in candidate mode (the PR's own catalog is built by the viewer test in the unit workflow)\n");
  } else if (options.firstCommit) {
    process.stdout.write("build:viewer: skipped for a repository's first commit (--base none: there is no commit for source links to point at)\n");
  } else {
    const files = (await readdir(options.catalog)).filter((file) => /^0[0-5]-.*\.tokens\.json$/u.test(file)).sort();
    if (files.length === 0) throw new Error(`catalog folder has no tier files: ${options.catalog}`);
    const generation = await generatorResult(options);
    const catalog = await catalogData(options, generation, files);
    await bundle(options, catalog);
    process.stdout.write(`Viewer built: ${path.join(options.out, 'index.html')} (${catalog.tiers.length} tiers, ${catalog.gaps.length} gaps)\n`);
  }
} catch (error) {
  process.stderr.write(`Viewer build failed: ${error.message}\n`);
  process.exitCode = 1;
}
