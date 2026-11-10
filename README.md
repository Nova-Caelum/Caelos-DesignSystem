# Caelos Design System

The single source of truth for Caelos design tokens and components. Caelos apps install it as a versioned package and keep no copies of their own.

Raw values live only in the bottom tier. Every tier above it uses only tokens and components from the tiers below.

**Status:** the token catalog is in. [`token_catalog/`](token_catalog/README.md) lists every token from tier 0 to tier 5, with its value where one is decided, its status, and the items still undecided. `src/tokens.ts` holds the product colours for code, one token per colour, and the palette job keeps it identical to the palette record. The Tier 1 material preset is available for review.

Copyright 2026 Nova Caelum & Co. All rights reserved. See [LICENSE](LICENSE).

## Use the Tier 1 materials

Add `materialPreset` from [src/material-preset.mjs](src/material-preset.mjs) to the Panda configuration's presets. Use the generated `material({ layer: 'ground', texture: 'auto' })` recipe. Auto selects graph or glass by layer. Choose plain, graph, glass, portal, or sage for an explicit finish. Set `data-theme="light"` on a containing element for the light theme. Reduced transparency uses a solid fill for each glass finish.

For panel and portal glass, the host sets `--sys-glass-auto-blur` **on the material element** to the measured fraction of content behind it. Clear, partial and full overlap interpolate between no filtering and the finish’s catalog blur and saturation. Unmeasured surfaces keep full filtering. Body opacity and tint stay fixed; reduced transparency stays opaque. Each nested material starts with its own default.

## Palette check

Every colour in this repository must be in the Caelos product palette held in the Nova Caelum brand library. `scripts/check-palette.mjs` reads that palette at run time through the vault gateway and fails the pull request on any other colour. The `palette` job runs it from `main` on every pull request and on every push to `main`: the change under review is checked out as data and never executed. The same job fails if `src/tokens.ts` differs from the product palette record in any role or value, so the tokens cannot drift from the brand library. The `unit` job runs the check's own tests.

    node --test                     # offline tests
    node scripts/check-palette.mjs [--root DIR] [--tokens FILE]  # needs GAETWAY_URL, GAETWAY_AGENT and GAETWAY_KEY

Exit 0 passes. Exit 1 means a colour is outside the palette (the output names the file, line and value) the palette document holds a hex code, or the tokens file differs from the palette record. Exit 2 means the check could not run, which is never a pass.
