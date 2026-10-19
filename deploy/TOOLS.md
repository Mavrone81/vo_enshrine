# Running admin scripts on 165: the tools image

Backfill dry runs and applies (M5 payout ids, A-0 amountCollected, SEC-12 NRIC) run from the **tools** image that CI builds
and pushes as `ghcr.io/<account>/virtualoffice-tools:<git sha>` (the account is derived from the repo's own owner in
ci-cd.yml, never hardcoded here), through `deploy/vo-run-tool.sh`.
- **Nothing is built on 165.**
- Every run needs **the owner's go**; an apply needs its own.

## What the wrapper enforces
- **Pinned image:**
  - the image is pulled **by digest** (`--digest sha256:…`, which CI prints in the **tools-publish** job summary under "tools image").
    Tags are mutable; digests aren't.
  - the image's `org.opencontainers.image.revision` label must equal the git SHA given;
  - the checkout at `/root/VirtualOffice` must be **at that SHA and clean**.
- **`--out FILE`:** must be an absolute path under `/root`, with no `.` or `..` components, in an existing directory, and not
  existing yet. It's created with mode 600.
- **Allow-listed variables only:**
  - `DATABASE_URL`, plus anything named in `--vars`, is read from `.env`;
  - quotes are stripped;
  - the values go into a 600 file in **/dev/shm** (RAM), which is shredded on any exit;
  - values are never on a command line and never echoed. The wrapper prints only the variable **names** it passes.
- **Read-only by default:** the DB session is forced read-only. `--write` is required for an apply, and the script's own
  pre-flight checks the mode too.
- **Exactly one DB network**, and **at least 1 GB of memory available**, or it stops.
- **Container hardening:** non-root, read-only root filesystem, `--cap-drop ALL`, `no-new-privileges`, 1 GB memory and
  256 pids caps, `--rm`.
- **Clean-up:** the image is removed afterwards. Nothing shared is ever pruned.

## Runbook block
As root on 165, with the owner's go:
```sh
cd /root/VirtualOffice && git log -1 --oneline        # the deployed commit
SHA=$(git rev-parse HEAD)
DIGEST=sha256:<from the CI job summary for $SHA>
# only if the GHCR package is private: a read-only token on stdin, never as an argument
docker login ghcr.io -u <github user> --password-stdin

# M5: payout-id backfill dry run
deploy/vo-run-tool.sh "$SHA" backfill-payout-ids.ts --digest "$DIGEST"
# A-0: amountCollected dry run, machine-readable plan saved root-only
install -d -m 700 /root/a0-predeploy
deploy/vo-run-tool.sh "$SHA" backfill-amount-collected.ts --digest "$DIGEST" --out /root/a0-predeploy/plan.json -- --json
# SEC-12: NRIC encryption dry run (needs the PII key; AUTH_SECRET only satisfies the env schema)
deploy/vo-run-tool.sh "$SHA" backfill-encrypt-nric.ts --digest "$DIGEST" --vars PII_ENCRYPTION_KEY --dummy AUTH_SECRET
# SEC-12 apply: a separate go, after the pre-apply dump (reviews/predeploy-backup-standard.md)
# --expect <N> is REQUIRED with --apply: N is the dry run's own "total to encrypt", re-checked
# live right before any write. The script refuses --apply without it, so a copy-paste that
# omits it fails loudly rather than running unguarded. Pass --expect 0 to re-confirm a no-op.
deploy/vo-run-tool.sh "$SHA" backfill-encrypt-nric.ts --digest "$DIGEST" --vars PII_ENCRYPTION_KEY --dummy AUTH_SECRET --write -- --apply --expect "$TOTAL_FROM_DRY_RUN"

docker logout ghcr.io
```

## The GHCR package (the owner's settings)
- The first push to `main` after this lands **creates a new package**, `ghcr.io/<account>/virtualoffice-tools`
  (account derived from the repo's own owner, see above). Its **visibility and who can pull it are the owner's settings.**
- **Contents:** only code that's already in the repo:
  - no secrets and no `.env`;
  - the seed is fake after W2-a;
  - it's built after the history purge, so no pre-purge commit ever has a tools image.
- **If the package is private:** 165 needs a **read-only pull token**, passed on stdin at run time (see the block above) and
  logged out after.
- **Cost:** GitHub Packages is, to our understanding, free for public packages (not verified against the owner's plan). A private
  package counts toward his storage quota.
- **Retention (optional, the owner's call, since it deletes):**
  - with `actions/delete-package-versions` (`package-name: virtualoffice-tools`, `package-type: container`,
    `min-versions-to-keep: 30`, about 10 pushes including the provenance manifests) as a step after the tools push;
  - or by hand in the package settings.
  - Not enabled by default, because it deletes data.
  - A "push only when scripts/lib/server/prisma change" filter was deliberately **not** used: the wrapper requires an image
    for exactly the deployed commit.

## Testing
`deploy/tools-image-smoke.sh <image>` runs in CI (the `tools-image` job) against a throwaway Postgres. It checks:
- no secrets or `.env` in the image;
- the image runs non-root and has no Next build;
- the M5 dry run works read-only through the wrapper;
- a writable session is refused by the dry run;
- only allow-listed variables are passed;
- non-SHA tags, path scripts, a bad `--out`, a missing digest and a revision-label mismatch are all rejected;
- `--out` writes a 600 file;
- the temporary env file is gone afterwards.
