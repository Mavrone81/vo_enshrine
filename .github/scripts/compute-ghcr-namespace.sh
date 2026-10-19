#!/usr/bin/env bash
# Shared by every job in ci-cd.yml that needs the GHCR namespace -- one script, not four
# near-identical inline copies, same reasoning Hive's own migration-baseline.yml namespace job
# gives for not repeating itself per job.
#
# The owner moved this repo's account once already (the old one's Actions minutes exhausted,
# no per-account config fix for that) -- a hardcoded owner, or a variable that just holds the
# same literal one level removed, means redoing this by hand every time it moves again.
# Deriving it from the repo's own owner (passed in as $1, the caller reads it from
# github.repository_owner before calling this) means the same workflow works unchanged on
# whichever account it's actually running under.
#
# Two separate, named failure modes, not one blanket check -- each one maps to a real, distinct
# way this could go wrong:
#   EMPTY: a blank $1 (github.repository_owner unset or empty) would build
#   "ghcr.io//virtualoffice" -- a different, worse kind of broken than a wrong-but-present name,
#   and must not pass silently into a build-arg/tag string that looks superficially fine.
#   UPPERCASE: ghcr.io package paths are lowercase regardless of the GitHub account's own
#   display casing. This can never fire against the `tr` call below AS WRITTEN -- it exists as
#   a safety net against a FUTURE edit to this script (someone changes how the owner is derived
#   and drops the lowercasing) silently reintroducing the exact bug this whole patch exists to
#   fix. Proven non-vacuous by mutation, not assumed: remove the `tr` call, this check is what
#   catches it, not a downstream GHCR push failing three steps later with a confusing 404/denied.
#
# Usage: compute-ghcr-namespace.sh <raw repository_owner> >> "$GITHUB_OUTPUT"
set -euo pipefail

raw="${1:-}"
owner="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"

if [ -z "$owner" ]; then
  echo "::error::GHCR namespace resolved to an empty string -- github.repository_owner was empty (or became empty after lowercasing, which cannot happen for a non-empty ASCII input). Refusing to build, push, or deploy against a registry path with an empty segment." >&2
  exit 1
fi

case "$owner" in
  *[A-Z]*)
    echo "::error::GHCR namespace '$owner' still contains an uppercase character after lowercasing -- ghcr.io package paths must be all-lowercase. Refusing to build, push, or deploy with an invalid registry path." >&2
    exit 1
    ;;
esac

echo "owner=$owner"
