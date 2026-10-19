// CR-0001: the backfill script (scripts/backfill-associate-agreements.ts)
// re-renders PAST signings from source data. It must read the row's OWN
// companySignatoryNameAtSigning/companySignatureFileKeyAtSigning snapshot,
// never a live CompanySignatory read — otherwise re-running it would
// silently restamp an already-signed agreement with whoever the CURRENT
// signatory happens to be, rewriting history on a signed document (the same
// failure class the owner ruled against for sale prices, arriving
// independently here).
//
// The diff reads correct either way (a live read and a snapshot read look
// identical until the signatory actually changes between signing and a
// later backfill run), so this asserts the REGENERATED, RE-STORED PDF's own
// text — not the source data the script was handed — with a differential
// control proving the backfill is sensitive to which signatory it's fed at
// all, so "it always prints the same text" can't pass as a false positive.
import { describe, it, expect, afterAll, vi } from "vitest";
import { execFileSync } from "child_process";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => {}), onboardingInviteEmail: vi.fn(), approvalEmail: vi.fn() }));

import { prisma } from "@/lib/db";
import { putObject, getObject } from "@/lib/storage";

const TAG = "CR0001BACKFILL-";
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
  nationality: "Singaporean", gender: "Male" as const, religion: "Buddhism",
  signature: `data:image/png;base64,${TINY_PNG.toString("base64")}`,
  spouseConflict: false,
};

// Local pdftotext helpers — tracked + cleaned up in a finally, per tonight's
// tmpfs-hotfix convention (this file would otherwise be a fresh instance of
// the exact leak class fixed everywhere else tonight).
function pdfText(bytes: Buffer, page: number): string {
  const dir = mkdtempSync(join(tmpdir(), "cr0001-backfill-test-"));
  try {
    const file = join(dir, "out.pdf");
    writeFileSync(file, bytes);
    return execFileSync("pdftotext", ["-f", String(page), "-l", String(page), file, "-"], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

afterAll(async () => {
  await prisma.candidate.deleteMany({ where: { id: { in: candidateIds } } });
  await prisma.companySignatory.deleteMany({});
});

describe("backfill-associate-agreements — snapshot, never live, on re-render", () => {
  it("re-running the backfill after the signatory changes leaves an already-signed agreement showing the ORIGINAL signatory — proven on the regenerated document's own text, with a control proving the backfill is sensitive to the signatory at all", async () => {
    await prisma.companySignatory.deleteMany({});
    vi.resetModules();
    const { submitOnboarding } = (await import("@/server/recruitment/actions")) as {
      submitOnboarding: (token: string, s: unknown) => Promise<{ ok: boolean }>;
    };

    // Signatory ALPHA, with a real stored signature object.
    await putObject("companies/signatory/alpha.png", TINY_PNG);
    await prisma.companySignatory.create({
      data: { singleton: true, signatoryName: "Backfill Signatory Alpha", signatureFileKey: "companies/signatory/alpha.png" },
    });
    const c1 = await makeCandidate(`${TAG}alpha-${randomUUID()}@example.com`);
    candidateIds.push(c1.id);
    expect((await submitOnboarding(c1.onboardingToken, validSubmission)).ok).toBe(true);
    const c1AfterSign = await prisma.candidate.findUniqueOrThrow({ where: { id: c1.id } });
    expect(c1AfterSign.companySignatoryNameAtSigning).toBe("Backfill Signatory Alpha"); // sanity: signed under Alpha

    // Snapshot the ORIGINAL rendered PDF's bytes before the backfill touches
    // anything, so "genuinely regenerates" can be measured, not assumed.
    const beforeBackfill = await getObject(c1AfterSign.signedAgreementFileKey!);
    expect(beforeBackfill).not.toBeNull();

    // Signatory changes to BETA — simulates an admin editing the Company
    // Data tab between the original signing and a later backfill run.
    await prisma.companySignatory.update({
      where: { singleton: true },
      data: { signatoryName: "Backfill Signatory Beta", signatureFileKey: "companies/signatory/beta.png" },
    });
    await putObject("companies/signatory/beta.png", TINY_PNG);

    // CONTROL (the differential half, not just "A appears"): a FRESH
    // candidate, signed NOW, after the change — this one's snapshot really
    // is Beta, and the backfill (re-rendering it from its OWN current-at-
    // signing snapshot) must show Beta. Without this, a backfill that always
    // stamped a fixed/cached name regardless of input would still pass the
    // "still shows Alpha" assertion below.
    const c2 = await makeCandidate(`${TAG}beta-${randomUUID()}@example.com`);
    candidateIds.push(c2.id);
    expect((await submitOnboarding(c2.onboardingToken, validSubmission)).ok).toBe(true);
    const c2AfterSign = await prisma.candidate.findUniqueOrThrow({ where: { id: c2.id } });
    expect(c2AfterSign.companySignatoryNameAtSigning).toBe("Backfill Signatory Beta");

    // Run the backfill for real, against BOTH candidates at once — the
    // actual scenario: one old signing (c1, under Alpha) and one new one
    // (c2, under Beta), backfilled in the same pass.
    vi.resetModules();
    process.env.WRITE = "1";
    process.env.REASON = "test: CR-0001 snapshot regression";
    const { main: runBackfill } = (await import("../../scripts/backfill-associate-agreements")) as { main: () => Promise<void> };
    await runBackfill();
    delete process.env.WRITE;
    delete process.env.REASON;

    const afterBackfill = await getObject(c1AfterSign.signedAgreementFileKey!);
    expect(afterBackfill).not.toBeNull();
    // Control: the backfill genuinely regenerated the file — a no-op backfill
    // (e.g. a bug that skips writing) would leave the old bytes in place,
    // which would make the assertions below pass for the wrong reason (the
    // ORIGINAL render already said Alpha).
    expect(afterBackfill!.equals(beforeBackfill!)).toBe(false);

    const c1Text = pdfText(afterBackfill!, 7);
    expect(c1Text).toContain("Backfill Signatory Alpha");
    expect(c1Text).not.toContain("Backfill Signatory Beta");

    // The differential control itself: c2's OWN regenerated document, from
    // the SAME backfill pass, shows Beta — proving the backfill script
    // really is sensitive to which signatory a row's snapshot names, not
    // printing a fixed value that happened to match Alpha above by luck.
    const c2Pdf = await getObject(c2AfterSign.signedAgreementFileKey!);
    const c2Text = pdfText(c2Pdf!, 7);
    expect(c2Text).toContain("Backfill Signatory Beta");
    expect(c2Text).not.toContain("Backfill Signatory Alpha");
  }, 60_000);
});
