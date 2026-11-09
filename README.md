# Caelos Design System

The single source of truth for Caelos design tokens and components. Caelos apps install it as a versioned package and keep no copies of their own.

Raw values live only in the bottom tier. Every tier above it uses only tokens and components from the tiers below.

**Status:** the token catalog is in. [`token_catalog/`](token_catalog/README.md) lists every token from tier 0 to tier 5, with its value where one is decided, its status, and the items still undecided. No components have been built yet.

Copyright 2026 Nova Caelum & Co. All rights reserved. See [LICENSE](LICENSE).

## Palette check

Every colour in this repository must be in the Caelos product palette held in the Nova Caelum brand library. `scripts/check-palette.mjs` reads that palette at run time through the vault gateway and fails the pull request on any other colour. The `palette` job runs it from `main` on every pull request and on every push to `main`: the change under review is checked out as data and never executed. The `unit` job runs the check's own tests.

    node --test                     # offline tests
    node scripts/check-palette.mjs [--root DIR]  # needs GAETWAY_URL, GAETWAY_AGENT and GAETWAY_KEY

Exit 0 passes. Exit 1 means a colour is outside the palette (the output names the file, line and value) or the palette document holds a hex code. Exit 2 means the check could not run, which is never a pass.
