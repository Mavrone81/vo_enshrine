import { describe, it, expect, vi, beforeEach } from "vitest";

// Owner ruling 2026-10-17: resubmitting before approval keeps earlier
// answers. nric/bankAccountNumber are "kept unless changed": the candidate
// sees a MASK the server computed from the stored ciphertext
// (lib/onboarding-prefill.ts); sending that mask back unchanged keeps the
// prior ciphertext verbatim, sending a different value re-encrypts it.
// Mutation proof: removing the nricKept/bankKept branches in submitOnboarding
// (server/recruitment/actions.ts) would re-encrypt the mask text itself as
// if it were the real NRIC, corrupting the stored value — the "preserves
// ciphertext" tests below catch that; the "triggers re-encryption" tests
// catch the opposite mistake (always keeping, never re-encrypting a real edit).

const { prismaMock, putObjectMock } = vi.hoisted(() => ({
  prismaMock: {
    candidate: {
      findUnique: vi.fn(),
      // Bare vi.fn() (not vi.fn(async () => ...)) — a zero-arg implementation
      // narrows the mock's inferred call-arg type to an empty tuple, which
      // breaks .mock.calls[0][0].data below. mockResolvedValue in beforeEach
      // supplies the return value instead.
      update: vi.fn(),
      // The associate code is reserved at signing (lib/associate-code.ts):
      // one scoped read for the high-water mark, one conditional write.
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    associate: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    companySignatory: { findUnique: vi.fn(async () => null) },
  },
  putObjectMock: vi.fn(async () => undefined),
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })), recordFailure: vi.fn(), recordSuccess: vi.fn() }));
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/storage", () => ({ putObject: putObjectMock, getObject: vi.fn() }));
vi.mock("@/lib/pdf/agreement", () => ({
  renderAgreementPdf: vi.fn(async () => Buffer.from("pdf")),
  formatUplineOrNA: () => "NA",
}));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(), onboardingInviteEmail: vi.fn(), approvalEmail: vi.fn() }));

import { submitOnboarding } from "./actions";
import { encryptPII, decryptPiiRaw, maskNric, maskAccount } from "@/lib/crypto";
import { buildOnboardingPrefill } from "@/lib/onboarding-prefill";

const REAL_NRIC = "S1234567A";
const REAL_BANK_ACCOUNT = "000123456789";
const VALID_COMMENCEMENT_DATE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function baseSubmission(overrides: Record<string, unknown> = {}) {
  return {
    fullName: "Jane Tan",
    commencementDate: VALID_COMMENCEMENT_DATE,
    nric: REAL_NRIC,
    paymentMethod: "Bank Transfer" as const,
    bankName: "DBS",
    bankAccountNumber: REAL_BANK_ACCOUNT,
    agreementAccepted: true,
    nationality: "Singaporean",
    gender: "Male" as const,
    religion: "Buddhism",
    spouseConflict: false,
    signature: "data:image/png;base64,iVBORw0KGgo=",
    ...overrides,
  };
}

