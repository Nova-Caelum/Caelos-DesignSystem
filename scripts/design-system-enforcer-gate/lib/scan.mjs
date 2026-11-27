// The engine: runs every rule over one file and returns findings.
import { existsSync, readFileSync } from "node:fs";
import { dirname, posix, resolve as resolvePath } from "node:path";
import { stripComments, blank, lineIndex, kebab, matcher } from "./util.mjs";
import { buildClassIndex, parseCss } from "./css.mjs";
import { parseMarkup, attr, visualChildCount } from "./markup.mjs";
import { checkValue, DYN } from "./values.mjs";
import { nearestToken } from "./tokens.mjs";

const CLASS_ATTRS = (n) => n === "class" || n === "className" || n === ":class" || n === "v-bind:class" || n === "[class]" || n === "[ngClass]" || n.startsWith("class:");
const SHORTHANDS = { p: "padding", px: "padding-inline", py: "padding-block", pt: "padding-top", pr: "padding-right", pb: "padding-bottom", pl: "padding-left", m: "margin", mx: "margin-inline", my: "margin-block", mt: "margin-top", mr: "margin-right", mb: "margin-bottom", ml: "margin-left", bg: "background", bgColor: "background-color", rounded: "border-radius", w: "width", h: "height" };
const TW = [
  [/^(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left|start|end)$/, "spacing", "length"],
  [/^(?:w|h|size|min-[wh]|max-[wh]|basis)$/, "size", "length"],
  [/^rounded(?:-[a-z]{1,2})?$/, "radius", "length"],
  [/^shadow$/, "shadow", "shadow"],
  [/^leading$/, "typography", "length", "line-height"],
  [/^tracking$/, "typography", "length", "letter-spacing"],
  [/^duration$|^delay$/, "motion", "time"],
  [/^ease$/, "motion", "easing"],
  [/^opacity$/, "opacity", "number"],
  [/^z$/, "z-index", "number"],
  [/^(?:bg|from|via|to|fill|stroke|accent|caret|decoration|ring|outline|border(?:-[xytrbl])?|divide|placeholder)$/, "colour", "colour"],
];

function splitTopLevel(source, separator) {
  const parts = []; let start = 0, depth = 0, quote = null;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if ("([{<".includes(char)) depth++;
    else if (")]}>".includes(char)) depth--;
    else if (char === separator && depth === 0) { parts.push(source.slice(start, i)); start = i + 1; }
  }
  parts.push(source.slice(start));
  return parts;
}

