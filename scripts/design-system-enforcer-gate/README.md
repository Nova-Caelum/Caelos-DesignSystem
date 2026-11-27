# design-system-enforcer-gate

A Node gate that fails UI code whose visual values are not derived from the design-system package. Framework-agnostic: CSS, TSX/JSX/TS, Vue, Svelte, Tailwind arbitrary values, Panda escape hatches, inline styles. The page paint pass loads the repository's installed Style Dictionary package to reuse its token-name transform; it does not fetch packages when it runs.

## Difference from the source

The only change to the moved program and library files is a reworded comment in `lib/values.mjs`, so the repository's palette check can read it. `npm run check:app` refuses a scan of 0 files or 0 tokens with exit 2.

```bash
node scripts/design-system-enforcer-gate/design-system-enforcer-gate.mjs [--config design-system-enforcer-gate.config.json] [--json] [--strict] [--only rule,rule] [repoDir]
```

Exit 1 on any error-severity finding (`--strict`: any finding). Exit 2 on a bad config or directory. Each finding prints as

```
file:line  [rule] what is wrong — the fix (nearest token when computable)
```

Warnings print `(warn)` before the message. Exemptions are listed at the end with their reasons. Without `--config` it reads `<repoDir>/design-system-enforcer-gate.config.json` if present. This repository's example config is `design-system-enforcer-gate.config.json`; app repositories keep their config at the same repository-root path.

`npm run check:app` runs the normal gate, then a page-only paint pass. The second pass is additive: `pages` and `pagePaint` are removed before the normal configuration is compiled. Add `pages` as a non-empty list of non-empty, repo-relative globs to select page folders; a missing or malformed value is a configuration error and exits 2. The paint pass reads and validates the catalog's paint families at run time, then rejects every page-owned `var(--…)` from those families regardless of the property, attribute, or custom-property alias that contains it. A page is still judged when an app token-source, scan, or class-index setting also names it; those settings can contribute definitions but cannot narrow the page set. Static app classes and generated theme utilities are both checked, so an app class with the same name cannot mask a theme utility. Page globs also select matching files below `build`, `out`, `dist`, and `coverage` directories; unselected output directories remain skipped.

## Config

| Key | Meaning |
|---|---|
| `scan.include` / `exclude` / `types` | Globs (repo-relative) and extensions to judge. |
| `pages` | App-only, non-empty list of non-empty page-folder globs used by `check:app` for its second, paint-only pass. Missing or invalid values exit 2. |
| `tokens.css` / `tokens.dtcg` | Token sources: CSS custom-property files and DTCG JSON. Paths or globs; `~/` and `../` allowed. A CSS var is `--` plus the DTCG path joined by `-` (`base.space.px-12` is `--base-space-px-12`). The normal pass does not judge token files; the paint pass still judges any matching page file. |
| `classIndex` | Extra CSS (e.g. the kit) used to resolve class names to declarations for the missing-value rules and the page paint pass. |
| `dimensions.<name>` | `enabled`, `kind`, `tokens` (allowed families: a `--prefix` or a `^regex`, primary family first; the first is also where "nearest token" looks), `properties` (array, or `{prop: kind}`), `allow` (extra keywords, or `/regex/`), `severity`. Built in: colour, spacing, size (off), radius, shadow, typography, motion, opacity, z-index (off). Add your own by name. |
| `customProperties` | `[{match, dimension, kind, hintProp}]`: judge definitions of app-local custom properties (`--app-line-body: 30px`). |
| `styledObjects` | `panda: true` treats bare strings (`'4'`, `'red.400'`) as token names; `shorthands: true` reads Panda `p`, `bg`, `rounded`. |
| `kit` | `requireClass`, `requireWrapper`, `fileRequires`, `projectRequires`: "use the kit class" rules. |
| `icons` | `allowedImports`, `forbiddenImports` (regex), `allowSvgIn` (globs), `strokeOnly`. |
| `missing.gap` / `typography` / `motion` | `severity` (`error`/`warn`/`off`) and rule options. Motion also needs `required: true`. |
| `severity` | Per-rule override, e.g. `{"missing-typography": "warn"}`. |

