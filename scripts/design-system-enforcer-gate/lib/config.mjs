// Config loading, defaults and compilation.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { compilePatterns, GLOBAL_ALLOW } from "./values.mjs";

const COMP = "^--(controls|kit|primitives|overlays|patterns|units|caelos|app)-";
const sides = (b, extra = []) => [b, ...["top", "right", "bottom", "left", "inline", "block", "inline-start", "inline-end", "block-start", "block-end", ...extra].map((s) => `${b}-${s}`)];
const obj = (names, kind) => Object.fromEntries(names.map((n) => [n, kind]));

export const DEFAULT_DIMENSIONS = {
  colour: {
    kind: "colour", tokens: ["^--(base|sys)-color-", COMP],
    properties: { ...obj(["color", "background-color", "border-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "outline-color", "fill", "stroke", "caret-color", "accent-color", "text-decoration-color", "column-rule-color", "scrollbar-color"], "colour"),
    // shorthands: a var() here may be a width or a material, so only colour literals are judged ("~" = literals only)
    ...obj(["background", "border", "border-top", "border-right", "border-bottom", "border-left", "outline", "text-decoration"], "colour~") },
    anywhere: true,
  },
  spacing: {
    kind: "length", tokens: ["^--(base|sys)-space-", COMP], allow: ["auto"],
    properties: obj([...sides("padding"), ...sides("margin"), "gap", "row-gap", "column-gap", "inset", "inset-inline", "inset-block", "inset-inline-start", "inset-inline-end", "inset-block-start", "inset-block-end", "top", "right", "bottom", "left"], "length"),
  },
  size: {
    enabled: false, kind: "length", tokens: ["^--(base|sys)-size-", COMP], allow: ["auto", "fit-content", "min-content", "max-content", "stretch"],
    properties: obj(["width", "height", "min-width", "min-height", "max-width", "max-height", "inline-size", "block-size", "flex-basis"], "length"),
  },
  radius: {
    kind: "length", tokens: ["^--(base|sys)-radius-", COMP],
    properties: obj(["border-radius", "border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius", "border-start-start-radius", "border-start-end-radius", "border-end-start-radius", "border-end-end-radius"], "length"),
  },
  shadow: { kind: "shadow", allow: ["inset"], tokens: ["^--(base|sys)-(shadow|elevation)-", "^--(base|sys)-(color|space|blur|opacity|size)-", COMP], properties: obj(["box-shadow", "text-shadow"], "shadow") },
  typography: {
    kind: "any", tokens: ["^--(base|sys)-type-", "^--primitives-typography-", COMP],
    properties: { "font-family": "family", "font-size": "length", "font-weight": "weight", "line-height": "length", "letter-spacing": "length", "word-spacing": "length", font: "any" },
    hints: { "font-size": "-size", "line-height": "-line", "font-weight": "-weight", "letter-spacing": "-(tracking|letter)", "font-family": "-family" },
  },
  motion: {
    kind: "motion", tokens: ["^--(base|sys)-motion-", COMP],
    properties: { transition: "motion", "transition-duration": "time", "transition-delay": "time", "transition-timing-function": "easing", animation: "motion", "animation-duration": "time", "animation-delay": "time", "animation-timing-function": "easing" },
  },
  opacity: { kind: "number", tokens: ["^--(base|sys)-opacity-", COMP], allow: ["0", "1"], properties: { opacity: "number" } },
  "z-index": { enabled: false, kind: "number", tokens: ["^--(base|sys)-(z|layer|stack)", COMP], allow: ["0", "auto"], properties: { "z-index": "number" } },
};

export const DEFAULTS = {
  scan: { include: ["**"], exclude: ["**/*.test.*", "**/*.spec.*", "**/*.stories.*"], types: ["tsx", "jsx", "ts", "js", "css", "vue", "svelte"] },
  tokens: { css: [], dtcg: [] },
  classIndex: [],
  customProperties: [],
  styledObjects: { enabled: true, panda: false, shorthands: false },
  tailwind: { arbitrary: true },
  var: { noFallback: true, mustBeDefined: true, ignore: ["^--tw-"] },
  kit: { requireClass: [], requireWrapper: [], fileRequires: [], projectRequires: [] },
  icons: {
    enabled: true, component: "lucide-react",
    allowedImports: ["lucide-react"],
    forbiddenImports: ["^react-icons", "^@heroicons", "^@fortawesome", "^@phosphor-icons", "^@tabler/icons", "^feather-icons", "^react-feather", "^@mui/icons-material", "^@radix-ui/react-icons", "^@iconify"],
    allowSvgIn: [], strokeOnly: true,
  },
  missing: {
    gap: { severity: "error", ignoreJustify: true, childSpacingExempts: true },
    typography: { severity: "warn", inherit: "ancestors", textElements: ["p", "h1", "h2", "h3", "h4", "h5", "h6", "span", "label", "li", "a", "small", "strong", "em", "b", "i", "blockquote", "figcaption", "dt", "dd", "td", "th", "button", "legend", "summary", "code", "pre"], textComponents: [], typographyClasses: [] },
    motion: { severity: "off", required: false, interactiveElements: ["button", "a", "input", "select", "textarea", "summary"], interactiveComponents: [] },
  },
  severity: {},
  failOn: ["error"],
};

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
export function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in a && isObj(a[k]) && isObj(v) ? deepMerge(a[k], v) : v;
  return out;
}

export const expandHome = (p) => (p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p);

export function loadConfig(configPath, repoDir) {
  let raw = {};
  if (configPath) {
    if (!existsSync(configPath)) throw new Error(`config not found: ${configPath}`);
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  }
  const cfg = deepMerge(DEFAULTS, raw);
  const dims = {};
  for (const [name, def] of Object.entries(DEFAULT_DIMENSIONS)) {
    const user = raw.dimensions?.[name] ?? {};
    const m = { ...def, ...user };
    if (user.properties) m.properties = user.properties;
    if (user.extraProperties) m.properties = { ...m.properties, ...Object.fromEntries(user.extraProperties.map((p) => [p, m.kind])) };
    dims[name] = m;
  }
  for (const [name, user] of Object.entries(raw.dimensions ?? {})) if (!(name in dims)) dims[name] = { enabled: true, kind: "any", tokens: [], properties: {}, ...user };
  cfg.compiled = {};
  for (const [name, d] of Object.entries(dims)) {
    if (d.enabled === false) continue;
    const props = Array.isArray(d.properties) ? obj(d.properties, d.kind) : d.properties;
    cfg.compiled[name] = {
      name, kind: d.kind, anywhere: !!d.anywhere,
      severity: cfg.severity[name] ?? d.severity ?? "error",
      patterns: compilePatterns(d.tokens), suggest: compilePatterns((d.tokens ?? []).slice(0, d.suggestCount ?? 1)),
      allow: new Set([...GLOBAL_ALLOW, ...(d.allow ?? []).filter((x) => !x.startsWith("/")).map((x) => x.toLowerCase())]),
      allowRe: (d.allow ?? []).filter((x) => x.startsWith("/")).map((x) => new RegExp(x.slice(1, x.lastIndexOf("/")), x.slice(x.lastIndexOf("/") + 1))),
      allowFunctions: d.allowFunctions ?? [],
      props: new Map(Object.entries(props)),
      hints: Object.fromEntries(Object.entries(d.hints ?? {}).map(([k, v]) => [k, new RegExp(v)])),
    };
  }
  cfg.configDir = configPath ? dirname(resolve(configPath)) : repoDir;
  return cfg;
}
