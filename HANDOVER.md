# VirtualOffice (Enshrine Portal) — Operations Handover

A working map of how this app is built, deployed, and operated, for anyone
picking it up. Pairs with the `deploy/` docs and the ADR/review notes in the
repo; this file is the operational layer they don't cover.

> ⚠ **This repository is public.** Nothing here is a secret. Secret **values**
> (SSH key, encryption keys, tokens) live only in GitHub Actions secrets and on
> the server — never in the repo, and never in this file. Keep it that way.
>
> Dates are absolute. When this file disagrees with the live system, trust the
> system and fix this file.

## 1. What it is

VirtualOffice is the Enshrine sales/recruitment portal (live at
**vo.enshrine.com.sg**). A single Next.js (App Router) application with server
actions, Prisma + Postgres, server-side PDF agreement generation, bilingual UI
(English + Simplified Chinese), and an admin-only AI chat assistant. It is used
by sales associates, their managers/directors, and admins to run recruitment,
onboarding, sales submissions, commission splits, quotations, and signed
agreements.

## 2. Repository & accounts

- **Base of record: `MavroneBamboo/vo_enshrine` (public).** Moved here on
  2026-10-19 from the previous account's `VirtualOffice` repo (now archived),
  because the old account has an account-level GitHub Actions/billing block. CI
  and CD now run on the `MavroneBamboo` account.
- **PR flow:** branches and PRs are authored as **`Mavrone81`**; the owner, as
  **`MavroneBamboo`**, approves and merges. Commit author and committer email
  **must** be the account's noreply address
  (`137863987+Mavrone81@users.noreply.github.com`) — never a personal email.
- **The build box** is signed in to GitHub as `Mavrone81` and opens draft PRs
  directly; the team never merges. Branch protection + the owner's review are the
  gate.
- **Branch protection on `main`** (verify with GraphQL
  `isRequired(pullRequestNumber:)`, not the REST protection endpoint, which 404s
  for non-admins): required status checks = **test** and **Credential-shaped
  literals**; plus **1 approving review**. *Dependency advisories* is run on
  every PR but is **optional** by design (see *Known open items*).
- 🔴 **The owner-name scanner is load-bearing.** `security.yml` runs
  `owner-name-delta-scan.mjs`, which fails any change that **adds** the project
  owner's personal name to tracked content or to a commit message. The name
  itself is not in the repo — it arrives from the `OWNER_NAME_PATTERN` secret, so
  the public repo never discloses it. Do not write the owner's name anywhere,
  including this file and commit messages.

## 3. Architecture

- **One Next.js app** (`app/` App Router, `components/`, `server/`, `lib/`).
  Mutations are **server actions** in `server/**/actions.ts`, each gated by an
  auth/role check (`requireAdmin`, `isAdminRole`, session role claims).
- **Prisma + Postgres** (`prisma/schema.prisma`). Migrations in
  `prisma/migrations/`. Roles run from Sales Associate up to Business Admin and
  Accounts; `isFullAdmin` is the broadest.
- **PII is encrypted at write.** NRIC, bank account number and similar C3-PII are
  encrypted before storage (`server/pii.ts`, `lib/crypto.ts`) and only ever
  surfaced masked; reveals are audited (`decryptPiiAudited`, audit-before-reveal).
  A plain name (e.g. full name) is **not** in that class and is stored as-is.
  Follow the existing encrypt-at-write path for any new C3-PII — never invent a
  new one, never log plaintext.
- **PDF agreements** are stamped onto fixed master templates by coordinate
  (`lib/pdf/`, `public/templates/`). The Associate Agreement's "Name of
  Applicant as in NRIC/Passport" box is stamped from the candidate's full name
  captured at onboarding. The Pets Ashes Agreement (`server/agreements/`) has its
  own flow and an `AshesAgreementStatus` enum (`Draft`/`Signed`/`Superseded`/
  `Rejected`); rejecting a submission cascades its agreement to a terminal state
  in the same transaction.
- **i18n:** every user string lives in `messages/en.json` + `messages/zh-CN.json`;
  a parity test (`lib/i18n-parity.test.ts`) fails if the two drift apart, so add
  keys to **both**.

## 4. Hosting & deploy

- **Production** runs as Docker containers on a single droplet. The droplet's SSH
  host/user and the deploy key are in the `SSH_HOST` / `SSH_USER` / `SSH_KEY`
  GitHub Actions secrets — **not** in the repo. In-repo operator docs:
  `deploy/ROLLBACK.md`, `deploy/TOOLS.md`.
