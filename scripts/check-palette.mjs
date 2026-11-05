// Palette check. Every colour in every git-tracked text file under the scan root must be in the
// product palette, which is read at run time from the Nova Caelum brand library through the vault
// gateway. palettes.md, read the same way, must hold no hex code at all: every hex lives in the
// palette record.
//
// Exit 0: every colour is allowed and palettes.md holds no hex code.
// Exit 1: a colour is not allowed, or palettes.md holds a hex code.
// Exit 2: the check could not run (no palette, bad configuration, no git). Never a pass.
//
// The scan root is data. Nothing under it is executed or imported, and a link inside it is never
// followed out of it. The output holds hashes, line numbers and the scanned colours with file:line;
// it never holds palette or vault text. There are no exclusions, no ignore comments and no allowlist.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PRODUCT_PALETTE_PATH = 'AgentSecretBase/brand_library/resources/product-palette.json';
export const PALETTES_MD_PATH = 'AgentSecretBase/brand_library/resources/palettes.md';

export class ConfigError extends Error {}

// ---------------------------------------------------------------------------------------------
// Colour vocabulary

// CSS named colours, one string, split at run time. Exempt keywords are not in it.
const NAMED = new Set(
  ('aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|' +
    'burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|' +
    'darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|' +
    'darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|' +
    'deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|' +
    'ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|' +
    'lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|' +
    'lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|' +
    'lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|' +
    'mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|' +
    'mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|' +
    'orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|' +
    'pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|' +
    'seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|' +
    'teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen').split('|'),
);
// CSS system colours: colours too, but common words as strings, so only refused as declaration values.
const SYSTEM = new Set(
  ('accentcolor|accentcolortext|activetext|buttonborder|buttonface|buttontext|canvas|canvastext|field|' +
    'fieldtext|graytext|highlight|highlighttext|linktext|mark|marktext|selecteditem|selecteditemtext|' +
    'visitedtext').split('|'),
);
export const NAMED_COLOUR_COUNT = NAMED.size;

// Declaration properties whose value can carry a colour, besides every property ending in -color.
const COLOUR_PROPS = new Set(
  ('color|bg|background|background-image|border|border-top|border-right|border-bottom|border-left|' +
    'border-block|border-inline|border-block-start|border-block-end|border-inline-start|border-inline-end|' +
    'border-image|outline|box-shadow|text-shadow|text-decoration|text-emphasis|column-rule|fill|stroke|' +
    'filter|backdrop-filter|mask|mask-image|text-stroke').split('|'),
);

// ---------------------------------------------------------------------------------------------
// Palette record

export function parsePalette(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ConfigError('the palette record is not valid JSON');
  }
  if (!doc || doc.schema !== 1) throw new ConfigError('the palette record must have "schema": 1');
  if (doc.palette !== 'product') {
    throw new ConfigError('the palette record is not the product palette: this check reads the product palette only');
  }
  if ('rulings' in doc) {
    throw new ConfigError('the palette record carries "rulings": colors is the only allow-list, and a colour not in it is refused');
  }
  if (!Array.isArray(doc.colors) || doc.colors.length === 0) throw new ConfigError('the palette record has no colors');
  const hexRe = /^#[0-9A-Fa-f]{6}$/;
  const allowed = new Set();
  for (const [i, c] of doc.colors.entries()) {
    if (!c || !hexRe.test(c.hex) || !c.role || !c.name) throw new ConfigError(`palette colour ${i} is malformed`);
    allowed.add(c.hex.toUpperCase());
  }
  return { allowed };
}

