# Promote fixtures

Catalog files carry a `.fixture` suffix so repository-wide catalog checks do not classify them as production token catalogs. Tests copy each fixture tree into a temporary directory and remove that suffix before running the promote command.
