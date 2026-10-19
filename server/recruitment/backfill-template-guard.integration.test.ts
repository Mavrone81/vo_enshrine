// The template provenance guard, proven on the SCRIPT, against a real database
// and real stored objects — not on the decision function in isolation (that is
// lib/pdf/agreement-template-guard.test.ts).
//
// What this file has to establish that a unit test cannot:
//   1. the script actually consults the guard at all — a guard module nothing
//      imports is just a file;
//   2. a refusal happens BEFORE the first write, so "abort" means "refused to
//      start" and not "stopped halfway through overwriting signed documents".
//      Every refusal case below therefore asserts that the stored bytes of
//      EVERY fixture row are byte-identical afterwards, and that no .bak was
//      created — the only honest way to say "nothing was written";
//   3. the differential half: the same script, same fixtures, WRITES when the
//      provenance is good. Without that, a guard that refused unconditionally
//      (or a script that silently no-ops) would pass every refusal assertion.
//
// Row counts are asserted explicitly throughout, and the fixture set is pinned
// to exactly the rows the script will see. The backfill selects every candidate
// in the table with a signedAgreementFileKey, so a stray row from another test
// file would change what is under test; the count assertions turn that into a
// loud failure instead of a quiet one. A refusal test that ran over zero rows
// would otherwise pass while proving nothing at all.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHash, randomUUID } from "crypto";

vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => {}), onboardingInviteEmail: vi.fn(), approvalEmail: vi.fn() }));

import { prisma } from "@/lib/db";
import { getObject, putObject } from "@/lib/storage";
import { MASTER_TEMPLATE_SHA256 } from "@/lib/pdf/associate-agreement-coordinates";

const TAG = "TPLGUARD-";
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const validSubmission = {
  fullName: "Jane Tan",
  commencementDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  nric: "S1234567A",
  paymentMethod: "PayNow" as const,
  agreementAccepted: true,
  nationality: "Singaporean",
  gender: "Male" as const,
  religion: "Buddhism",
  signature: `data:image/png;base64,${TINY_PNG.toString("base64")}`,
  spouseConflict: false,
};

/** Obviously-fake 64-hex sha standing in for "some other master". Never a real digest. */
const FAKE_OTHER_SHA = "d".repeat(64);
const OVERRIDE_REASON = "test: explicit per-record override, authorised in-test";

const FIXTURE_COUNT = 3;
const candidateIds: string[] = [];
/** candidate id -> the signed PDF key(s) the backfill would rewrite for that row. */
const keysById = new Map<string, string[]>();

async function signedPayload(id: string): Promise<Record<string, unknown>> {
  const c = await prisma.candidate.findUniqueOrThrow({ where: { id } });
  return c.submittedPayload as Record<string, unknown>;
}

async function setPayload(id: string, payload: Record<string, unknown>) {
  await prisma.candidate.update({ where: { id }, data: { submittedPayload: payload as never } });
}

// Whether a write HAPPENED is measured with a sentinel, never by diffing one
// render against another. Re-rendering the same row from the same source data
// is deterministic, so "the bytes changed" is only incidentally true — it holds
// on the first pass (the original was rendered from a slightly different
// signedDate) and stops holding once a backfilled row is backfilled again.
// A test resting on that passes or fails according to how many times the suite
// has run before it, which is exactly the kind of accidental green this whole
// exercise is about. Writing a known non-PDF sentinel to the key first makes
// both directions decidable and order-independent: after a real write the
// sentinel is gone and a %PDF- header is in its place; after a refused run the
// sentinel is still there, byte for byte.
const SENTINEL = Buffer.from("SENTINEL-NOT-A-PDF-this-byte-string-must-be-replaced-by-a-real-write");
const SENTINEL_DIGEST = createHash("sha256").update(SENTINEL).digest("hex");

/** Overwrite every PDF key the backfill could touch with the sentinel. */
async function primeSentinel(): Promise<number> {
  let primed = 0;
  for (const [, keys] of keysById) {
    for (const key of keys) {
      await putObject(key, SENTINEL);
      primed++;
    }
  }
  return primed;
}