// Line numbers of palettes.md that hold a hex code. Self-contained on purpose: it also runs inside the
// gateway, so the markdown never leaves the vault, only these numbers do.
export function hexLineNumbers(md) {
  const re = /#[0-9a-fA-F]{3,8}\b/;
  const lines = [];
  md.split('\n').forEach((line, i) => {
    if (re.test(line)) lines.push(i + 1);
  });
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Gateway read

function buildProgram() {
  return [
    hexLineNumbers.toString(),
    `const j = await vault.read({ path: ${JSON.stringify(PRODUCT_PALETTE_PATH)} });`,
    `const m = await vault.read({ path: ${JSON.stringify(PALETTES_MD_PATH)} });`,
    'return { json: { hash: j.hash, encoding: j.encoding, content: j.content }, md: { hash: m.hash, hexLines: hexLineNumbers(m.content) } };',
  ].join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function readFromGateway({ url, agent, key, fetchImpl = fetch, retryDelayMs = 1000 }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError('GAETWAY_URL is not a URL');
  }
  if (parsed.protocol !== 'https:') throw new ConfigError('GAETWAY_URL must be an https URL');
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'execute', arguments: { code: buildProgram() } },
  });
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-gaetway-agent': agent,
    authorization: `Bearer ${key}`,
  };
  let res;
  let lastError = 'no attempt';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) });
      if (res.status < 500) break;
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      res = undefined;
      lastError = e?.message ?? String(e);
    }
    if (attempt < 2) await sleep(retryDelayMs * 2 ** attempt);
  }
  if (!res) throw new ConfigError(`the gateway could not be reached: ${lastError}`);
  let payload;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (res.status !== 200) {
    const code = typeof payload?.code === 'string' ? payload.code : '';
    throw new ConfigError(`the gateway answered HTTP ${res.status}${code ? ` (${code})` : ''}; check GAETWAY_AGENT and GAETWAY_KEY`);
  }
  const structured = payload?.result?.structuredContent;
  if (payload?.result?.isError || !structured || structured.error) {
    const e = structured?.error;
    const code = typeof e?.code === 'string' ? `: ${e.code}` : '';
    const id = typeof e?.request_id === 'string' ? ` (request ${e.request_id})` : '';
    throw new ConfigError(`the gateway refused the read${code}${id}`);
  }
  const value = structured.result;
  if (!value?.json || typeof value.json.content !== 'string' || !Array.isArray(value?.md?.hexLines)) {
    throw new ConfigError('the gateway returned no palette (result missing or truncated)');
  }
  const sha = createHash('sha256').update(value.json.content, 'utf8').digest('hex');
  if (value.json.encoding !== 'text' || sha !== value.json.hash) {
    throw new ConfigError('the palette record failed its hash check');
  }
  return {
    paletteText: value.json.content,
    mdHexLines: value.md.hexLines,
    source: `vault ${PRODUCT_PALETTE_PATH} sha256=${value.json.hash}; vault ${PALETTES_MD_PATH} sha256=${value.md.hash}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Colour scanning

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const toHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const NUM = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

function hexToRgbHex(digits) {
  const d = digits.toUpperCase();
  if (d.length === 3 || d.length === 4) return `#${[...d.slice(0, 3)].map((c) => c + c).join('')}`;
  return `#${d.slice(0, 6)}`;
}

function channels(args) {
  const slash = args.indexOf('/');
  const left = slash >= 0 ? args.slice(0, slash) : args;
  const legacy = slash < 0 && left.includes(',');
  const toks = left.trim().split(legacy ? /\s*,\s*/ : /\s+/).filter(Boolean);
  if (!legacy) return toks.length === 3 ? toks : null;
  return toks.length === 3 || toks.length === 4 ? toks.slice(0, 3) : null;
}

function rgbToHex(args) {
  const toks = channels(args);
  if (!toks) return null;
  const out = [];
  for (const t of toks) {
    const pct = t.endsWith('%');
    const body = pct ? t.slice(0, -1) : t;
    if (!NUM.test(body)) return null;
    const n = Number(body);
    out.push(clamp(Math.round(pct ? n * 2.55 : n), 0, 255));
  }
  return toHex(...out);
}

function hslToHex(args) {
  const toks = channels(args);
  if (!toks) return null;
  const hm = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|grad|rad|turn)?$/i.exec(toks[0]);
  if (!hm) return null;
  const unit = (hm[2] ?? 'deg').toLowerCase();
  const deg = Number(hm[1]) * { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 }[unit];
  const pc = (t) => (t.endsWith('%') && NUM.test(t.slice(0, -1)) ? clamp(Number(t.slice(0, -1)) / 100, 0, 1) : null);
  const s = pc(toks[1]);
  const l = pc(toks[2]);
  if (s === null || l === null) return null;
  const h = ((deg % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return toHex(...[r, g, b].map((v) => clamp(Math.round((v + m) * 255), 0, 255)));
}

function matchingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

// A bare word: not part of a longer identifier, a path, a member access or a hyphenated name.
const WORD = /(?<![\w$.\/-])([A-Za-z]+)(?![\w$.\/-])/g;
const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).toLowerCase();

