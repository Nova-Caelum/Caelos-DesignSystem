// The token catalog's own rules. Offline; reads token_catalog/ only.
//
// - Every file parses, and each has exactly one root group, unique across files.
// - No token or group name contains '.', '{' or '}', or starts with '$'.
// - Raw values live only in 00-foundations. Every other token is a single alias.
// - Every alias resolves, to a token in a lower tier (the semantic files count as tier 0, above foundations).
// - The light semantic file holds no path the dark one lacks.
// - Every token has a $type and a status of canon, composer-derived or provisional.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'token_catalog');
const EXT = 'app.caelos';
const STATUSES = new Set(['canon', 'composer-derived', 'provisional']);
const ALIAS = /^\{([^{}]+)\}$/;

const files = readdirSync(DIR).filter((f) => f.endsWith('.tokens.json')).sort();
const load = (f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8'));
// Rank: foundations 0, semantic 1, tier N files N + 1. A token may reference only a lower rank.
const rank = (f) => (f.startsWith('00-foundations') ? 0 : f.startsWith('00-semantic') ? 1 : Number(f.slice(0, 2)) + 1);

function tokens(node, prefix, out, file) {
  for (const [name, child] of Object.entries(node)) {
    if (name.startsWith('$')) continue;
    assert.ok(!/[.{}]/.test(name), `${file}: bad name '${name}' under '${prefix}'`);
    const p = prefix ? `${prefix}.${name}` : name;
    if (child && typeof child === 'object' && '$value' in child) out.set(p, child);
    else tokens(child, p, out, file);
  }
  return out;
}

const catalog = new Map(files.map((f) => [f, tokens(load(f), '', new Map(), f)]));

test('the catalog has the expected files', () => {
  assert.deepEqual(files, [
    '00-foundations.tokens.json', '00-semantic.dark.tokens.json', '00-semantic.light.tokens.json',
    '01-primitives.tokens.json', '02-controls.tokens.json', '03-overlays.tokens.json',
    '04-patterns.tokens.json', '05-product-units.tokens.json',
  ]);
});

test('each file has one root group, unique except the two semantic modes', () => {
  const roots = files.map((f) => Object.keys(load(f)));
  for (const [i, r] of roots.entries()) assert.equal(r.length, 1, `${files[i]} has ${r.length} roots`);
  const names = roots.map((r) => r[0]).filter((r) => r !== 'sys');
  assert.equal(new Set(names).size, names.length);
});

test('raw values only in foundations; everything else is one alias', () => {
  for (const [f, toks] of catalog) {
    for (const [p, t] of toks) {
      const isAlias = typeof t.$value === 'string' && ALIAS.test(t.$value);
      if (f.startsWith('00-foundations')) assert.ok(!isAlias, `${f}: ${p} is an alias in foundations`);
      else assert.ok(isAlias, `${f}: ${p} holds a raw value`);
    }
  }
});

test('every alias resolves to a lower tier, with matching type', () => {
  const owner = (target, mode) => {
    for (const [f, toks] of catalog) {
      if (f.startsWith('00-semantic') && !f.includes(`.${mode}.`)) continue;
      if (toks.has(target)) return [f, toks.get(target)];
    }
    return [null, null];
  };
  for (const mode of ['dark', 'light']) {
    for (const [f, toks] of catalog) {
      if (f.startsWith('00-semantic') && !f.includes(`.${mode}.`)) continue;
      for (const [p, t] of toks) {
        const m = typeof t.$value === 'string' && t.$value.match(ALIAS);
        if (!m) continue;
        const [tf, target] = owner(m[1], mode);
        // Tier files resolve semantic roles against dark; a role missing from light is a parity gap, not a break.
        if (!tf && mode === 'light' && !f.startsWith('00-semantic')) continue;
        assert.ok(tf, `${f}: ${p} -> {${m[1]}} does not resolve (${mode})`);
        assert.ok(rank(tf) < rank(f), `${f}: ${p} references ${tf}, which is not a lower tier`);
        assert.equal(t.$type, target.$type, `${f}: ${p} type differs from {${m[1]}}`);
      }
    }
  }
});

test('light holds no path that dark lacks', () => {
  const dark = catalog.get('00-semantic.dark.tokens.json');
  for (const p of catalog.get('00-semantic.light.tokens.json').keys()) assert.ok(dark.has(p), `light-only path ${p}`);
});

test('every token has a type and a status', () => {
  for (const [f, toks] of catalog) {
    for (const [p, t] of toks) {
      assert.ok(t.$type, `${f}: ${p} has no $type`);
      assert.ok(STATUSES.has(t.$extensions?.[EXT]?.status), `${f}: ${p} has no valid status`);
    }
  }
});

import { compareTokens, parseCatalogColors, parsePalette, parseTokens } from '../scripts/check-palette.mjs';

const foundationFile = '00-foundations.tokens.json';
function expectedPalette() {
  if (process.env.CAELOS_PRODUCT_PALETTE) {
    return parsePalette(readFileSync(process.env.CAELOS_PRODUCT_PALETTE, 'utf8'));
  }
  // The protected workflow separately compares this public mirror and the catalog
  // directly to the private product record, without running candidate code.
  const mirror = parseTokens(readFileSync(path.join(DIR, '..', 'src', 'tokens.ts'), 'utf8'));
  assert.deepEqual(mirror.problems, []);
  return {roles:new Map([...mirror.roles].map(([role, entry]) => [role, entry.hex]))};
}
const validateColors = doc => compareTokens(parseCatalogColors(JSON.stringify(doc)), expectedPalette());

test('every foundation colour matches its own product palette role', () => {
  assert.deepEqual(validateColors(load(foundationFile)), []);
});

test('another legal palette colour cannot stand in for the declared role', () => {
  const doc = load(foundationFile);
  doc.base.color.ground.$value = doc.base.color.chrome.$value;
  assert.ok(validateColors(doc).some(m => m.includes("role 'ground'")));
  doc.base.color.ground.$extensions[EXT].paletteRole = 'chrome';
  assert.ok(validateColors(doc).some(m => m.includes('own palette role')));
});

test('missing roles, invalid channels and opacity are refused', () => {
  const doc = load(foundationFile);
  delete doc.base.color.ground;
  doc.base.color.chrome.$value.alpha = 0;
  doc.base.color.top.$value.components = [];
  const errors = validateColors(doc);
  for (const part of ['missing','color.chrome','color.top']) assert.ok(errors.some(m => m.includes(part)));
});

test('the icon glossary preserves distinct activity meanings and composer actions', () => {
  const { glossary } = load('01-primitives.tokens.json').primitives.shared.icon.$extensions[EXT];
  for (const rows of [glossary.conversation, glossary.composer]) {
    assert.equal(new Set(rows.map(row => row.glyph)).size, rows.length);
    assert.ok(rows.every(row => row.glyph && row.action && row.meaning));
  }
  const byAction = rows => Object.fromEntries(rows.map(row => [row.action, row.glyph]));
  const conversation = byAction(glossary.conversation);
  assert.equal(conversation['Thinking · reasoning'], 'Brain');
  assert.equal(conversation['General action · Request suggestions'], 'Flame');
  assert.equal(conversation['Other tool action'], 'Wrench');
  assert.equal(conversation['Write a document or artifact'], 'Feather');
  assert.equal(conversation['Read documents or files'], 'BookOpen');
  assert.equal(conversation['Run a Bash or code command'], 'Terminal');
  assert.equal(conversation['Search tool'], 'Search');
  const harnesses = byAction(glossary.harnesses);
  assert.equal(harnesses['Oh My Pi'], 'OMP');
  assert.equal(harnesses['Aelpha'], 'Aelpha');
  assert.equal(conversation['Athena · checking spacing / Agent session'], 'Bot');
  const composer = byAction(glossary.composer);
  assert.equal(composer['Model settings'], 'Zap');
  assert.equal(composer['Live Conversation Mode'], 'AudioLines');
  assert.equal(composer['Send message'], 'ArrowUp');
  assert.equal(composer['Stop response / live conversation'], 'Square');
});

test('focused ink follows the palette hover role in each theme', () => {
  const focus = load('01-primitives.tokens.json').primitives.shared['recipes-focus'];
  assert.equal(focus.foreground?.$value, '{sys.color.action-blue-hover}');
  for (const theme of ['dark', 'light']) {
    const ink = load(`00-semantic.${theme}.tokens.json`).sys.color['action-blue-hover'];
    assert.equal(ink?.$value, '{base.color.action-blue-hover}');
  }
});
