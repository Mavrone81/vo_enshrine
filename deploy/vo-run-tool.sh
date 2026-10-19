#!/usr/bin/env bash
#
# vo-run-tool.sh — run one VirtualOffice admin script (a backfill dry run or
# apply) from the CI-built tools image, pinned by git SHA. Replaces the one-off
# "docker build --target deps on 165" bridge (M5 runbook §5a): nothing is built
# on the shared box.
#
#   deploy/vo-run-tool.sh <40-hex git sha> <script.ts> --digest sha256:<64 hex> [options] [-- script args]
#
#   --digest D        REQUIRED: the image digest CI printed for that commit (job
#                     summary "tools image"). Tags are mutable; the digest is not.
#                     The pulled image must also carry the label
#                     org.opencontainers.image.revision=<git sha>.
#   --vars "A B"      extra variables to pass from .env (DATABASE_URL is always
#                     passed). Nothing else from .env ever reaches the container.
#   --dummy "A B"     variables set to a fixed non-secret placeholder, for scripts
#                     whose imports validate the app's env schema (lib/env) but
#                     never use the value (e.g. AUTH_SECRET).
#   --write           run with a WRITABLE DB session (an apply). Default: the DB
#                     session is forced read-only (default_transaction_read_only=on).
#   --out FILE        also save stdout to FILE: an absolute path under /root, no
#                     "..", parent directory must exist, file must not exist yet
#                     (created 600).
#   --keep-image      don't remove the image afterwards.
#
# Hardening (DevSecOps, from the §5a review): umask 077; values are read from
# .env into a 600 temp file that is shredded on ANY exit — never on a command
# line (argv is visible in `ps` on this shared host); `docker --env-file` does
# not strip quotes, so they are stripped here; exactly one DB network or stop;
# a memory gate; the container runs non-root with a read-only root fs, no
# capabilities, no new privileges and a memory/pid cap; the image is removed
# afterwards; no prune of anything shared.
#
# Needs root on 165 (reads /root/VirtualOffice/.env) and a pullable image: if the
# GHCR package is private, log in first with a read-only token on stdin
# (`docker login ghcr.io -u <user> --password-stdin`) and log out after.
set -euo pipefail
umask 077

REPO_DIR=${VO_REPO_DIR:-/root/VirtualOffice}
ENV_FILE=${VO_ENV_FILE:-$REPO_DIR/.env}
# GHCR_NAMESPACE: the account moved once already (the old one's Actions minutes exhausted,
# no per-account fix for that) -- defaults to the CURRENT namespace, so switching is a single
# env line, never a code edit. Same variable docker-compose.prod.yml's own image default reads.
TOOLS_REPO=${VO_TOOLS_REPO:-ghcr.io/${GHCR_NAMESPACE:-mavrone81}/virtualoffice-tools}
DB_CONTAINER=${VO_DB_CONTAINER:-virtualoffice-db}
NETWORK=${VO_NETWORK:-}          # tests only; on 165 it's derived from the DB container
MIN_AVAIL_MB=${VO_MIN_AVAIL_MB:-1024}

die() { echo "STOP: $*" >&2; exit 1; }

[ $# -ge 2 ] || die "usage: $0 <git-sha> <script.ts> --digest sha256:<hex> [--vars \"A B\"] [--dummy \"A B\"] [--write] [--out FILE] [--keep-image] [-- args]"
SHA=$1; SCRIPT=$2; shift 2
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || die "the image must be pinned by a full 40-hex git SHA"
[[ $SCRIPT =~ ^[a-z0-9][a-z0-9-]*\.ts$ ]] || die "script must be a plain scripts/<name>.ts file name"

VARS=""; DUMMIES=""; WRITE=0; OUT=""; KEEP=0; DIGEST=""; ARGS=()
while [ $# -gt 0 ]; do
  case $1 in
    --digest) DIGEST=$2; shift 2 ;;
    --vars) VARS=$2; shift 2 ;;
    --dummy) DUMMIES=$2; shift 2 ;;
    --write) WRITE=1; shift ;;
    --out) OUT=$2; shift 2 ;;
    --keep-image) KEEP=1; shift ;;
    --) shift; ARGS=("$@"); break ;;
    *) die "unknown option $1" ;;
  esac
