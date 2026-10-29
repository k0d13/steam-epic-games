#!/usr/bin/env bash
# changesets owns package.json and CHANGELOG.md, and millennium.toml gets a copy of the version.
# `changeset version` exits 1 without pending changesets, so this only runs when there are some
set -euo pipefail

pnpm exec changeset version

new_version=$(jq -r .version package.json)
sed -i "s/^version = \".*\"/version = \"${new_version}\"/" millennium.toml

pnpm install --lockfile-only
pnpm exec oxfmt package.json
