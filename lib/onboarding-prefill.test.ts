import { describe, it, expect } from "vitest";
import { encryptPII } from "./crypto";
import { buildOnboardingPrefill } from "./onboarding-prefill";

const REAL_NRIC = "S1234567A";
const REAL_BANK_ACCOUNT = "000123456789";

describe("buildOnboardingPrefill", () => {
  it("prefills the inviter's commencementDate for an in-flight (not yet submitted) candidate", () => {
    const p = buildOnboardingPrefill({ commencementDate: new Date("2026-11-01T00:00:00.000Z"), fullName: "Jane Tan", submittedPayload: null });
    expect(p.commencementDate).toBe("2026-11-01");
    // Nothing else exists yet — every other field is absent/null, never a guess.
    expect(p.nric).toBeUndefined();
    expect(p.bankAccountNumber).toBeUndefined();
  });

  it("round-trips a prior submission's plain (non-sensitive) fields verbatim", () => {
    const p = buildOnboardingPrefill({
      commencementDate: new Date("2026-11-01T00:00:00.000Z"),
      fullName: "Jane Tan",
      submittedPayload: {
        businessName: "Nathan Ventures",
        nationality: "Singaporean",
        gender: "Male",
        religion: "Buddhism",
        maritalStatus: "Married",
        spouseConflict: true,
        spouseName: "Jamie",
        spouseCompany: "Co",
        spouseDesignation: "Director",
        paymentMethod: "PayNow",
        paynowNumber: "91234567",
      },
    });
    expect(p).toMatchObject({
      businessName: "Nathan Ventures",
      nationality: "Singaporean",
      gender: "Male",
      religion: "Buddhism",
      maritalStatus: "Married",
      spouseConflict: true,
      spouseName: "Jamie",
      spouseCompany: "Co",
      spouseDesignation: "Director",
      paymentMethod: "PayNow",
      paynowNumber: "91234567",
    });
  });

  // Non-vacuous per PD's spec: assert the REAL plaintext string is genuinely
  // absent from the prefill, not merely that a masked string happens to render.
  it("never puts the decrypted nric/bankAccountNumber plaintext anywhere in the result", () => {
    const p = buildOnboardingPrefill({
      commencementDate: null,
      fullName: "Jane Tan",
      submittedPayload: {
        nric: encryptPII(REAL_NRIC),
        bankAccountNumber: encryptPII(REAL_BANK_ACCOUNT),
      },
    });
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain(REAL_NRIC);
    expect(serialized).not.toContain(REAL_BANK_ACCOUNT);
    // And it isn't the raw ciphertext blob either — only the masked display form.
    expect(serialized).not.toContain("v1:");
  });

  it("masks nric/bankAccountNumber using the real crypto mask helpers, not a guess", () => {
    const p = buildOnboardingPrefill({
      commencementDate: null,
      fullName: "Jane Tan",
      submittedPayload: { nric: encryptPII(REAL_NRIC), bankAccountNumber: encryptPII(REAL_BANK_ACCOUNT) },
    });
    expect(p.nric).toBe("S••••567A");
    expect(p.bankAccountNumber).toBe("••••6789");
  });

  it("never prefills photo, signature or agreementAccepted — a signature is re-drawn and re-accepted every time", () => {
    const p = buildOnboardingPrefill({
      commencementDate: null,
      fullName: "Jane Tan",
      submittedPayload: { nric: encryptPII(REAL_NRIC) },
    }) as Record<string, unknown>;
    expect(p).not.toHaveProperty("photo");
    expect(p).not.toHaveProperty("signature");
    expect(p).not.toHaveProperty("agreementAccepted");
  });
});
