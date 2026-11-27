// Token sources: CSS custom properties and DTCG JSON -> one index of { name, value, source }.
import { readFileSync } from "node:fs";
import { stripComments } from "./util.mjs";

/** Parse a single CSS length/time/number/colour string into a comparable form, or null. */
export function parseComparable(v) {
  const s = String(v).trim().toLowerCase();
  let m;
  if ((m = s.match(/^#([0-9a-f]{3,8})$/))) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    if (h.length < 6) return null;
    return { kind: "colour", rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) };
  }
  if ((m = s.match(/^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/))) return { kind: "colour", rgb: [+m[1], +m[2], +m[3]] };
  if ((m = s.match(/^(-?[\d.]+)(px|rem|em)$/))) return { kind: "length", n: parseFloat(m[1]) * (m[2] === "px" ? 1 : 16) };
  if ((m = s.match(/^(-?[\d.]+)(ms|s)$/))) return { kind: "time", n: parseFloat(m[1]) * (m[2] === "s" ? 1000 : 1) };
  if ((m = s.match(/^-?[\d.]+$/))) return { kind: "number", n: parseFloat(s) };
  return null;
}

function resolveVar(name, raw, depth = 0) {
  if (depth > 12) return null;
  const m = String(raw).trim().match(/^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/);
  if (!m) return raw;
  const next = raw.__map?.get(m[1]);
  return next === undefined ? null : resolveVar(m[1], next, depth + 1);
}

export function parseCssTokens(file) {
  const text = stripComments(readFileSync(file, "utf8"), { line: false });
  const out = [];
  for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) out.push({ name: m[1], raw: m[2].trim(), source: file });
  return out;
}

const flattenDtcg = (node, path, out) => {
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("$") || v === null || typeof v !== "object") continue;
    if ("$value" in v) out.push({ path: [...path, k], token: v, type: v.$type ?? node.$type });
    else flattenDtcg({ $type: v.$type ?? node.$type, ...v }, [...path, k], out);
  }
};

function dtcgToString(value, type) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ("hex" in value) return value.hex;
    if ("value" in value && "unit" in value) return `${value.value}${value.unit}`;
    return null;
  }
  if (Array.isArray(value)) return type === "cubicBezier" ? `cubic-bezier(${value.join(",")})` : value.join(", ");
  return String(value);
}

export function parseDtcgTokens(file) {
  const root = JSON.parse(readFileSync(file, "utf8"));
  const flat = [];
  flattenDtcg(root, [], flat);
  const byPath = new Map(flat.map((t) => [t.path.join("."), t]));
  const resolve = (t, depth = 0) => {
    const v = t.token.$value;
    if (typeof v === "string" && /^\{[^}]+\}$/.test(v)) {
      const next = byPath.get(v.slice(1, -1));
      return next && depth < 12 ? resolve(next, depth + 1) : null;
    }
    return dtcgToString(v, t.type);
  };
  return flat.map((t) => ({ name: "--" + t.path.join("-"), raw: resolve(t), source: file, dtcgPath: t.path.join("."), type: t.type }));
}

/** Build the index. `defined` is every known custom-property name; `resolved` holds literal values where they can be resolved. */
export function buildTokenIndex(entries) {
  const map = new Map(entries.map((e) => [e.name, e.raw]));
  const tokens = [];
  for (const e of entries) {
    if (e.raw == null) { tokens.push({ ...e, value: null }); continue; }
    const holder = new String(e.raw);
    holder.__map = map;
    const value = resolveVar(e.name, holder);
    tokens.push({ ...e, value: value == null ? null : String(value), cmp: value == null ? null : parseComparable(String(value)) });
  }
  return { defined: new Set(entries.map((e) => e.name)), tokens, byName: new Map(tokens.map((t) => [t.name, t])) };
}

const rgbDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Nearest token for a literal in one dimension. `matchers` are the dimension's token patterns, primary first. */
export function nearestToken(index, matchers, literal, nameRe = null) {
  const want = parseComparable(literal);
  const lit = String(literal).trim().toLowerCase();
  let best = null;
  for (const t of index.tokens) {
    if (!t.value || t.app || (nameRe && !nameRe.test(t.name))) continue;
    const rank = matchers.findIndex((m) => m(t.name));
    if (rank < 0) continue;
    let dist = null;
    if (want && t.cmp && t.cmp.kind === want.kind) dist = want.kind === "colour" ? rgbDist(want.rgb, t.cmp.rgb) : Math.abs(want.n - t.cmp.n);
    else if (!want && t.value.trim().toLowerCase() === lit) dist = 0;
    if (dist == null) continue;
    const max = want ? { colour: 60, length: 6, time: 150, number: 0.25 }[want.kind] : 0;
    if (dist > max) continue;
    if (!best || dist < best.dist || (dist === best.dist && rank < best.rank)) best = { name: t.name, value: t.value, dist, rank };
  }
  return best;
}
