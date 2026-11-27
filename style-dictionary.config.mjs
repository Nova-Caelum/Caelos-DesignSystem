import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { default: StyleDictionary } = await import(require.resolve('style-dictionary'));
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const files = ['00-foundations', '01-primitives', '02-controls', '03-overlays', '04-patterns', '05-product-units', '00-semantic.dark'];
const rules = [
  { ns: 'color', test: p => p[0] === 'sys' && p[1] === 'color' && p.length === 3 },
  { ns: 'spacing', test: p => p[0] === 'base' && p[1] === 'space' && p.length === 3 },
  { ns: 'radius', test: p => p[0] === 'base' && p[1] === 'radius' && p.length === 3 },
  { ns: 'text', test: p => p[0] === 'base' && p[1] === 'type' && p[2] === 'size' && p.length === 4 },
];
const cssTokenName = StyleDictionary.hooks.transforms['name/kebab'].transform;

export function tokenName(path) {
  return cssTokenName({ path }, {});
}

function fail(message) { throw new Error(message); }
export function countTokens(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return 0;
  if (Object.hasOwn(node, '$value')) return 1;
  return Object.entries(node).filter(([key]) => !key.startsWith('$')).reduce((sum, [, value]) => sum + countTokens(value), 0);
}

export function checkOutput({ css, theme, input }) {
  const properties = [...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map(match => match[1]);
  const written = new Set(properties).size;
  if (written !== properties.length) fail('Output contains repeated CSS property names.');
  if (!css.trim() || !written || !theme.trim() || !/@theme\s*\{/.test(theme) || !/--[\w-]+\s*:/.test(theme)) fail('Empty or invalid output file.');
  if (input !== written) fail(`Token count mismatch: tokens in ${input}, written ${written}.`);
  return written;
}

async function build() {
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
  const sd = new StyleDictionary({
    source: sources,
    log: { verbosity: 'verbose', warnings: 'disabled', errors: { brokenReferences: 'throw' } },
    platforms: { css: { transformGroup: 'css', buildPath: output, files: [
      { destination: 'tokens.css', format: 'css/variables', options: { selector: ':root', outputReferences: true, showFileHeader: false } },
      { destination: 'tailwind-theme.css', format: 'tailwind/theme' },
    ] } },
  });
  const dictionary = await sd.getPlatformTokens('css');
  const seen = new Map();
  for (const t of dictionary.allTokens) {
    const previous = seen.get(t.name);
    if (!previous) { seen.set(t.name, t); continue; }
    const first = previous.path.join('.'), second = t.path.join('.');
    fail(`Collision --${t.name}: ${first} = ${JSON.stringify(previous.$value)}, ${second} = ${JSON.stringify(t.$value)}.`);
  }
  await sd.buildAllPlatforms();
  const css = readFileSync(join(output, 'tokens.css'), 'utf8');
  const theme = readFileSync(join(output, 'tailwind-theme.css'), 'utf8');
  const written = checkOutput({ css, theme, input });
  console.log(`tokens in ${input}, written ${written}`);
}

const entryFile = process.argv[1] ? realpathSync(resolve(process.argv[1])) : null;
const moduleFile = realpathSync(fileURLToPath(import.meta.url));
if (entryFile === moduleFile) {
  try {
    await build();
  } catch (error) {
    console.error(`Token build failed: ${error.message} Next: inspect the named token or source and correct it before rebuilding.`);
    process.exitCode = 1;
  }
}
