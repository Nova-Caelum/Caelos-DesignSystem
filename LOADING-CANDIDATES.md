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

## 06 — Three Horizon Pulse

Daniel approved **Three Horizon Pulse** with **4px gaps** as the replacement for the round-dot 06 study. This locks the reviewed normal-motion appearance and spacing; it does not approve the separate reduced-motion treatment or assign a consumer role. Open the [selected live gallery](https://www.figma.com/design/Jj3Dpnc1s6H5ZjV1Kv3LTx?node-id=632-1028&autoplay-code-preview=632-1028) on **Tier 2 · Controls (Clean)**, page `377:6179`, code layer `632:1028`.

Three filled Quiet Horizon contours occupy 8 × 8px frames separated by 4px. A fixed envelope sampled across 720 contour phases normalizes the geometry before pulse lift; visible edge gaps vary as the contours move inside their frames. All three share a 4.8s contour cycle. The original pulse remains: 1.2s ease-in-out, delays of 0 / 0.16 / 0.32s, opacity 0.23 to 1, and a 2px lift at 40%.

| Construction | Existing reference | Value |
| --- | --- | --- |
| Frame | `base.space.px-8` | 8px |
| Gap | `base.space.px-4` | 4px |
| Ink | `sys.color.text-primary` | Dawn Cream, `#EDE3CF` |
| Lift | `base.space.px-2` | 2px upward |
| Rest / peak opacity | `base.opacity.fraction-0-23` / `base.opacity.fraction-1` | 0.23 / 1 |
| Pulse stagger | `base.motion.duration.ms-160` | 160ms per position |
| Contour duration | `base.motion.duration.ms-4800` | 4800ms; foundation remains provisional |

These references document construction; the private preview CSS is not bound to catalog or Figma variables. The 1200ms pulse duration, ease-in-out curve, 40% peak, and derived second stagger still need a production recipe. Reduced motion freezes the preview at 0.6 opacity; that static treatment has not received separate approval. No new raw foundation tokens were introduced, and no consumer role is assigned by this selection.

The [approved 6px/4px comparison](https://www.figma.com/design/Jj3Dpnc1s6H5ZjV1Kv3LTx?node-id=626-1028&autoplay-code-preview=626-1028), [original 6px study](https://www.figma.com/design/Jj3Dpnc1s6H5ZjV1Kv3LTx?node-id=623-1028&autoplay-code-preview=623-1028), and [superseded round-dot gallery](https://www.figma.com/design/Jj3Dpnc1s6H5ZjV1Kv3LTx?node-id=602-405&autoplay-code-preview=602-405) are preserved on **Tier 67 - Drafting Bench**, page `160:3876`.

Private geometry source: `nova-horizon-three-dot-gap-review.html`; SHA-256: `315eedd66417ba9a9f9dd6928ae226be123d122c339b72c0e995347ebbc50357`. The approved contour calculation is preserved in the current gallery.

## Additional loading studies

Open [Selected loading gallery](https://www.figma.com/design/Jj3Dpnc1s6H5ZjV1Kv3LTx?node-id=632-1028&autoplay-code-preview=632-1028) on **Tier 2 · Controls (Clean)**, page `377:6179`, code layer `632:1028`. Start the code-layer preview to see all five studies together. Pause stops the animations; reduced-motion preference freezes them.

| Source number | Candidate ID | Animation | Decision |
| --- | --- | --- | --- |
| 01 | `double-border-beam` | Double BorderBeam | Selected |
| 03 | `shape-morph` | Shape morph | Selected |
| 04 | `helix` | Helix | Provisional |
| 05 | `text-shimmer-wave` | Text shimmer wave | Selected |
| 06 | `three-horizon-pulse` | Three Horizon Pulse | Selected; 4px gap approved |

Numbers identify the original [six-study drafting gallery](https://www.figma.com/design/Jj3Dpnc1s6H5ZjV1Kv3LTx?node-id=584-1099&autoplay-code-preview=584-1099), retained on **Tier 67 - Drafting Bench**. The animation definitions for 01 / 03 / 04 / 05 are unchanged. Entry 06 uses the approved Three Horizon Pulse replacement. Four-square morph (02) is not selected.

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

The current five-study gallery was rendered in local Chromium. Checks observed three 8px frames, a 4px computed gap, Dawn Cream ink, changing Horizon contour and pulse, pause/resume, reduced-motion freezing, preservation of the system reduced-motion preference after a manual toggle, a fitting 390px viewport, and no page errors. Its desktop screenshot was visually reviewed. The other four animation definitions were retained; their motion was not freshly exercised in this replacement pass. These checks do not constitute an accessibility or production audit.

Figma import and placement succeeded. **Playback inside Figma remains unverified by the agent**. Daniel approved the preceding 4px comparison; that approval is distinct from verification of the newly imported gallery. A signed-in reviewer should launch the new gallery and check animations, pause, and reduced motion.

Private evidence filenames (request from Daniel; not public repository downloads):

- `selected-loading-review-horizon-20261114.html`, `.png`, and `-verification.json`: current gallery and local checks. HTML SHA-256: `43c9ca788281709eab70489bb8d75ace454ea3210f7cb7529268e78faa99db5f`.
- `selected-loading-review-20261113.html` and accompanying captures/checks: superseded round-dot gallery; historical checks of all five original animations apply to that version only.
- `recovered-motion-review-20261113.html` and `.sources.json`: original six-study gallery and recovery provenance.
- `loader-review-20261113.html` and `.sources.json`: original Compact/Artifacts/Orbs sources and hashes.
- `text-loader-review-20261113.html` and `.sources.json`: rejected fade/lift study and its foundation-reference map.

The previews remain private evidence; they are not redistributed as production components in this public repository. Source fingerprints identify the reviewed files, not licensing clearance.
