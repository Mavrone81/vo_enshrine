// C-4: an existing-user candidate approval must file the signed agreement
// into the P-File, same as a new-user approval already does. Real throwaway
// Postgres; fake data only, cleaned up.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";

const who: { session: unknown } = { session: null };
vi.mock("@/auth", () => ({ auth: async () => who.session }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Map() }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => {}), onboardingInviteEmail: vi.fn(), approvalEmail: vi.fn() }));

import { prisma } from "@/lib/db";
import { submitOnboarding, approveCandidate } from "./actions";
import { uploadOfflineSignedAgreement } from "@/server/associates/actions";
import { putObject } from "@/lib/storage";

const TAG = "C4FILING-";
const FAKE_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
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
const ADMIN = { user: { associateId: null, id: "", role: "Admin" } };

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
const userIds: string[] = [];
let adminUserId = "";

beforeAll(async () => {
  adminUserId = (await prisma.user.create({
    data: { email: `${TAG.toLowerCase()}admin-${randomUUID()}@example.com`, passwordHash: "x", role: "Admin" as never },
  })).id;
  userIds.push(adminUserId);
  ADMIN.user.id = adminUserId;
});

afterEach(() => {
  who.session = null;
});

afterAll(async () => {
  await prisma.pFileDocument.deleteMany({ where: { pFile: { userId: { in: userIds } } } });
  await prisma.pFile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.associate.deleteMany({ where: { id: { in: associateIds } } });
  await prisma.candidate.deleteMany({ where: { id: { in: candidateIds } } });
});