function unwrap(source) {
  let value = source.trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    const parts = splitTopLevel(value.slice(1, -1), ",");
    if (parts.length !== 1) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function decodeString(source) {
  if (source[0] === '"') { try { return JSON.parse(source); } catch { return null; } }
  if (source[0] === "'") return source.slice(1, -1).replace(/\\(['\\])/g, "$1");
  return null;
}

function staticString(source, bindings, depth = 0) {
  if (depth > 12) return null;
  const value = unwrap(source);
  const plus = splitTopLevel(value, "+");
  if (plus.length > 1) {
    const pieces = plus.map((part) => staticString(part, bindings, depth + 1));
    return pieces.every((part) => part !== null) ? pieces.join("") : null;
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return decodeString(value);
  if (value.startsWith("`") && value.endsWith("`")) {
    const body = value.slice(1, -1);
    let failed = false;
    const folded = body.replace(/\$\{([^{}]+)\}/g, (_, expression) => {
      const result = staticString(expression, bindings, depth + 1);
      if (result === null) failed = true;
      return result ?? "";
    });
    return failed || /\$\{/.test(folded) ? null : folded.replace(/\\`/g, "`");
  }
  if (/^[A-Za-z_$][\w$]*$/.test(value)) return bindings.get(value) ?? null;
  return null;
}

function staticBindings(text) {
  const bindings = new Map(), pending = [];
  for (const match of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) pending.push([match[1], match[2]]);
  for (let pass = 0; pass <= pending.length; pass++) for (const [name, expression] of pending) {
    const value = staticString(expression, bindings);
    if (value !== null) bindings.set(name, value);
  }
  return bindings;
}

function classExpressionStrings(source, bindings) {
  const value = staticString(source, bindings);
  if (value !== null) return [value];
  const call = unwrap(source).match(/^(clsx|cn|classnames)\s*\(([\s\S]*)\)$/);
  if (!call) return [];
  return splitTopLevel(call[2], ",").map((part) => staticString(part, bindings)).filter((part) => part !== null);
}

function foldedStrings(text, bindings) {
  const out = [];
  const atoms = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60|[A-Za-z_$][\w$]*)`;
  for (const match of text.matchAll(new RegExp(`${atoms}(?:\\s*\\+\\s*${atoms})+`, "g"))) {
    const value = staticString(match[0], bindings);
    if (value !== null) out.push([value, match.index]);
  }
  for (const match of text.matchAll(/`(?:\\.|[^`\\])*`/g)) {
    const value = staticString(match[0], bindings);
    if (value !== null) out.push([value, match.index]);
  }
  return out;
}

function paintReferences(value) {
  const refs = new Set();
  for (const match of String(value).matchAll(/var\(\s*(--[\w-]+)/gi)) refs.add(match[1]);
  for (const match of String(value).matchAll(/(?<![\w-])(?:[\w-]+:)*[\w-]+-\(\s*(?:[\w-]+\s*:\s*)?(--[\w-]+)\s*\)/gi)) refs.add(match[1]);
  return refs;
}

function themeUtilityName(word) {
  let name = splitTopLevel(word, ":").at(-1)?.trim() ?? "";
  name = name.replace(/^!+|!+$/g, "");
  name = splitTopLevel(name, "/")[0].trim();
  return name.replace(/^!+|!+$/g, "");
}

export function createEngine({ root, cfg, index, classGlobal, moduleIdx, defined }) {
  const dims = cfg.compiled;
  const aliasOk = (name, dim, depth = 0) => {
    if (depth > 8) return false;
    if (dim.patterns.some((p) => p(name))) return true;
    const raw = index.byName.get(name)?.raw;
    if (!raw) return false;
    const refs = [...String(raw).matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
    return refs.length > 0 && refs.every((r) => aliasOk(r, dim, depth + 1));
  };
  const ctxFor = (dim, kind) => ({ kind: kind.replace("~", ""), varOk: kind.endsWith("~") ? () => true : (n) => aliasOk(n, dim), allow: dim.allow, allowRe: dim.allowRe, allowFunctions: dim.allowFunctions, panda: cfg.styledObjects.panda });
  const svgOk = matcher(cfg.icons.allowSvgIn);
  const forbidden = cfg.icons.forbiddenImports.map((s) => new RegExp(s));
  const ignoreVar = cfg.var.ignore.map((s) => new RegExp(s));
  const sev = (rule, dflt = "error") => cfg.severity[rule] ?? dflt;

  function scanFile(f, raw) {
    const st = { rel: f.rel, raw, findings: [], usedTokens: [], ranges: [], moduleIdents: new Map(), localClasses: new Map(), iconNames: new Set(), bindings: staticBindings(raw) };
    const text = stripComments(raw, { line: !["css"].includes(f.type) });
    const lineAt = lineIndex(raw);
    const add = (rule, idx, message, severity = sev(rule)) => { if (severity !== "off") st.findings.push({ file: f.rel, line: lineAt(idx), idx, rule, severity, message }); };
    const showLit = (t) => t.replaceAll(DYN, "${…}");
    const paintContext = (idx) => {
      const before = text.slice(Math.max(0, idx - 500), idx);
      const objectProperty = before.match(/(?:^|[{,])\s*(?:["']([^"']+)["']|([A-Za-z_$][\w$-]*))\s*:\s*[^,{}]*$/s);
      if (objectProperty) return objectProperty[1] ?? objectProperty[2];
      const cssProperty = before.match(/(?:^|[;{])\s*(--[\w-]+|[A-Za-z-]+)\s*:\s*[^;{}]*$/s);
      if (cssProperty) return cssProperty[1];
      const attribute = before.match(/([:\w-]+)\s*=\s*(?:["']|\{\s*["'`])?[^<>"'\n]*$/);
      return attribute?.[1] ?? "value";
    };
    const reportPaint = (value, idx, label = paintContext(idx)) => {
      if (!cfg.pagePaint) return;
      for (const token of paintReferences(value)) if (cfg.pagePaint.isPaintToken(token, index)) {
        add("page-paint", idx, `${label}: paint token ${token} — use an imported component for paint`);
      }
    };
    const loadPaintModule = (spec, idx, id = null) => {
      const rel = posix.normalize(posix.join(dirname(f.rel), spec));
      if (id) st.moduleIdents.set(id, rel);
      const absolute = resolvePath(root, rel);
      if (!existsSync(absolute)) return;
      const parsed = parseCss(readFileSync(absolute, "utf8"));
      if (!moduleIdx.has(rel)) moduleIdx.set(rel, buildClassIndex(parsed, new Map()));
      for (const declaration of parsed.decls) reportPaint(declaration.value, idx, `import "${spec}" ${declaration.prop}`);
    };

    // ---- value rules -------------------------------------------------
    const runDim = (dim, kind, prop, value, idx, label = prop) => {
      const probs = checkValue(value, ctxFor(dim, kind));
      for (const p of probs) {
        if (p.type === "literal") {
          let hint = "use a token";
          const hintRe = dim.hints[prop];
          const lit = showLit(p.text);
          const near = lit.includes("${") ? null : nearestToken(index, dim.suggest, p.text, hintRe ?? null);
          if (near) hint = near.dist === 0 ? `use var(${near.name}) (${near.value})` : `nearest token var(${near.name}) (${near.value})`;
          add(dim.name, idx, `${label}: ${lit} is a hand-written ${dim.name} value — ${hint}`, dim.severity);
        } else add(dim.name, idx, `${label}: ${p.name} is not one of the ${dim.name} token families (dimensions.${dim.name}.tokens) — use a ${dim.name} token`, dim.severity);
      }
    };
    const normProp = (p) => kebab(p.trim()).replace(/^-(webkit|moz|ms)-/, "");
    const checkDecl = (propIn, valueIn, idx, label) => {
      const prop = propIn.startsWith("--") ? propIn : normProp(propIn);
      let value = String(valueIn);
      if (/^\[.*\]$/.test(value.trim())) value = value.trim().slice(1, -1); // Panda escape hatch
      let hit = false;
      for (const dim of Object.values(dims)) {
        const kind = dim.props.get(prop);
        if (kind) { hit = true; runDim(dim, kind, prop, value, idx, label ?? prop); }
      }
      if (prop.startsWith("--")) for (const m of cfg.customProperties) {
        const dim = dims[m.dimension];
        if (dim && new RegExp(m.match).test(prop)) { hit = true; runDim(dim, m.kind ?? dim.kind, m.hintProp ?? prop, value, idx, prop); }
      }
      const colour = dims.colour;
      if (!hit && colour?.anywhere) {
        const probs = checkValue(value, { ...ctxFor(colour, "colour"), varOk: () => true });
        for (const p of probs) add("colour", idx, `${prop}: ${showLit(p.text)} is a hand-written colour value — ${(() => { const n = nearestToken(index, colour.suggest, p.text); return n ? `nearest token var(${n.name}) (${n.value})` : "use a colour token"; })()}`, colour.severity);
      }
    };

    // ---- CSS declarations ---------------------------------------------
    const cssBlock = (css, base) => {
      const parsed = parseCss(css);
      for (const d of parsed.decls) {
        checkDecl(d.prop, d.value, base + d.idx);
        if (cfg.icons.enabled && cfg.icons.strokeOnly && d.prop === "fill" && d.value.trim().toLowerCase() !== "none") add("icon-fill", base + d.idx, `fill: ${d.value.trim()} — icons are stroke-only; set fill: none or remove it`);
      }
      return parsed;
    };

    const isSfc = f.type === "vue" || f.type === "svelte";
    let markupText = text;
    if (f.type === "css") cssBlock(text, 0);
    if (isSfc) {
      for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
        const base = m.index + m[0].indexOf(">") + 1;
        const parsed = cssBlock(m[1], base);
        for (const r of parsed.rules) for (const sel of r.selector.split(",")) for (const c of sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) { const mp = st.localClasses.get(c[1]) ?? new Map(); for (const d of r.decls) mp.set(d.prop, [...(mp.get(d.prop) ?? []), d.value]); st.localClasses.set(c[1], mp); }
      }
      markupText = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g, blank);
    }

    // ---- var() hygiene (every file) -----------------------------------
    const varCalls = cfg.pagePaint ? /var\(\s*(--[\w-]+)\s*(,)?/gi : /var\(\s*(--[\w-]+)\s*(,)?/g;
    for (const m of text.matchAll(varCalls)) {
      st.usedTokens.push({ name: m[1], file: f.rel, line: lineAt(m.index) });
      const after = text[m.index + m[0].length - (m[2] ? 1 : 0)];
      if (cfg.var.noFallback && m[2]) add("fallback", m.index, `var(${m[1]}, …) has a fallback — remove it; if the token is missing, use one that exists`);
      if (cfg.var.mustBeDefined && !defined.has(m[1]) && !ignoreVar.some((r) => r.test(m[1])) && !(m[1].endsWith("-") && /[$'"`]/.test(after ?? ""))) add("undefined", m.index, `${m[1]} is not defined in the token sources or the app's CSS — pick a token that exists`);
      if (cfg.pagePaint?.isPaintToken(m[1], index)) add("page-paint", m.index, `${paintContext(m.index)}: paint token ${m[1]} — use an imported component for paint`);
    }
    if (cfg.pagePaint) {
      for (const m of text.matchAll(/(?<![\w-])(?:[\w-]+:)*[\w-]+-\(\s*(?:[\w-]+\s*:\s*)?(--[\w-]+)\s*\)/gi)) reportPaint(m[0], m.index, `class "${m[0]}"`);
      for (const [value, idx] of foldedStrings(text, st.bindings)) reportPaint(value, idx);
      for (const m of text.matchAll(/@import\s+(?:url\()?\s*["']([^"']+\.module\.(?:css|scss|sass|less))["']/gi)) loadPaintModule(m[1], m.index);
    }

    if (f.type !== "css") {
      // ---- imports (icons, css modules) -------------------------------
      for (const m of text.matchAll(/import\s+(?:type\s+)?([^'";]*?)\s*from\s*["']([^"']+)["']|import\s*["']([^"']+)["']/g)) {
        const spec = m[2] ?? m[3], clause = m[1] ?? "";
        if (cfg.pagePaint && /\.module\.(css|scss|sass|less)$/.test(spec)) {
          const id = clause.match(/^(\w+)/)?.[1];
          loadPaintModule(spec, m.index, id);
        } else if (/\.module\.(css|scss)$/.test(spec)) {
          const id = clause.match(/^(\w+)/)?.[1];
          if (id) st.moduleIdents.set(id, posix.normalize(posix.join(dirname(f.rel), spec)));
        }
        if (cfg.icons.enabled) {
          if (forbidden.some((r) => r.test(spec))) add("icon-import", m.index, `import from "${spec}" — icons come only from ${cfg.icons.allowedImports.join(", ")}; pick the glyph the icon glossary lists`);
          if (/\.svg(\?.*)?$/.test(spec) && !svgOk(f.rel)) add("icon-svg", m.index, `import of ${spec} — hand-drawn SVG in app code; use an icon from ${cfg.icons.component}`);
          if (cfg.icons.allowedImports.includes(spec)) for (const n of clause.replace(/[{}]/g, "").split(",")) { const nm = n.trim().split(/\s+as\s+/).pop(); if (nm) st.iconNames.add(nm); }
        }
      }

      // ---- styled objects: key: "value" -------------------------------
      if (cfg.styledObjects.enabled) {
        const keys = new Set();
        for (const dim of Object.values(dims)) for (const p of dim.props.keys()) { if (p.startsWith("--")) continue; keys.add(p); keys.add(p.replace(/-([a-z])/g, (_, c) => c.toUpperCase())); }
        if (cfg.styledObjects.shorthands) for (const k of Object.keys(SHORTHANDS)) keys.add(k);
        const re = new RegExp(String.raw`(?<![\w$.-])(["']?)(${[...keys].sort((a, b) => b.length - a.length).join("|")})\1\s*:\s*(?:(["'\`])((?:\\.|(?!\3)[^\\])*)\3|(-?\d+(?:\.\d+)?)(?![\w.]))`, "g");
        for (const m of text.matchAll(re)) {
          const after = text.slice(m.index + m[0].length).match(/^\s*(.)/)?.[1];
          if (after === "|" || after === "+") continue; // a TS union type, or a string built by concatenation: not a whole value
          let value = m[4] ?? m[5];
          if (m[3] === "`") value = value.replace(/\$\{[^}]*\}/g, DYN);
          const prop = SHORTHANDS[m[2]] && cfg.styledObjects.shorthands ? SHORTHANDS[m[2]] : m[2];
          checkDecl(prop, value, m.index + m[1].length, `${m[2]}`);
        }
      }

      // ---- Tailwind arbitrary values ----------------------------------
      if (cfg.tailwind.arbitrary) {
        const re = /(?<![\w-])((?:[a-z0-9-]+:)*)(-?)([a-z]+(?:-[a-z]{1,2})?)-\[([^\]\s]+)\]/g;
        for (const m of text.matchAll(re)) {
          let util = m[3], inner = m[4].replace(/_/g, " ");
          let hit = TW.find(([r]) => r.test(util));
          if (util === "text" || util === "font" || util === "border" || util === "outline" || util === "ring" || util === "bg") {
            const typed = inner.match(/^([a-z-]+):(.*)$/s);
            if (typed && !/^(?:var|calc|url)\b/.test(inner)) inner = typed[2];
            if (util === "text") hit = /^(#|rgba?|hsla?|oklch|oklab)/i.test(inner) ? TW.find(([, d]) => d === "colour") : ["", "typography", "length", "font-size"];
            else if (util === "font") hit = /^\d+$/.test(inner) ? ["", "typography", "weight", "font-weight"] : ["", "typography", "family", "font-family"];
            else if (util === "bg" || util === "border" || util === "outline" || util === "ring") hit = /^(#|rgba?\(|hsla?\(|oklch\()/i.test(inner) ? TW.find(([, d]) => d === "colour") : null;
          }
          if (!hit) continue;
          const dim = dims[hit[1]];
          if (!dim) continue;
          const mm = inner.match(/^\((--[\w-]+)\)$/); if (mm) inner = `var(${mm[1]})`;
          runDim(dim, hit[2], hit[3] ?? util, inner, m.index, `${m[0]}`);
        }
        for (const m of text.matchAll(/(?<![\w-])((?:[a-z0-9-]+:)*)(-?)([a-z]+(?:-[a-z]{1,2})?)-\((--[\w-]+)\)/g)) {
          const util = m[3];
          const hit = util === "text" || util === "font" ? null : TW.find(([r]) => r.test(util));
          if (hit && dims[hit[1]] && !aliasOk(m[4], dims[hit[1]])) add(hit[1], m.index, `${m[0]}: ${m[4]} is not a ${hit[1]} token`, dims[hit[1]].severity);
        }
      }
    }

    // ---- markup rules -----------------------------------------------
    const markupFile = ["tsx", "jsx", "vue", "svelte"].includes(f.type) || (cfg.pagePaint && f.type === "mdx");
    if (markupFile) {
      const els = parseMarkup(markupText, isSfc ? "html" : "jsx");
      markupRules(f, st, els, add);
    }

    // ---- file-level kit rules ---------------------------------------
    for (const r of cfg.kit.fileRequires) {
      const nm = f.rel.split("/").pop().replace(/\.[^.]+$/, "");
      if (new RegExp(r.fileName, "i").test(nm) && (!r.ext || f.rel.endsWith("." + r.ext))) {
        const sib = r.siblingSuffix ? raw + "\n" + (f.siblingText ?? "") : raw;
        if (!new RegExp(r.anyOf).test(sib)) add(r.id, 0, r.message ?? `${nm} does not match ${r.anyOf}`);
      }
    }

    // ---- exemptions --------------------------------------------------
    const rawLines = raw.split("\n");
    const exempt = [], kept = [];
    for (const fd of st.findings) {
      const range = st.ranges.find((r) => fd.idx >= r.from && fd.idx <= r.to);
      let reason = range?.reason;
      if (reason === undefined) {
        for (const ln of [fd.line, fd.line - 1]) {
          const m = rawLines[ln - 1]?.match(/(?:ui|kit)-exempt:\s*(.*?)\s*(?:\*\/|-->|\}\s*$|$)/);
          if (m) { reason = m[1]; break; }
        }
      }
      if (fd.rule === "page-paint") {
        const exemption = range && reason
          ? `; element carried ${range.attribute}="${reason}" but page paint has no exemption`
          : "; page paint has no exemption";
        kept.push({ ...fd, message: `${fd.message}${exemption}` });
      } else if (reason === undefined) kept.push(fd);
      else if (reason === "") kept.push(fd); // an exemption without a reason does not exempt
      else exempt.push({ ...fd, reason });
    }
    return { findings: kept, exempt, usedTokens: st.usedTokens };
  }

  // ---- element rules ------------------------------------------------
  function markupRules(f, st, els, add) {
    const { missing, kit, icons } = cfg;
    const classWords = (el) => {
      const words = new Set(), staticWords = new Set(); const refs = [];
      let rawClass = "";
      for (const a of el.attrs) {
        if (!CLASS_ATTRS(a.name)) continue;
        if (a.name.startsWith("class:")) { words.add(a.name.slice(6)); continue; }
        rawClass += " " + a.value;
        for (const m of a.value.matchAll(/\b(\w+)\.([A-Za-z_][\w-]*)\b/g)) if (st.moduleIdents.has(m[1])) refs.push([st.moduleIdents.get(m[1]), m[2]]);
        for (const m of a.value.matchAll(/\b(\w+)\[\s*["']([\w-]+)["']\s*\]/g)) if (st.moduleIdents.has(m[1])) refs.push([st.moduleIdents.get(m[1]), m[2]]);
        const staticValues = a.kind === "str" ? [a.value] : cfg.pagePaint ? classExpressionStrings(a.value, st.bindings) : [];
        const src = staticValues.length ? staticValues.join(" ") : [...a.value.matchAll(/["'`]([^"'`]*)["'`]/g)].map((m) => m[1]).join(" ");
        for (const w of src.replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) if (w) {
          words.add(w);
          if (staticValues.length && (a.name === "class" || a.name === "className")) staticWords.add(w);
        }
      }
      return { words, staticWords, refs, rawClass };
    };
    const resolve = (el) => {
      if (el._res) return el._res;
      const props = new Map();
      const put = (k, vals) => props.set(k, [...(props.get(k) ?? []), ...vals]);
      const { words, staticWords, refs, rawClass } = classWords(el);
      for (const w of words) {
        const g = classGlobal.get(w) ?? st.localClasses.get(w);
        if (g) for (const [k, v] of g) put(k, v);
        if (/^(inline-)?(flex|grid)$/.test(w)) put("display", [w.replace("inline-", "")]);
        else if (/^gap(-[xy])?(-|$)/.test(w) || /^space-[xy](-|$)/.test(w)) put("gap", ["tw"]);
        else if (/^text-(?:xs|sm|base|lg|\d?xl|\[)/.test(w)) put("font-size", ["tw"]);
        else if (/^font-(?:\[|thin|light|normal|medium|semibold|bold|sans|serif|mono)/.test(w)) put("font-weight", ["tw"]);
        else if (/^leading-/.test(w)) put("line-height", ["tw"]);
        else if (/^transition|^duration-|^ease-|^animate-/.test(w)) put("transition", [w]);
        const arb = w.match(/^(?:[a-z-]+:)*(duration|ease|delay)-\[([^\]]+)\]/); if (arb) put("transition", [arb[2]]);
      }
      for (const [file, name] of refs) { const g = moduleIdx.get(file)?.get(name); if (g) for (const [k, v] of g) put(k, v); }
      const sa = attr(el, "style");
      if (sa) {
        if (sa.kind === "str") for (const d of sa.value.split(";")) { const i = d.indexOf(":"); if (i > 0) put(normProp2(d.slice(0, i)), [d.slice(i + 1).trim()]); }
        else for (const m of sa.value.matchAll(/(?<![\w$])["']?([A-Za-z-]+)["']?\s*:\s*([^,}]+)/g)) put(normProp2(m[1]), [m[2].trim()]);
      }
      return (el._res = { props, words, staticWords, rawClass });
    };
    const normProp2 = (p) => kebab(p.trim());
    const hasProp = (res, ...names) => names.some((n) => res.props.has(n));
    const exemptAttr = (el) => attr(el, "data-ui-exempt", "data-kit-exempt");
    for (const el of els) {
      const ex = exemptAttr(el);
      if (ex) {
        st.ranges.push({ from: el.idx, to: el.openEnd, reason: (ex.value ?? "").trim(), attribute: ex.name });
        if (cfg.pagePaint) add("page-paint-exemption", ex.start ?? el.idx,
          `${ex.name} on <${el.tag}> is listed for review`, "info");
      }
    }
    const lc = (el) => el.tag.toLowerCase();

    for (const el of els) {
      if (el.fragment) continue;
      const tag = lc(el), res = resolve(el);

      // icons
      if (icons.enabled) {
        if (tag === "svg" && el.tag === "svg" && !svgOk(f.rel)) add("icon-svg", el.idx, `raw <svg> in app code — use an icon from ${icons.component} (the icon glossary lists the glyph per action)`);
        if (st.iconNames.has(el.tag)) {
          const fa = attr(el, "fill");
          if (icons.strokeOnly && fa && !(fa.kind === "str" && fa.value.toLowerCase() === "none")) add("icon-fill", fa.start, `fill on <${el.tag}> — icons are stroke-only; remove fill`);
        }
      }

      // page paint: static markup classes resolved from visible CSS and generated utilities
      if (cfg.pagePaint) {
        const reportClass = (word, declarations) => {
          if (!declarations) return;
          const uses = new Map();
          for (const [property, values] of declarations) for (const value of values) {
            for (const token of paintReferences(value)) uses.set(`${property}\0${token}`, [property, token]);
          }
          for (const [property, token] of uses.values()) if (cfg.pagePaint.isPaintToken(token, index)) {
            add("page-paint", el.idx, `class "${word}" ${property}: paint token ${token} — use an imported component for paint`);
          }
        };
        for (const word of res.staticWords) {
          reportClass(word, classGlobal.get(word));
          reportClass(word, cfg.pagePaint.themeClasses.get(themeUtilityName(word)));
        }
        for (const [file, name] of classWords(el).refs) reportClass(name, moduleIdx.get(file)?.get(name));
      }

      // kit: required classes
      for (const r of kit.requireClass) {
        if (!new RegExp(`^(?:${r.tag})$`).test(tag)) continue;
        if (r.types && tag === "input") { const t = attr(el, "type")?.value.replace(/["'{}\s]/g, ""); if (t && !r.types.includes(t)) continue; }
        if (!new RegExp(r.anyOf).test(res.rawClass)) add(r.id, el.idx, r.message ?? `<${tag}> without a class matching ${r.anyOf}`);
      }
      for (const r of kit.requireWrapper) {
        if (!new RegExp(r.class).test(res.rawClass)) continue;
        let ok = false;
        for (let p = el.parent; p; p = p.parent) { const rc = resolve(p).rawClass; if (new RegExp(r.wrapperAnyOf).test(rc) && (!r.alsoAnyOf || new RegExp(r.alsoAnyOf).test(rc))) { ok = true; break; } }
        if (!ok) add(r.id, el.idx, r.message ?? `${r.class} is not inside a wrapper matching ${r.wrapperAnyOf}`);
      }

      // missing gap
      if (missing.gap.severity !== "off") {
        const disp = (res.props.get("display") ?? []).some((v) => /^(inline-)?(flex|grid)\b/.test(v));
        const kids = visualChildCount(el);
        if (disp && kids >= 2) {
          const hasGap = hasProp(res, "gap", "row-gap", "column-gap");
          const just = missing.gap.ignoreJustify && (res.props.get("justify-content") ?? []).some((v) => /^space-(between|around|evenly)/.test(v));
          const kidSpacing = missing.gap.childSpacingExempts && el.children.some((c) => hasProp(resolve(c), "margin", "margin-top", "margin-left", "margin-inline", "margin-block", "margin-inline-start", "margin-block-start", "margin-right", "margin-bottom"));
          if (!hasGap && !just && !kidSpacing) add("missing-gap", el.idx, `<${el.tag}> is a flex/grid container with ${kids >= 2 ? (el.children.some((c) => c.inMap) ? "2+" : kids) : kids} children and declares no gap — add gap: var(--sys-space-…) (or token margins on the children)`, missing.gap.severity);
        }
      }

      // missing typography
      if (missing.typography.severity !== "off") {
        const isText = missing.typography.textElements.includes(tag) || missing.typography.textComponents.includes(el.tag);
        if (isText && (el.textLen > 0 || el.exprChildren > 0)) {
          const typoRes = (r) => hasProp(r, "font-size", "font") || missing.typography.typographyClasses.some((re) => new RegExp(re).test(r.rawClass));
          let ok = typoRes(res);
          if (!ok && missing.typography.inherit === "ancestors") for (let p = el.parent; p && !ok; p = p.parent) ok = typoRes(resolve(p));
          if (!ok) add("missing-typography", el.idx, `<${el.tag}> renders text with no typography token — give it (or an ancestor) a class or style setting font-size from var(--primitives-typography-size-…) / var(--base-type-size-…)`, missing.typography.severity);
        }
      }

      // missing motion
      if (missing.motion.required && missing.motion.severity !== "off") {
        const interactive = (missing.motion.interactiveElements.includes(tag) && (tag !== "a" || attr(el, "href", ":href", "v-bind:href"))) || missing.motion.interactiveComponents.includes(el.tag) || (attr(el, "role")?.value ?? "").includes("button");
        if (interactive && !(attr(el, "type")?.value === "hidden")) {
          const vals = ["transition", "transition-duration", "animation", "animation-duration"].flatMap((p) => res.props.get(p) ?? []);
          const motionDim = dims.motion;
          const ok = vals.some((v) => [...String(v).matchAll(/var\(\s*(--[\w-]+)/g)].some((m) => (motionDim ? motionDim.patterns.some((p) => p(m[1])) : true)));
          if (!ok) add("missing-motion", el.idx, `<${el.tag}> is interactive with no motion token — give it a transition using var(--base-motion-duration-…) and var(--base-motion-easing-…)`, missing.motion.severity);
        }
      }
    }
    for (const e of els) { const ex = exemptAttr(e); if (ex && !(ex.value ?? "").trim()) add("exempt-reason", e.idx, `${ex.name} carries no reason — write ${ex.name}="<why this is an exception>"`); }
  }

  return { scanFile };
}
