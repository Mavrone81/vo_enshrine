import { decryptPiiRaw, maskNric, maskAccount } from "./crypto";

// What submitOnboarding (server/recruitment/actions.ts) writes into
// Candidate.submittedPayload. Kept local to this file (not shared with
// server/recruitment/actions.ts's own private StoredPayload, which is a
// narrower subset approveCandidate reads) so a change to one never silently
// changes the other's shape.
type StoredOnboardingPayload = {
  businessName?: string | null;
  nric?: string | null; // ciphertext
  dateOfBirth?: string | null;
  residentialAddress?: string | null;
  emergencyContactName?: string | null;
  emergencyContactNumber?: string | null;
  emergencyContactRelationship?: string | null;
  emergencyContactAddress?: string | null;
  paymentMethod?: "PayNow" | "Bank Transfer" | null;
  paynowNumber?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null; // ciphertext
  maritalStatus?: "Single" | "Married" | "Divorced" | "Widowed" | null;
  nationality?: string | null;
  gender?: "Male" | "Female" | null;
  religion?: string | null;
  spouseConflict?: boolean | null;
  spouseName?: string | null;
  spouseCompany?: string | null;
  spouseDesignation?: string | null;
};

/**
 * Owner ruling 2026-10-17: resubmitting before approval keeps earlier
 * answers. nric/bankAccountNumber are decrypted here and returned ONLY in
 * their masked display form (e.g. "S•••••00A") — the plaintext never leaves
 * this function, so the token-only /onboard/[token] page can never echo it.
 * photo, signature and agreementAccepted are deliberately absent: a
 * signature is an act, re-drawn and re-accepted on every submission, never
 * reused from a prior one.
 */
export type OnboardingPrefill = {
  commencementDate?: string | null;
  // The full legal name, prefilled from the candidate row (the inviter-set
  // name) so the field opens populated; the candidate edits it at onboarding
  // (owner request 2026-10-19). A real column, not part of submittedPayload.
  fullName?: string | null;
  businessName?: string | null;
  nric?: string; // masked, or absent when nothing was stored yet
  dateOfBirth?: string | null;
  residentialAddress?: string | null;
  emergencyContactName?: string | null;
  emergencyContactNumber?: string | null;
  emergencyContactRelationship?: string | null;
  emergencyContactAddress?: string | null;
  paymentMethod?: "PayNow" | "Bank Transfer" | null;
  paynowNumber?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string; // masked, or absent when nothing was stored yet
  maritalStatus?: "Single" | "Married" | "Divorced" | "Widowed" | null;
  nationality?: string | null;
  gender?: "Male" | "Female" | null;
  religion?: string | null;
  spouseConflict?: boolean | null;
  spouseName?: string | null;
  spouseCompany?: string | null;
  spouseDesignation?: string | null;
};

export function buildOnboardingPrefill(c: {
  commencementDate: Date | null;
  fullName: string;
  submittedPayload: unknown;
}): OnboardingPrefill {
  const p = (c.submittedPayload as StoredOnboardingPayload | null) ?? {};
  return {
    // A real column (not in submittedPayload), so it survives a first visit
    // before any submission — the inviter-set name shows until the candidate
    // changes it.
    fullName: c.fullName,
    // Doubles as the in-flight (not-yet-submitted) case: before a first
    // submission this column still holds the inviter's own suggested date
    // (now optional, possibly null) — same field, same prefill, no branch
    // needed between "invited" and "resubmitting".
    commencementDate: c.commencementDate ? c.commencementDate.toISOString().slice(0, 10) : null,
    businessName: p.businessName ?? null,
    nric: p.nric ? maskNric(decryptPiiRaw(p.nric)) : undefined,
    dateOfBirth: p.dateOfBirth ?? null,
    residentialAddress: p.residentialAddress ?? null,
    emergencyContactName: p.emergencyContactName ?? null,
    emergencyContactNumber: p.emergencyContactNumber ?? null,
    emergencyContactRelationship: p.emergencyContactRelationship ?? null,
    emergencyContactAddress: p.emergencyContactAddress ?? null,
    paymentMethod: p.paymentMethod ?? null,
    paynowNumber: p.paynowNumber ?? null,
    bankName: p.bankName ?? null,
    bankAccountNumber: p.bankAccountNumber ? maskAccount(decryptPiiRaw(p.bankAccountNumber)) : undefined,
    maritalStatus: p.maritalStatus ?? null,
    nationality: p.nationality ?? null,
    gender: p.gender ?? null,
    religion: p.religion ?? null,
    spouseConflict: p.spouseConflict ?? null,
    spouseName: p.spouseName ?? null,
    spouseCompany: p.spouseCompany ?? null,
    spouseDesignation: p.spouseDesignation ?? null,
  };
}