done
OUT_ROOT=${VO_OUT_ROOT:-/root}   # tests only
if [ -n "$OUT" ]; then
  case $OUT in "$OUT_ROOT"/*) ;; *) die "--out must be an absolute path under $OUT_ROOT" ;; esac
  case /$OUT/ in */../*|*/./*) die "--out must not contain . or .. components" ;; esac
  [ -d "$(dirname "$OUT")" ] || die "--out directory does not exist: $(dirname "$OUT")"
  [ ! -e "$OUT" ] && [ ! -L "$OUT" ] || die "--out already exists: $OUT"
fi
if [ "${VO_NO_PULL:-0}" != 1 ]; then
  [[ $DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || die "--digest sha256:<64 hex> is required (from the CI job summary)"
fi
for v in $VARS $DUMMIES; do [[ $v =~ ^[A-Z][A-Z0-9_]*$ ]] || die "bad variable name: $v"; done

# The wrapper (from the checkout) and the image must be the same reviewed commit,
# and the checkout must be clean (§5a C2). Tests only: VO_SKIP_REPO_CHECK=1.
if [ "${VO_SKIP_REPO_CHECK:-0}" != 1 ]; then
  [ "$(git -C "$REPO_DIR" rev-parse HEAD)" = "$SHA" ] || die "$REPO_DIR is not at $SHA (git log -1 there, and pass that SHA)"
  [ -z "$(git -C "$REPO_DIR" status --porcelain)" ] || die "$REPO_DIR has local changes"
fi

# Memory gate: a script run is light (no build), but this host serves other people.
AVAIL=$(free -m | awk '/^Mem:/{print $7}')
[ "${AVAIL:-0}" -ge "$MIN_AVAIL_MB" ] || die "available memory ${AVAIL}MB < ${MIN_AVAIL_MB}MB"

# Exactly one network: the one the DB container is on (so the script reaches `db`).
if [ -z "$NETWORK" ]; then
  NETS=$(docker inspect "$DB_CONTAINER" -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')
  set -- $NETS
  [ $# -eq 1 ] || die "$DB_CONTAINER is on $# networks"
  NETWORK=$1
fi

[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE"
WORK=$(mktemp -d "${VO_TMPDIR:-/dev/shm}/vo-run-tool.XXXXXX")   # RAM-backed (/dev/shm) on 165: the values never touch disk
RUN_ENV="$WORK/run.env"
# Pull by digest (immutable); tests only: VO_NO_PULL=1 uses the local tag.
if [ "${VO_NO_PULL:-0}" = 1 ]; then IMAGE="$TOOLS_REPO:$SHA"; else IMAGE="$TOOLS_REPO@$DIGEST"; fi
cleanup() {
  [ -f "$RUN_ENV" ] && shred -u "$RUN_ENV" 2>/dev/null || rm -f "$RUN_ENV"
  rmdir "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

# Copy ONLY the allow-listed variables, quotes stripped, one line each.
: > "$RUN_ENV"
for v in DATABASE_URL $VARS; do
  n=$(grep -c "^$v=" "$ENV_FILE" || true)
  [ "$n" -eq 1 ] || die "$v must appear exactly once in the env file (found $n)"
  grep "^$v=" "$ENV_FILE" | sed -E "s/^($v)=\"(.*)\"\$/\1=\2/; s/^($v)='(.*)'\$/\1=\2/" >> "$RUN_ENV"
done
for v in $DUMMIES; do echo "$v=unused-in-tools-container" >> "$RUN_ENV"; done
# Names only (never values), so the operator sees exactly what the container gets.
echo "passing: DATABASE_URL${VARS:+ $VARS}$(for v in $DUMMIES; do printf ' %s(placeholder)' "$v"; done)"

# Read-only by default: force the session read-only in the URL (the scripts'
# own pre-flight then checks SHOW transaction_read_only). The URL is edited in
# the file, never echoed.
if [ "$WRITE" -eq 0 ]; then
  if grep -q '^DATABASE_URL=.*?' "$RUN_ENV"; then SEP='\&'; else SEP='?'; fi   # \& : a bare & means "the match" in sed
  sed -i -E "s|^(DATABASE_URL=.*)\$|\1${SEP}options=-c%20default_transaction_read_only%3Don|" "$RUN_ENV"
  echo "mode: READ-ONLY session"
else
  echo "mode: WRITE session (--write) — this must be the approved apply step"
fi

[ "${VO_NO_PULL:-0}" = 1 ] || docker pull -q "$IMAGE" >/dev/null
# The image must say which commit it was built from, and it must be ours.
REV=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")
[ "$REV" = "$SHA" ] || die "image revision label is '$REV', expected $SHA"
echo "image: $IMAGE (revision $REV)"
echo "network: $NETWORK"

run_tool() {
  docker run --rm --network "$NETWORK" --env-file "$RUN_ENV" \
    --read-only --tmpfs /tmp:rw,size=64m --cap-drop ALL --security-opt no-new-privileges \
    --memory 1g --pids-limit 256 \
    "$IMAGE" "scripts/$SCRIPT" "${ARGS[@]}"
}
RC=0
if [ -n "$OUT" ]; then run_tool | tee "$OUT" || RC=$?; else run_tool || RC=$?; fi

[ "$KEEP" -eq 1 ] || docker rmi "$IMAGE" >/dev/null 2>&1 || true
exit "$RC"