function priorCandidateRow() {
  return {
    id: "c1",
    fullName: "Jane Tan",
    email: "jane@example.com",
    mobileNumber: "91234567",
    onboardingStage: "SignedPendingApproval",
    photoFileKey: null,
    signedAgreementFileKey: "candidates/c1/signed-agreement.pdf",
    intendedDirectUplineId: null,
    intendedDesignation: "SalesAssociate",
    intendedTeam: null,
    commencementDate: new Date(VALID_COMMENCEMENT_DATE),
    submittedPayload: {
      nric: encryptPII(REAL_NRIC),
      bankAccountNumber: encryptPII(REAL_BANK_ACCOUNT),
      paymentMethod: "Bank Transfer",
      bankName: "DBS",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.candidate.update.mockResolvedValue({});
  prismaMock.companySignatory.findUnique.mockResolvedValue(null);
  putObjectMock.mockResolvedValue(undefined);
});

describe("submitOnboarding — resubmission keeps the prior ciphertext unless changed", () => {
  it("preserves the prior nric ciphertext verbatim when the submitted value is the server's own mask", async () => {
    const prior = priorCandidateRow();
    prismaMock.candidate.findUnique.mockResolvedValue(prior);
    const priorNricMask = maskNric(decryptPiiRaw(prior.submittedPayload.nric));

    const r = await submitOnboarding("tok123", baseSubmission({ nric: priorNricMask }));

    expect(r).toEqual({ ok: true });
    const data = prismaMock.candidate.update.mock.calls[0][0].data;
    expect(data.submittedPayload.nric).toBe(prior.submittedPayload.nric); // byte-identical ciphertext, not re-encrypted
  });

  it("re-encrypts when the candidate types a genuinely new nric", async () => {
    const prior = priorCandidateRow();
    prismaMock.candidate.findUnique.mockResolvedValue(prior);
    const NEW_NRIC = "T9876543Z";

    const r = await submitOnboarding("tok123", baseSubmission({ nric: NEW_NRIC }));

    expect(r).toEqual({ ok: true });
    const data = prismaMock.candidate.update.mock.calls[0][0].data;
    expect(data.submittedPayload.nric).not.toBe(prior.submittedPayload.nric);
    expect(decryptPiiRaw(data.submittedPayload.nric)).toBe(NEW_NRIC);
  });

  it("preserves the prior bankAccountNumber ciphertext verbatim when the submitted value is the server's own mask", async () => {
    const prior = priorCandidateRow();
    prismaMock.candidate.findUnique.mockResolvedValue(prior);
    const priorBankMask = maskAccount(decryptPiiRaw(prior.submittedPayload.bankAccountNumber));

    const r = await submitOnboarding("tok123", baseSubmission({ bankAccountNumber: priorBankMask }));

    expect(r).toEqual({ ok: true });
    const data = prismaMock.candidate.update.mock.calls[0][0].data;
    expect(data.submittedPayload.bankAccountNumber).toBe(prior.submittedPayload.bankAccountNumber);
  });

  it("re-encrypts when the candidate types a genuinely new bankAccountNumber", async () => {
    const prior = priorCandidateRow();
    prismaMock.candidate.findUnique.mockResolvedValue(prior);
    const NEW_ACCOUNT = "999988887777";

    const r = await submitOnboarding("tok123", baseSubmission({ bankAccountNumber: NEW_ACCOUNT }));

    expect(r).toEqual({ ok: true });
    const data = prismaMock.candidate.update.mock.calls[0][0].data;
    expect(data.submittedPayload.bankAccountNumber).not.toBe(prior.submittedPayload.bankAccountNumber);
    expect(decryptPiiRaw(data.submittedPayload.bankAccountNumber)).toBe(NEW_ACCOUNT);
  });

  it("the page's own prefill mask is exactly what the kept-check compares against (round trip)", () => {
    const prior = priorCandidateRow();
    const prefill = buildOnboardingPrefill(prior);
    expect(prefill.nric).toBe(maskNric(REAL_NRIC));
    expect(prefill.bankAccountNumber).toBe(maskAccount(REAL_BANK_ACCOUNT));
  });

  it("persists the candidate's own chosen commencementDate, not the inviter's, on resubmission", async () => {
    const prior = priorCandidateRow();
    prior.commencementDate = new Date("2026-11-01"); // the inviter's/earlier choice
    prismaMock.candidate.findUnique.mockResolvedValue(prior);
    const candidateChosenDate = VALID_COMMENCEMENT_DATE;

    const r = await submitOnboarding("tok123", baseSubmission({ commencementDate: candidateChosenDate }));

    expect(r).toEqual({ ok: true });
    const data = prismaMock.candidate.update.mock.calls[0][0].data;
    expect(data.commencementDate).toEqual(new Date(candidateChosenDate));
  });
});
