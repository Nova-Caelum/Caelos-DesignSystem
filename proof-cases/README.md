# Visible planted proof cases

The tier-proof runner applies these cases only in disposable workspaces. Ordinary
cases are never committed; the merge-block case is a separate, on-demand proof.
Every refusing plant names its check and an `expect` pattern that identifies the
planted file or entry and the rule. Exit 1 alone is not proof of the refusal.

| Kind | Expected result | Planting surfaces |
| --- | --- | --- |
| Rebuilt component | Refused | App page and catalog recipe |
| Reused component | Accepted | App page and catalog recipe |
| Raw value equal to a token | Refused | App code and catalog token |
| Empty required value | Refused | App code and catalog recipe |
| Non-token merge | Refused by the required check | One-use throwaway pull request |

Run `node scripts/prove-tier-drift.mjs --validate-only --cases proof-cases` to
validate a case folder without executing checks. The same runner accepts a
different case folder for private evaluation. Inspect the merge case with
`node scripts/prove-merge-block.mjs --dry-run --case proof-cases/non-token-merge.case.json`.
A real run requires a used-cases list and records the case after closing the pull
request. It never deletes branch history.

The normal proof reports the merge case as `not-run (on demand)` and excludes it
from the pass count. A real merge-block run is the only way to execute that case.
