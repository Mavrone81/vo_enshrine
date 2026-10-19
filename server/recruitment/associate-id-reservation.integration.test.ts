// The associate code is reserved at SIGNING so it can be printed into the
// agreement, and consumed unchanged at approval.
//
// 🔴 WHY THIS FILE IS AN INTEGRATION TEST AND COULD NOT BE A UNIT TEST. The
// property that matters most here is that two concurrent submissions cannot
// receive the same code, and nothing in the application code guarantees that:
// nextAssociateCode is a read-then-compute with no lock, so both callers DO
// propose the same number. What prevents the duplicate is the unique index on
// candidates.reserved_associate_code — a database object. A mocked client has no
// index, so it would report whatever the mock chose to report and prove nothing
// about the only mechanism actually doing the work. These tests therefore run
// against a real Postgres, with real concurrency, and no vi.mock("@/lib/db").
//
// Requires poppler-utils (pdftotext) for the box-scoped read of page 7.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { randomUUID } from "crypto";

// approveCandidate goes through requireAdmin(), so the session has to be real
// for that half of the test; submitOnboarding is token-authenticated and needs
// none. One settable mock covers both.
const who: { session: unknown } = { session: null };
vi.mock("@/auth", () => ({ auth: async () => who.session }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// approveCandidate's baseUrl() calls next/headers() when AUTH_URL is unset, which
// throws outside a request scope. Same stub the other approveCandidate tests use.
vi.mock("next/headers", () => ({ headers: async () => new Map() }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => {}), onboardingInviteEmail: vi.fn(), approvalEmail: vi.fn() }));

import { prisma } from "@/lib/db";
import { getObject } from "@/lib/storage";
import { AGREEMENT_FIELD_BOXES } from "@/lib/pdf/associate-agreement-coordinates";
import { SEQ_RE, nextAssociateCode, reserveAssociateCodeForCandidate } from "@/lib/associate-code";

const TAG = "RESV-";
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const submission = {
  fullName: "Jane Tan",
  commencementDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  nric: "S1234567A",
  paymentMethod: "PayNow" as const,
  agreementAccepted: true,
  nationality: "Singaporean", gender: "Male" as const, religion: "Buddhism",
  signature: `data:image/png;base64,${TINY_PNG.toString("base64")}`,
  spouseConflict: false,
};

let submitOnboarding: (token: string, s: unknown) => Promise<{ ok: boolean; error?: string }>;
let approveCandidate: (id: string) => Promise<{ ok: boolean; error?: string }>;

const candidateIds: string[] = [];
const associateIds: string[] = [];
let adminUserId = "";

/** Box-scoped read of what is actually printed in a field's own row on its own
 *  page — from the rendered PDF, never from what we asked to stamp. */
function textInBox(bytes: Buffer, box: { page: number; x: number; y: number; width: number; height: number }): string {
  const dir = mkdtempSync(join(tmpdir(), "resv-"));
  const file = join(dir, "a.pdf");
  let xml: string;
  try {
    writeFileSync(file, bytes);
    xml = execFileSync("pdftotext", ["-bbox", "-f", String(box.page), "-l", String(box.page), file, "-"], { encoding: "utf8" });
  } finally {
    rmSync(dirname(file), { recursive: true, force: true });
  }
  const tol = 1;
  const out: string[] = [];
  const re = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const [xMin, yMin, xMax, yMax] = [+m[1], +m[2], +m[3], +m[4]];
    if (yMin >= box.y - tol && yMax <= box.y + box.height + tol && xMin >= box.x - tol && xMax <= box.x + box.width + tol) {
      out.push(m[5]);
    }
  }
  return out.join(" ");
}

async function makeCandidate(label: string) {
  const c = await prisma.candidate.create({
    data: {
      fullName: `${TAG}${label}`, mobileNumber: "91234567",
      email: `${TAG.toLowerCase()}${label}-${randomUUID()}@example.invalid`,
      intendedDesignation: "SalesAssociate" as never,
      onboardingToken: randomUUID(),
      onboardingStage: "Invited" as never,
    },
  });
  candidateIds.push(c.id);
  return c;
}

const reservedOf = async (id: string) =>
  (await prisma.candidate.findUniqueOrThrow({ where: { id }, select: { reservedAssociateCode: true } })).reservedAssociateCode;

beforeAll(async () => {
  vi.resetModules();
  ({ submitOnboarding, approveCandidate } = (await import("./actions")) as never);
  adminUserId = (await prisma.user.create({
    data: { email: `${TAG.toLowerCase()}${Date.now()}@example.invalid`, passwordHash: "not-a-real-hash", role: "Admin" as never },
    select: { id: true },
  })).id;
}, 120_000);

afterAll(async () => {
  if (candidateIds.length) await prisma.candidate.deleteMany({ where: { id: { in: candidateIds } } });
  if (associateIds.length) await prisma.associate.deleteMany({ where: { id: { in: associateIds } } });
  if (adminUserId) await prisma.user.deleteMany({ where: { id: adminUserId } });
  await prisma.companySignatory.deleteMany({});
});

