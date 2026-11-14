# Loading candidates — Tier 2 review

These are recovered and newly adapted animation studies for Daniel to compare, not approved loading recipes. No candidate has been assigned to a product action. Existing loader entries stay open; the review adds no foundation tokens or production implementations.

## Open the review

[Figma: Loading studies · live review · not approved](https://www.figma.com/design/Jj3Dpnc1s6H5ZjV1Kv3LTx?node-id=555-1016&autoplay-code-preview=555-1016), on **Tier 2 · Controls (Clean)**. Page `377:6179`, code layer `555:1016`.

Start the code-layer preview in an authenticated Figma session. Choose **Compact**, **Artifacts**, or **Orbs**. Compact shows seven candidates together; Artifacts and Orbs each offer three studies, one at a time. **Stop previews** removes the running previews; **Play previews** restarts them from the beginning. Switching collections removes hidden animations. Reduced-motion preference starts the review stopped; playing is an explicit opt-in.

Review appearance and interaction first. Send candidate IDs and proposed uses to Daniel in the active design-review chat. For the text family, identify `text-loading` plus variant `fade` or `lift`. For an orb sub-example, include the collection ID plus its visible tab/example label (or a screenshot). Daniel explicitly approves selections; the implementing agent then records that decision in the Supabase worklog and updates the catalog. Merely opening or playing a study is not approval. Only after selection should a separate implementation rebuild the chosen behavior from approved lower-tier tokens, cover loading/success/error and reduced motion, and verify real asynchronous completion. Historical source values in this preview are not additions to the token system.

## Text loading: fade and gentle lift

[Figma: Text loading · fade and lift · not approved](https://www.figma.com/design/Jj3Dpnc1s6H5ZjV1Kv3LTx?node-id=570-1016&autoplay-code-preview=570-1016), below the original loader review on the same page. Code layer `570:1016`.

Candidate `text-loading` has two side-by-side variants: `fade` passes an opacity wave through the letters; `lift` adds a gentle vertical wave. Choose **Thinking…**, **Generating…**, or **Loading…**, then use **Pause motion / Resume motion**. Reduced motion stops both automatically and displays static, fully opaque labels; it also disables the motion toggle. This differs from the older gallery's explicit opt-in behavior.

This is an original adaptation inspired by the saved Text Shimmer Wave example and [Motion Primitives' Text Shimmer](https://motion-primitives.com/docs/text-shimmer), not a recovered exact animation. Only opacity and transform animate. The preview uses resolved foundation values at generation time, not live Figma variable bindings. Its private source manifest maps all 17 reused foundation references; `token_catalog/02-controls.tokens.json` → `controls.$extensions.app.caelos.loadingReview.supplementaryPreviews` mirrors that complete map.

| Animation parameter | Foundation reference | Resolved value |
| --- | --- | --- |
| Cycle | `base.motion.duration.ms-1800` | 1800ms |
| Letter delay | `base.motion.duration.ms-60` | 60ms |
| Lift | `base.space.px-2` | 2px |
| Dim / full opacity | `base.opacity.fraction-0-55` / `base.opacity.fraction-1` | 55% / 100% |

Continuous easing `cubic-bezier(.645,.045,.355,1)` follows the canonical Linear motion guidance but is **provisional here**, not a new approved foundation token. The preview shell contains local layout values and is not a production recipe. Caelum Sans is requested but not bundled, so a system font may appear.

Local Chromium checks passed for changing opacity and lift, pause/resume (including keyboard activation), label changes, live and startup reduced motion, restoring the operating-system motion preference, and no horizontal overflow at 390px. Animated letters are hidden from accessibility APIs and the whole label is exposed as one status. No page errors were observed. This is not a full accessibility audit. The local screenshot was visually reviewed. Figma import and placement succeeded; **Figma playback is unverified**. While signed in, start this code layer and repeat label selection, pause/resume, and reduced-motion checks before accepting its Figma behavior. On macOS, toggle System Settings → Accessibility → Display → Reduce motion while the preview runs; also reload with it enabled, then disable it to check motion resumes. Request the private evidence filenames below from Daniel; they are intentionally not public repository paths.

## Inventory

There are **14 review entries**: seven compact loaders, three artifact studies, three orb collections, and one text-loading family with two variants. Each orb collection contains further internal examples; 14 is not the count of individual animations.

| Candidate ID | Visible name | Collection |
| --- | --- | --- |
| `compact-0` | Pixel noise · 8 × 8 | Compact |
| `compact-3` | Pixel noise · 3 × 3 | Compact |
| `compact-6` | Nova orbital · v6 | Compact |
| `compact-9` | Columns · original | Compact |
| `compact-12` | Columns · v2 | Compact |
| `compact-15` | Typing · four dots | Compact |
| `compact-18` | Ripple · 3 × 3 | Compact |
| `particle-loading-card-final` | Artifact · particle fold V4.8 | Artifacts |
| `particle-card-reveal` | Artifact · early reveal | Artifacts |
| `particle-card-reveal-calm` | Artifact · calm study | Artifacts |
| `orbs-v1` | Particle orbs · v1 | Orbs |
| `orbs-v2` | Particle orbs · v2 | Orbs |
| `orbs-v3` | Particle orbs · v3 | Orbs |
| `text-loading` | Fade / gentle lift | Text (separate code layer) |

## Recovery and verification limits

- The exact three-dot typing/ripple loader remembered from v0 is still missing. The four-dot study is a separate candidate, not a substitute or a claimed match.
- Morph, helix, and double-beam outline sources were located but are not runnable entries in this review. Their dependencies and behavior still need recovery. The saved text-shimmer example inspired the new text-loading adaptation above; its exact historical implementation has not been restored. Additional motion-registry material was inaccessible without authentication.
- Compact entries came from an earlier loader gallery; artifact and orb entries came from recovered reference previews. Original styling and motion remain historical. Orb scripts were inlined and an obsolete comparison link was replaced with collection navigation guidance.
- Local Chromium checks observed compact motion, stop/restart, artifact canvas and its materialize control, and v3 orb motion, pause, speed selection, and reduced-motion startup. No page errors were observed during those checks. Screenshots of the three collections were visually reviewed. This is not exhaustive verification of every study or interaction.
- Figma import succeeded and the code layer was located. **Playback inside Figma remains unverified** because the available browser session was signed out. The next acceptance check, while signed in, is to observe compact animation, stop and restart it, switch to Artifacts and Orbs, and exercise v3 orb pause and speed selection. Also reload with reduced motion enabled and confirm previews start stopped. Record which checks actually ran and any failures; import success alone is not playback evidence.
- This review does not establish production readiness, accessibility compliance, token compliance, or Tier 2 signoff.

## Provenance fingerprints

The preview and recovered implementation files remain in private evidence storage; they are not redistributed in this public repository. Daniel’s private evidence collection holds `loader-review-20261113.html` and `loader-review-20261113.sources.json`; request those by filename for an implementation handoff. The source manifest records original paths and source hashes. The fingerprints below identify the actual embedded HTML for each entry so a maintainer with that evidence can compare the reviewed versions. They are not download links or proof of licensing clearance.

Preview HTML SHA-256: `82df814d3bde51627ed215a16002e0a23da03778242b9031dd4c0c22f9d9a528`

| Candidate ID | Embedded HTML SHA-256 |
| --- | --- |
| `compact-0` | `a87ea4dbc89f341455a244d0af63cec951706442679893e25994b24995002223` |
| `compact-3` | `480c56c9a39ebb146075d9854c24f38e993a99bae42588a8cb611da705046764` |
| `compact-6` | `45047dba6799d764ae8e0a59f9e9f3da5637fafbcc64579f5651645ef44065b4` |
| `compact-9` | `a5d00caae4327f5b89e7fd99d1b71c3f41a093ae68a22d1f32643232cb7c7cd7` |
| `compact-12` | `aa08280f252a13ed6d691d3c7c1d95a358e6826969577cc2429a4f2abdeb7442` |
| `compact-15` | `b8a85ff8be92482da72b93b155ac22044c68feeb9c3ad2a89a4f2672883aed3a` |
| `compact-18` | `7516601eb210ca6a02e11a1560c930c8e894851828248cb72bc0a3a1974e16de` |
| `particle-loading-card-final` | `a2a4cf521d835b1650c3da5bd1e229c0ed0cb23c1516efdb84f028eba9c1fa00` |
| `particle-card-reveal` | `f0c5d33096a61d29a1cc194e490e99048fcc610df5e6211628f43dcfe3709184` |
| `particle-card-reveal-calm` | `575ce404b193a279c4a563a716612c099272261b859972dfb51ab86fc3197b52` |
| `orbs-v1` | `dd71291bb44b1755efd048f465428c42c09d339abeced21defa2d75ce6f77d81` |
| `orbs-v2` | `5ec1d20e2406e9672fa3adcd3bdbf3c756f730329e0a42119fa507eb3d6731d4` |
| `orbs-v3` | `0932809c13a4a60ae18591f913323a2ebf76b2ca9ed50e32b550ba95192e011b` |

The separate text preview is retained privately as `text-loader-review-20261113.html`, with `text-loader-review-20261113.sources.json`, `text-loader-verification.json`, and `text-loader-review.png`. Its HTML SHA-256 is `6476b7e1f3a562b2ed017c8deb256109631ae3cc0f3c1b9a2478c94cb55b9372`. The manifest records resolved foundation references, provisional easing, and the font limitation.
