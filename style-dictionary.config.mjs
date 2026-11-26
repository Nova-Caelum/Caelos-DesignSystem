import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { default: StyleDictionary } = await import(require.resolve('style-dictionary'));
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const files = ['00-foundations', '01-primitives', '02-controls', '03-overlays', '04-patterns', '05-product-units', '00-semantic.dark'];
const rules = [
  { ns: 'color', test: p => p[0] === 'sys' && p[1] === 'color' && p.length === 3 },
  { ns: 'spacing', test: p => p[0] === 'base' && p[1] === 'space' && p.length === 3 },
  { ns: 'radius', test: p => p[0] === 'base' && p[1] === 'radius' && p.length === 3 },
  { ns: 'text', test: p => p[0] === 'base' && p[1] === 'type' && p[2] === 'size' && p.length === 4 },
];

function fail(message) { throw new Error(`${message} Next: correct the catalog or build input and rerun npm run build:tokens.`); }
function countTokens(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return 0;
  if (Object.hasOwn(node, '$value')) return 1;
  return Object.entries(node).filter(([key]) => !key.startsWith('$')).reduce((sum, [, value]) => sum + countTokens(value), 0);
}

try {
  const sources = process.env.CAELOS_TOKEN_SOURCES ? JSON.parse(process.env.CAELOS_TOKEN_SOURCES) : files.map(f => `token_catalog/${f}.tokens.json`);
  if (!Array.isArray(sources) || !sources.length) fail('No source files specified; tokens in 0, written 0.');
  let input = 0;
  for (const source of sources) {
    try { input += countTokens(JSON.parse(readFileSync(source, 'utf8'))); }
    catch (error) { fail(`Cannot read or parse source ${source}: ${error.message}; tokens in ${input}, written 0.`); }
  }
  if (!input) fail('Source files contain no tokens; tokens in 0, written 0.');
  const output = resolve(process.env.CAELOS_TOKEN_OUTPUT || 'generated') + '/';
  StyleDictionary.registerFormat({ name: 'tailwind/theme', format: ({ dictionary }) => {
    const lines = [];
    for (const t of dictionary.allTokens) {
      const rule = rules.find(r => r.test(t.path));
      if (rule) lines.push(`  --${rule.ns}-${t.path.at(-1)}: var(--${t.name});`);
    }
    return `@theme {\n${lines.join('\n')}\n}\n`;
  } });
  const duplicates = new Set();
  const filter = t => !duplicates.has(t.path.join('.'));
  const sd = new StyleDictionary({
    source: sources,
    log: { verbosity: 'verbose', warnings: 'disabled' },
    platforms: { css: { transformGroup: 'css', buildPath: output, files: [
      { destination: 'tokens.css', format: 'css/variables', filter, options: { selector: ':root', outputReferences: true, showFileHeader: false } },
      { destination: 'tailwind-theme.css', format: 'tailwind/theme', filter },
    ] } },
  });
  const dictionary = await sd.getPlatformTokens('css');
  const seen = new Map();
  for (const t of dictionary.allTokens) {
    const previous = seen.get(t.name);
    if (!previous) { seen.set(t.name, t); continue; }
    const first = previous.path.join('.'), second = t.path.join('.');
    if (JSON.stringify(previous.$value) !== JSON.stringify(t.$value)) fail(`Collision --${t.name}: ${first} = ${JSON.stringify(previous.$value)}, ${second} = ${JSON.stringify(t.$value)}.`);
    console.warn(`Warning: collision --${t.name}: ${first} and ${second} share ${JSON.stringify(t.$value)}.`);
    duplicates.add(second);
  }
  await sd.buildAllPlatforms();
  const css = readFileSync(join(output, 'tokens.css'), 'utf8');
  const theme = readFileSync(join(output, 'tailwind-theme.css'), 'utf8');
  const properties = [...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map(match => match[1]);
  const written = new Set(properties).size;
  if (written !== properties.length) fail('Output contains repeated CSS property names.');
  console.log(`tokens in ${input}, written ${written}, same-value duplicates ${duplicates.size}`);
  if (!css.trim() || !written || !theme.trim() || !/@theme\s*\{/.test(theme) || !/--[\w-]+\s*:/.test(theme)) fail('Empty or invalid output file.');
  if (input - written !== duplicates.size) fail(`Token count mismatch: tokens in ${input}, written ${written}, same-value duplicates ${duplicates.size}.`);
} catch (error) {
  console.error(`Token build failed: ${error.message} Next: inspect the named token or source and correct it before rebuilding.`);
  process.exitCode = 1;
}
