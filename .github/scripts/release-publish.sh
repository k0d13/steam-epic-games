#!/usr/bin/env bash
# Tags and releases a stable version, then pushes a PluginDatabase branch for the maintainer
# to open a PR from. Every step can be re-run after a partial failure without duplicating
#
# PLUGIN_DB_TOKEN is a PAT with Contents: write on the fork, which lives under its owner's account
set -euo pipefail

name=$(sed -n 's/^id = "\(.*\)"/\1/p' millennium.toml)
version=$(sed -n 's/^version = "\(.*\)"/\1/p' millennium.toml)
tag="v${version}"
asset="${name}-${version}.star"

cp ".millennium/${name}.star" "$asset"

# The remote, as Actions checkouts have no tags. A tag there means an earlier run did
# everything, so this one records nothing for changesets/action to report as a publish
if git ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1; then
  echo "Tag ${tag} already on remote — nothing to publish."
  exit 0
fi

notes_file=$(mktemp)
if [ -f CHANGELOG.md ]; then
  awk -v ver="$version" '
    $0 == "## " ver { capture = 1; next }
    capture && /^## / { exit }
    capture { print }
  ' CHANGELOG.md > "$notes_file"
fi

# Both the GitHub release and Millennium's update note carry these notes, so
# end them with the one place to support the plugin.
printf '
---

Enjoying the plugin? [Support it on Ko-fi](https://ko-fi.com/X8X554X28) ☕
' >> "$notes_file"

# Millennium's update note is the message of the commit PluginDatabase points at, otherwise
# the changesets merge, so an empty commit carries the changelog as markdown
message_file=$(mktemp)
{
  echo "${name} ${tag}"
  echo
  cat "$notes_file"
} > "$message_file"

# A re-run starts from the merge commit again, so it reuses a release commit already on main
git fetch origin main --depth=1
if [ "$(git log -1 --format=%s FETCH_HEAD)" = "${name} ${tag}" ]; then
  echo "Release commit for ${tag} already on main — reusing it."
  release_sha=$(git rev-parse FETCH_HEAD)
  git checkout --detach "$release_sha"
else
  git -c user.name="github-actions[bot]" \
      -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
      commit --allow-empty -F "$message_file"
  # Pushed with GITHUB_TOKEN, so this doesn't retrigger the workflow
  git push origin HEAD:main
  release_sha=$(git rev-parse HEAD)
fi

git tag -f "$tag"
git push origin "$tag"

if ! gh release view "$tag" >/dev/null 2>&1; then
  gh release create "$tag" "$asset" --title "$tag" --notes-file "$notes_file"
fi

upstream="SteamClientHomeBrew/PluginDatabase"
branch="update-${name}-${version}"
release_url="https://github.com/${GITHUB_REPOSITORY}/releases/tag/${tag}"

export GH_TOKEN="$PLUGIN_DB_TOKEN"

fork_owner=$(gh api user --jq .login)
fork="${fork_owner}/SteamClientHomeBrew_PluginDatabase"
# Fine-grained PATs can't fork a repository they don't own, so an existing fork is kept
if ! gh repo view "$fork" >/dev/null 2>&1; then
  gh repo fork "$upstream" \
    --clone=false \
    --default-branch-only \
    --fork-name SteamClientHomeBrew_PluginDatabase >/dev/null
fi

workdir=$(mktemp -d)
gh repo clone "$fork" "$workdir" -- --depth=1
pushd "$workdir" >/dev/null

git remote add upstream "https://github.com/${upstream}.git" 2>/dev/null \
  || git remote set-url upstream "https://github.com/${upstream}.git"
git fetch upstream main --depth=1
git checkout -B "$branch" upstream/main

# Found by URL, unless this repository was renamed after being added and
# PLUGIN_DB_SUBMODULE_PATH names it, as the grep can't follow GitHub's redirect
adding=false
if [ -n "${PLUGIN_DB_SUBMODULE_PATH:-}" ]; then
  submodule_path="$PLUGIN_DB_SUBMODULE_PATH"
else
  # `|| true`, or pipefail ends the script on no match
  submodule_key=$(
    { git config -f .gitmodules --get-regexp 'submodule\..*\.url' 2>/dev/null || true; } \
      | { grep -iE "[/:]${GITHUB_REPOSITORY}(\.git)?\$" || true; } \
      | head -n1 \
      | awk '{print $1}' \
      | sed 's/\.url$//'
  )
  if [ -z "$submodule_key" ]; then
    # Not listed yet, so the branch submits the plugin rather than updating it
    adding=true
    submodule_path="plugins/${name}"
    git submodule add "https://github.com/${GITHUB_REPOSITORY}" "$submodule_path"
  else
    submodule_path=$(git config -f .gitmodules "${submodule_key}.path")
  fi
fi

git submodule update --init "$submodule_path"

# The tagged commit, not main's tip, which may have moved past the release since
git -C "$submodule_path" fetch origin "$release_sha" --depth=1
git -C "$submodule_path" checkout --detach "$release_sha"

if [ "$adding" = true ]; then
  pr_title="Add \`${name}\` ${tag}"
else
  pr_title="Update \`${name}\` to ${tag}"
fi

# A re-run may find it there already; a new submodule is staged, not modified, so always commits
if [ "$adding" = false ] && git diff --quiet -- "$submodule_path"; then
  echo "Submodule ${submodule_path} already at latest, no commit needed."
else
  git -c user.name="github-actions[bot]" \
      -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
      commit -am "$pr_title"
fi

git push -f "https://x-access-token:${PLUGIN_DB_TOKEN}@github.com/${fork}.git" "$branch"

popd >/dev/null

# The upstream PR is opened by hand, from a compare link and body left on the release commit
pr_body=$(mktemp)
sed \
  -e "s|REPLACE_WITH_PLUGIN_NAME|${name}|g" \
  -e "s|REPLACE_WITH_UPDATE_SUMMARY|See full release notes: ${release_url}|g" \
  .github/plugin-db-pr-template.md > "$pr_body"

encoded_title=$(jq -nr --arg s "$pr_title" '$s|@uri')
compare_url="https://github.com/${upstream}/compare/main...${fork_owner}:${branch}?quick_pull=1&title=${encoded_title}"

comment_body=$(cat <<EOF
## Plugin database update ready for ${tag}

Branch \`${branch}\` has been pushed to [\`${fork}\`](https://github.com/${fork}/tree/${branch}).

**[Open the PR against \`${upstream}\` →](${compare_url})**

Paste this as the PR body:

\`\`\`\`md
$(cat "$pr_body")
\`\`\`\`
EOF
)

# The PAT has no access to this repository
GH_TOKEN="$GITHUB_TOKEN" gh api \
  "repos/${GITHUB_REPOSITORY}/commits/${release_sha}/comments" \
  -f body="$comment_body" >/dev/null

# How changesets/action learns of a publish; `packageName` is package.json's name, not
# millennium.toml's id
if [ -n "${CHANGESETS_OUTPUT:-}" ]; then
  jq -nc --arg tag "$tag" --arg pkg "$(jq -r .name package.json)" \
    '{type: "git-tag", tag: $tag, packageName: $pkg}' >> "$CHANGESETS_OUTPUT"
fi

echo "Published ${name} ${tag}"
