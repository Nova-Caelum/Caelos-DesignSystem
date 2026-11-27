// Small zero-dependency helpers: globs, directory walk, line maths, comment blanking.
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".nuxt", ".svelte-kit", "out", "dist", "build", "coverage", ".turbo", ".cache", "__pycache__"]);
const PAGE_OUTPUT_DIRS = new Set(["out", "dist", "build", "coverage"]);

/** Glob to RegExp. Supports **, *, ?, {a,b}. Matches against forward-slash relative paths. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      re += "(?:" + glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|") + ")";
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

export const matcher = (globs) => {
  const res = (globs ?? []).map(globToRegExp);
  return (rel) => res.some((r) => r.test(rel));
};

function configuredPageMatcher(root) {
  let globs;
  try { globs = JSON.parse(process.env.CAELOS_PAGE_PAINT_PAGES ?? "null"); } catch { globs = null; }
  if (!Array.isArray(globs)) {
    const configFlag = process.argv.indexOf("--config");
    const configPath = configFlag >= 0 && process.argv[configFlag + 1]
      ? resolve(process.argv[configFlag + 1])
      : join(root, "design-system-enforcer-gate.config.json");
    try { globs = JSON.parse(readFileSync(configPath, "utf8")).pages; } catch { globs = null; }
  }
  return Array.isArray(globs) && globs.every((glob) => typeof glob === "string") ? matcher(globs) : null;
}

/** Every file under `root` (forward-slash relative paths), skipping dependency and unrequested output directories. */
export function walk(root) {
  const out = [];
  const pageMatch = configuredPageMatcher(root);
  (function rec(dir, pageOnly = false) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) rec(p, pageOnly);
        else if (pageMatch && PAGE_OUTPUT_DIRS.has(name)) rec(p, true);
      } else {
        const rel = relative(root, p).split(sep).join("/");
        if (!pageOnly || pageMatch(rel)) out.push(rel);
      }
    }
  })(root);
  return out;
}

/** Precomputed line starts so many lookups on one file stay cheap. */
export function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (idx) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

/** Replace the characters of a span with spaces, keeping newlines so offsets and line numbers hold. */
export const blank = (s) => s.replace(/[^\n]/g, " ");

/** Blank block comments (and, when `line` is set, // comments, except after a colon as in URLs). Offsets and lines hold. */
export function stripComments(text, { line = true } = {}) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (line) out = out.replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));
  return out;
}

/** Index of the matching close for the opener at `open` (one of ( [ {), skipping strings. -1 when unbalanced. */
export function matchClose(text, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const o = text[open], c = pairs[o];
  let depth = 0, quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === "\\") i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  return -1;
}

export const kebab = (s) => s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
export const camel = (s) => s.replace(/-([a-z])/g, (_, m) => m.toUpperCase());
