# Loading selection — Tier 2

Daniel selected **nova-horizonloader**, the single-ring Quiet Horizon, as the general-purpose spinner. Four additional visual studies remain selected and Helix remains provisional. These selections do not establish production readiness; no application consumer is wired by this change.

## General-purpose spinner: nova-horizonloader

On **Tier 2 · Controls (Clean)**, page `377:6179`:

- [Review board](https://www.figma.com/design/Jj3Dpnc1s6H5ZjV1Kv3LTx?node-id=615-1040): static default and reduced-motion samples aligned by size.
- [Reusable component set](https://www.figma.com/design/Jj3Dpnc1s6H5ZjV1Kv3LTx?node-id=615-1027): six variants, 16 / 24 / 40px × default / reduced motion. Native components are static design references.
- [Adjustable live preview](https://www.figma.com/design/Jj3Dpnc1s6H5ZjV1Kv3LTx?node-id=616-1028&autoplay-code-preview=616-1028): imported runnable study with duration, pause/play, and reset controls. Playback inside Figma still needs a signed-in reviewer to verify it.

The outer contour flows around a fixed open center; the whole ring does not rotate. Geometry is preserved from the private brand-library source `quiet-horizon-loader-small-size.html`, including its 200 × 200 viewBox. The 16 / 24 / 40px sizes are frame dimensions, not visible-ink bounds; no optical normalization was applied. Reduced motion shows a still ring with adjacent loading text. Triad remains a draft, not part of this component.

The catalog group is `controls.shared.nova-horizonloader`. Its configurable values reference lower tiers:

| Property | Foundation or semantic reference | Resolved value |
| --- | --- | --- |
| Size 16px | `base.size.px-16` | 16px |
| Size 24px | `base.space.px-24` | 24px; existing dimension reused |
| Size 40px | `base.size.px-40` | 40px |
| Ink | `sys.color.text-primary` | Dawn Cream, `#EDE3CF` |
| Cycle duration | `base.motion.duration.ms-4800` | 4800ms, provisional |

The duration is added to the foundation catalog as provisional, recovered from the source and adjustable in the preview. Daniel selected the loader concept and its general-purpose role; the new size samples, palette adaptation, and speed have not received rendered-review signoff. The source’s off-palette ink is replaced with the approved Dawn Cream token; the original remains documented in the source HTML. Size, ink, and duration aliases remain provisional pending Daniel's review. There is no published Panda recipe or generated CSS variable for this loader yet.

## Additional loading studies

Open [Loading · 4 selected + Helix provisional · Live preview](https://www.figma.com/design/Jj3Dpnc1s6H5ZjV1Kv3LTx?node-id=602-405&autoplay-code-preview=602-405) on **Tier 2 · Controls (Clean)**, page `377:6179`, code layer `602:405`. Start the code-layer preview to see all five studies together. Pause stops the animations; reduced-motion preference freezes them.

| Source number | Candidate ID | Animation | Decision |
| --- | --- | --- | --- |
| 01 | `double-border-beam` | Double BorderBeam | Selected |
| 03 | `shape-morph` | Shape morph | Selected |
| 04 | `helix` | Helix | Provisional |
| 05 | `text-shimmer-wave` | Text shimmer wave | Selected |
| 06 | `three-dot-pulse` | Three-dot pulse | Selected |

Numbers identify the original [six-study drafting gallery](https://www.figma.com/design/Jj3Dpnc1s6H5ZjV1Kv3LTx?node-id=584-1099&autoplay-code-preview=584-1099), retained on **Tier 67 - Drafting Bench**. Animation implementations are unchanged in the curated gallery; its labels and membership reflect the selection. Four-square morph (02) is not selected. The selected three-dot study is available; it is not claimed to be the exact historical v0 ripple Daniel previously remembered.

## Preserved drafts and unselected studies

- **Artifact particle fold V4.8** is preserved in the **Artifacts** collection of [the archived gallery](https://www.figma.com/design/Jj3Dpnc1s6H5ZjV1Kv3LTx?node-id=555-1016&autoplay-code-preview=555-1016), now on **Tier 67 - Drafting Bench**, page `160:3876`. It is outside the active Tier 2 selection. Artifact-generation feedback is its proposed later-tier use; no Tier 3 placement or implementation is claimed.
- **Gooey loader** remains [a separate drafting preview](https://www.figma.com/design/Jj3Dpnc1s6H5ZjV1Kv3LTx?node-id=580-1099&autoplay-code-preview=580-1099) on Tier 67 for future customization.
- The old Compact and Orbs collections remain in the archived gallery for recovery only. None is selected, including Nova orbital. The catalog retains their historical candidate IDs as archive metadata.
- The rejected [text fade / gentle lift study](https://www.figma.com/design/Jj3Dpnc1s6H5ZjV1Kv3LTx?node-id=570-1016&autoplay-code-preview=570-1016) is also archived on Tier 67. It is distinct from selected **05 Text shimmer wave**.

## Next implementation work

The catalog record is [02-controls.tokens.json](token_catalog/02-controls.tokens.json), under `controls.$extensions.app.caelos.loadingReview`. It records selection status separately from readiness, retains archive provenance, and keeps **composer send loading** as `required-not-implemented` with its loader unassigned.

This is a selection record in [Nova-Caelum/Caelos-DesignSystem](https://github.com/Nova-Caelum/Caelos-DesignSystem), not a ready-to-build specification. Follow [AGENTS.md](AGENTS.md), [catalog conventions](token_catalog/README.md), and the approved [foundation](token_catalog/00-foundations.tokens.json) and [primitive](token_catalog/01-primitives.tokens.json) catalogs. Helix is included for comparison only; its final approval remains with Daniel.

The general-purpose spinner role is assigned to nova-horizonloader. Ask Daniel to assign the additional studies and the composer send indicator to concrete uses, then rebuild the production recipes using approved lower-tier tokens. Do not promote historical preview colors, sizes, easing, or durations into foundations automatically. Preserve the reviewed effect while making its construction explicit. Implement the composer sending variant and asynchronous loading/completion/error behavior, prevent duplicate submission where appropriate, and review reduced-motion behavior. Neither a click nor a timer proves successful completion.

Production recipes and consumer integration remain separate work. The catalog and native Figma references document construction; the private runnable studies are not production components.

Formal Tier 2 completion still requires Daniel's rendered-tier signoff and deployed drift checks proven with clean cases and planted violations. This selection does not establish either requirement for the new loading recipes. Existing unimplemented loader inventory entries remain open rather than being silently marked complete. The existing enforcement and proof entry points are [check-tier-drift.cjs](scripts/check-tier-drift.cjs), [prove-tier-drift.mjs](scripts/prove-tier-drift.mjs), and the [pre-commit hook](.husky/pre-commit).

## Evidence and limits

For nova-horizonloader, the native board was exported and visually reviewed; its six variants and Figma variable aliases were inspected. Nine checks on the exact imported script in a mocked DOM passed: changing contour with fixed center, pause, resume, duration change without a phase jump, invalid-duration rejection, reset, reduced-motion freeze even after Play, hidden-document pause, and stopping after removal. These are script checks, not browser rendering or Figma playback proof. The anonymous Figma viewer did not expose runnable playback, so **Figma playback remains unverified**. Daniel can perform that visual review in signed-in Figma: launch the preview and inspect motion at all three sizes, duration changes, pause, and reduced motion. The implementing agent should record the observed results here and in `loadingReview.quietHorizon`, with the decision posted to the Supabase worklog.

Private Quiet Horizon evidence filenames: `nova-horizonloader-review.html`, `nova-horizonloader-provenance.json`, and `nova-horizonloader-figma.png`.

The following evidence applies only to the five-study gallery, not to nova-horizonloader:

Local Chromium checks observed changing animation in all five studies, pause behavior, reduced-motion freezing after browser style updates settled, a fitting 390px viewport, and no page errors. The local screenshot was visually reviewed. These checks do not constitute an accessibility or production audit.

Figma import and placement succeeded. **Playback inside Figma remains unverified**; the screenshot service returned a blank image rather than visible animation content. The next reviewer with signed-in Figma preview access must launch the new code layer and check all five animations, pause, and reduced motion and record the result before accepting its Figma playback. Import success alone is not playback evidence.

Private evidence filenames (request from Daniel; not public repository downloads):

- `selected-loading-review-20261113.html`, `.png`, `-verification.json`, and `-figma.png` hold the curated preview and checks.
- `recovered-motion-review-20261113.html` and `.sources.json` hold the original six-study gallery and recovery provenance.
- `loader-review-20261113.html` and `.sources.json` retain the original Compact/Artifacts/Orbs sources and hashes.
- `text-loader-review-20261113.html` and `.sources.json` retain the rejected fade/lift study and its foundation-reference map, also preserved in catalog archive metadata.

`selected-loading-review-20261113.html` SHA-256: `841f3231b090c4c5f7936fcebc21edc41dda7040121c6840c3754acd9f2e442c`.

The previews remain private evidence; they are not redistributed as production components in this public repository. Source fingerprints identify the reviewed files, not licensing clearance.
