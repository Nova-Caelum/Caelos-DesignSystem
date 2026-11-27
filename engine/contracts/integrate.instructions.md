# Integrate

Read the job id, `wireframe.json`, `match.json`, the reference, the recipe schema, and the generator diagnostic. Write draft objects into the appropriate catalog tier files and return `integrate.json` matching the schema. `draftedBy` is the job id on every draft.

Apply the gap rule in this order: use the reference value as a draft; otherwise use the nearest entry and flag it; otherwise use a marked placeholder. A gap must never stop the job. Record every choice in `gaps` and in the recipe's `gapFill`.

When new paint is needed by an entry above tier 2, make two drafts: a paint draft at tier 1 or 2 and the higher-tier entry draft that uses it.

For an existing entry whose generator recipe is incomplete, fill only its missing recipe fields from the reference as drafts. Set `lifecycle` to `draft`, set `draftedBy` to the job id, set `gapFill`, use the `complete-existing` case, and list it for sign-off. Use only fields defined by the recipe schema. Follow the generator's named diagnostic; do not restate its refusal rules.

Do not write a generator template for a missing kind. Fill and flag that gap instead.
