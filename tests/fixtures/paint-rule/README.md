# Paint-rule fixture

Every source or config file in this fixture app has `.fixture` appended to its real name. Tests materialize the tree in a temporary directory and strip that suffix before running the gate. This keeps the deliberately invalid raw value out of repository-wide source scans.
