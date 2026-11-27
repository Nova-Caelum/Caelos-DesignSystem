// The engine: runs every rule over one file and returns findings.
import { dirname, posix } from "node:path";
import { stripComments, blank, lineIndex, kebab, matcher } from "./util.mjs";
import { parseCss } from "./css.mjs";
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
    const st = { rel: f.rel, raw, findings: [], ranges: [], moduleIdents: new Map(), localClasses: new Map(), iconNames: new Set() };
    const text = stripComments(raw, { line: !["css"].includes(f.type) });
    const lineAt = lineIndex(raw);
    const add = (rule, idx, message, severity = sev(rule)) => { if (severity !== "off") st.findings.push({ file: f.rel, line: lineAt(idx), idx, rule, severity, message }); };
    const showLit = (t) => t.replaceAll(DYN, "${…}");

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
    for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
      const after = text[m.index + m[0].length - (m[2] ? 1 : 0)];
      if (cfg.var.noFallback && m[2]) add("fallback", m.index, `var(${m[1]}, …) has a fallback — remove it; if the token is missing, use one that exists`);
      if (cfg.var.mustBeDefined && !defined.has(m[1]) && !ignoreVar.some((r) => r.test(m[1])) && !(m[1].endsWith("-") && /[$'"`]/.test(after ?? ""))) add("undefined", m.index, `${m[1]} is not defined in the token sources or the app's CSS — pick a token that exists`);
    }

    if (f.type !== "css") {
      // ---- imports (icons, css modules) -------------------------------
      for (const m of text.matchAll(/import\s+(?:type\s+)?([^'";]*?)\s*from\s*["']([^"']+)["']|import\s*["']([^"']+)["']/g)) {
        const spec = m[2] ?? m[3], clause = m[1] ?? "";
        if (/\.module\.(css|scss)$/.test(spec)) { const id = clause.match(/^(\w+)/)?.[1]; if (id) st.moduleIdents.set(id, posix.normalize(posix.join(dirname(f.rel), spec))); }
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
    const markupFile = ["tsx", "jsx", "vue", "svelte"].includes(f.type);
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
      let reason = st.ranges.find((r) => fd.idx >= r.from && fd.idx <= r.to)?.reason;
      if (reason === undefined) {
        for (const ln of [fd.line, fd.line - 1]) {
          const m = rawLines[ln - 1]?.match(/(?:ui|kit)-exempt:\s*(.*?)\s*(?:\*\/|-->|\}\s*$|$)/);
          if (m) { reason = m[1]; break; }
        }
      }
      if (reason === undefined) kept.push(fd);
      else if (reason === "") kept.push(fd); // an exemption without a reason does not exempt
      else exempt.push({ ...fd, reason });
    }
    return { findings: kept, exempt };
  }

  // ---- element rules ------------------------------------------------
  function markupRules(f, st, els, add) {
    const { missing, kit, icons } = cfg;
    const classWords = (el) => {
      const words = new Set(); const refs = [];
      let rawClass = "";
      for (const a of el.attrs) {
        if (!CLASS_ATTRS(a.name)) continue;
        if (a.name.startsWith("class:")) { words.add(a.name.slice(6)); continue; }
        rawClass += " " + a.value;
        for (const m of a.value.matchAll(/\b(\w+)\.([A-Za-z_][\w-]*)\b/g)) if (st.moduleIdents.has(m[1])) refs.push([st.moduleIdents.get(m[1]), m[2]]);
        for (const m of a.value.matchAll(/\b(\w+)\[\s*["']([\w-]+)["']\s*\]/g)) if (st.moduleIdents.has(m[1])) refs.push([st.moduleIdents.get(m[1]), m[2]]);
        const src = a.kind === "str" ? a.value : [...a.value.matchAll(/["'`]([^"'`]*)["'`]/g)].map((m) => m[1]).join(" ");
        for (const w of src.replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) if (w) words.add(w);
      }
      return { words, refs, rawClass };
    };
    const resolve = (el) => {
      if (el._res) return el._res;
      const props = new Map();
      const put = (k, vals) => props.set(k, [...(props.get(k) ?? []), ...vals]);
      const { words, refs, rawClass } = classWords(el);
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
      return (el._res = { props, words, rawClass });
    };
    const normProp2 = (p) => kebab(p.trim());
    const hasProp = (res, ...names) => names.some((n) => res.props.has(n));
    const exemptAttr = (el) => attr(el, "data-ui-exempt", "data-kit-exempt");
    for (const el of els) {
      const ex = exemptAttr(el);
      if (ex) {
        st.ranges.push({ from: el.idx, to: el.openEnd, reason: (ex.value ?? "").trim() });
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
