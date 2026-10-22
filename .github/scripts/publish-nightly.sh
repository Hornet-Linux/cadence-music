#!/usr/bin/env bash
# Publish build outputs to the rolling "Nightly" pre-release.
#
#   publish-nightly.sh <file>...
#
# The Nightly release (tag `nightly`) always holds the newest build of main, so
# there is a stable place to download every app without signing in or cutting a
# version. Real releases (v* tags) are separate and untouched. Each workflow
# (CI, Android, iOS) calls this for its own files, so the files are uploaded
# with --clobber and the release and tag are created or moved idempotently.
#
# Needs: GH_TOKEN (with contents: write), GITHUB_REPOSITORY, GITHUB_SHA.
# NIGHTLY_TAG overrides the tag name (used by the script's test).
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
TAG="${NIGHTLY_TAG:-nightly}"
REPO="$GITHUB_REPOSITORY"

if [ "$#" -eq 0 ]; then
  echo "usage: publish-nightly.sh <file>..." >&2
  exit 2
fi
for f in "$@"; do
  [ -f "$f" ] || { echo "missing file: $f" >&2; exit 1; }
done

# Only the newest commit on main may publish, so a slow older run can never
# overwrite newer files or move the tag backwards.
head="$(gh api "repos/$REPO/commits/main" --jq .sha)"
if [ "$head" != "$GITHUB_SHA" ]; then
  echo "main has moved on ($head); a newer run will publish. Skipping."
  exit 0
fi

# Point the tag at this commit (create it the first time).
if gh api "repos/$REPO/git/ref/tags/$TAG" >/dev/null 2>&1; then
  gh api -X PATCH "repos/$REPO/git/refs/tags/$TAG" -f sha="$GITHUB_SHA" -F force=true >/dev/null
else
  gh api -X POST "repos/$REPO/git/refs" -f ref="refs/tags/$TAG" -f sha="$GITHUB_SHA" >/dev/null
fi

short="${GITHUB_SHA:0:7}"
notes="Automatic build of \`main\` at ${short} ($(date -u +'%Y-%m-%d %H:%M UTC')).

**This is an unreleased development build.** Versioned releases are listed separately. Each file is rebuilt when its app changes, so a file can be older than the commit above (the Android and iOS builds only run when their folders change).

The Android APK is signed with the project's release key, so it installs over earlier nightlies and releases."

if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  gh release edit "$TAG" -R "$REPO" --title "Nightly (latest main)" --notes "$notes" --prerelease --latest=false >/dev/null
else
  # Another workflow may create it at the same moment; if so, just edit it.
  gh release create "$TAG" -R "$REPO" --verify-tag --title "Nightly (latest main)" --notes "$notes" --prerelease --latest=false >/dev/null 2>&1 \
    || gh release edit "$TAG" -R "$REPO" --title "Nightly (latest main)" --notes "$notes" --prerelease --latest=false >/dev/null
fi

gh release upload "$TAG" "$@" -R "$REPO" --clobber
echo "Published $# file(s) to the $TAG release at ${short}."
