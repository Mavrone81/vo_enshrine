#!/usr/bin/env bash
#
# tools-image-smoke.sh — checks for the `tools` image (Dockerfile target) and the
# deploy/vo-run-tool.sh wrapper. Run by CI on every PR/push; also runs locally.
#
#   TEST_DATABASE_URL=postgresql://…/<throwaway db>?schema=public \
#     deploy/tools-image-smoke.sh <image ref, e.g. ghcr.io/<account>/virtualoffice-tools:<sha> --
#     the account is whichever one this repo currently lives under, never hardcoded here;
#     ci-cd.yml derives it from the repo's own owner before calling this script>
#
# The database must be a THROWAWAY one reachable from a --network host container
# (CI's postgres service, or a local test container): it gets migrated here.
set -euo pipefail
IMG=${1:?image ref}
: "${TEST_DATABASE_URL:?set TEST_DATABASE_URL to a throwaway database}"
HERE=$(cd "$(dirname "$0")" && pwd)
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

# 1. No secrets or placeholder secrets baked into the image config or its history.
ENVS=$(docker image inspect -f '{{json .Config.Env}}' "$IMG")
for v in AUTH_SECRET DATABASE_URL PII_ENCRYPTION_KEY SMTP_PASSWORD ANTHROPIC_API_KEY; do
  case $ENVS in *"$v="*) fail "image ENV contains $v" ;; esac
done
docker history --no-trunc --format '{{.CreatedBy}}' "$IMG" | grep -Eq 'AUTH_SECRET|PII_ENCRYPTION_KEY|DATABASE_URL=' \
  && fail "image history mentions a secret variable"
ok "no secret variables in image ENV or history"

# 2. No .env file anywhere in the image (outside third-party packages).
FOUND=$(docker run --rm --entrypoint sh "$IMG" -c "find / -xdev \( -name '.env' -o -name '.env.*' \) -not -path '*/node_modules/*' 2>/dev/null" || true)
[ -z "$FOUND" ] || fail ".env file(s) in the image: $FOUND"
ok "no .env files in the image"

# 3. Runs as a non-root user.
[ "$(docker run --rm --entrypoint id "$IMG" -u)" != 0 ] || fail "runs as root"
ok "runs as non-root"

# 4. No Next build in it.
docker run --rm --entrypoint sh "$IMG" -c '[ ! -e /app/.next ] && [ ! -e /app/app ]' || fail "image contains a Next build or app/"
ok "no Next build or app/ sources"

# Fixture: migrate the throwaway DB with the image's own prisma CLI.
docker run --rm --network host -e DATABASE_URL="$TEST_DATABASE_URL" --entrypoint node_modules/.bin/prisma "$IMG" \
  migrate deploy >/dev/null
ok "migrations applied to the throwaway DB"

# The wrapper, driven exactly as on 165 (only the env file / network / pull differ).
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
printf 'DATABASE_URL="%s"\nAUTH_SECRET=must-not-be-passed\n' "$TEST_DATABASE_URL" > "$WORK/env"   # quoted on purpose
SHA=$(printf '%s' "$IMG" | sed -nE 's/.*:([0-9a-f]{40})$/\1/p')
[ -n "$SHA" ] || fail "image ref must end in :<40-hex sha>"
REPO=${IMG%:*}
wrap() { VO_OUT_ROOT="$WORK" VO_SKIP_REPO_CHECK=1 VO_TMPDIR="$WORK" VO_ENV_FILE="$WORK/env" VO_NETWORK=host VO_NO_PULL=1 VO_TOOLS_REPO="$REPO" VO_MIN_AVAIL_MB=0 \
  "$HERE/vo-run-tool.sh" "$@"; }

# 5. M5 dry run, read-only (default): succeeds and says it changed nothing.
OUT=$(wrap "$SHA" backfill-payout-ids.ts --keep-image)
grep -q 'nothing was changed' <<<"$OUT" || { echo "$OUT"; fail "M5 dry run did not complete"; }
grep -q 'mode: READ-ONLY session' <<<"$OUT" || fail "wrapper did not force a read-only session"
ok "M5 dry run via the wrapper (read-only session)"

# 6. Without the read-only session the script's own pre-flight refuses to run.
if wrap "$SHA" backfill-payout-ids.ts --write --keep-image >/dev/null 2>&1; then
  fail "the dry run ran on a writable session"
fi
ok "dry run refuses a writable session (script pre-flight)"

# 7. Only allow-listed variables reach the container. AUTH_SECRET is in the env
#    file but must not be passed; with --dummy it is passed as the placeholder.
grep -q '^passing: DATABASE_URL$' <<<"$OUT" || { grep '^passing:' <<<"$OUT"; fail "passed more than DATABASE_URL"; }
OUT2=$(wrap "$SHA" backfill-payout-ids.ts --dummy AUTH_SECRET --keep-image)
grep -q '^passing: DATABASE_URL AUTH_SECRET(placeholder)$' <<<"$OUT2" || fail "dummy not passed as a placeholder"
ok "only allow-listed variables are passed; dummies are placeholders"

# 8. Input validation: non-SHA tag, a path as script, a bad --out, a missing
#    digest when pulling, and an image whose revision label doesn't match.
wrap "not-a-sha" backfill-payout-ids.ts >/dev/null 2>&1 && fail "accepted a non-SHA tag"
wrap "$SHA" "../etc/passwd" >/dev/null 2>&1 && fail "accepted a path as script"
wrap "$SHA" backfill-payout-ids.ts --out relative.json --keep-image >/dev/null 2>&1 && fail "accepted a relative --out"
wrap "$SHA" backfill-payout-ids.ts --out "$WORK/../escape.json" --keep-image >/dev/null 2>&1 && fail "accepted --out with .."
wrap "$SHA" backfill-payout-ids.ts --out /etc/vo-plan.json --keep-image >/dev/null 2>&1 && fail "accepted --out outside the out root"
VO_SKIP_REPO_CHECK=1 VO_TMPDIR="$WORK" VO_ENV_FILE="$WORK/env" VO_NETWORK=host VO_TOOLS_REPO="$REPO" VO_MIN_AVAIL_MB=0 \
  "$HERE/vo-run-tool.sh" "$SHA" backfill-payout-ids.ts >/dev/null 2>&1 && fail "ran without --digest"
OTHER=0123456789abcdef0123456789abcdef01234567
docker tag "$IMG" "$REPO:$OTHER"     # same image, claimed for another commit
MISMATCH=0; wrap "$OTHER" backfill-payout-ids.ts --keep-image >"$WORK/mm.txt" 2>&1 || MISMATCH=1
docker rmi "$REPO:$OTHER" >/dev/null
[ "$MISMATCH" = 1 ] && grep -q 'revision label' "$WORK/mm.txt" || fail "ran an image whose revision label doesn't match"
ok "rejects non-SHA tags, path scripts, bad --out, a missing digest and a revision mismatch"

# --out happy path: written 600 under the out root.
wrap "$SHA" backfill-payout-ids.ts --out "$WORK/plan.txt" --keep-image >/dev/null
[ "$(stat -c %a "$WORK/plan.txt")" = 600 ] || fail "--out file is not 600"
grep -q 'nothing was changed' "$WORK/plan.txt" || fail "--out file incomplete"
ok "--out writes a 600 file"

# 9. The temporary env file never outlives the run.
[ -z "$(find "$WORK" -name run.env)" ] || fail "run.env left behind"
ok "temporary env file removed"
echo "ALL OK"
