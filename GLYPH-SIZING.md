# Glyph sizing

The [Tier 1 Clean icon gallery](https://www.figma.com/design/Jj3Dpnc1s6H5ZjV1Kv3LTx/Caelos-Canon?node-id=368-1160) uses measured artwork bounds instead of the imported SVG canvas. Daniel approved the sizing rule on 2026-11-12; visual signoff of this rendering remains pending.

## Rule and ownership

- Foundation: `base.ratio.fraction-0-95` = 0.95; Figma `ratio/fraction-0-95`.
- Primitive: `primitives.shared.icon.artwork-coverage` aliases that foundation; Figma `primitives/shared/icon/artwork-coverage`.
- Fit the longest painted dimension to 95% of a square glyph frame. For a rectangular frame, fit the limiting dimension. Center the painted bounds on both axes, preserve geometry proportions, and restore authored stroke weights after scaling.
- Ordinary glyphs retain their existing foundation-bound frame sizes. A plus in a 20px frame has 19px artwork. Non-square marks retain their proportions; neither axis is stretched independently.
- Dot is the explicit intrinsic variant: keep its existing small artwork and calculate its square frame as longest painted dimension / coverage. Current artwork is about 3.33px; frame about 3.51px.
- A glyph frame is not a tap target. Controls own their interaction area and padding. This rule does not shrink interactive controls.

The catalog's `artworkSizing` metadata records the policy and target IDs. This change affects the duplicated masters and visible instances on Tier 1 Clean only. Original Tier 1, Tier 67, mobile designs and production consumers were not migrated. No Panda/runtime icon export is claimed.

## Apply or verify

Run the following from the design-system repository root. These scripts require an authenticated Figma Plugin API connection with edit access for apply mode; they are not a local Figma CLI.

1. Inspect the target page. This routine owns artwork fitting and dimension/construction labels only; leave unrelated edits intact. If an intentional artwork-size edit conflicts with the rule, resolve it with Daniel before applying. Run `python3 -B scripts/glyph-fit-plan.py` and parse its JSON output as `config` in the caller. Reconfirm IDs if the library was duplicated.
2. The catalog is authoritative. Before fitting, sync the foundation variable from the catalog and the primitive variable as an alias to it. Missing variables or a catalog/value mismatch stop execution; resolve the discrepancy before retrying.
3. Use the connected `use_figma` tool with this file's key. Pass the complete `scripts/glyph-fit.js` source followed by an invocation such as the example below. Embed the JSON configuration in the call; it is not shared automatically between calls. Set apply to `false` for an audit or `true` for normalization. An optional fourth argument limits glyph names for diagnosis. Nonempty `failures` means failure. Exceptions may leave partial edits: inspect before retrying.
4. After a passing apply, call `await updateGlyphLabels(figma, config, result.results)` in the same call or reload the source and saved results in a subsequent call. Return the text IDs alongside `result.mutatedNodeIds` so the session records exactly which nodes it changed. Labels round dimensions to two decimals.
5. Run the read-only audit again. It measures each listed gallery instance and records its linked master; it does not independently measure the hidden masters or every instance elsewhere in the file. Check labels separately against the returned dimensions: the geometry audit does not validate text. Inspect readable screenshots of Plus, a non-square mark, Dot and the rule card. Save the complete results, failure arrays, affected IDs and diagnostic screenshots in the project's configured evidence directory outside the vault. Keep the measured table in this document as the tracked summary. Newly added glyphs need both a master and a gallery instance.

Invocation after the script source and caller-generated `config` have been included in the same Figma call:

```js
const variables = await figma.variables.getLocalVariablesAsync();
const variable = variables.find(v => v.name === config.primitiveName);
if (!variable) throw new Error('Coverage variable is missing');
config.coverageVariableId = variable.id;
const result = await fitGlyphGallery(figma, config, false);
return result;
```

Figma variables cannot express this vector-fitting calculation. Changing a variable alone does not update geometry or labels: rerun the steps above. New icon-category generation through `renderPrimitiveCategory` automatically fits and labels when supplied `manifest.glyphFit`; evaluate `glyph-fit.js` before `primitive-sheet.js`. Do not regenerate over an edited category. When constructing a new destination, update both the manifest page ID and glyphFit page ID, and keep the source component-set ID valid. The renderer supplies the newly created gallery ID.

## Verification and limits

The fitting routine measures visible painted vector render bounds, including strokes, rather than empty frame bounds. Coverage tolerance is 0.002 in ratio units; center tolerance is 0.002px. These are measurement tolerances, not design tokens. It is intended for these unrotated vector glyphs, not arbitrary artwork with masks, raster content or effects.

On 2026-11-12, all 70 gallery instances, each linked to its recorded master, passed the final live audit. During normalization, source stroke weights and ordinary frame sizes were preserved; Dot retained its artwork size. On the live Plus master, shifting artwork by 1px produced a centering failure, scaling to 80% produced coverage and centering failures, and restoring it passed. All test mutations were restored. Screenshots of Plus, Aelpha and Dot were inspected during fitting; final Plus, Dot and coverage labels were inspected after labeling. This is not visual signoff of all 70 glyphs.

The repository tests cover fitting math, intrinsic sizing, invalid bounds and violation rejection. Existing hook/CI checks enforce catalog alias direction. Neither CI nor a background process currently reads the live Figma canvas; the live audit is an explicit connected-session step. Production adoption and Daniel's visual approval remain separate.

## Measured gallery record

Snapshot from the final live audit. Dimensions are pixels, rounded to three decimals; every listed row passed. Before-art dimensions were captured before normalization.

| Glyph | Master | Gallery instance | Before art | Final art | Final frame |
| --- | --- | --- | --- | --- | --- |
| Zap | 362:4235 | 368:1174 | 16.672 × 18.338 | 17.268 × 19 | 20 × 20 |
| Flame | 362:4238 | 368:1185 | 13.333 × 17.5 | 14.438 × 19 | 20 × 20 |
| Wrench | 362:4241 | 368:1196 | 17.504 × 17.504 | 19 × 19 | 20 × 20 |
| Globe | 362:4244 | 368:1207 | 18.333 × 18.333 | 19 × 19 | 20 × 20 |
| ChevronDown | 362:4249 | 368:1220 | 11.667 × 6.667 | 18.999 × 10.333 | 20 × 20 |
| ChevronRight | 362:4252 | 368:1232 | 6.667 × 11.667 | 10.333 × 18.999 | 20 × 20 |
| ChevronLeft | 362:4255 | 368:1243 | 6.667 × 11.667 | 10.333 × 18.999 | 20 × 20 |
| ChevronsRight | 362:4258 | 368:1254 | 11.667 × 10 | 19 × 16.111 | 20 × 20 |
| Maximize2 | 362:4262 | 368:1266 | 16.667 × 16.667 | 19 × 18.999 | 20 × 20 |
| Minimize2 | 362:4268 | 368:1280 | 16.667 × 16.667 | 18.999 × 19 | 20 × 20 |
| PanelLeft | 362:4274 | 368:1295 | 16.667 × 16.667 | 19 × 19 | 20 × 20 |
| PanelRight | 362:4278 | 368:1307 | 16.667 × 16.667 | 19 × 19 | 20 × 20 |
| Pencil | 362:4282 | 368:1319 | 18.333 × 18.333 | 19 × 19 | 20 × 20 |
| Check | 362:4286 | 368:1331 | 15 × 10.833 | 19 × 13.583 | 20 × 20 |
| Copy | 362:4289 | 368:1342 | 18.333 × 18.333 | 18.999 × 18.999 | 20 × 20 |
| Download | 362:4293 | 368:1355 | 16.667 × 16.667 | 18.999 × 18.999 | 20 × 20 |
| Undo2 | 362:4298 | 368:1368 | 15 × 15 | 19 × 18.999 | 20 × 20 |
| Redo2 | 362:4302 | 368:1380 | 15 × 15 | 19 × 18.998 | 20 × 20 |
| RotateCcw | 362:4306 | 368:1392 | 16.667 × 16.667 | 19 × 19 | 20 × 20 |
| ThumbsUp | 362:4310 | 368:1404 | 18.192 × 18.333 | 18.851 × 19 | 20 × 20 |
| ThumbsDown | 362:4314 | 368:1417 | 18.192 × 18.333 | 18.852 × 19 | 20 × 20 |
| ArrowUpRight | 362:4318 | 368:1429 | 10 × 10 | 19 × 19 | 20 × 20 |
| ArrowDown | 362:4322 | 368:1441 | 13.333 × 13.333 | 19 × 19 | 20 × 20 |
| X | 362:4326 | 368:1453 | 11.667 × 11.667 | 18.999 × 18.999 | 20 × 20 |
| Play | 362:4330 | 368:1465 | 13.333 × 16.667 | 15.148 × 19 | 20 × 20 |
| Pause | 362:4333 | 368:1477 | 11.667 × 15 | 14.667 × 19 | 20 × 20 |
| Folder | 362:4337 | 368:1489 | 18.333 × 15.833 | 19 × 16.4 | 20 × 20 |
| Goal | 362:4340 | 368:1500 | 16.667 × 18.333 | 17.266 × 19 | 20 × 20 |
| Captions | 362:4345 | 368:1513 | 16.667 × 13.333 | 19 × 15.148 | 20 × 20 |
| Hermes | 362:4349 | 368:1525 | 12.742 × 15.822 | 15.301 × 19 | 20 × 20 |
| ClaudeCode | 362:4352 | 368:1537 | 20 × 12.5 | 19 × 11.875 | 20 × 20 |
| Codex | 362:4355 | 368:1548 | 16.667 × 16.667 | 18.999 × 19 | 20 × 20 |
| Plus | 362:4358 | 368:1559 | 13.333 × 13.333 | 19 × 19 | 20 × 20 |
| Mic | 362:4362 | 368:1571 | 13.333 × 18.333 | 13.8 × 19 | 20 × 20 |
| Brain | 362:4367 | 368:1584 | 18.334 × 18.337 | 19 × 19 | 20 × 20 |
| MessageSquare | 362:4378 | 368:1604 | 16.667 × 16.667 | 19 × 19 | 20 × 20 |
| AudioLines | 362:4381 | 368:1615 | 18.333 × 16.667 | 19 × 17.266 | 20 × 20 |
| ArrowUp | 362:4389 | 368:1631 | 13.333 × 13.333 | 19 × 19 | 20 × 20 |
| Square | 362:4393 | 368:1643 | 16.667 × 16.667 | 19 × 19 | 20 × 20 |
| KeyRound | 362:4396 | 368:1654 | 18.365 × 18.365 | 19 × 19 | 20 × 20 |
| Volume2 | 362:4400 | 368:1667 | 18.333 × 15.005 | 19 × 15.538 | 20 × 20 |
| FileText | 362:4405 | 368:1680 | 15 × 18.333 | 15.54 × 19 | 20 × 20 |
| Bot | 362:4412 | 368:1695 | 18.333 × 15 | 19 × 15.529 | 20 × 20 |
| Feather | 362:4420 | 368:1711 | 18.332 × 18.34 | 18.994 × 19 | 20 × 20 |
| BookOpen | 362:4425 | 368:1724 | 18.333 × 16.667 | 19 × 17.269 | 20 × 20 |
| Terminal | 362:4429 | 368:1737 | 15 × 13.333 | 19 × 16.834 | 20 × 20 |
| Search | 362:4433 | 368:1749 | 16.667 × 16.667 | 19 × 18.999 | 20 × 20 |
| OMP | 362:4437 | 368:1761 | 16.667 × 14.167 | 19 × 16.15 | 20 × 20 |
| Aelpha | 362:4440 | 368:1772 | 15.547 × 16.812 | 17.57 × 19 | 20 × 20 |
| Claude | 362:4444 | 368:1784 | 20 × 20 | 19 × 19 | 20 × 20 |
| ChatGPT | 362:4447 | 368:1796 | 20 × 19.822 | 19 × 18.832 | 20 × 20 |
| OpenRouter | 362:4450 | 368:1807 | 19.999 × 14.132 | 19 × 13.426 | 20 × 20 |
| PydanticGraph | 362:4453 | 368:1818 | 19.868 × 17.216 | 19 × 16.464 | 20 × 20 |
| PydanticAgent | 362:4455 | 368:1830 | 19.868 × 17.216 | 19 × 16.464 | 20 × 20 |
| GitHub | 362:4457 | 368:1842 | 19.167 × 18.565 | 19 × 18.404 | 20 × 20 |
| Settings | 362:4460 | 368:1854 | 16.696 × 18.333 | 17.296 × 19 | 20 × 20 |
| TrendingUp | 362:4464 | 368:1866 | 18.333 × 10 | 19 × 10.333 | 20 × 20 |
| FolderOpen | 362:4468 | 368:1878 | 18.336 × 15.833 | 19 × 16.397 | 20 × 20 |
| Layers | 362:4471 | 368:1889 | 18.347 × 18.332 | 19 × 18.986 | 20 × 20 |
| LayersPlus | 362:4476 | 368:1902 | 18.348 × 18.332 | 19 × 18.985 | 20 × 20 |
| FolderPen | 362:4483 | 368:1918 | 18.333 × 15.833 | 19 × 16.4 | 20 × 20 |
| RotateCcwClock | 362:4487 | 368:1930 | 16.667 × 16.667 | 19 × 19 | 20 × 20 |
| ListFilter | 362:4492 | 368:1943 | 16.667 × 11.667 | 19 × 13.225 | 20 × 20 |
| Atom | 362:4497 | 368:1956 | 16.659 × 16.659 | 19 × 19 | 20 × 20 |
| GripVertical | 362:4502 | 368:1969 | 8.333 × 15 | 10.328 × 19 | 20 × 20 |
| GraphStar | 362:4510 | 368:1986 | 18.333 × 18.333 | 19 × 19 | 20 × 20 |
| Dot | 362:4523 | 368:2007 | 3.333 × 3.333 | 3.333 × 3.333 | 3.509 × 3.509 |
| Ellipsis | 362:4526 | 368:2018 | 15 × 3.333 | 19 × 3.833 | 20 × 20 |
| Bell | 362:4531 | 368:2031 | 16.666 × 18.333 | 17.266 × 19 | 20 × 20 |
| Star | 362:4535 | 368:2043 | 18.335 × 17.56 | 17.319 × 16.592 | 18.23 × 18.23 |
