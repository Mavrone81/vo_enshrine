# Dependency-advisory waivers

Every entry here is a `pnpm.auditConfig.ignoreGhsas` exemption in `package.json` — scoped to
that one GHSA ID only, never a blanket `--audit-level` drop or a whole-package exclusion. An
entry without a real reason or a real expiry is not acceptable; this file is where that reason
and expiry are recorded, since `package.json` itself (plain JSON) has nowhere to carry prose.

| GHSA ID | Package | Reason | Added | Re-check by |
| --- | --- | --- | --- | --- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | `braces` | Stack-exhaustion DoS via deeply nested brace patterns. **No patched version exists** — the advisory's own `patched_versions` field is `<0.0.0` and npm's registry has no `braces` release past `3.0.3` as of this entry. `braces` here is a deep transitive dependency (via `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch`), reached only by the lint toolchain, never by the production build or runtime — not a route an attacker-controlled pattern could reach in this app. Overriding to a version that doesn't exist isn't possible; waiving is the only option until upstream ships a fix. | 2026-10-19 | 2026-11-19 — re-run `pnpm audit` and check `npm view braces versions` for a release past `3.0.3`; if one exists, replace this waiver with a real bump instead of renewing it. |
| [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx) | `deepmerge-ts` | Stack exhaustion merging recursive object graphs. **Only `>=8.0.0` fixes it** — no 7.x patch exists. The consumer, `@prisma/config` (via `prisma@6.19.3`), declares an **exact pin** `"deepmerge-ts": "7.1.5"`, not a range, so a bare override would force a version it never asked for; checked the real 8.0.0 release notes and it is a genuine breaking change (Map values deep-merge by default instead of shallow, `deepmergeInto` no longer mutates inputs, two type renames). `deepmerge-ts` is a deep transitive dependency only — VO's own code never imports it. Owner's decision, 2026-10-19: narrow waiver over the major, pending upstream. | 2026-10-19 | **When `@prisma/config` itself moves to `deepmerge-ts@>=8.0.0`** (check `pnpm why deepmerge-ts` after any Prisma bump), or if a `7.x` patch ships in the meantime — whichever happens first. Not a fixed calendar date: this one resolves itself the moment the Prisma dependency chain moves, which a routine Prisma upgrade could do without anyone deliberately revisiting this entry, so check `pnpm why deepmerge-ts` on every Prisma bump regardless of whether this doc gets touched. |

**Re-check procedure:** before extending or removing an entry, re-run `pnpm audit --audit-level
high` against current `main` and `npm view <package> versions` for the waived package. If a
patched version now exists, remove the waiver and bump instead — a waiver that quietly outlives
its own fix is the same "guard never in force" gap a missing waiver would be, just in the other
direction.
