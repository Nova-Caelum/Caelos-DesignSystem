# Token catalog

The source of truth for every Caelos design token, one file per tier, in the Design Tokens format (DTCG 2025.10). Product colours start in the product palette record. Each foundation colour declares its palette role and follows its value. All other values start in this catalog. Decisions come from the decision ledger.

| File | Root | Holds |
|---|---|---|
| `00-foundations.tokens.json` | `base` | Every raw value in the system |
| `00-semantic.dark.tokens.json`, `00-semantic.light.tokens.json` | `sys` | Roles, one file per mode, with the same paths |
| `01-primitives` … `05-product-units` | `primitives`, `controls`, `overlays`, `patterns`, `units` | Recipes per tier, grouped by surface: `shared`, `chat`, `task-graph`, `dashboard` |

## Rules

`tests/token-catalog.test.mjs` enforces these on every pull request:
- Raw values live only in `00-foundations`.
- Every other token is a single alias to a token in a lower tier.
- The light file holds no path the dark file lacks.
- Every token carries a status.

## Status

Each token's status is in `$extensions["app.caelos"].status`:
- `canon`: traces to a recorded decision (its D-number is in `decision`) or to the product palette record.
- `composer-derived`: measured from the approved Composer, not written down as its own decision.
- `provisional`: filled, with no decision behind it.

An undecided item has no token. Each file lists its undecided items under `$extensions["app.caelos"].open`.

A recipe with no values yet has status `open` and lists its slots, variants, states and modes, so every gap stays visible.

`figmaName` maps a token to its variable in the Figma library.

Decision IDs (D01–D83, G01–G09) refer to the Nova Caelum design decision ledger.

## Counts at creation, 2026-11-09

| File | Canon | Composer-derived | Provisional | Recipes (with values) |
|---|---:|---:|---:|---:|
| 00-foundations | 89 | 13 | 20 | — |
| 00-semantic.dark | 46 | 0 | 1 | — |
| 00-semantic.light | 9 | 0 | 1 | — |
| 01-primitives | 6 | 0 | 0 | 111 (1) |
| 02-controls | 2 | 0 | 0 | 18 (1) |
| 03-overlays | 17 | 4 | 0 | 48 (4) |
| 04-patterns | 0 | 0 | 0 | 36 (0) |
| 05-product-units | 28 | 13 | 2 | 168 (1) |

Tiers were assigned from source folders and names, and are unverified. 54 product-specific components were moved to tier 5 from tiers 3 and 4; each carries `movedFromTier`.

## Not here yet

- Tiers 6 (regions) and 7 (screens).
- The build that turns this catalog into the package Caelos apps install.

## Sync the merged catalog to Figma

A signed-in Codex client with the Figma connector and edit access runs the sync. Set `CAELOS_FIGMA_FILE` locally to the destination file key. Set `CODEX_BIN` if the executable is outside PATH. Keep these settings outside the repository.

Run `python3 scripts/figma-catalog.py watch` on the signed-in host. It fetches main at startup and every minute, applies each newly observed main revision and reads back all three collections. The host must be awake and connected. For a single update use `sync`. For a read-only comparison use `check`. A one-shot command exits 0 for identical collections, 1 for differences and 2 if verification could not run.

The comparison includes legacy variables, mode names, values and collection-qualified alias targets. Variables without counterparts remain intact for binding review. A Figma default in a catalog role with no Light decision is reported as drift. The sync does not publish library updates to downstream design files.