- **CD deploys on merge to `main`.** `ci-cd.yml` builds and pushes the image to
  GHCR, then an SSH deploy job on the server fetches `origin/main`, checks out
  the deployed SHA, and runs `deploy/deploy-app.sh`, which runs
  **`prisma migrate deploy`** and recreates the container. Because migrations
  apply on merge, **owner approval of the exact migration SQL must come before
  the merge** (see *Migrations*).
- **GHCR namespace is derived from the repo owner** in CI
  (`.github/scripts/compute-ghcr-namespace.sh`); the server's compose and tool
  scripts read it from a `GHCR_NAMESPACE` env default, so moving accounts is one
  env line on the box, never a code edit.
- 🔴 **When moving the repo between accounts, re-point the server's own git
  remote too.** The server's working copy does `git fetch origin` during deploy;
  if its `origin` still points at the old account, the first deploy from the new
  account fails at checkout. (This bit us once — add it to any future move
  checklist.)
- **Health / recovery:** `https://vo.enshrine.com.sg/api/health` returns 200
  (`{"status":"ok"}`). A failed on-box build can leave prod down; recovery is
  `docker compose -f docker-compose.prod.yml up -d` in the app directory. The
  daemon has `live-restore` enabled so containers survive a dockerd crash.
- **Backups:** a nightly job GPG-encrypts the database **and** the uploads volume
  (an uploads-less backup would restore with every signed PDF link dead). The
  backup private key is kept **off** the server; a backup is "verified" only by
  decrypting it. Retention prunes only after a successful write.

## 5. CI/CD workflows

- **`ci-cd.yml`** → *test* (unit + integration against a real Postgres), build &
  push the image, and the SSH deploy job (on `main` only).
- **`security.yml`** → *Credential-shaped literals* (required), *Owner name
  delta*, *Client-document disclosure*, and dependency advisories.
- **`repo-hygiene.yml`, `repo-structure.yml`** → *Committed documents*,
  *Top-level directories*, structural guards.

The integration tests need a database, so they run in CI, not on the build box
(which has no local Postgres). Validate schema/validation-level changes with
`tsc --noEmit` and the unit tests locally; rely on CI for the DB-backed tests.

## 6. Migrations & data fixes

- Every migration needs the owner's **explicit yes on the exact SQL**, delivered
  as text, because CD runs `migrate deploy` on merge. Keep a migration to the one
  change it is for (e.g. an `ALTER TYPE … ADD VALUE` on its own — Postgres won't
  let you *use* a new enum value in the same transaction that adds it).
- An **applied** migration is immutable: a comment-only edit breaks
  `migrate deploy` via the stored checksum. `schema.prisma` itself is not
  checksummed.
- **One-off production data fixes** follow a fixed discipline: **back up first →
  run a read-only COUNT and show the numbers → only then run the UPDATE/DELETE**,
  inside a transaction with `lock_timeout`/`statement_timeout` and a row-count
  assertion. Pre-deletion dumps are kept on the server. Never delete/alter prod
  rows without the owner's yes.

## 7. Operational notes worth keeping

- **Document uploads:** the admin Documents library caps uploads at **150 MB**
  (server-action body limit + `MAX_BYTES` in `server/documents/{actions,
  template-actions}.ts`, plus a client-side guard). The reverse proxy's
  `client_max_body_size` must be **≥** that, or files between the two limits are
  truncated mid-upload and surface as a generic error page rather than a readable
  "too large" message.
- **Deleting a document removes its whole retired history.** A re-upload leaves a
  hidden retired predecessor that points at the current row (`superseded_by`, ON
  DELETE RESTRICT), which used to make the current row undeletable with no UI
  path to the blocker. `deleteDocument` now walks the supersession chain and
  deletes it together in one transaction.
- **Client-facing documents** (quotations, invoices) never show commission,
  overrides, company cut, or retained percentages. Sale closing amounts are
  prefilled from the product's closing price and locked at admin quotation
  approval.
- **The AI chat assistant** is admin-only and calls a configured model via an
  env var; it is not part of the core request path.

## 8. Known open items (as of 2026-10-19)

- **Dependency advisories** is green but kept **optional**, with two advisories
  narrowly waived (no patched version within the consumer's declared range) in
  `docs/dependency-audit-waivers.md`, each with a re-check date (next: 2026-11-19).
  Whether to make the check *required* is a future owner decision.
- **Go-live hardening** (before real associates / real data): rotate every
  account off the shared seed password, and run the pre-production history purge.
  Prod currently holds **test data only**.
- **Off-box backups:** backups and the on-box state should have an off-site copy;
  confirm current arrangement before relying on it.
