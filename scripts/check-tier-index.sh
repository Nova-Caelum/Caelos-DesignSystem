#!/bin/sh
# The checker and its dependencies come from the trusted checkout. The candidate
# index is data, even when a pull request proposes changes to the checker.
set -eu
trusted=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
snapshot=$(mktemp -d)
trap 'rm -rf "$snapshot"' EXIT
git -C "$1" checkout-index --all --prefix="$snapshot/"
node "$trusted/scripts/check-tier-drift.cjs" "$snapshot"
