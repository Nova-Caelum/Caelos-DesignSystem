# Tier 1 primitive review sheet

The [Tier 1 Primitives (Clean) page](https://www.figma.com/design/Jj3Dpnc1s6H5ZjV1Kv3LTx/Caelos-Canon?node-id=362-4233) presents the existing catalog and specimens in the approved Tier 0 reading format. It does not approve new token values or finish open recipes.

## Reading the page

Each category has one box. A family occupies one row; its variants appear horizontally, wrapping after five. The four-column arrangement uses the same dimensions and typography as Tier 0 (Clean).

Read name and purpose, value and specimen, construction, evidence, status, and downstream uses. Parameter cards give the Figma variable name, catalog path and complete alias chain to foundations. Composed specimens list existing variable bindings; corresponding parameter rows show the resolved foundation values. Colour captions use the foundation palette name where recorded.

- **Canon / partial / provisional:** existing catalog status, not a new signoff.
- **Study:** existing component artwork retained for visual review. It does not prove a complete production recipe or that every property is bound.
- **Open inventory:** historical entries still marked open. Some overlap existing glyphs or studies. Their status and tier placement need reconciliation; this is not a list of 102 missing components.
- **Panda:** an actual exported CSS reference where one exists in the material preset. “No standalone token export” means no export is asserted, not that the foundation value is absent.

Dark mode is the v1 review scope. Different light values are reference-only. Live Figma variable bindings drive supported specimen properties. Value labels are catalog-generated snapshots and must be regenerated after catalog changes; they do not automatically refresh with a variable edit.

## Contents and verification

| Category | Catalog parameters | Existing specimens |
| --- | ---: | ---: |
| Typography | 17 | 20 |
| Icons | 4 | 70 |
| Layout | 8 | 8 |
| Surfaces | 14 | 5 |
| Materials | 44 | 17 |
| Scrolling | 8 | 3 |
| Separators | 2 | 2 |
| Focus | 4 | 2 |
| Open inventory | 0 | 0; 102 historical entries |
| Total | 101 | 127 |

In the 2026-11-12 rendering, all 101 Tier 1 variable aliases matched the catalog target roles. Comparing those variables and their recursive dependencies across available modes produced 238 exact matches and zero mismatches, using the existing catalog compiler’s float conversion. These are point-in-time checks, not a claim that a new continuous check was deployed.

Every Tier 1 primitive catalog leaf appears exactly once in the parameter cards. Original Tier 1 (`187:5380`) remains unchanged. Duplicated masters are preserved in the hidden `Source specimens · preserved` frame (`366:837`) on the clean page; visible instances depend on them.

## Construction tools and future edits

Run commands from the root of [Nova-Caelum/Caelos-DesignSystem](https://github.com/Nova-Caelum/Caelos-DesignSystem). The repository supplies labels and alias chains: `token_catalog/01-primitives.tokens.json`, foundation and semantic token catalogs, and the icon glossary. Export names come from `src/material-preset.mjs`.

For routine corrections, update only affected labels and bindings on the existing page through the Figma Plugin API; there is no automatic refresh command. Recompile the manifest as the source of labels. The construction helpers below are for a new, empty destination page, not a rebuild over the reviewed page. Keep the existing hidden masters in place, retain their source IDs, and set the manifest’s `pageId` to the new page ID after reading it from Figma. A connected, authenticated Figma tool session with edit access is required.

1. Inspect the live page before editing; preserve manual review edits and original masters. The renderer rejects existing categories and guides. These scripts generate a new review layout; they do not safely update an already edited one in place.
2. Run `python3 scripts/primitive-sheet.py` to compile the manifest in memory. It rejects missing or duplicate catalog leaves. Resolved values are not a new token source.
3. Through a connected Figma Plugin API session, load `scripts/primitive-sheet.js` and call `renderPrimitiveCategory(category, manifest)` for each category. Supply its zero-based `column` and optional `y` placement. Send only that category plus `pageId` and `meanings` in the manifest argument to stay within tool limits. Source IDs are specific to this file and declared in the compiler; verify them before reconstruction.
4. Load `scripts/primitive-sheet-guide.js` and call `finishPrimitiveSheet(slimManifest)`. The slim manifest needs `pageId`, `tokenCount`, `pending`, and each category’s `title` and `rows[].items[]` containing `path` and `css`. It adds the guide and open inventory, annotates exports and arranges four columns. Do not send the full manifest in one tool call.
5. Read back coverage, bindings and bounds; inspect rendered rows at readable scale. Refresh catalog-generated labels when changing tokens. Preserve returned node IDs as execution evidence.

For example, capture the Python command's JSON output into the tool caller’s `manifest` object, and load the renderer source into a Figma call before this invocation:

```js
const category = { ...manifest.categories[0], column: 0 };
return await renderPrimitiveCategory(category, {
  pageId: manifest.pageId,
  meanings: manifest.meanings
});
```

For the guide call, construct its smaller input in the caller:

```js
const slimManifest = {
  pageId: manifest.pageId,
  tokenCount: manifest.tokenCount,
  pending: manifest.pending,
  categories: manifest.categories.map(({ title, rows }) => ({
    title,
    rows: rows.map(({ items }) => ({
      items: items.map(({ path, css }) => ({ path, css }))
    }))
  }))
};
```

These are review-sheet tools, not app code or an automatic Figma sync job. Page-furniture dimensions are not product token values.

## Review limits

The material preset exports CSS custom properties; a general Panda token export for all primitives is not implemented here. Gradient geometry, unsupported filter parameters, static motion samples and adaptive-glass overlap still need implementation-specific verification. Separator fade-stop roles remain unresolved. This cleanup does not invent missing decisions, change source values, or certify runtime behavior. Daniel’s visual review of the new grouping remains pending.

## Visual review

Daniel should review category membership, family grouping, visible values, foundation chains and specimen fidelity. Record corrections against the relevant card or node ID. Record approval explicitly in the project worklog; catalog status alone does not approve this new presentation.
