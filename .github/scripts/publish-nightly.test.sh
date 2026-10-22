#!/usr/bin/env bash
# Tests publish-nightly.sh against a fake `gh`, so nothing is published.
#   bash .github/scripts/publish-nightly.test.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/publish-nightly.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
touch "$work/Cadence.apk" "$work/Cadence.apk.sha256"

# The fake gh records every call and answers from FAKE_* variables.
cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
echo "gh $*" >>"$FAKE_LOG"
case "$1 $2" in
  "api repos/o/r/commits/main") echo "$FAKE_HEAD" ;;
  "api repos/o/r/git/ref/tags/nightly") exit "${FAKE_TAG_MISSING:-0}" ;;
  "api -X") ;;
  "release view") exit "${FAKE_RELEASE_MISSING:-0}" ;;
  "release create") exit "${FAKE_CREATE_FAILS:-0}" ;;
  "release edit" | "release upload") ;;
  *) echo "unexpected gh call: $*" >&2; exit 99 ;;
esac
FAKE
chmod +x "$work/bin/gh"

failures=0
run() { # run <name> -- <env assignments...> -- <args...>
  local name=$1; shift
  : >"$work/log"
  env PATH="$work/bin:$PATH" GH_TOKEN=x GITHUB_REPOSITORY=o/r GITHUB_SHA=abcdef1234567 FAKE_LOG="$work/log" "$@" >"$work/out" 2>&1
  status=$?
  log="$(cat "$work/log")"
  echo "--- $name (exit $status)"
}
expect() { # expect <description> <condition>
  if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; failures=$((failures + 1)); fi
}
has() { grep -qF -- "$1" <<<"$log"; }
hasnt() { ! grep -qF -- "$1" <<<"$log"; }

run "first publish: creates the tag and the pre-release, then uploads" \
  FAKE_HEAD=abcdef1234567 FAKE_TAG_MISSING=1 FAKE_RELEASE_MISSING=1 \
  bash "$script" "$work/Cadence.apk" "$work/Cadence.apk.sha256"
expect "exits 0" '[ "$status" = 0 ]'
expect "creates the tag at this commit" 'has "-X POST repos/o/r/git/refs -f ref=refs/tags/nightly -f sha=abcdef1234567"'
expect "creates a pre-release that is not 'latest'" 'has "release create nightly" && has "--prerelease --latest=false"'
expect "requires the tag to exist" 'has "--verify-tag"'
expect "uploads both files with --clobber" 'has "release upload nightly" && has "Cadence.apk.sha256" && has "--clobber"'

run "later publish: moves the tag, edits the release, uploads" \
  FAKE_HEAD=abcdef1234567 FAKE_TAG_MISSING=0 FAKE_RELEASE_MISSING=0 \
  bash "$script" "$work/Cadence.apk"
expect "exits 0" '[ "$status" = 0 ]'
expect "moves the tag by force" 'has "-X PATCH repos/o/r/git/refs/tags/nightly -f sha=abcdef1234567 -F force=true"'
expect "edits instead of creating" 'has "release edit nightly" && hasnt "release create"'
expect "uploads" 'has "release upload nightly"'

run "race: another workflow created the release first" \
  FAKE_HEAD=abcdef1234567 FAKE_TAG_MISSING=0 FAKE_RELEASE_MISSING=1 FAKE_CREATE_FAILS=1 \
  bash "$script" "$work/Cadence.apk"
expect "exits 0" '[ "$status" = 0 ]'
expect "falls back to editing" 'has "release create nightly" && has "release edit nightly"'
expect "still uploads" 'has "release upload nightly"'

run "main has moved on: publishes nothing" \
  FAKE_HEAD=1111111111111 FAKE_TAG_MISSING=0 FAKE_RELEASE_MISSING=0 \
  bash "$script" "$work/Cadence.apk"
expect "exits 0" '[ "$status" = 0 ]'
expect "does not touch the tag, the release or any file" 'hasnt "git/refs" && hasnt "release" '
expect "says why" 'grep -q "main has moved on" "$work/out"'

run "a missing file is an error before anything is published" \
  FAKE_HEAD=abcdef1234567 \
  bash "$script" "$work/not-there.apk"
expect "exits non-zero" '[ "$status" != 0 ]'
expect "makes no gh calls" '[ -z "$log" ]'

run "no files is a usage error" FAKE_HEAD=abcdef1234567 bash "$script"
expect "exits 2" '[ "$status" = 2 ]'

if [ "$failures" -gt 0 ]; then echo "$failures check(s) failed"; exit 1; fi
echo "all checks passed"
