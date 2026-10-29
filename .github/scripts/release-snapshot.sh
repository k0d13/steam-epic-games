#!/usr/bin/env bash
# A beta pre-release of the changesets still pending on main, and nothing else: no tag
# push, commit or database branch. The version carries a timestamp and SHA, so re-runs never collide
set -euo pipefail

# changesets/action reports `published: false` with no changesets too, which would re-tag the stable version
shopt -s nullglob
pending=(.changeset/*.md)
shopt -u nullglob
pending_count=0
for f in "${pending[@]}"; do
  [ "$(basename "$f")" != "README.md" ] && pending_count=$((pending_count + 1))
done
if [ "$pending_count" -eq 0 ]; then
  echo "No pending changesets, skipping snapshot release."
  exit 0
fi

pnpm exec changeset version --snapshot beta

snapshot_version=$(jq -r .version package.json)
name=$(sed -n 's/^id = "\(.*\)"/\1/p' millennium.toml)

# Before the build, since starlight bakes the version into the .star
sed -i "s/^version = \".*\"/version = \"${snapshot_version}\"/" millennium.toml

mise run build

tag="v${snapshot_version}"
asset="${name}-${snapshot_version}.star"
cp ".millennium/${name}.star" "$asset"

gh release create "$tag" "$asset" \
  --title "$tag" \
  --notes "Snapshot build from commit ${GITHUB_SHA}. Not a stable release." \
  --prerelease \
  --target "$GITHUB_SHA"