## Rules

Value rules (rule id = dimension): any literal in a governed property, whether in CSS, inline `style`, a styled object, `p-[13px]`, or `'[13px]'`, is a violation unless it is a `var(--token)`. A `var()` from the wrong family is also a violation (`padding: var(--sys-color-text)`). Allowed without a token: `0`, `none`, `inherit`-type keywords, `transparent`/`currentcolor`, `normal`, plus each dimension's `allow`. Unitless numbers inside `calc()` are fine. A colour function is fine when it contains a `var()` (`color-mix(in srgb, var(--x) 50%, transparent)`).

Others: `fallback` (`var(--x, 1px)`), `undefined` (`var(--x)` nobody defines), kit rules (ids from config), `icon-svg` (raw `<svg>`, `.svg` imports), `icon-import` (non-allowed icon packages), `icon-fill` (non-`none` fill).

Missing-value rules, each with its own severity: `missing-gap` (flex/grid container with 2+ children and no gap, no `space-between` justify, no child margins), `missing-typography` (text element with no `font-size`/`font` from its own class/style, or from an ancestor in the same file when `inherit: "ancestors"`), `missing-motion` (button, `a[href]`, input, select, textarea, summary, `role=button` with no `transition`/`animation` using a motion token).

Exemptions: `data-ui-exempt="<reason>"` on the element (old `data-kit-exempt` accepted), or `/* ui-exempt: <reason> */` / `// ui-exempt: <reason>` on the line or the line above. No reason, no exemption: it is reported as `exempt-reason`.

## Known blind spots

- Static only. The page paint pass folds literal class expressions, no-substitution templates, literal concatenation, same-file literal constants, and string arguments to `clsx`/`cn`/`classnames`; it also reads application CSS, generated theme utilities, and page-imported CSS modules. For generated theme utilities it removes chained variant prefixes, a leading or trailing `!`, and a slash modifier before lookup. It recognises both `utility-(--token)` and `utility-(type:--token)` shorthand. Classes chosen from run-time data (`styles[variant]`, computed template substitutions, conditional/object combiners, or classes added by a library) remain invisible. The missing-value rules treat an unresolved class as declaring nothing (so they can over-report) and cannot see a gap set through a descendant selector (`.row > * + *`).
- `missing-gap` ignores wrapper components that render the flex container themselves and children inside a component you did not scan; it cannot see `grid-template` spacing tricks.
- `missing-typography` cannot see inheritance across files or from `body`/`:root`. `inherit: "ancestors"` follows only the same file's markup; `"none"` requires every text element to carry its own.
- `missing-motion` accepts any token-using `transition`/`animation` regardless of the property list, and cannot tell a control that should not animate.
- Styled objects are matched by key name, so a data object with a `color` or `padding` key reads as a style; TS union types and strings joined by `+` are skipped. JS expressions as a whole value (`padding: size`) are not judged.
- Tailwind normal value rules judge arbitrary values (`p-[13px]`, `p-(--x)`), not arbitrary scale utilities such as `p-4` or `text-sm`. Separately, the page paint pass judges statically visible generated theme utilities whose generated declaration reaches a catalog paint token; unrelated scale utilities still pass.
- CSS-in-JS template literals (`styled.div` and `css` tags) are not parsed. Svelte `style:prop=` directives and Vue `v-bind()` in CSS are not parsed. `@apply` is read as a Tailwind arbitrary value only.
- Nearest-token compares numbers, lengths (rem as 16px), durations and colours (RGB distance); it stays silent beyond a small distance and for dynamic `${…}` values.
- Outside the page paint pass, a local custom property that holds a literal (`--glow: 0.7`) is reported at its use site as "not a token" for the governed dimension, and judged at its definition only if `customProperties` maps it. In the page paint pass, an app custom property in a catalog path family is paint even when its value is literal, and any duplicate definition that aliases paint makes the property paint.
- JSX is read with a heuristic scanner, not a TypeScript parser: generics versus JSX is guessed, and JSX inside a template literal is not seen.
