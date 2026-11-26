#!/usr/bin/env node
// design-system-enforcer-gate: fails any UI code whose visual values are not derived from the design system.
//
//   node design-system-enforcer-gate.mjs [--config design-system-enforcer-gate.config.json] [--json] [--only rule,rule] [--strict] [repoDir]
//
// Exit 1 on any error-severity finding (any finding with --strict). Each is printed as
//   file:line  [rule] what is wrong — the fix (nearest token when computable)
// Zero dependencies. See README.md.
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join, relative, dirname, isAbsolute } from "node:path";
import { walk, matcher, globToRegExp } from "./lib/util.mjs";
import { loadConfig, expandHome } from "./lib/config.mjs";
import { parseCssTokens, parseDtcgTokens, buildTokenIndex } from "./lib/tokens.mjs";
import { parseCss, buildClassIndex } from "./lib/css.mjs";
import { createEngine } from "./lib/scan.mjs";

const args = process.argv.slice(2);
let configPath = null, json = false, strict = false, only = null, repoArg = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--config") configPath = args[++i];
  else if (a === "--json") json = true;
  else if (a === "--strict") strict = true;
  else if (a === "--only") only = new Set(args[++i].split(","));
  else if (a === "-h" || a === "--help") { console.log("usage: design-system-enforcer-gate.mjs [--config FILE] [--json] [--strict] [--only rule,rule] [repoDir]"); process.exit(0); }
  else repoArg = a;
}
const root = resolve(repoArg ?? process.cwd());
if (!existsSync(root) || !statSync(root).isDirectory()) { console.error(`design-system-enforcer-gate: not a directory: ${root}`); process.exit(2); }
if (!configPath && existsSync(join(root, "design-system-enforcer-gate.config.json"))) configPath = join(root, "design-system-enforcer-gate.config.json");

let cfg;
try { cfg = loadConfig(configPath ? resolve(configPath) : null, root); } catch (e) { console.error(`design-system-enforcer-gate: ${e.message}`); process.exit(2); }

