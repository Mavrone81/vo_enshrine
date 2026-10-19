// CR-0001: the company signatory + signature must be captured AT SIGNING
// (server/recruitment/actions.ts, the same prisma.candidate.update write
// that sets signedAgreementFileKey) and never re-read afterward — otherwise
// re-rendering/re-viewing an old agreement would silently restate history
// if the admin Company Data tab later changes the signatory.
//
// Two things have to be true at once, or this test passes against code that
// never reads CompanySignatory at all:
//   1. An ALREADY-signed candidate keeps its ORIGINAL signatory after the
//      table changes (the actual acceptance criterion).
//   2. A FRESH signing, done AFTER the change, picks up the NEW value (the
//      control — proves the code path really reads CompanySignatory, rather
//      than e.g. always writing null or a hardcoded value that happens to
//      equal the original by coincidence).
// Also covers the copy-through at approveCandidate: the snapshot on the
// resulting Associate must match the candidate's, not a fresh read.
// Real throwaway Postgres.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";

const who: { session: unknown } = { session: null };
vi.mock("@/auth", () => ({ auth: async () => who.session }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// approveCandidate's baseUrl() calls next/headers() when AUTH_URL isn't set
// (the production early-return path, correct behaviour — CI's .env.example
// has it commented out, unlike a local .env). Without this mock, headers()
// throws "called outside a request scope" here, since this test's own
// approvalEmail is mocked below and never reads the resulting link — so an
// empty baseUrl() is harmless to what this test actually asserts (DB
// columns, never the email mock's call arguments).
vi.mock("next/headers", () => ({ headers: async () => new Map() }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => {}), onboardingInviteEmail: vi.fn(), approvalEmail: vi.fn() }));

import { prisma } from "@/lib/db";

const TAG = "CR0001SNAP-";
// Real 1x1 transparent PNG — unlike the box-coverage/onboarding unit tests
// (which mock @/lib/pdf/agreement entirely), this test drives the real
// renderAgreementPdf, which decodes the signature image for real via pdf-lib.
const FAKE_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let submitOnboarding: (token: string, s: unknown) => Promise<{ ok: boolean; error?: string }>;
let approveCandidate: (id: string) => Promise<{ ok: boolean; error?: string; code?: string }>;

const validSubmission = {
  fullName: "Jane Tan",
  commencementDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  nric: "S1234567A",
  paymentMethod: "PayNow" as const,
  agreementAccepted: true,
  nationality: "Singaporean", gender: "Male" as const, religion: "Buddhism",
  signature: FAKE_PNG_DATA_URL,
  spouseConflict: false,
};

async function makeCandidate(email: string) {
  return prisma.candidate.create({
    data: {
      fullName: TAG + "Candidate", mobileNumber: "91234567", email,
      intendedDesignation: "SalesAssociate" as never,
      onboardingToken: randomUUID(),
      onboardingStage: "Invited" as never,
    },
  });
}

const candidateIds: string[] = [];
const associateIds: string[] = [];
let adminUserId = "";

beforeAll(async () => {
  // Start from a known, isolated state — delete any leftover row from a
  // previous failed run under this tag before creating the ORIGINAL row.
  await prisma.companySignatory.deleteMany({});
  adminUserId = (await prisma.user.create({
    data: { email: `${TAG.toLowerCase()}admin-${randomUUID()}@example.com`, passwordHash: "x", role: "Admin" as never },
    select: { id: true },
  })).id;
});

afterEach(async () => {
  who.session = null;
});

afterAll(async () => {
  await prisma.associate.deleteMany({ where: { id: { in: associateIds } } });
  await prisma.candidate.deleteMany({ where: { id: { in: candidateIds } } });
  await prisma.companySignatory.deleteMany({});
  await prisma.user.deleteMany({ where: { id: adminUserId } });
});

describe("CR-0001 — company signatory snapshot at signing", () => {
  it("freezes the signatory on an already-signed candidate, while a fresh signing after the change picks up the new value", async () => {
    vi.resetModules();
    ({ submitOnboarding, approveCandidate } = (await import("./actions")) as never);

    await prisma.companySignatory.create({
      data: { singleton: true, signatoryName: "Original Signatory", signatureFileKey: "companies/signatory/original.png" },
    });

    const c1 = await makeCandidate(`${TAG}1-${randomUUID()}@example.com`);
    candidateIds.push(c1.id);
    const signed1 = await submitOnboarding(c1.onboardingToken, validSubmission);
    expect(signed1).toEqual({ ok: true });

    const afterSign1 = await prisma.candidate.findUniqueOrThrow({ where: { id: c1.id } });
    expect(afterSign1.companySignatoryNameAtSigning).toBe("Original Signatory");
    expect(afterSign1.companySignatureFileKeyAtSigning).toBe("companies/signatory/original.png");

    // Simulate the admin Company Data tab changing the signatory.
    await prisma.companySignatory.update({
      where: { singleton: true },
      data: { signatoryName: "New Signatory", signatureFileKey: "companies/signatory/new.png" },
    });

    // Acceptance criterion: c1's already-signed snapshot must NOT drift.
    const c1AfterChange = await prisma.candidate.findUniqueOrThrow({ where: { id: c1.id } });
    expect(c1AfterChange.companySignatoryNameAtSigning).toBe("Original Signatory");
    expect(c1AfterChange.companySignatureFileKeyAtSigning).toBe("companies/signatory/original.png");

    // Control: a FRESH signing, now, must pick up the NEW value — proves the
    // code path actually reads CompanySignatory rather than e.g. leaving the
    // snapshot columns permanently null or copying some other fixed value.
    const c2 = await makeCandidate(`${TAG}2-${randomUUID()}@example.com`);
    candidateIds.push(c2.id);
    const signed2 = await submitOnboarding(c2.onboardingToken, validSubmission);
    expect(signed2).toEqual({ ok: true });
    const afterSign2 = await prisma.candidate.findUniqueOrThrow({ where: { id: c2.id } });
    expect(afterSign2.companySignatoryNameAtSigning).toBe("New Signatory");
    expect(afterSign2.companySignatureFileKeyAtSigning).toBe("companies/signatory/new.png");

    // Copy-through at approval: the Associate created from c1 must carry
    // c1's ORIGINAL snapshot, not a fresh read of (now-changed) CompanySignatory.
    who.session = { user: { id: adminUserId, role: "Admin", associateId: null } };
    const approved = await approveCandidate(c1.id);
    expect(approved.ok).toBe(true);
    const assoc = await prisma.associate.findFirst({ where: { associateCode: approved.code! } });
    expect(assoc).not.toBeNull();
    associateIds.push(assoc!.id);
    expect(assoc!.companySignatoryNameAtSigning).toBe("Original Signatory");
    expect(assoc!.companySignatureFileKeyAtSigning).toBe("companies/signatory/original.png");
  });

  it("captures null when no CompanySignatory row exists yet (not an error)", async () => {
    vi.resetModules();
    ({ submitOnboarding } = (await import("./actions")) as never);
    await prisma.companySignatory.deleteMany({});

    const c = await makeCandidate(`${TAG}3-${randomUUID()}@example.com`);
    candidateIds.push(c.id);
    const r = await submitOnboarding(c.onboardingToken, validSubmission);
    expect(r).toEqual({ ok: true });
    const after = await prisma.candidate.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.companySignatoryNameAtSigning).toBeNull();
    expect(after.companySignatureFileKeyAtSigning).toBeNull();
  });
});