describe("the reserved code reaches the signed document and the associate record", () => {
  it("prints the reserved code in the official-use box, and approval reuses that exact code (1 document, 1 associate)", async () => {
    const c = await makeCandidate("match");
    expect(await reservedOf(c.id)).toBeNull(); // nothing reserved before signing

    expect((await submitOnboarding(c.onboardingToken, submission)).ok).toBe(true);

    const reserved = await reservedOf(c.id);
    expect(reserved).toMatch(SEQ_RE);

    // What the DOCUMENT says, read out of its own box on page 7 — not what we
    // asked to stamp, and not merely "appears somewhere in the file".
    const row = await prisma.candidate.findUniqueOrThrow({ where: { id: c.id } });
    const pdf = await getObject(row.signedAgreementFileKey!);
    expect(pdf).not.toBeNull();
    const printed = textInBox(pdf!, AGREEMENT_FIELD_BOXES.associateIdOfficial).trim();
    expect(printed).toBe(reserved);

    // Approval must CONSUME that code, not allocate a second one.
    who.session = { user: { id: adminUserId, role: "Admin", associateId: null } };
    const approved = await approveCandidate(c.id);
    expect(approved.ok, `approval failed: ${approved.error}`).toBe(true);
    const after = await prisma.candidate.findUniqueOrThrow({
      where: { id: c.id },
      include: { convertedAssociate: { select: { id: true, associateCode: true } } },
    });
    associateIds.push(after.convertedAssociate!.id);
    expect(after.convertedAssociate!.associateCode).toBe(printed);
  }, 180_000);

  it("a candidate submitting twice does not allocate a second code (idempotent per candidate)", async () => {
    const c = await makeCandidate("twice");
    expect((await submitOnboarding(c.onboardingToken, submission)).ok).toBe(true);
    const first = await reservedOf(c.id);
    expect(first).toMatch(SEQ_RE);

    // Submitting again must reuse the reservation, whatever the submit path does
    // with the rest of the row.
    await submitOnboarding(c.onboardingToken, submission);
    expect(await reservedOf(c.id)).toBe(first);

    // And calling the reservation directly is idempotent too, which is what the
    // concurrent case below relies on for the same-candidate race.
    expect(await reserveAssociateCodeForCandidate(c.id)).toBe(first);
  }, 180_000);
});

describe("concurrency, against a real Postgres", () => {
  it("8 simultaneous submissions receive 8 DISTINCT codes", async () => {
    const N = 8;
    const cs = await Promise.all(Array.from({ length: N }, (_, i) => makeCandidate(`conc${i}`)));
    expect(cs).toHaveLength(N);

    // Genuinely simultaneous: all submissions in flight at once, no awaiting
    // between them. This is the case the application code cannot survive alone.
    const results = await Promise.all(cs.map((c) => submitOnboarding(c.onboardingToken, submission)));
    expect(results.filter((r) => r.ok)).toHaveLength(N);

    const codes = await Promise.all(cs.map((c) => reservedOf(c.id)));
    expect(codes).toHaveLength(N);
    expect(codes.every((c) => c !== null && SEQ_RE.test(c))).toBe(true);
    // The whole point: N candidates, N different numbers.
    expect(new Set(codes).size).toBe(N);
  }, 300_000);

  it("8 simultaneous direct reservations also receive 8 distinct codes", async () => {
    const N = 8;
    const cs = await Promise.all(Array.from({ length: N }, (_, i) => makeCandidate(`draw${i}`)));
    const codes = await Promise.all(cs.map((c) => reserveAssociateCodeForCandidate(c.id)));
    expect(codes).toHaveLength(N);
    expect(new Set(codes).size).toBe(N);
    // Persisted, not just returned.
    const stored = await Promise.all(cs.map((c) => reservedOf(c.id)));
    expect(new Set(stored).size).toBe(N);
    expect([...stored].sort()).toEqual([...codes].sort());
  }, 300_000);

  it("the unique index — the thing that actually prevents the duplicate — is present and bites", async () => {
    // 🔴 The design rests on this constraint, so assert the constraint itself
    // rather than trusting the schema file. Without it, two candidates could
    // both reserve one number and both sign immutable PDFs printing it.
    const a = await makeCandidate("uniqA");
    const b = await makeCandidate("uniqB");
    const code = await reserveAssociateCodeForCandidate(a.id);

    await expect(
      prisma.candidate.update({ where: { id: b.id }, data: { reservedAssociateCode: code } }),
    ).rejects.toMatchObject({ code: "P2002" });

    expect(await reservedOf(b.id)).toBeNull(); // the loser holds nothing
    expect(await reservedOf(a.id)).toBe(code);
  }, 180_000);

  it("a reserved code is not reissued by the next allocation, even with no associate holding it", async () => {
    // Finding-3 property at the database level: the high-water mark spans both
    // the associate table and reserved candidate codes.
    const c = await makeCandidate("highwater");
    const reserved = await reserveAssociateCodeForCandidate(c.id);
    const next = await nextAssociateCode();
    expect(next).not.toBe(reserved);
    const num = (s: string) => parseInt(s.slice(2), 10);
    expect(num(next)).toBeGreaterThan(num(reserved));
  }, 180_000);
});