function valueExtent(text, start) {
  const q = text[start];
  if (q === '"' || q === "'" || q === '`') {
    const limit = q === '`' ? 2000 : 400;
    for (let i = start + 1; i < text.length && i - start < limit; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === q) return [start + 1, i];
      else if (text[i] === '\n' && q !== '`') break;
    }
    const nl = text.indexOf('\n', start);
    return [start + 1, nl < 0 ? text.length : nl];
  }
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (ch === ';' || ch === '}' || ch === '"' || ch === "'" || ch === '`')) break;
    else if (ch === '\n' && i > start) {
      const before = text.slice(start, i).trimEnd();
      if (before && !before.endsWith(',')) break;
    }
  }
  return [start, i];
}

export function scanText(text, palette) {
  const hits = new Map();
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const where = (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: index - starts[lo] + 1 };
  };
  const add = (index, value, reason) => {
    if (hits.has(index)) return;
    const shown = value.replace(/\s+/g, ' ');
    hits.set(index, { ...where(index), value: shown.length > 80 ? `${shown.slice(0, 77)}...` : shown, reason });
  };
  const judge = (index, shown, hex) => {
    if (palette.allowed.has(hex)) return;
    add(index, shown, 'not in the product palette');
  };

  // Hex colours, including the percent-encoded form used inside data URLs.
  for (const m of text.matchAll(/(?:#|%23)([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9A-Za-z_])/g)) {
    if (m[0][0] === '#' && text[m.index - 1] === '&') continue;
    judge(m.index, m[0], hexToRgbHex(m[1]));
  }

  // The red-green-blue and hue-saturation-lightness functions are normalised to hex; anything that cannot be normalised is refused.
  for (const m of text.matchAll(/(?<![\w$-])(rgba?|hsla?)\(/gi)) {
    const open = m.index + m[0].length - 1;
    const close = matchingParen(text, open);
    const shown = text.slice(m.index, close < 0 ? Math.min(text.length, m.index + 60) : close + 1);
    const hex = close < 0 ? null : (m[1].toLowerCase().startsWith('rgb') ? rgbToHex : hslToHex)(text.slice(open + 1, close));
    if (hex === null) add(m.index, shown, 'colour function that cannot be checked against the palette');
    else judge(m.index, shown, hex);
  }

  // Colour spaces and mixers that cannot be checked against a hex list.
  for (const m of text.matchAll(/(?<![\w$-])(?:oklch|oklab|lab|lch|hwb|device-cmyk|color-contrast|contrast-color)\(|(?<![\w$.-])color\(/gi)) {
    add(m.index, m[0], 'colour format that cannot be checked against the palette');
  }
  for (const m of text.matchAll(/(?<![\w$-])color-mix\(/gi)) {
    const open = m.index + m[0].length - 1;
    const close = matchingParen(text, open);
    const inner = close < 0 ? text.slice(open) : text.slice(open + 1, close);
    const literal = /(?:#|%23)[0-9a-fA-F]{3,8}|(?<![\w$-])(?:rgba?|hsla?)\(/i.test(inner) ||
      [...inner.matchAll(WORD)].some((w) => NAMED.has(w[1].toLowerCase()));
    if (close < 0 || literal) add(m.index, close < 0 ? text.slice(m.index, m.index + 60) : text.slice(m.index, close + 1), 'color-mix with a literal colour cannot be checked against the palette');
  }

  // Named colours. A quoted string that is only a colour name; a colour property's value; an unquoted attribute.
  const quoted = /(["'`])[ \t]*([A-Za-z]+)[ \t]*\1/y;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '"' && ch !== "'" && ch !== '`') continue;
    quoted.lastIndex = i;
    const m = quoted.exec(text);
    if (m && NAMED.has(m[2].toLowerCase())) add(i + m[0].indexOf(m[2]), m[2], 'named colour (not a palette hex)');
  }
  for (const m of text.matchAll(/(?<![\w$.-])(["']?)(--[\w-]+|-?[A-Za-z][\w-]*)\1[ \t]*:\s*/g)) {
    const prop = kebab(m[2]).replace(/^-(webkit|moz)-/, '');
    if (!prop.startsWith('--') && !prop.endsWith('-color') && !COLOUR_PROPS.has(prop)) continue;
    const base = m.index + m[0].length;
    const [from, to] = valueExtent(text, base);
    const value = text.slice(from, to).replace(/\$\{[^}]*\}/g, (s) => ' '.repeat(s.length)).replace(/url\([^)]*\)/gi, (s) => ' '.repeat(s.length));
    for (const w of value.matchAll(WORD)) {
      const name = w[1].toLowerCase();
      if (NAMED.has(name) || SYSTEM.has(name)) add(from + w.index, w[1], 'named colour (not a palette hex)');
    }
  }
  for (const m of text.matchAll(/(?<![\w$-])(?:fill|stroke|color|bgcolor|[a-z]+-color)=([A-Za-z]+)(?![\w.\/-])/g)) {
    if (NAMED.has(m[1].toLowerCase())) add(m.index + m[0].length - m[1].length, m[1], 'named colour (not a palette hex)');
  }

  return [...hits.values()].sort((a, b) => a.line - b.line || a.col - b.col);
}

// ---------------------------------------------------------------------------------------------
// Repository scan

export function scanRepo(root, palette) {
  let listed;
  try {
    listed = execFileSync('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 1 << 28 }).toString('utf8');
  } catch {
    throw new ConfigError('git ls-files failed: is this a git checkout?');
  }
  const files = listed.split('\0').filter(Boolean);
  const realRoot = realpathSync(root);
  const findings = [];
  let scanned = 0;
  let binary = 0;
  let submodules = 0;
  for (const rel of files) {
    const full = path.join(root, rel);
    let buf;
    try {
      const parent = realpathSync(path.dirname(full));
      if (parent !== realRoot && !parent.startsWith(realRoot + path.sep)) {
        throw new ConfigError(`tracked path ${rel} resolves outside the scan root`);
      }
      const st = lstatSync(full);
      if (st.isDirectory()) {
        submodules++;
        continue;
      }
      buf = st.isSymbolicLink() ? Buffer.from(readlinkSync(full)) : readFileSync(full);
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      throw new ConfigError(`could not read tracked file ${rel}: ${e.code ?? e.message}`);
    }
    if (buf.subarray(0, 8192).includes(0)) {
      binary++;
      continue;
    }
    scanned++;
    for (const f of scanText(buf.toString('utf8'), palette)) findings.push({ file: rel, ...f });
  }
  if (scanned === 0) throw new ConfigError('no tracked text files were scanned');
  return { findings, scanned, binary, submodules };
}

// ---------------------------------------------------------------------------------------------
// Command line

function parseArgs(argv) {
  const opts = { root: null, palette: null, paletteMd: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const key = { '--root': 'root', '--palette': 'palette', '--palette-md': 'paletteMd' }[flag];
    if (!key || i + 1 >= argv.length) throw new ConfigError(`unknown or incomplete argument: ${flag}`);
    opts[key] = argv[++i];
  }
  if (Boolean(opts.palette) !== Boolean(opts.paletteMd)) throw new ConfigError('--palette and --palette-md must be given together');
  return opts;
}

export async function main(argv, env, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
  try {
    const opts = parseArgs(argv);
    let paletteText;
    let mdHexLines;
    let source;
    if (opts.palette) {
      paletteText = readFileSync(opts.palette, 'utf8');
      mdHexLines = hexLineNumbers(readFileSync(opts.paletteMd, 'utf8'));
      source = 'local fixtures (--palette, tests only)';
    } else {
      const missing = ['GAETWAY_URL', 'GAETWAY_AGENT', 'GAETWAY_KEY'].filter((k) => !env[k]);
      if (missing.length) throw new ConfigError(`not configured: set ${missing.join(', ')}`);
      ({ paletteText, mdHexLines, source } = await readFromGateway({
        url: env.GAETWAY_URL,
        agent: env.GAETWAY_AGENT,
        key: env.GAETWAY_KEY,
        fetchImpl: io.fetchImpl,
        retryDelayMs: io.retryDelayMs,
      }));
    }
    const palette = parsePalette(paletteText);
    const root = path.resolve(opts.root ?? '.');
    const { findings, scanned, binary, submodules } = scanRepo(root, palette);
    out(`palette source: ${source}\n`);
    out(`scanned ${scanned} text files (${binary} binary and ${submodules} submodule paths skipped)\n`);
    if (mdHexLines.length) err(`FAIL palettes.md: hex code at line ${mdHexLines.join(', ')}; palettes.md must name colours only\n`);
    for (const f of findings) err(`FAIL ${f.file}:${f.line}:${f.col}  ${f.value}  ${f.reason}\n`);
    if (mdHexLines.length || findings.length) {
      err(`palette check FAILED: ${findings.length} colour(s) outside the product palette in ${new Set(findings.map((f) => f.file)).size} file(s); palettes.md holds hex codes on ${mdHexLines.length} line(s)\n`);
      return 1;
    }
    out('palette check passed\n');
    return 0;
  } catch (e) {
    err(`palette check could not run: ${e?.message ?? e}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
