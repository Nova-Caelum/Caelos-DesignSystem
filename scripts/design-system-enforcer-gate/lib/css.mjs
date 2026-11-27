// A small CSS reader: declarations with their selectors and offsets, plus a class index for resolving className -> properties.
import { stripComments } from "./util.mjs";

/**
 * Parse CSS text into flat declarations. Nested blocks (media queries, CSS nesting) are walked.
 * Returns { decls: [{ prop, value, idx, selector }], rules: [{ selector, decls }] }.
 * `idx` is the offset of the declaration's property name in `text`.
 */
export function parseCss(text) {
  const src = stripComments(text, { line: false });
  const decls = [], rules = [];
  const stack = [{ selector: "", own: [] }];
  let i = 0, start = 0, paren = 0, quote = null;
  const top = () => stack[stack.length - 1];
  const flushDecl = (end) => {
    const seg = src.slice(start, end);
    const m = seg.match(/^(\s*)([-\w]+|--[\w-]+)\s*:([\s\S]*)$/);
    if (m && !/^\s*[@&]/.test(seg)) {
      const d = { prop: m[2], value: m[3].trim(), idx: start + m[1].length, selector: top().selector };
      decls.push(d); top().own.push(d);
    }
  };
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (paren > 0) continue;
    else if (c === ";") { flushDecl(i); start = i + 1; }
    else if (c === "{") {
      const prelude = src.slice(start, i).trim();
      const parent = top().selector;
      const sel = prelude.startsWith("@") ? parent : prelude.includes("&") ? prelude.replace(/&/g, parent) : parent ? `${parent} ${prelude}` : prelude;
      stack.push({ selector: sel, own: [], at: prelude.startsWith("@") });
      start = i + 1;
    } else if (c === "}") {
      flushDecl(i);
      const done = stack.pop();
      if (done && !done.at && done.own.length) rules.push({ selector: done.selector, decls: done.own });
      if (!stack.length) stack.push({ selector: "", own: [] });
      start = i + 1;
    }
  }
  return { decls, rules };
}

/**
 * Class index: class name -> merged property map { prop: [values] } from every rule whose selector is a
 * single compound ending in that class (no descendant combinators), pseudo-classes included.
 */
export function buildClassIndex(parsed, into = new Map()) {
  for (const r of parsed.rules) {
    for (const sel of r.selector.split(",").map((s) => s.trim())) {
      if (/[\s>+~]/.test(sel.replace(/\[[^\]]*\]|\([^)]*\)/g, ""))) continue;
      for (const m of sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
        const props = into.get(m[1]) ?? new Map();
        for (const d of r.decls) { const a = props.get(d.prop) ?? []; a.push(d.value); props.set(d.prop, a); }
        into.set(m[1], props);
      }
    }
  }
  return into;
}

