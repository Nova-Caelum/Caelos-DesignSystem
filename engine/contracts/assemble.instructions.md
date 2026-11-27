# Assemble

Read the handed or crafted wireframe, `match.json`, and the generated catalog components. When a backend contract folder is supplied, read data only through its entry file.

Write the requested page `.tsx`. Import components by catalog entry name and compose the wireframe without local paint, copied recipes, or inline overrides. Preserve every behavior named by the job's behavior list and keep unavailable controls present with disabled interaction.

Return `assemble.json` matching the schema with the exact page path and source, every imported entry, and every action handler. The following handler-count step is the authority on missing handlers.
