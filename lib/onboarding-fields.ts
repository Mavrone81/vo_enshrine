import type { OnboardingSubmission } from "@/server/recruitment/actions";

// Which onboarding fields are required, and which are missing. PURE (no DOM, no
// React, no i18n) so the form's scroll/focus/highlight and the server's
// field-specific error code both hang off one function, and so it is
// unit-testable without a browser.
//
// This answers "is a required value PRESENT?" only. Shape/length rules (an
// over-long NRIC, an out-of-enum value) stay with onboardingSchema, which
// remains the authority; lib/onboarding-fields.test.ts pins the two together so
// they cannot drift apart silently.

/** Required fields, in DOCUMENT ORDER (the order they appear on the page). */
export const ONBOARDING_FIELD_ORDER = [
  "fullName",
  "commencementDate",
  "nric",
  "nationality",
  "gender",
  "religion",
  "spouseConflict",
  "spouseName",
  "spouseCompany",
  "spouseDesignation",
  "paymentMethod",
  "agreementAccepted",
  "signature",
] as const;

export type OnboardingField = (typeof ONBOARDING_FIELD_ORDER)[number];

/** `errors.*` i18n key shown at the field, and returned by the server, for each field. */
export const ONBOARDING_REQUIRED_ERROR_CODE: Record<OnboardingField, string> = {
  fullName: "fullNameRequired",
  // Presence only — the today..+12-months range check is onboardingSchema's
  // alone (candidateCommencementDate, lib/schemas.ts), per this file's own
  // division of labor (see the file header comment).
  commencementDate: "commencementDateRequired",
  nric: "nricRequired",
  nationality: "nationalityRequired",
  gender: "genderRequired",
  religion: "religionRequired",
  spouseConflict: "spouseConflictRequired",
  spouseName: "spouseNameRequired",
  spouseCompany: "spouseCompanyRequired",
  spouseDesignation: "spouseDesignationRequired",
  paymentMethod: "paymentMethodRequired",
  agreementAccepted: "agreementRequired",
  signature: "signatureRequired",
};

/**
 * DOM id of the element to scroll to / focus for each field. The form's markup
 * must carry these ids (lib/onboarding-fields.test.ts checks it does). The
 * agreement checkbox is disabled until the agreement is opened and a disabled
 * control cannot take focus, so the form falls back to the "agreementView" link.
 */
export const ONBOARDING_FIELD_DOM_ID: Record<OnboardingField, string> = {
  fullName: "fullName",
  commencementDate: "commencementDate",
  nric: "nric", nationality: "nationality", gender: "gender", religion: "religion",
  spouseConflict: "spouseConflict", spouseName: "spouseName", spouseCompany: "spouseCompany",
  spouseDesignation: "spouseDesignation", paymentMethod: "pm",
  agreementAccepted: "agreementAccepted", signature: "signature",
};

export type OnboardingFieldCheck = {
  /** First invalid field in document order, or null when every required field is present. */
  first: OnboardingField | null;
  /** Every invalid field, in document order. */
  invalid: OnboardingField[];
};

const blank = (v: string | undefined | null) => !v?.trim();

export function findInvalidOnboardingFields(
  f: Partial<OnboardingSubmission>,
): OnboardingFieldCheck {
  // spouseConflict is a tri-state in the form (unanswered / No / Yes). Only a
  // real boolean counts as answered — the unanswered default is NOT valid
  // (onboardingSchema: spouseConflict is z.boolean(), owner ruling).
  const conflictYes = f.spouseConflict === true;
  const missing: Record<OnboardingField, boolean> = {
    fullName: blank(f.fullName),
    commencementDate: blank(f.commencementDate),
    nric: blank(f.nric),
    nationality: blank(f.nationality),
    gender: !f.gender,
    religion: blank(f.religion),
    spouseConflict: typeof f.spouseConflict !== "boolean",
    spouseName: conflictYes && blank(f.spouseName),
    spouseCompany: conflictYes && blank(f.spouseCompany),
    spouseDesignation: conflictYes && blank(f.spouseDesignation),
    paymentMethod: !f.paymentMethod,
    agreementAccepted: f.agreementAccepted !== true,
    signature: !f.signature,
  };
  const invalid = ONBOARDING_FIELD_ORDER.filter((k) => missing[k]);
  return { first: invalid[0] ?? null, invalid: [...invalid] };
}
