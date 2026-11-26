// Value classification: is a CSS value made only of token references (and permitted keywords)?
import { matchClose } from "./util.mjs";

const NAMED = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen").split(" "));
const COLOUR_FN = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)$/i;
const EASING_KW = new Set(["ease", "ease-in", "ease-out", "ease-in-out", "linear", "step-start", "step-end"]);
const EASING_FN = new Set(["cubic-bezier", "steps", "linear"]);
const MATH_FN = new Set(["calc", "min", "max", "clamp"]);
export const DYN = "\u0001"; // marks a dynamic ${…} / {…} hole in a value
const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)`;

export const GLOBAL_ALLOW = ["inherit", "initial", "unset", "revert", "revert-layer", "none", "0", "0s", "0ms", "currentcolor", "transparent", "normal"];

/** Split top-level into pieces: { fn, name, args } | { word }. Commas, slashes and spaces separate. */
function pieces(v) {
  const out = [];
  let i = 0;
  while (i < v.length) {
    const c = v[i];
    if (/[\s,/]/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") { const e = v.indexOf(c, i + 1); const end = e < 0 ? v.length : e; out.push({ word: v.slice(i, end + 1), str: true }); i = end + 1; continue; }
    const m = v.slice(i).match(/^[^\s,/()"']+/);
    const w = m ? m[0] : "";
    if (v[i + w.length] === "(") {
      const e = matchClose(v, i + w.length);
      const end = e < 0 ? v.length : e;
      out.push({ fn: true, name: w.toLowerCase(), args: v.slice(i + w.length + 1, end) });
      i = end + 1;
    } else { out.push({ word: w }); i += Math.max(w.length, 1); }
  }
  return out;
}

const isZero = (w) => /^[+-]?0*\.?0+([a-z%]*)$/i.test(w) && parseFloat(w) === 0;
const isLength = (w) => new RegExp(`^${NUM}(?:[a-z%]+)?$`, "i").test(w) && !/^[+-]?[\d.]+e/i.test(w);
const isTime = (w) => new RegExp(`^${NUM}m?s$`, "i").test(w);
const isNumber = (w) => new RegExp(`^${NUM}$`).test(w);

/** True when `w` (one word) is a hand-written value of `kind`. */
function wordLiteral(w, kind, opts) {
  const lw = w.toLowerCase();
  if (w.includes(DYN)) {
    if (w === DYN) return false; // unknown at lint time
    const rest = w.replace(new RegExp(DYN, "g"), "");
    if (/^(?:[a-z%]+)$/i.test(rest)) return kind === "length" || kind === "time" || kind === "motion" ? true : false;
    return false;
  }
  if (/^\{[\w.-]+\}$/.test(w)) return false; // DTCG / Panda reference
  if (opts.panda && !/^[+-]?[\d.]+[a-z%]+$/i.test(w) && !/^#/.test(w) && !(kind === "colour" && NAMED.has(lw)) && /^[\w.-]+(\/\d+)?$/.test(w)) return false; // Panda token name
  switch (kind) {
    case "colour": return /^#[0-9a-f]{3,8}$/i.test(w) || NAMED.has(lw);
    case "length": return !isZero(w) && isLength(w);
    case "number": return isNumber(w) && !isZero(w);
    case "time": return isTime(w) && !isZero(w);
    case "easing": return EASING_KW.has(lw);
    case "motion": return (isTime(w) && !isZero(w)) || EASING_KW.has(lw);
    case "weight": return isNumber(w) || /^(bold|bolder|lighter)$/.test(lw);
    default: return true; // family, shadow, any: any remaining word is hand-written
  }
}

/**
 * Check one value. Returns problems: { type: "literal", text } | { type: "family", name }.
 * ctx: { kind, varOk(name), allow:Set|RegExp[], panda }
 */
export function checkValue(value, ctx, inCalc = false, acc = []) {
  const allowed = (w) => ctx.allow.has(w.toLowerCase()) || ctx.allowRe.some((r) => r.test(w));
  const whole = (kind) => kind === "family" || kind === "shadow" || kind === "any";
  const ps = pieces(String(value).replace(/\s*!important\s*$/i, ""));
  for (const p of ps) {
    if (p.fn) {
      if (p.name === "var") {
        const nm = p.args.match(/^\s*(--[\w-]+)/)?.[1];
        if (nm && !ctx.varOk(nm)) acc.push({ type: "family", name: nm });
        continue;
      }
      if (["env", "url", "attr", "counter", "image-set"].includes(p.name) || ctx.allowFunctions.includes(p.name)) continue;
      if (p.name === "token" || p.name === "theme") continue;
      if (COLOUR_FN.test(p.name)) {
        if (/var\(/.test(p.args)) { varsOnly(p.args, ctx, acc); continue; } // derived from a token (color-mix, rgb(var(--x) / 50%))
        if (ctx.kind === "colour" || whole(ctx.kind)) acc.push({ type: "literal", text: `${p.name}(${p.args})` });
        continue;
      }
      if (EASING_FN.has(p.name) && p.name !== "linear" && (ctx.kind === "easing" || ctx.kind === "motion" || whole(ctx.kind))) { acc.push({ type: "literal", text: `${p.name}(${p.args})` }); continue; }
      if (MATH_FN.has(p.name)) { if (["colour", "number", "weight", "easing"].includes(ctx.kind)) varsOnly(p.args, ctx, acc); else checkCalc(p.args, ctx, acc); continue; }
      checkValue(p.args, ctx, inCalc, acc); // gradients, filters: look inside
      continue;
    }
    if (allowed(p.word)) continue;
    if (p.str) { if (ctx.kind === "family" || whole(ctx.kind)) acc.push({ type: "literal", text: p.word }); continue; }
    if (wordLiteral(p.word, ctx.kind, ctx)) acc.push({ type: "literal", text: p.word });
  }
  if (whole(ctx.kind)) { const lits = acc.filter((a) => a.type === "literal"); if (lits.length) { const rest = acc.filter((a) => a.type !== "literal"); acc.length = 0; acc.push({ type: "literal", text: String(value).trim() }, ...rest); } }
  return acc;
}

function varsOnly(args, ctx, acc) {
  for (const m of args.matchAll(/var\(\s*(--[\w-]+)/g)) if (!ctx.varOk(m[1])) acc.push({ type: "family", name: m[1] });
}

/** Inside calc()/min()/max()/clamp(): unitless numbers and operators are fine; unit numbers and colours are not. */
function checkCalc(args, ctx, acc) {
  for (const p of pieces(args.replace(/[+*]/g, " "))) {
    if (p.fn) {
      if (p.name === "var") { const nm = p.args.match(/^\s*(--[\w-]+)/)?.[1]; if (nm && !ctx.varOk(nm)) acc.push({ type: "family", name: nm }); }
      else if (MATH_FN.has(p.name)) checkCalc(p.args, ctx, acc);
      else if (p.name !== "env") checkCalc(p.args, ctx, acc);
      continue;
    }
    const w = p.word.replace(/^-(?=\s|$)/, "");
    if (!w || w === "-") continue;
    if (w.includes(DYN)) { if (w !== DYN && /^[a-z%]+$/i.test(w.replaceAll(DYN, ""))) acc.push({ type: "literal", text: w.replaceAll(DYN, "N") }); continue; }
    if (isZero(w)) continue;
    if (isNumber(w)) continue;
    if (new RegExp(`^${NUM}[a-z%]+$`, "i").test(w)) acc.push({ type: "literal", text: w });
  }
}

export const compilePatterns = (list) => (list ?? []).map((s) => (s.startsWith("^") ? new RegExp(s) : { test: (n) => n.startsWith(s) })).map((r) => (n) => r.test(n));
