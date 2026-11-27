// Markup reader for JSX/TSX and Vue/Svelte/HTML templates: a tree of elements with attributes, children and text flags.
import { matchClose } from "./util.mjs";

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

function skipString(text, i) {
  const q = text[i];
  for (i++; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (q === "`" && text[i] === "$" && text[i + 1] === "{") { const j = matchClose(text, i + 1); if (j < 0) return text.length; i = j; }
    else if (text[i] === q) return i;
  }
  return text.length;
}

function looksLikeJsx(text, i) {
  const next = text[i + 1];
  if (!(next === ">" || /[A-Za-z]/.test(next ?? ""))) return false;
  let j = i - 1;
  if (j >= 0 && /[\w$)\]]/.test(text[j])) return false; // foo<T>, a<b: a generic or comparison
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j < 0) return true;
  const p = text[j];
  if ("(,=:?&|{};>!".includes(p)) return !/^<[A-Z](\s*,|\s+extends\b)/.test(text.slice(i, i + 24)); // not `<T,>(` / `<T extends X>(`
  return /\breturn$|\bdefault$|\bcase$/.test(text.slice(Math.max(0, j - 8), j + 1));
}

function parseOpenTag(text, i, mode) {
  const nm = text.slice(i + 1).match(/^[A-Za-z][\w.:-]*/);
  const tag = nm ? nm[0] : "";
  let p = i + 1 + tag.length;
  const attrs = [];
  let selfClosing = false;
  for (; p < text.length; p++) {
    const c = text[p];
    if (/\s/.test(c)) continue;
    if (c === ">") break;
    if (c === "/" && text[p + 1] === ">") { selfClosing = true; p++; break; }
    if (c === "{") { const e = matchClose(text, p); if (e < 0) return null; attrs.push({ name: "...", kind: "spread", value: text.slice(p + 1, e), start: p, end: e }); p = e; continue; }
    const m = text.slice(p).match(/^[^\s=>/{"']+/);
    if (!m) { if (text[p] === "/") continue; return null; }
    const a = { name: m[0], kind: "bool", value: "", start: p, end: p + m[0].length };
    p += m[0].length;
    let q = p; while (/\s/.test(text[q] ?? "")) q++;
    if (text[q] === "=") {
      q++; while (/\s/.test(text[q] ?? "")) q++;
      const v = text[q];
      if (v === '"' || v === "'") { const e = text.indexOf(v, q + 1); if (e < 0) return null; a.kind = "str"; a.value = text.slice(q + 1, e); a.end = e; p = e; }
      else if (v === "{") { const e = matchClose(text, q); if (e < 0) return null; a.kind = "expr"; a.value = text.slice(q + 1, e); a.end = e; p = e; }
      else { const u = text.slice(q).match(/^[^\s>]+/); a.kind = "str"; a.value = u ? u[0] : ""; p = q + a.value.length - 1; a.end = p; }
    } else p -= 1;
    attrs.push(a);
  }
  if (p >= text.length) return null;
  if (mode === "html" && VOID.has(tag.toLowerCase())) selfClosing = true;
  return { tag, attrs, selfClosing, openEnd: p };
}

/** Parse markup. mode: "jsx" (TS/JS with embedded JSX) or "html" (Vue/Svelte/HTML template text). */
export function parseMarkup(text, mode) {
  const elements = [];
  const open = []; // open elements
  const frames = [mode === "jsx" ? { t: "js" } : { t: "children" }];
  let eachDepth = 0;
  const realParent = () => { for (let k = open.length - 1; k >= 0; k--) if (!open[k].fragment) return open[k]; return null; };
  const addElement = (info, idx) => {
    const el = { ...info, idx, parent: realParent(), children: [], textLen: 0, exprChildren: 0, inMap: eachDepth > 0, fragment: info.tag === "" };
    const ex = [...frames].reverse().find((x) => x.t === "expr");
    if (ex) ex.made.push(el);
    if (el.attrs.some((a) => a.name === "v-for" || a.name === "*ngFor")) el.inMap = true;
    if (!el.fragment) { el.parent?.children.push(el); }
    elements.push(el);
    return el;
  };
  let i = 0;
  while (i < text.length) {
    const f = frames[frames.length - 1];
    const c = text[i];
    if (f.t === "children") {
      if (c === "<") {
        if (text.startsWith("<!--", i)) { const e = text.indexOf("-->", i); i = e < 0 ? text.length : e + 3; continue; }
        if (text[i + 1] === "/") {
          const e = text.indexOf(">", i); const el = open.pop();
          frames.pop();
          if (el) el.closeIdx = i;
          i = e < 0 ? text.length : e + 1; continue;
        }
        if (/[A-Za-z>]/.test(text[i + 1] ?? "")) {
          const info = parseOpenTag(text, i, mode);
          if (info) {
            const el = addElement(info, i);
            if (!info.selfClosing) { open.push(el); frames.push({ t: "children" }); }
            i = info.openEnd + 1; continue;
          }
        }
        i++; continue;
      }
      if (c === "{") {
        const parent = open[open.length - 1];
        if (mode === "html") {
          const e = matchClose(text, i); const end = e < 0 ? text.length : e;
          const inner = text.slice(i + 1, end);
          if (/^#each\b/.test(inner)) eachDepth++;
          else if (/^\/each\b/.test(inner)) eachDepth = Math.max(0, eachDepth - 1);
          else if (!/^[#:/@]/.test(inner) && inner.trim() && parent) parent.exprChildren++;
          i = end + 1; continue;
        }
        frames.push({ t: "expr", start: i, made: [] }); i++; continue;
      }
      if (c === "}") { i++; continue; }
      if (!/\s/.test(c)) { const parent = open[open.length - 1]; if (parent) parent.textLen++; }
      i++; continue;
    }
    // js / expr / brace frames (jsx mode only)
    if (c === '"' || c === "'" || c === "`") { i = skipString(text, i) + 1; continue; }
    if (c === "{") { frames.push({ t: "brace" }); i++; continue; }
    if (c === "}") {
      const done = frames.length > 1 ? frames.pop() : null;
      if (done?.t === "expr") {
        const raw = text.slice(done.start + 1, i);
        const parent = open[open.length - 1];
        if (raw.trim()) {
          if (done.made.length === 0) { if (parent) parent.exprChildren++; }
          else if (/\.map\(|\.flatMap\(/.test(raw)) for (const m of done.made) m.inMap = true;
        }
      }
      i++; continue;
    }
    if (c === "<" && looksLikeJsx(text, i)) {
      const info = parseOpenTag(text, i, mode);
      if (info) {
        const el = addElement(info, i);
        if (!info.selfClosing) { open.push(el); frames.push({ t: "children" }); }
        i = info.openEnd + 1; continue;
      }
    }
    i++;
  }
  return elements;
}

export const attr = (el, ...names) => el.attrs.find((a) => names.includes(a.name));

/** Child count as the layout sees it: a mapped/looped group counts as 2 (many). */
export function visualChildCount(el) {
  const direct = el.children.filter((c) => !c.inMap).length;
  return direct + (el.children.some((c) => c.inMap) ? 2 : 0);
}