/** Digest every stored object the backfill could touch, so "no writes" is measurable. */
async function snapshotStoredBytes(): Promise<Map<string, string>> {
  const snap = new Map<string, string>();
  for (const [, keys] of keysById) {
    for (const key of keys) {
      const cur = await getObject(key);
      snap.set(key, cur ? createHash("sha256").update(cur).digest("hex") : "(absent)");
      const bak = await getObject(`${key}.pre-v2607.bak`);
      snap.set(`${key}.pre-v2607.bak`, bak ? createHash("sha256").update(bak).digest("hex") : "(absent)");
    }
  }
  return snap;
}

/**
 * Import a fresh copy of the script with a specific environment and run main().
 * WRITE/REASON are read at module scope, so they must be set before the import,
 * not before the call.
 */
async function runBackfill(env: Record<string, string | undefined>) {
  const keys = ["WRITE", "REASON", "OVERRIDE_TEMPLATE_GUARD_IDS", "OVERRIDE_TEMPLATE_GUARD_REASON"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    vi.resetModules();
    const mod = (await import("../../scripts/backfill-associate-agreements")) as { main: () => Promise<void> };
    return await mod.main();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const WRITE_ENV = { WRITE: "1", REASON: "test: template provenance guard" };

beforeAll(async () => {
  await prisma.companySignatory.deleteMany({});
  vi.resetModules();
  const { submitOnboarding } = (await import("@/server/recruitment/actions")) as {
    submitOnboarding: (token: string, s: unknown) => Promise<{ ok: boolean }>;
  };

  for (let i = 0; i < FIXTURE_COUNT; i++) {
    const c = await prisma.candidate.create({
      data: {
        fullName: `${TAG}Candidate ${i}`,
        mobileNumber: "91234567",
        email: `${TAG.toLowerCase()}${i}-${randomUUID()}@example.invalid`,
        intendedDesignation: "SalesAssociate" as never,
        onboardingToken: randomUUID(),
        onboardingStage: "Invited" as never,
      },
    });
    candidateIds.push(c.id);
    expect((await submitOnboarding(c.onboardingToken, validSubmission)).ok).toBe(true);
    const after = await prisma.candidate.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.signedAgreementFileKey).not.toBeNull();
    keysById.set(c.id, [after.signedAgreementFileKey!]);
  }
  expect(candidateIds).toHaveLength(FIXTURE_COUNT);
}, 120_000);

afterAll(async () => {
  await prisma.candidate.deleteMany({ where: { id: { in: candidateIds } } });
  await prisma.companySignatory.deleteMany({});
});

describe("backfill-associate-agreements — template provenance guard", () => {
  it("fixture precondition: the script sees exactly our rows, each recording the CURRENT master's sha", async () => {
    const signed = await prisma.candidate.findMany({
      where: { signedAgreementFileKey: { not: null } },
      select: { id: true, submittedPayload: true },
    });
    // Pins what is under test. The backfill's own query is table-wide, so this
    // is the row count every assertion in this file examines.
    expect(signed).toHaveLength(FIXTURE_COUNT);
    expect(signed.map((r) => r.id).sort()).toEqual([...candidateIds].sort());

    // submitOnboarding records the sha it stamped against — the mechanism this
    // guard reads, confirmed present rather than assumed.
    const shas = signed.map((r) => (r.submittedPayload as Record<string, unknown>).agreementTemplateSha256);
    expect(shas).toHaveLength(FIXTURE_COUNT);
    expect(shas.every((s) => s === MASTER_TEMPLATE_SHA256)).toBe(true);
  });

  it("stored sha matches the current master: PROCEEDS, and genuinely rewrites all 3 rows", async () => {
    // The differential half of this file. Without a case that WRITES, a guard
    // wired to refuse everything — or a script that silently stopped doing any
    // work at all — would satisfy every refusal assertion below.
    const before = await snapshotStoredBytes();
    expect(before.size).toBe(FIXTURE_COUNT * 2); // 3 PDFs + 3 backups

    // No backup exists yet: the fixture keys are per-run UUIDs, so this is the
    // first time anything has backed them up. That makes the .bak transition
    // below a deterministic witness that the write path really executed.
    const baksBefore = [...before].filter(([k]) => k.endsWith(".bak"));
    expect(baksBefore).toHaveLength(FIXTURE_COUNT);
    expect(baksBefore.every(([, v]) => v === "(absent)")).toBe(true);

    await expect(runBackfill(WRITE_ENV)).resolves.toBeUndefined();

    const after = await snapshotStoredBytes();
    let rewritten = 0;
    for (const [, keys] of keysById) {
      for (const key of keys) {
        // The pre-existing PDF was preserved as a backup — absent before, and
        // now byte-equal to what was stored before the run.
        expect(after.get(`${key}.pre-v2607.bak`)).not.toBe("(absent)");
        expect(after.get(`${key}.pre-v2607.bak`)).toBe(before.get(key));
        // And a real PDF is at the key afterwards.
        const cur = await getObject(key);
        expect(cur).not.toBeNull();
        expect(cur!.subarray(0, 5).toString("latin1")).toBe("%PDF-");
        rewritten++;
      }
    }
    expect(rewritten).toBe(FIXTURE_COUNT);
  }, 120_000);

  it("stored sha DIFFERS from the current master: REFUSES, with zero writes across all 3 rows", async () => {
    const target = candidateIds[0];
    const original = await signedPayload(target);
    await setPayload(target, { ...original, agreementTemplateSha256: FAKE_OTHER_SHA });

    expect(await primeSentinel()).toBe(FIXTURE_COUNT);
    const before = await snapshotStoredBytes();
    expect(before.size).toBe(FIXTURE_COUNT * 2);
    try {
      await expect(runBackfill(WRITE_ENV)).rejects.toThrow(/ABORTED with nothing written/);

      // The whole point of a pre-flight: the two GOOD rows were not rewritten
      // either. One bad row stops the run before any row is touched.
      const after = await snapshotStoredBytes();
      expect(after.size).toBe(before.size);
      let compared = 0;
      let stillSentinel = 0;
      for (const [key, digest] of before) {
        expect(after.get(key), `${key} must be untouched`).toBe(digest);
        compared++;
        if (!key.endsWith(".bak")) {
          // Unambiguous: the sentinel is still in place, so no PDF was written.
          expect(after.get(key)).toBe(SENTINEL_DIGEST);
          stillSentinel++;
        }
      }
      expect(compared).toBe(FIXTURE_COUNT * 2);
      expect(stillSentinel).toBe(FIXTURE_COUNT);
    } finally {
      await setPayload(target, original);
    }
  }, 120_000);

  it("NO stored sha at all: REFUSES — absent means 'signed against an older master', never 'proceed'", async () => {
    // 🔴 The case that matters. Every row signed before the Oct swap looks like
    // this, because the sha was introduced by the swap commit itself. If absent
    // were read as "unknown, proceed", the guard would wave through precisely
    // the rows it exists to stop.
    const target = candidateIds[1];
    const original = await signedPayload(target);
    const withoutSha = { ...original };
    delete withoutSha.agreementTemplateSha256;
    expect("agreementTemplateSha256" in withoutSha).toBe(false);
    // Keep the version marker: it survived the swap unchanged, so on its own it
    // must not be mistaken for provenance.
    expect(withoutSha.agreementTemplateVersion).toBe("V.2026-04");
    await setPayload(target, withoutSha);

    expect(await primeSentinel()).toBe(FIXTURE_COUNT);
    const before = await snapshotStoredBytes();
    expect(before.size).toBe(FIXTURE_COUNT * 2);
    try {
      await expect(runBackfill(WRITE_ENV)).rejects.toThrow(/ABORTED with nothing written[\s\S]*1 absent/);

      const after = await snapshotStoredBytes();
      let compared = 0;
      let stillSentinel = 0;
      for (const [key, digest] of before) {
        expect(after.get(key), `${key} must be untouched`).toBe(digest);
        compared++;
        if (!key.endsWith(".bak")) {
          expect(after.get(key)).toBe(SENTINEL_DIGEST);
          stillSentinel++;
        }
      }
      expect(compared).toBe(FIXTURE_COUNT * 2);
      expect(stillSentinel).toBe(FIXTURE_COUNT);
    } finally {
      await setPayload(target, original);
    }
  }, 120_000);

  it("dry run refuses identically — a preview must not disagree with the write run it previews", async () => {
    const target = candidateIds[1];
    const original = await signedPayload(target);
    const withoutSha = { ...original };
    delete withoutSha.agreementTemplateSha256;
    await setPayload(target, withoutSha);
    try {
      await expect(runBackfill({})).rejects.toThrow(/ABORTED with nothing written/);
    } finally {
      await setPayload(target, original);
    }
  }, 120_000);

  it("override: the NAMED row proceeds; naming a different row does not rescue the refused one", async () => {
    const target = candidateIds[2];
    const other = candidateIds[0];
    const original = await signedPayload(target);
    const withoutSha = { ...original };
    delete withoutSha.agreementTemplateSha256;
    await setPayload(target, withoutSha);
    expect(await primeSentinel()).toBe(FIXTURE_COUNT);

    try {
      // Per-record, not a mode: an override naming `other` leaves `target` refused.
      await expect(
        runBackfill({
          ...WRITE_ENV,
          OVERRIDE_TEMPLATE_GUARD_IDS: other,
          OVERRIDE_TEMPLATE_GUARD_REASON: OVERRIDE_REASON,
        }),
      ).rejects.toThrow(/ABORTED with nothing written/);

      // Ids without a reason is a configuration error, not a quiet override.
      await expect(
        runBackfill({ ...WRITE_ENV, OVERRIDE_TEMPLATE_GUARD_IDS: target }),
      ).rejects.toThrow(/OVERRIDE_TEMPLATE_GUARD_REASON/);

      // There is no "all rows" syntax.
      await expect(
        runBackfill({ ...WRITE_ENV, OVERRIDE_TEMPLATE_GUARD_IDS: "*", OVERRIDE_TEMPLATE_GUARD_REASON: OVERRIDE_REASON }),
      ).rejects.toThrow(/not a candidate id/);

      // Nothing was written by any of the three refused attempts above: the
      // sentinel primed before them is still in place on every row.
      const afterRefused = await snapshotStoredBytes();
      let untouched = 0;
      for (const [key, digest] of afterRefused) {
        if (key.endsWith(".bak")) continue;
        expect(digest, `${key} must still hold the sentinel`).toBe(SENTINEL_DIGEST);
        untouched++;
      }
      expect(untouched).toBe(FIXTURE_COUNT);

      // Naming the row itself, with a reason, lets the run through.
      await expect(
        runBackfill({
          ...WRITE_ENV,
          OVERRIDE_TEMPLATE_GUARD_IDS: target,
          OVERRIDE_TEMPLATE_GUARD_REASON: OVERRIDE_REASON,
        }),
      ).resolves.toBeUndefined();

      // The sentinel is gone and a real PDF replaced it, on every row.
      let rewritten = 0;
      for (const [, keys] of keysById) {
        for (const key of keys) {
          const cur = await getObject(key);
          expect(cur).not.toBeNull();
          expect(createHash("sha256").update(cur!).digest("hex")).not.toBe(SENTINEL_DIGEST);
          expect(cur!.subarray(0, 5).toString("latin1")).toBe("%PDF-");
          rewritten++;
        }
      }
      expect(rewritten).toBe(FIXTURE_COUNT);
    } finally {
      await setPayload(target, original);
    }
  }, 120_000);
});
