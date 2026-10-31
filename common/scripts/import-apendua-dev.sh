#!/usr/bin/env bash
#
# Imports the packages and demos that move here from apendua.dev, with their
# history. This is step 2 of docs/migration-plan.md.
#
#   common/scripts/import-apendua-dev.sh [source] [ref]
#
# source is a URL or path of apendua.dev to clone, by default its GitHub
# repository, and ref is the branch to import, by default develop. The script
# clones the source into a temporary directory, keeps only the paths listed
# below, and fetches the result into this repository as the branch
# apendua-dev-import. Merging that branch is left to the caller:
#
#   git merge --allow-unrelated-histories --no-ff apendua-dev-import
#
# The rewrite is deterministic: the same source commits always come out as the
# same commits here. A run after apendua.dev has moved on therefore yields the
# earlier import's commits plus the new ones, and the run made at the start of
# the freeze replaces the one under review without changing what was reviewed.
#
# Needs git-filter-repo (pip install git-filter-repo).

set -euo pipefail

source_repo="${1:-https://github.com/apendua/apendua.dev.git}"
ref="${2:-develop}"

# The directories that move. Each keeps its path, except the four renamed
# below.
moved=(
  packages/justdom
  packages/signal
  packages/freedom
  packages/justui
  packages/vite-hmr
  packages/headset
  packages/geometry
  packages/sound
  packages/jsdom-env
  packages/euclid-core
  packages/euclid-lang
  apps/bricks-xr
  apps/castle-xr
  apps/desk
  apps/euclid
  apps/knights
  apps/minesweeper
  apps/showcase-xr
  apps/todo-vanilla
  apps/signal-ssr
)

# Where the moved files lived before an earlier rename. Without these a file's
# history would stop at the commit that moved it. They stay at their old paths,
# so `git log --follow` finds them the same way it does in apendua.dev.
#
# This list and the one of single files below hold every rename into the kept
# paths that git finds at its default similarity threshold of 50%, the one
# `--follow` uses. Files reworked on the way in, such as the two that
# packages/reactive-data-structures left in signal, fall below it and are left
# out, since `--follow` would not reach their old paths anyway.
earlier=(
  packages/dom # justdom
  packages/hmr # vite-hmr
  packages/three # freedom; never alongside packages/freedom
  packages/diagnostics # justui
  packages/reactive # signal and justdom
  packages/heap # signal
  packages/context # signal
  packages/minesweeper # apps/minesweeper
  apps/minesweeper-vanilla # apps/minesweeper
  apps/blocks-xr # castle-xr
  apps/euclid-xr # euclid
)

# Single files that moved in from a directory that stays behind.
files=(
  packages/media/src/click.js # sound/src/click.ts
  packages/media/src/click.test.js # sound/src/click.test.ts
  apps/minesweeper-react/src/store4/index.ts # packages/minesweeper
  apps/minesweeper-react/src/store4/types.ts # packages/minesweeper
)

# The directories whose name changes here, as old:new. packages/three is
# freedom's own earlier name and has been free since August 2026, and none of
# the new paths has ever existed in apendua.dev, so no two histories merge.
renamed=(
  packages/freedom/:packages/three/
  packages/justui/:packages/three-ui/
  packages/headset/:packages/xr/
  apps/signal-ssr/:apps/todo-ssr/
)

target="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Nothing moved is stored in Git LFS, so the clone skips fetching LFS objects.
GIT_LFS_SKIP_SMUDGE=1 git clone --quiet --single-branch --branch "$ref" \
  --no-local "$source_repo" "$work/repo"

args=()
for path in "${moved[@]}" "${earlier[@]}"; do
  args+=(--path "$path/")
done
for path in "${files[@]}"; do
  args+=(--path "$path")
done
for pair in "${renamed[@]}"; do
  args+=(--path-rename "$pair")
done

# A bare "#123" in a commit message names an apendua.dev pull request, and here
# it would link to this repository's own #123.
messages="$work/messages.txt"
printf '%s\n' 'regex:(?<![\w/&#])#(\d+)\b==>apendua/apendua.dev#\1' >"$messages"

git -C "$work/repo" filter-repo --force "${args[@]}" \
  --replace-message "$messages"

git -C "$target" fetch --quiet --no-tags "$work/repo" \
  "+refs/heads/$ref:refs/heads/apendua-dev-import"

count="$(git -C "$target" rev-list --count apendua-dev-import)"
head="$(git -C "$target" rev-parse --short apendua-dev-import)"
echo "Imported $count commits into apendua-dev-import ($head)."
