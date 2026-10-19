# Rolling back the application

**There is no `:latest` retag step any more. A deploy runs one exact commit, and a rollback
is "deploy commit X" — nothing is retagged by hand.**

Every CI build pushes two tags: `ghcr.io/<account>/virtualoffice:latest` and
`…:<commit-sha>` — the account is derived from the repo's own owner in ci-cd.yml, never
hardcoded, so this doc names the shape rather than a literal that goes stale the next time
the repo moves accounts. The deploy pulls and runs the **per-commit tag**, and pins the host's
source checkout to that same commit, so the migrations that run and the image that starts
are always the same revision.

## How to roll back

1. Find the commit you want live — any commit whose CI build succeeded.
2. Point a ref at it (a branch or tag) so the workflow can be dispatched on it.
3. Run the **CI/CD** workflow via **Run workflow** (`workflow_dispatch`) on that ref, with:
   - **`allow_non_head`** = **true**
   - **`reason`** = why, in a sentence. *A blank reason is refused* — an override nobody
     can explain later is not an override, it is a hole.
4. The run rebuilds that commit, pushes `:<sha>`, deploys it, and then **verifies the
   running container reports that sha** before the job is allowed to pass.

## Why the override exists

The deploy **refuses any sha that is not `main`'s head**. That is deliberate: two CI runs
can finish out of order, and on 2026-09-28 an older run redeployed over a newer one and
production served a stale build with every check green.

**A rollback is the one legitimate case of deploying a sha that is not the head**, so it
needs an explicit, audited way through rather than a weakened check. The override is
recorded in the run log with the offered sha, `main`'s head, and the reason.

🔴 **Rolling back does not change `main`.** After a rollback, production is deliberately
behind `main`, and the post-deploy check compares the running container against **the sha
that was deployed**, not against `main` — so a rollback verifies clean. Land a real fix on
`main` and deploy normally; do not leave production on an older sha and forget.

## Database

**A code rollback does not undo a migration.** Migrations are applied forward at deploy
time and are not reversed here. If the commit you are rolling back to predates a migration
that has already run, check that the older code tolerates the newer schema **before**
dispatching. Where a data change needs undoing, that is a separate, reviewed step — see
`deploy/m5-rollback.sql` for the shape of one.

## What this cannot catch

The deploy pipeline enforces this for deploys it performs. It cannot see a change made by
hand on the host — a manual `docker compose up`, an image retagged directly in the
registry, or an earlier rollback left in place. **The `/api/health` `sha` field is what
surfaces those**: compare it with `git ls-remote origin refs/heads/main` whenever you want
to know what is actually running, rather than what should be.
