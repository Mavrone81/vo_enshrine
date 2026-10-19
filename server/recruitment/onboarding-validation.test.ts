import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, putObjectMock, rateLimitMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shared mock is reused for both a throwing and a resolving case
  const throwOnTouch = (label: string) => vi.fn<(...args: any[]) => any>(() => { throw new Error(`${label} must not be touched on invalid input`); });
  return {
    prismaMock: {
      candidate: {
        findUnique: vi.fn(),
        update: throwOnTouch("Candidate write"),
        // Reserving the associate code (lib/associate-code.ts) is a conditional
        // write that DOES happen on the valid path, before the agreement is
        // rendered — so unlike `update` above it must not throw-on-touch. The
        // invalid-input cases never reach it, because validation rejects first;
        // the assertion that they allocate nothing is below.
        updateMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => []),
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
      checkRateLimit: vi.fn(async () => ({ allowed: true })),
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
import { renderAgreementPdf } from "@/lib/pdf/agreement";

beforeEach(() => {
  vi.clearAllMocks();
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
  putObjectMock.mockResolvedValue(undefined);
  prismaMock.companySignatory.findUnique.mockResolvedValue(null);
});

describe("submitOnboarding validation", () => {
  it("returns invalidInput and never writes to the DB or object storage for malformed input", async () => {
    // Otherwise well-formed submission (passes the pre-existing ad-hoc field
    // checks: nric present, agreementAccepted true, signature present) but
    // paymentMethod is outside the enum — only schema validation catches this.
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately malformed input, per Task 3 brief Step 1
    } as any;
    const r = await submitOnboarding("tok123", malformed);

    expect(r).toEqual({ ok: false, error: "invalidInput" });
    expect(prismaMock.candidate.update).not.toHaveBeenCalled();
    expect(putObjectMock).not.toHaveBeenCalled();
    // And no associate code is allocated. Codes are reserved at signing now, so
    // a rejected submission that still burned a number would leave a permanent
    // gap in the sequence for input that was never accepted. Gaps are tolerated
    // for abandoned candidates, not manufactured by validation failures.
    expect(prismaMock.candidate.updateMany).not.toHaveBeenCalled();
  });

  it("does not reject cleared optional fields sent as empty strings (form clears to '', not undefined)", async () => {
    prismaMock.candidate.update.mockResolvedValue({});
    const r = await submitOnboarding("tok123", {
      fullName: "Jane Tan",
      commencementDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      nric: "S1234567A",
      paymentMethod: "PayNow",
      agreementAccepted: true,
      nationality: "Singaporean", gender: "Male" as const, religion: "Buddhism",
      signature: "data:image/png;base64,iVBORw0KGgo=",
      dateOfBirth: "",
      bankAccountNumber: "",
      spouseConflict: false,
    });
    expect(r).toEqual({ ok: true });
  });

  // C-2 (owner ruling): spouseConflict is now required at final submit — an
  // otherwise well-formed submission that omits it must be refused with a
  // clear message (not just "not ok"), and must never reach the DB or
  // object storage, same as any other invalid-input refusal.
  it("refuses an otherwise well-formed submission that omits spouseConflict, with a clear message", async () => {
    const r = await submitOnboarding("tok123", {
      fullName: "Jane Tan",
      commencementDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      nric: "S1234567A",
      paymentMethod: "PayNow",
      agreementAccepted: true,
      nationality: "Singaporean", gender: "Male" as const, religion: "Buddhism",
      signature: "data:image/png;base64,iVBORw0KGgo=",
      // spouseConflict omitted — the thing under test.
    });
    expect(r).toEqual({ ok: false, error: "spouseConflictRequired" });
    expect(prismaMock.candidate.update).not.toHaveBeenCalled();
    expect(putObjectMock).not.toHaveBeenCalled();
  });

  // C-2: a declared conflict (Yes) must also name the spouse's designation,
  // not just their name and company — the field this ruling added.
  it("refuses a declared spouse conflict missing the spouse's designation", async () => {
    const r = await submitOnboarding("tok123", {
      fullName: "Jane Tan",
      commencementDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      nric: "S1234567A",
      paymentMethod: "PayNow",
      agreementAccepted: true,
      nationality: "Singaporean", gender: "Male" as const, religion: "Buddhism",
      signature: "data:image/png;base64,iVBORw0KGgo=",
      spouseConflict: true,
      spouseName: "Jamie Spouse",
      spouseCompany: "Spouse Co Pte Ltd",
      // spouseDesignation omitted — the thing under test.
    });
    expect(r).toEqual({ ok: false, error: "spouseDesignationRequired" });
    expect(prismaMock.candidate.update).not.toHaveBeenCalled();
    expect(putObjectMock).not.toHaveBeenCalled();
  });

  // Each missing required field gets ITS OWN code — never the bare "invalidInput"
  // that left a new associate with no way to tell what was wrong.
  const complete = {
    fullName: "Jane Tan",
    commencementDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    nric: "S1234567A", paymentMethod: "PayNow" as const, agreementAccepted: true,
    nationality: "Singaporean", gender: "Male" as const, religion: "Buddhism",
    spouseConflict: false, signature: "data:image/png;base64,iVBORw0KGgo=",
  };
  const cases: [string, Record<string, unknown>, string][] = [
    ["commencementDate", { commencementDate: "" }, "commencementDateRequired"],
    ["nric", { nric: "" }, "nricRequired"],
    ["nationality", { nationality: "  " }, "nationalityRequired"],
    ["gender", { gender: undefined }, "genderRequired"],
    ["religion", { religion: "" }, "religionRequired"],
    ["spouseConflict", { spouseConflict: undefined }, "spouseConflictRequired"],
    ["spouseName", { spouseConflict: true, spouseCompany: "B", spouseDesignation: "C" }, "spouseNameRequired"],
    ["spouseCompany", { spouseConflict: true, spouseName: "A", spouseDesignation: "C" }, "spouseCompanyRequired"],
    ["paymentMethod", { paymentMethod: undefined }, "paymentMethodRequired"],
  ];
  for (const [field, patch, code] of cases) {
    it(`names ${field} as the problem (${code})`, async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately incomplete input
      const r = await submitOnboarding("tok123", { ...complete, ...patch } as any);
      expect(r).toEqual({ ok: false, error: code });
      expect(prismaMock.candidate.update).not.toHaveBeenCalled();
    });
  }

  it("reports the FIRST missing field in document order when several are missing", async () => {
    // commencementDate is given (and valid) so this test isolates document
    // order among the fields it actually means to cover (nric ahead of
    // nationality/gender/etc) rather than trivially landing on fullName or commencementDate, which now sit
    // first in ONBOARDING_FIELD_ORDER (both supplied here).
    const incomplete = {
      fullName: "Jane Tan",
      commencementDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      nric: "", paymentMethod: "PayNow", agreementAccepted: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately incomplete input
    } as any;
    const r = await submitOnboarding("tok123", incomplete);
    expect(r).toEqual({ ok: false, error: "nricRequired" });
  });

  it("stays generic when every required field is present but the value is otherwise invalid", async () => {
    const r = await submitOnboarding("tok123", { ...complete, nric: "S".repeat(41) });
    expect(r).toEqual({ ok: false, error: "invalidInput" });
  });

  // A syntactically valid commencementDate outside today..+12-months is NOT a
  // missing field — it would otherwise fall through to the generic
  // "invalidInput" above, leaving the candidate with no idea why. Named
  // explicitly (owner ruling 2026-10-17).
  it("names an out-of-range commencementDate instead of the generic invalidInput", async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const r = await submitOnboarding("tok123", { ...complete, commencementDate: yesterday });
    expect(r).toEqual({ ok: false, error: "commencementDateOutOfRange" });
    expect(prismaMock.candidate.update).not.toHaveBeenCalled();
  });

  // Owner request 2026-10-19: the candidate fills their own "Full Name as per
  // NRIC" at onboarding, and THAT name — not the inviter-set name on the
  // candidate row — is what the agreement's "Name of Applicant" box carries and
  // what is persisted. Non-vacuous by a real decoy: the beforeEach candidate
  // mock is "Jane Tan", the submission below is "Tan Wei Ming", so a regression
  // to c.fullName would stamp/persist "Jane Tan" and fail here.
  it("stamps and persists the candidate's own submitted full name, not the inviter-set name", async () => {
    prismaMock.candidate.update.mockResolvedValue({});
    const r = await submitOnboarding("tok123", { ...complete, fullName: "Tan Wei Ming" });
    expect(r).toEqual({ ok: true });
    expect(vi.mocked(renderAgreementPdf)).toHaveBeenCalledWith(
      expect.objectContaining({ fullName: "Tan Wei Ming" }),
    );
    expect(prismaMock.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fullName: "Tan Wei Ming" }) }),
    );
  });
});
