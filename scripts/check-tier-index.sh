#!/bin/sh
# The checker and its dependencies come from the trusted checkout. The candidate
# index is data, even when a pull request proposes changes to the checker.
set -eu
trusted=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
snapshot=$(mktemp -d)
trap 'rm -rf "$snapshot"' EXIT
attributes=$(git -C "$1" rev-parse --git-path info/attributes)
case "$attributes" in
  /*) ;;
  *) attributes="$1/$attributes" ;;
esac
mkdir -p "$(dirname -- "$attributes")"
printf '%s\n' '* -working-tree-encoding -text -eol -ident -filter' >> "$attributes"
git -C "$1" checkout-index --all --prefix="$snapshot/"
node "$trusted/scripts/check-tier-drift.cjs" "$snapshot"
