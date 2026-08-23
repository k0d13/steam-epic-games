#!/usr/bin/env bash
# Bump versions and refresh metadata for a stable release.
#
# changesets owns package.json + CHANGELOG.md. We mirror the new version
# into plugin.json (Millennium's source of truth). Only runs when there are
# pending changesets — `changeset version` exits 1 otherwise.
set -euo pipefail

# --- Bump versions ----------------------------------------------------------

pnpm exec changeset version

# --- Mirror version into plugin.json ----------------------------------------

new_version=$(jq -r .version package.json)
tmp=$(mktemp)
jq --arg v "$new_version" '.version = $v' plugin.json > "$tmp"
mv "$tmp" plugin.json

# --- Refresh lockfile and format --------------------------------------------

pnpm install --lockfile-only
pnpm format plugin.json package.json --write