const hasGlob = (p) => /[*?{]/.test(p);
/** Expand path-or-glob patterns (relative to the repo, ~/ and ../ allowed) to absolute file paths. */
function expand(patterns) {
  const out = new Set();
  for (const pat of patterns ?? []) {
    const abs = isAbsolute(expandHome(pat)) ? expandHome(pat) : resolve(root, pat);
    if (!hasGlob(abs)) { if (existsSync(abs)) out.add(abs); continue; }
    const parts = abs.split("/"); const k = parts.findIndex(hasGlob);
    const base = parts.slice(0, k).join("/") || "/";
    const re = globToRegExp(parts.slice(k).join("/"));
    for (const rel of walk(base)) if (re.test(rel)) out.add(join(base, rel));
  }
  return [...out];
}

const tokenFiles = [...expand(cfg.tokens.css), ...expand(cfg.tokens.dtcg)];
const tokenSet = new Set(tokenFiles);
const entries = [];
try {
  for (const f of expand(cfg.tokens.css)) entries.push(...parseCssTokens(f));
  for (const f of expand(cfg.tokens.dtcg)) entries.push(...parseDtcgTokens(f));
} catch (e) { console.error(`design-system-enforcer-gate: cannot read token sources: ${e.message}`); process.exit(2); }
if (!entries.length) console.error("design-system-enforcer-gate: warning — no tokens found; check tokens.css / tokens.dtcg in the config");

// Files to scan.
const inc = matcher(cfg.scan.include), exc = matcher(cfg.scan.exclude);
const types = new Set(cfg.scan.types);
const files = walk(root)
  .filter((rel) => inc(rel) && !exc(rel) && types.has(rel.split(".").pop()) && !tokenSet.has(join(root, rel)))
  .map((rel) => ({ rel, abs: join(root, rel), type: rel.split(".").pop() }));
const classIndexFiles = expand(cfg.classIndex).filter((p) => p.endsWith(".css")).map((abs) => ({ abs, rel: relative(root, abs).split("\\").join("/") }));

// Prepass: class index, module css, defined custom properties, app custom properties (for alias resolution).
const classGlobal = new Map(), moduleIdx = new Map(), defined = new Set(), texts = new Map();
const appEntries = [];
for (const f of files) texts.set(f.abs, readFileSync(f.abs, "utf8"));
const cssTargets = [...files.filter((f) => f.type === "css"), ...classIndexFiles];
for (const f of cssTargets) {
  const text = texts.get(f.abs) ?? readFileSync(f.abs, "utf8");
  const parsed = parseCss(text);
  if (/\.module\.(css|scss)$/.test(f.rel)) moduleIdx.set(f.rel, buildClassIndex(parsed, new Map()));
  else buildClassIndex(parsed, classGlobal);
  for (const d of parsed.decls) if (d.prop.startsWith("--")) appEntries.push({ name: d.prop, raw: d.value, source: f.abs, app: true });
}
for (const [abs, text] of texts) {
  if (abs.endsWith(".css")) continue;
  for (const m of text.matchAll(/["'](--[\w-]+)["']\s*[:,]/g)) defined.add(m[1]); // set from JS: style={{"--x": v}}, setProperty("--x", v)
  for (const m of text.matchAll(/(?:^|[\s;{])(--[\w-]+)\s*:/g)) defined.add(m[1]);
}
const index = buildTokenIndex([...entries, ...appEntries.filter((e) => !entries.some((t) => t.name === e.name))]);
for (const n of index.defined) defined.add(n);
for (const e of appEntries) defined.add(e.name);

const engine = createEngine({ root, cfg, index, classGlobal, moduleIdx, defined });
let findings = [], exempt = [];
for (const f of files) {
  const raw = texts.get(f.abs);
  if (cfg.kit.fileRequires.some((r) => r.siblingSuffix) && f.type === "tsx") { const sib = f.abs.replace(/\.tsx$/, ".module.css"); f.siblingText = existsSync(sib) ? readFileSync(sib, "utf8") : ""; }
  const res = engine.scanFile(f, raw);
  findings.push(...res.findings); exempt.push(...res.exempt);
}
for (const pr of cfg.kit.projectRequires) {
  const re = new RegExp(pr.anyOf);
  if (!files.some((f) => f.type !== "css" && re.test(texts.get(f.abs)))) findings.push({ file: "(project)", line: 0, rule: pr.id, severity: cfg.severity[pr.id] ?? "error", message: pr.message ?? `nothing matches ${pr.anyOf}` });
}
if (only) { findings = findings.filter((f) => only.has(f.rule)); exempt = exempt.filter((f) => only.has(f.rule)); }
findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

const errors = findings.filter((f) => f.severity === "error"), warns = findings.filter((f) => f.severity !== "error");
const failing = cfg.failOn.includes("warn") || strict ? findings : errors;
const tally = (list) => list.reduce((a, f) => ((a[f.rule] = (a[f.rule] ?? 0) + 1), a), {});

if (json) {
  console.log(JSON.stringify({ files: files.length, tokens: index.tokens.length, errors: errors.length, warnings: warns.length, byRule: tally(findings), findings, exempt }, null, 1));
} else {
  const head = `design-system-enforcer-gate: ${failing.length ? "FAIL" : "PASS"} — ${files.length} files, ${index.tokens.length} tokens; ${errors.length} error(s), ${warns.length} warning(s)`;
  const by = Object.entries(tally(findings)).map(([k, n]) => `${k} ${n}`).join(", ");
  console.log(head + (by ? `: ${by}` : ""));
  for (const f of findings) console.log(`  ${f.file}${f.line ? ":" + f.line : ""}  [${f.rule}] ${f.severity === "error" ? "" : "(" + f.severity + ") "}${f.message}`);
  if (exempt.length) { console.log(`exempt (${exempt.length}) — reasons, for review:`); for (const f of exempt) console.log(`  ${f.file}:${f.line}  [${f.rule}] exempt: ${f.reason}`); }
}
process.exitCode = failing.length ? 1 : 0; // not process.exit(): it can truncate a large piped report