describe("C-4: existing-user candidate approval files the agreement in the P-File", () => {
  it("files the signed agreement even when a User already exists for the candidate's email", async () => {
    const email = `${TAG.toLowerCase()}existing-${randomUUID()}@example.com`;
    // A User already exists under this email BEFORE approval — the exact
    // condition that skips P-File creation in the current code (the `if
    // (!existing)` branch around the login-provisioning block).
    const existingUser = await prisma.user.create({
      data: { email, passwordHash: "x", role: "SalesAssociate" as never },
    });
    userIds.push(existingUser.id);

    const c = await makeCandidate(email);
    candidateIds.push(c.id);
    who.session = { user: { associateId: c.id, id: "sess-candidate" } };
    expect((await submitOnboarding(c.onboardingToken, validSubmission)).ok).toBe(true);

    who.session = ADMIN;
    const approved = await approveCandidate(c.id);
    expect(approved.ok).toBe(true);
    const assoc = await prisma.associate.findFirstOrThrow({ where: { associateCode: approved.code! } });
    associateIds.push(assoc.id);
    expect(assoc.signedAgreementFileKey).not.toBeNull();

    // The deliverable: the agreement must appear in the EXISTING user's
    // P-File — not silently skipped because no new login was provisioned.
    const pFile = await prisma.pFile.findUnique({ where: { userId: existingUser.id }, include: { documents: true } });
    expect(pFile).not.toBeNull();
    expect(pFile!.documents.some((d) => d.docType === "SignedAssociateAgreement" && d.fileKey === assoc.signedAgreementFileKey)).toBe(true);
  });

  it("a new-user approval still files the agreement exactly once (no duplicate)", async () => {
    const email = `${TAG.toLowerCase()}newuser-${randomUUID()}@example.com`;
    const c = await makeCandidate(email);
    candidateIds.push(c.id);
    who.session = { user: { associateId: c.id, id: "sess-candidate" } };
    expect((await submitOnboarding(c.onboardingToken, validSubmission)).ok).toBe(true);

    who.session = ADMIN;
    const before = Date.now();
    const approved = await approveCandidate(c.id);
    const after = Date.now();
    expect(approved.ok).toBe(true);
    const assoc = await prisma.associate.findFirstOrThrow({ where: { associateCode: approved.code! } });
    associateIds.push(assoc.id);
    const newUser = await prisma.user.findUniqueOrThrow({ where: { email } });
    userIds.push(newUser.id);
    expect(newUser.mustResetPassword).toBe(true); // confirms this really was the new-login path, not a coincidental existing user

    // #29: the new login has no known password — entry is by set-password
    // link only, same single-use hashed-token mechanism as self-service
    // reset. Asserted against the actual stored row, not inferred from ok:true.
    expect(newUser.resetTokenHash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest
    const expiresAt = newUser.resetTokenExpiresAt!.getTime();
    const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(before + TWENTY_FOUR_H);
    expect(expiresAt).toBeLessThanOrEqual(after + TWENTY_FOUR_H);

    const pFile = await prisma.pFile.findUnique({ where: { userId: newUser.id }, include: { documents: true } });
    expect(pFile).not.toBeNull();
    const signedDocs = pFile!.documents.filter((d) => d.docType === "SignedAssociateAgreement");
    expect(signedDocs).toHaveLength(1);
    expect(signedDocs[0].fileKey).toBe(assoc.signedAgreementFileKey);
  });
});

describe("C-4: offline (paper-signed) agreement upload", () => {
  async function makeApprovedAssociateWithoutPortalSigning() {
    const email = `${TAG.toLowerCase()}offline-${randomUUID()}@example.com`;
    const user = await prisma.user.create({ data: { email, passwordHash: "x", role: "SalesAssociate" as never } });
    userIds.push(user.id);
    const assoc = await prisma.associate.create({
      data: {
        associateCode: TAG + randomUUID().slice(0, 8), fullName: TAG + "Offline", mobileNumber: "91234567", email,
        designation: "SalesAssociate" as never, approvalStatus: "Approved" as never, associateStatus: "Active" as never,
      },
    });
    associateIds.push(assoc.id);
    await prisma.user.update({ where: { id: user.id }, data: { associateId: assoc.id } });
    return assoc;
  }

  it("succeeds when no portal-signed agreement exists, and files it in the P-File", async () => {
    const assoc = await makeApprovedAssociateWithoutPortalSigning();
    who.session = ADMIN;
    const pdfBytes = Buffer.from("%PDF-1.4\ntest\n");
    const file = new File([pdfBytes], "signed.pdf", { type: "application/pdf" });
    const r = await uploadOfflineSignedAgreement(assoc.id, file);
    expect(r).toEqual({ ok: true });

    const after = await prisma.associate.findUniqueOrThrow({ where: { id: assoc.id } });
    expect(after.signedAgreementFileKey).not.toBeNull();
    const user = await prisma.user.findUniqueOrThrow({ where: { associateId: assoc.id } });
    const pFile = await prisma.pFile.findUnique({ where: { userId: user.id }, include: { documents: true } });
    expect(pFile!.documents.some((d) => d.docType === "SignedAssociateAgreement" && d.fileKey === after.signedAgreementFileKey)).toBe(true);
  });

  it("is refused when a portal-signed agreement already exists — never overwrites it", async () => {
    const assoc = await makeApprovedAssociateWithoutPortalSigning();
    const existingKey = `associates/${assoc.id}/signed-agreement.pdf`;
    await putObject(existingKey, Buffer.from("%PDF-1.4\noriginal\n"));
    await prisma.associate.update({ where: { id: assoc.id }, data: { signedAgreementFileKey: existingKey } });

    who.session = ADMIN;
    const file = new File([Buffer.from("%PDF-1.4\nreplacement\n")], "signed.pdf", { type: "application/pdf" });
    const r = await uploadOfflineSignedAgreement(assoc.id, file);
    expect(r).toEqual({ ok: false, error: "agreementAlreadyOnFile" });

    const after = await prisma.associate.findUniqueOrThrow({ where: { id: assoc.id } });
    expect(after.signedAgreementFileKey).toBe(existingKey); // unchanged — the portal-signed copy survives
  });
});

describe("C-4 (DevSecOps/PD review): concurrent offline uploads for the same associate are serialised", () => {
  it("a race between two concurrent uploads produces exactly one filed document, never two", async () => {
    const email = `${TAG.toLowerCase()}race-${randomUUID()}@example.com`;
    const user = await prisma.user.create({ data: { email, passwordHash: "x", role: "SalesAssociate" as never } });
    userIds.push(user.id);
    const assoc = await prisma.associate.create({
      data: {
        associateCode: TAG + randomUUID().slice(0, 8), fullName: TAG + "Race", mobileNumber: "91234567", email,
        designation: "SalesAssociate" as never, approvalStatus: "Approved" as never, associateStatus: "Active" as never,
      },
    });
    associateIds.push(assoc.id);
    await prisma.user.update({ where: { id: user.id }, data: { associateId: assoc.id } });

    who.session = ADMIN;
    const fileA = new File([Buffer.from("%PDF-1.4\nrace-a\n")], "a.pdf", { type: "application/pdf" });
    const fileB = new File([Buffer.from("%PDF-1.4\nrace-b\n")], "b.pdf", { type: "application/pdf" });
    const [ra, rb] = await Promise.all([
      uploadOfflineSignedAgreement(assoc.id, fileA),
      uploadOfflineSignedAgreement(assoc.id, fileB),
    ]);

    // Exactly one of the two genuinely concurrent calls wins; the other must
    // be refused by the SAME guard a sequential second call would hit — not
    // silently also succeed, which is the exact bug class the atomic CAS
    // (updateMany matched on signedAgreementFileKey: null) exists to close
    // (the pre-fix TOCTOU: both reads happen before either write). No
    // assertion on object/storage count here, deliberately — the loser's
    // putObject having already run before its rollback is the ADR-0001/N2-
    // accepted orphan outcome, not something this test should enshrine.
    const results = [ra, rb];
    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0]).toEqual({ ok: false, error: "agreementAlreadyOnFile" });

    const pFile = await prisma.pFile.findUniqueOrThrow({ where: { userId: user.id }, include: { documents: true } });
    const signedDocs = pFile.documents.filter((d) => d.docType === "SignedAssociateAgreement");
    expect(signedDocs).toHaveLength(1); // never two, regardless of which call won
  });
});
