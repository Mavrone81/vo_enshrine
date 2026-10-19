import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { onboardingSchema } from "@/lib/schemas";
import en from "@/messages/en.json";
import zhCN from "@/messages/zh-CN.json";
import {
  findInvalidOnboardingFields,
  ONBOARDING_FIELD_ORDER,
  ONBOARDING_FIELD_DOM_ID,
  ONBOARDING_REQUIRED_ERROR_CODE,
} from "./onboarding-fields";

// A real yyyy-mm-dd always inside candidateCommencementDate's today..+12-months
// window, computed at test-run time rather than hardcoded.
const VALID_COMMENCEMENT_DATE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// The form's state exactly as a new associate first sees it.
const INITIAL = { nric: "", paymentMethod: "PayNow" as const, agreementAccepted: false };

// Every VISIBLY required field filled in (asterisked in the labels, plus the
// agreement box and the signature the Submit button already demands) —
// spouseConflict is left at its default, i.e. unanswered.
const ALL_FILLED_BUT_SPOUSE_CONFLICT = {
  fullName: "Tan Ah Kow",
  commencementDate: VALID_COMMENCEMENT_DATE,
  nric: "S1234567A",
  nationality: "Singaporean",
  gender: "Male" as const,
  religion: "Buddhism",
  paymentMethod: "PayNow" as const,
  agreementAccepted: true,
  signature: "data:image/png;base64,iVBORw0KGgo=",
};

describe("findInvalidOnboardingFields", () => {
  it("Case A (the live blocker): everything visibly required is filled but spouseConflict is at its default -> submit is blocked and spouseConflict is the first invalid field", () => {
    const r = findInvalidOnboardingFields(ALL_FILLED_BUT_SPOUSE_CONFLICT);
    expect(r.first).toBe("spouseConflict");
    expect(r.invalid).toEqual(["spouseConflict"]);
    // ...and the server would reject this same payload, so the client guard is
    // not stricter than the server (nor, as before, laxer).
    expect(onboardingSchema.safeParse(ALL_FILLED_BUT_SPOUSE_CONFLICT).success).toBe(false);
  });

  it("Case B: an all-empty submit identifies the first required field in document order and marks every required field", () => {
    const r = findInvalidOnboardingFields(INITIAL);
    // fullName (owner request 2026-10-19) is now first in document order.
    expect(r.first).toBe("fullName");
    // Spouse sub-fields are NOT required until the conflict is declared Yes.
    expect(r.invalid).toEqual([
      "fullName", "commencementDate", "nric", "nationality", "gender", "religion", "spouseConflict", "agreementAccepted", "signature",
    ]);
  });

  it("answering No clears spouseConflict and requires no spouse details", () => {
    const r = findInvalidOnboardingFields({ ...ALL_FILLED_BUT_SPOUSE_CONFLICT, spouseConflict: false });
    expect(r).toEqual({ first: null, invalid: [] });
  });

  it("answering Yes requires all three spouse details, in document order", () => {
    const yes = { ...ALL_FILLED_BUT_SPOUSE_CONFLICT, spouseConflict: true };
    expect(findInvalidOnboardingFields(yes).invalid).toEqual(["spouseName", "spouseCompany", "spouseDesignation"]);
    expect(findInvalidOnboardingFields({ ...yes, spouseName: "A", spouseCompany: "B" }).invalid).toEqual(["spouseDesignation"]);
    expect(findInvalidOnboardingFields({ ...yes, spouseName: "A", spouseCompany: "B", spouseDesignation: "C" }).first).toBeNull();
  });

  it("treats whitespace-only text as missing", () => {
    const r = findInvalidOnboardingFields({ ...ALL_FILLED_BUT_SPOUSE_CONFLICT, spouseConflict: false, nric: "  ", nationality: "\t" });
    expect(r.invalid).toEqual(["nric", "nationality"]);
  });

  it("reports invalid fields in document order whatever order they were broken in", () => {
    const r = findInvalidOnboardingFields({
      ...ALL_FILLED_BUT_SPOUSE_CONFLICT, spouseConflict: false, signature: undefined, religion: "", nric: "",
    });
    expect(r.invalid).toEqual(["nric", "religion", "signature"]);
    expect(r.first).toBe("nric");
  });
});

describe("client guard vs server schema (no drift)", () => {
  const valid = { ...ALL_FILLED_BUT_SPOUSE_CONFLICT, spouseConflict: false };

  it("a payload the guard passes is accepted by onboardingSchema", () => {
    expect(findInvalidOnboardingFields(valid).first).toBeNull();
    expect(onboardingSchema.safeParse(valid).success).toBe(true);
  });

  // signature is enforced by submitOnboarding itself (signatureRequired), not by
  // the schema, so it is excluded from the schema-side half of this check.
  const SCHEMA_ENFORCED = ONBOARDING_FIELD_ORDER.filter((f) => f !== "signature");
  for (const field of SCHEMA_ENFORCED) {
    it(`blanking ${field} is caught by BOTH the guard and onboardingSchema`, () => {
      const base = { ...valid, spouseConflict: true, spouseName: "A", spouseCompany: "B", spouseDesignation: "C" };
      const broken: Record<string, unknown> = { ...base };
      delete broken[field];
      expect(findInvalidOnboardingFields(broken).invalid).toContain(field);
      expect(onboardingSchema.safeParse(broken).success).toBe(false);
    });
  }
});

describe("wiring that the pure function depends on", () => {
  it("every field has an error code present in BOTH catalogues (the zh-CN set is machine-translated)", () => {
    for (const field of ONBOARDING_FIELD_ORDER) {
      const code = ONBOARDING_REQUIRED_ERROR_CODE[field];
      expect((en.errors as Record<string, string>)[code], `en errors.${code}`).toBeTruthy();
      expect((zhCN.errors as Record<string, string>)[code], `zh-CN errors.${code}`).toBeTruthy();
    }
  });

  it("every field's DOM id exists in the form markup, so scroll/focus has a target", () => {
    const src = readFileSync("app/onboard/[token]/onboard-form.tsx", "utf8");
    for (const field of ONBOARDING_FIELD_ORDER) {
      expect(src, `id="${ONBOARDING_FIELD_DOM_ID[field]}" for ${field}`).toContain(`id="${ONBOARDING_FIELD_DOM_ID[field]}"`);
    }
    expect(src).toContain('id="agreementView"'); // focus fallback while the checkbox is disabled
  });

  it("every required label carries exactly one asterisk, in both catalogues", () => {
    const labels = (c: typeof en) => [c.onboarding.details.fullName, c.onboarding.details.commencementDate, c.onboarding.details.nric, c.onboarding.details.nationality,
      c.onboarding.details.gender, c.onboarding.details.religion, c.onboarding.details.spouseConflict];
    for (const l of [...labels(en), ...labels(zhCN as typeof en)]) {
      expect(l.match(/\*/g)).toHaveLength(1);
      expect(l.trimEnd().endsWith("*")).toBe(true);
    }
  });
});
