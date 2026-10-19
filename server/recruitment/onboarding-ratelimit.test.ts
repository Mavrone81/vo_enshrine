import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, putObjectMock, rateLimitMock } = vi.hoisted(() => {
  return {
    prismaMock: {
      candidate: {
        findUnique: vi.fn(),
        update: vi.fn(),
        // The associate code is reserved at signing (lib/associate-code.ts):
        // one scoped read for the high-water mark, one conditional write.
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      associate: {
        findUnique: vi.fn(),
        findMany: vi.fn(async () => []),
      },
      companySignatory: {
        findUnique: vi.fn(),
      },
    },
    putObjectMock: vi.fn(),
    rateLimitMock: {
      checkRateLimit: vi.fn(),
      recordFailure: vi.fn(),
      recordSuccess: vi.fn(),
    },
  };
});

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/rate-limit", () => rateLimitMock);
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/storage", () => ({
  putObject: putObjectMock,
  getObject: vi.fn(),
}));
vi.mock("@/lib/pdf/agreement", () => ({
  renderAgreementPdf: vi.fn(async () => Buffer.from("pdf")),
  formatUplineOrNA: (u: { fullName: string; associateCode: string } | null | undefined) => (u ? `${u.fullName} (${u.associateCode})` : "NA"),
}));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(), onboardingInviteEmail: vi.fn(), approvalEmail: vi.fn() }));

import { submitOnboarding } from "./actions";

const validSubmission = {
  fullName: "Jane Tan",
  commencementDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  nric: "S1234567A",
  paymentMethod: "PayNow" as const,
  agreementAccepted: true,
  nationality: "Singaporean", gender: "Male" as const, religion: "Buddhism",
  signature: "data:image/png;base64,iVBORw0KGgo=",
  spouseConflict: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitMock.checkRateLimit.mockResolvedValue({ allowed: true });
  prismaMock.candidate.findUnique.mockResolvedValue({
    id: "c1",
    onboardingStage: "Invited",
    photoFileKey: null,
    signedAgreementFileKey: null,
    intendedDirectUplineId: null,
    intendedDesignation: "SalesAssociate",
    fullName: "Jane Tan",
    email: "jane@example.com",
    mobileNumber: "91234567",
    intendedTeam: null,
  });
  prismaMock.companySignatory.findUnique.mockResolvedValue(null);
  putObjectMock.mockResolvedValue(undefined);
});

describe("submitOnboarding rate limiting", () => {
  it("returns tooManyAttempts and never looks up or writes the candidate once blocked", async () => {
    rateLimitMock.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSec: 900 });

    const r = await submitOnboarding("tok123", validSubmission);

    expect(r).toEqual({ ok: false, error: "tooManyAttempts" });
    expect(prismaMock.candidate.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.candidate.update).not.toHaveBeenCalled();
    expect(putObjectMock).not.toHaveBeenCalled();
  });

  it("checks the rate limit keyed by the onboarding token", async () => {
    await submitOnboarding("tok-abc", validSubmission);

    expect(rateLimitMock.checkRateLimit).toHaveBeenCalledWith("tok-abc", "onboard_submit");
  });

  it("records a failure keyed by the token when the candidate lookup misses", async () => {
    prismaMock.candidate.findUnique.mockResolvedValue(null);

    const r = await submitOnboarding("tok-missing", validSubmission);

    expect(r).toEqual({ ok: false, error: "invalidOrExpiredLink" });
    expect(rateLimitMock.recordFailure).toHaveBeenCalledWith("tok-missing", "onboard_submit");
  });

  it("records a failure keyed by the token when validation fails", async () => {
    const malformed = {
      fullName: "Jane Tan",
      commencementDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      nric: "S1234567A",
      paymentMethod: "Crypto",
      agreementAccepted: true,
      nationality: "Singaporean", gender: "Male", religion: "Buddhism",
      // Every required field present, so paymentMethod is the ONLY defect (otherwise the
      // missing spouseConflict would be what fails, and this would pass for the wrong reason).
      spouseConflict: false,
      signature: "data:image/png;base64,iVBORw0KGgo=",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately malformed input
    } as any;

    const r = await submitOnboarding("tok-bad-input", malformed);

    expect(r).toEqual({ ok: false, error: "invalidInput" });
    expect(rateLimitMock.recordFailure).toHaveBeenCalledWith("tok-bad-input", "onboard_submit");
  });

  it("does not record a failure on a successful submission", async () => {
    prismaMock.candidate.update.mockResolvedValue({});

    const r = await submitOnboarding("tok-ok", validSubmission);

    expect(r).toEqual({ ok: true });
    expect(rateLimitMock.recordFailure).not.toHaveBeenCalled();
  });
});
