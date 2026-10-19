"use server";

import { randomBytes, createHash } from "crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import {
  ApprovalStatus, AssociateStatus, Designation, OnboardingStage,
  PaymentMethod, AppRole,
} from "@prisma/client";
import { hash } from "@node-rs/argon2";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { isAdminRole, canRecruit } from "@/lib/rbac";
import { encryptPII, decryptPiiRaw, maskNric, maskAccount } from "@/lib/crypto";
import { putObject, getObject } from "@/lib/storage";
import { assertUpload } from "@/lib/file-type";
import { humanize } from "@/lib/labels";
import { renderAgreementPdf, formatUplineOrNA, wouldTruncate } from "@/lib/pdf/agreement";
import { MASTER_TEMPLATE_VERSION, MASTER_TEMPLATE_SHA256 } from "@/lib/pdf/associate-agreement-coordinates";
import { nextAssociateCode, reserveAssociateCodeForCandidate } from "@/lib/associate-code";
import { sendMail, onboardingInviteEmail, approvalEmail } from "@/lib/mail";
import { logAudit, auditTx, AuditWriteError } from "@/lib/audit";
import { maskedPayee } from "@/server/associates/payee-audit";
import { validate } from "@/lib/validate";
import { onboardingSchema, inviteCandidateSchema } from "@/lib/schemas";
import { findInvalidOnboardingFields, ONBOARDING_REQUIRED_ERROR_CODE } from "@/lib/onboarding-fields";
import { isWithinCommencementDateRange } from "@/lib/commencement-date";
import { checkRateLimit, recordFailure } from "@/lib/rate-limit";
import { fileSignedAgreement } from "@/server/recruitment/file-signed-agreement";
import { normalizeEmail } from "@/lib/email";

async function requireAdmin() {
  const session = await auth();
  if (!session || !isAdminRole(session.user.role)) return null;
  return session;
}

// Recruitment invite is Manager and above (A9, owner ruling 2026-09-26 — see lib/rbac canRecruit).
async function requireRecruiter() {
  const session = await auth();
  if (!session || !canRecruit(session.user.role)) return null;
  return session;
}

/** Active team names the recruiter belongs to (member or director), falling
 *  back to their associate profile's free-text team name. */
async function recruiterTeamNames(associateId: string | null): Promise<string[]> {
  if (!associateId) return [];
  const [teams, me] = await Promise.all([
    prisma.team.findMany({
      where: { active: true, OR: [{ directorId: associateId }, { members: { some: { associateId } } }] },
      select: { name: true },
    }),
    prisma.associate.findUnique({ where: { id: associateId }, select: { teamName: true } }),
  ]);
  const names = teams.map((x) => x.name);
  if (names.length === 0 && me?.teamName) names.push(me.teamName);
  return names;
}

export async function myRecruiterTeams(): Promise<string[]> {
  const session = await requireRecruiter();
  if (!session) return [];
  if (isAdminRole(session.user.role)) return [];
  return recruiterTeamNames(session.user.associateId ?? null);
}

// Absolute base URL for links in emails: prefer AUTH_URL, else the request host.
async function baseUrl(): Promise<string> {
  if (env.AUTH_URL) return env.AUTH_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : "";
}

function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

// #29: how long a newly-approved associate's set-password link stays valid.
// Deliberately separate from server/account/actions.ts's SIGNIN_LINK_TTL_MS
// (72h) — that one is an admin manually re-issuing a link later, this one is
// the first link sent at approval time; same reset-token mechanism, shorter
// window because it's the expected, immediate path rather than a fallback.
const WELCOME_LINK_TTL_MS = 24 * 60 * 60 * 1000;

// app_role provisioned from org designation (16-Jul: each sales tier has its own role; cf. roleForDesignation in lib/rbac.ts)
const ROLE_FOR_DESIGNATION: Record<Designation, AppRole> = {
  // A Managing Director is a sales DESIGNATION the owner added for the
  // managing-director cut (2026-10-07); AppRole has no matching value and the
  // owner asked for a designation and a cut, not an access change. Mapped to
  // the highest existing sales role so permissions are unchanged in substance.
  ManagingDirector: AppRole.SalesDirector,
  SalesDirector: AppRole.SalesDirector,
  SalesManager: AppRole.SalesManager,
  SalesAssistantManager: AppRole.SalesAssistantManager,
  SalesAssociate: AppRole.SalesAssociate,
};



// ---------------------------------------------------------------------------
// Invite (admin AND manager/director — one action) — creates a candidate + unique onboarding link
// ---------------------------------------------------------------------------
export type InviteInput = {
  fullName: string;
  mobileNumber: string;
  email: string;
  intendedDesignation: Designation;
  intendedDirectUplineCode?: string;
  intendedTeam?: string;
  commencementDate: string;
};

// Error keys inviteCandidateSchema may surface to the invite form.
const INVITE_ERROR_CODES = new Set(["commencementDateRequired", "commencementDateInvalid"]);

export async function inviteCandidate(input: InviteInput): Promise<{ ok: boolean; error?: string; token?: string; emailed?: boolean }> {
  const t = await getTranslations("errors");
  const session = await requireRecruiter();
  if (!session) return { ok: false, error: t("forbidden") };
  if (!input.fullName?.trim()) return { ok: false, error: t("fullNameRequired") };
  if (!input.email?.trim()) return { ok: false, error: t("emailRequired") };
  // Bound the address before it can reach the mail transport's parser (DoS guard);
  // the same schema requires a real Commencement Date.
  // Owner ruling 2026-10-17: this field is now a non-binding suggestion only
  // (the candidate sets their own, mandatory date at onboarding submit), so
  // a blank/whitespace value is normalized to "absent" before validating —
  // inviteCandidateSchema's commencementDate is optional, but "" is not the
  // same value as undefined to zod's own .optional().
  const emailCheck = validate(inviteCandidateSchema, {
    email: input.email,
    commencementDate: input.commencementDate?.trim() || undefined,
  });
  if (!emailCheck.ok) return { ok: false, error: t(emailCheck.code && INVITE_ERROR_CODES.has(emailCheck.code) ? emailCheck.code : "invalidInput") };

  // Team rule (owner, Oct 2026): the team dropdown is for Business Admin only,
  // who can place a candidate into ANY team. A Manager / Director invites into
  // their OWN team, which is implied, not chosen:
  //   - one team            -> that team, filled in here (the client sends nothing);
  //   - several teams       -> the caller must name one of them (never silently
  //                            defaulted into the wrong one: teamRequired);
  //   - no team at all      -> no team; anything the client sends is refused, so a
  //                            non-admin can never tag a candidate into a team that
  //                            is not theirs (teamNotYours).
  // `ownTeams` falls back to the associate profile's team name (recruiterTeamNames).
  let intendedTeam = input.intendedTeam?.trim() || null;
  if (!isAdminRole(session.user.role)) {
    const ownTeams = await recruiterTeamNames(session.user.associateId ?? null);
    if (intendedTeam && !ownTeams.includes(intendedTeam)) return { ok: false, error: t("teamNotYours") };
    if (!intendedTeam && ownTeams.length === 1) intendedTeam = ownTeams[0];
    if (!intendedTeam && ownTeams.length > 1) return { ok: false, error: t("teamRequired") };
  }

  const upline = input.intendedDirectUplineCode
    ? await prisma.associate.findUnique({ where: { associateCode: input.intendedDirectUplineCode } })
    : null;
  if (input.intendedDirectUplineCode && !upline) return { ok: false, error: t("uplineCodeNotFound") };

  const token = randomBytes(24).toString("base64url");
  const email = emailCheck.data.email.toLowerCase();
  const candidate = await prisma.candidate.create({
    data: {
      fullName: input.fullName.trim(),
      mobileNumber: input.mobileNumber.trim(),
      email,
      intendedDesignation: input.intendedDesignation,
      intendedDirectUplineId: upline?.id ?? null,
      intendedTeam,
      commencementDate: emailCheck.data.commencementDate ? new Date(emailCheck.data.commencementDate) : null,
      onboardingToken: token,
      onboardingStage: OnboardingStage.Invited,
      invitedById: session.user.id,
    },
  });

  // Best-effort email of the onboarding link (no-op if SMTP unconfigured).
  const link = `${await baseUrl()}/onboard/${token}`;
  const { sent } = await sendMail({ ...onboardingInviteEmail(candidate.fullName, link), to: email });

  revalidatePath("/admin/recruitment");
  // Both invite pages list the caller's pending invites — refresh the other surface too.
  revalidatePath("/admin/recruitment/new");
  revalidatePath("/portal/recruitment/new");
  return { ok: true, token, emailed: sent };
}

// ---------------------------------------------------------------------------
/**
 * Cancel a pending invite (Issues v1.0 — Recruitment). Deletes the candidate
 * record, which invalidates the onboarding link already sent (the token is
 * gone). Allowed to the person who sent the invite or a Business Admin, and only
 * while the candidate has not yet been converted into an associate.
 */
export async function cancelInvite(candidateId: string): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations("errors");
  const session = await auth();
  if (!session) return { ok: false, error: t("forbidden") };

  const c = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: { invitedById: true, convertedAssociateId: true },
  });
  if (!c) return { ok: false, error: t("notFound") };
  if (!(isAdminRole(session.user.role) || c.invitedById === session.user.id)) return { ok: false, error: t("forbidden") };
  if (c.convertedAssociateId) return { ok: false, error: t("alreadyConverted") };

  await prisma.candidate.delete({ where: { id: candidateId } });
  await logAudit({ action: "candidate.invite_cancelled", entityType: "Candidate", entityId: candidateId, actorUserId: session.user.id });
  revalidatePath("/portal/recruitment/new");
  revalidatePath("/admin/recruitment/new");
  revalidatePath("/admin/recruitment");
  return { ok: true };
}

// Candidate self-onboarding (PUBLIC — no session, gated by unguessable token)
// ---------------------------------------------------------------------------
export type OnboardingSubmission = {
  // The candidate's OWN, mandatory commencement date (owner ruling
  // 2026-10-17) — supersedes the inviter's own, now-optional field.
  commencementDate: string;
  // Owner request 2026-10-19: the candidate's own full legal name as per
  // NRIC/passport, filled at onboarding and stamped onto the agreement's "Name
  // of Applicant" box (previously only the inviter-set name was used).
  fullName: string;
  businessName?: string;
  nric: string;
  dateOfBirth?: string;
  residentialAddress?: string;
  emergencyContactName?: string;
  emergencyContactNumber?: string;
  emergencyContactRelationship?: string;
  emergencyContactAddress?: string;
  paymentMethod: "PayNow" | "Bank Transfer";
  paynowNumber?: string;
  bankName?: string;
  bankAccountNumber?: string;
  agreementAccepted: boolean;
  // V-2026-07 additions.
  maritalStatus?: "Single" | "Married" | "Divorced" | "Widowed";
  // Printed on the agreement's particulars table — required (onboardingSchema).
  nationality?: string;
  gender?: "Male" | "Female";
  religion?: string;
  spouseConflict?: boolean;
  spouseName?: string;
  spouseCompany?: string;
  spouseDesignation?: string;
  photo?: File | null;
  signature?: string; // PNG data URL from the signature pad
};

// The form renders optional fields as `value={f.x ?? ""}`, so clearing one
// after typing sends "" rather than undefined. onboardingSchema treats
// dateOfBirth/bankAccountNumber as optional-but-non-empty-when-present, so ""
// would otherwise be wrongly rejected as invalidInput (same issue Task 2 hit
// on the associate form) — normalize before validating.
const BLANKABLE_KEYS: (keyof OnboardingSubmission)[] = ["dateOfBirth", "bankAccountNumber"];
function blankToUndefined(input: OnboardingSubmission): OnboardingSubmission {
  const out = { ...input };
  for (const k of BLANKABLE_KEYS) {
    if (out[k] === "") delete out[k];
  }
  return out;
}

// Error keys submitOnboarding may surface for a missing required field.
const ONBOARDING_ERROR_CODES = new Set(Object.values(ONBOARDING_REQUIRED_ERROR_CODE));

export async function submitOnboarding(
  token: string,
  submission: OnboardingSubmission,
): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations("errors");

  // Rate-limit BEFORE any DB lookup or write, keyed by the onboarding token
  // itself (unguessable, so token-scoped throttling is targeted + safe — no
  // account-enumeration concern the way there would be for an email/IP key).
  if (!(await checkRateLimit(token, "onboard_submit")).allowed) {
    return { ok: false, error: t("tooManyAttempts") };
  }

  const c = await prisma.candidate.findUnique({ where: { onboardingToken: token } });
  if (!c) {
    await recordFailure(token, "onboard_submit");
    return { ok: false, error: t("invalidOrExpiredLink") };
  }
  if (c.onboardingStage === OnboardingStage.Approved) {
    await recordFailure(token, "onboard_submit");
    return { ok: false, error: t("applicationAlreadyApproved") };
  }
  if (c.onboardingStage === OnboardingStage.Rejected) {
    await recordFailure(token, "onboard_submit");
    return { ok: false, error: t("applicationClosed") };
  }

  const normalised = blankToUndefined(submission);
  const v = validate(onboardingSchema, normalised);
  if (!v.ok) {
    await recordFailure(token, "onboard_submit");
    // Name the first missing required field (document order) instead of a bare
    // "Invalid input." — the form shows it at the field. Anything the presence
    // check does not explain (over-long, out-of-enum, tampered) stays generic,
    // EXCEPT a syntactically valid but out-of-range commencementDate (today..+12
    // months, candidateCommencementDate in lib/schemas.ts) — not a missing field,
    // but common enough to deserve its own named reason rather than a bare
    // "Invalid input."
    const firstMissing = findInvalidOnboardingFields(normalised).first;
    const code = firstMissing ? ONBOARDING_REQUIRED_ERROR_CODE[firstMissing] : undefined;
    if (!code && typeof normalised.commencementDate === "string" && normalised.commencementDate.trim() &&
        !isWithinCommencementDateRange(normalised.commencementDate.trim())) {
      return { ok: false, error: t("commencementDateOutOfRange") };
    }
    return { ok: false, error: t(code && ONBOARDING_ERROR_CODES.has(code) ? code : "invalidInput") };
  }
  const s = v.data;

  // Resubmitting before approval keeps earlier answers (owner ruling
  // 2026-10-17). nric/bankAccountNumber are "kept unless changed": the page
  // prefilled them with a MASK the server itself computed from the stored
  // ciphertext (lib/onboarding-prefill.ts) — if what comes back is exactly
  // that mask, the candidate never touched the field, so the prior
  // ciphertext is kept verbatim rather than re-encrypting the mask text
  // itself (which would corrupt the stored value). Comparing against the
  // server's OWN recomputed mask (not a client-asserted flag) means a
  // tampered client can't force a "kept" or "changed" outcome either way.
  const priorPayload = (c.submittedPayload as StoredPayload | null) ?? null;
  const priorNricMask = priorPayload?.nric ? maskNric(decryptPiiRaw(priorPayload.nric)) : null;
  const nricKept = priorNricMask !== null && s.nric === priorNricMask;
  const priorBankMask = priorPayload?.bankAccountNumber ? maskAccount(decryptPiiRaw(priorPayload.bankAccountNumber)) : null;
  const bankKept = priorBankMask !== null && !!s.bankAccountNumber && s.bankAccountNumber === priorBankMask;

  if (!s.nric?.trim()) {
    await recordFailure(token, "onboard_submit");
    return { ok: false, error: t("nricRequired") };
  }
  if (!s.agreementAccepted) {
    await recordFailure(token, "onboard_submit");
    return { ok: false, error: t("agreementRequired") };
  }
  if (!s.signature) {
    await recordFailure(token, "onboard_submit");
    return { ok: false, error: t("signatureRequired") };
  }

  // Optional profile photo → object storage. The browser-supplied MIME type
  // (s.photo.type) is untrustworthy — sniff the real magic bytes instead.
  let photoFileKey = c.photoFileKey ?? undefined;
  if (s.photo && s.photo.size > 0) {
    if (s.photo.size > 5_000_000) {
      await recordFailure(token, "onboard_submit");
      return { ok: false, error: t("photoTooLarge") };
    }
    const photoBytes = new Uint8Array(await s.photo.arrayBuffer());
    let sniffed: "png" | "jpeg";
    try {
      sniffed = assertUpload(photoBytes, ["png", "jpeg"]) as "png" | "jpeg";
    } catch {
      await recordFailure(token, "onboard_submit");
      return { ok: false, error: t("invalidFileType") };
    }
    const ext = sniffed === "jpeg" ? "jpg" : "png";
    photoFileKey = `candidates/${c.id}/photo.${ext}`;
    await putObject(photoFileKey, Buffer.from(photoBytes));
  }

  // Sensitive fields are encrypted at rest inside the JSON payload; the same
  // ciphertext is copied verbatim onto the Associate record on approval.
  // nric/bankAccountNumber reuse the PRIOR ciphertext verbatim when kept
  // unchanged (see nricKept/bankKept above) instead of re-encrypting the
  // mask text the candidate left in place.
  const payload = {
    businessName: s.businessName?.trim() || null,
    nric: nricKept ? priorPayload!.nric! : encryptPII(s.nric.trim()),
    dateOfBirth: s.dateOfBirth || null,
    residentialAddress: s.residentialAddress?.trim() || null,
    emergencyContactName: s.emergencyContactName?.trim() || null,
    emergencyContactNumber: s.emergencyContactNumber?.trim() || null,
    paymentMethod: s.paymentMethod,
    paynowNumber: s.paynowNumber?.trim() || null,
    bankName: s.bankName?.trim() || null,
    bankAccountNumber: bankKept ? priorPayload!.bankAccountNumber! : (s.bankAccountNumber ? encryptPII(s.bankAccountNumber.trim()) : null),
    maritalStatus: s.maritalStatus ?? null,
    nationality: s.nationality?.trim() || null,
    gender: s.gender ?? null,
    religion: s.religion?.trim() || null,
    // Conflict-of-interest declaration (V-2026-07). Spouse details are only kept
    // when the conflict is declared Yes.
    spouseConflict: s.spouseConflict ?? false,
    spouseName: s.spouseConflict ? s.spouseName?.trim() || null : null,
    spouseCompany: s.spouseConflict ? s.spouseCompany?.trim() || null : null,
    spouseDesignation: s.spouseConflict ? s.spouseDesignation?.trim() || null : null,
    agreementAcceptedAt: new Date().toISOString(),
    // Which master the signed PDF was stamped onto. Pre-existing rows have
    // neither key (they were signed against the previous master).
    agreementTemplateVersion: MASTER_TEMPLATE_VERSION,
    agreementTemplateSha256: MASTER_TEMPLATE_SHA256,
  };

  // E-signature → store the raw signature image, then render and store a signed
  // Associate Agreement PDF embedding it.
  let signedAgreementFileKey = c.signedAgreementFileKey ?? undefined;
  const sigMatch = s.signature.match(/^data:image\/png;base64,(.+)$/);
  if (!sigMatch) {
    await recordFailure(token, "onboard_submit");
    return { ok: false, error: t("signatureInvalid") };
  }
  const signatureBytes = new Uint8Array(Buffer.from(sigMatch[1], "base64"));
  try {
    assertUpload(signatureBytes, ["png"]);
  } catch {
    await recordFailure(token, "onboard_submit");
    return { ok: false, error: t("invalidFileType") };
  }
  await putObject(`candidates/${c.id}/signature.png`, Buffer.from(signatureBytes));

  // CR-0001: snapshot the company signatory AT THIS MOMENT — the same write
  // that sets signedAgreementFileKey below — so a later edit in the admin
  // Company Data tab can never alter an already-signed agreement. Read live
  // here, on purpose: this is the one place "live" is correct, because it IS
  // the signing moment. Every other reader must use the snapshot columns,
  // never this table, once a candidate/associate has signed.
  const companySignatory = await prisma.companySignatory.findUnique({ where: { singleton: true } });
  // The stamp on the PDF (below) and the DB snapshot (below, at the
  // candidate.update) both come from this SAME read — never two separate
  // queries that could observe two different signatories if one changed
  // mid-request. The signature file itself follows the same PNG convention
  // as the associate's own signature upload (assertUpload(["png"]) above).
  let companySignatureDataUrl: string | null = null;
  if (companySignatory?.signatureFileKey) {
    const buf = await getObject(companySignatory.signatureFileKey);
    if (buf) companySignatureDataUrl = `data:image/png;base64,${buf.toString("base64")}`;
  }

  // Tier 1/2 Manager (page 7 "For Official Use") are knowable at signing —
  // the candidate signs before approval, so this is the INTENDED upline
  // chain, not the eventual associate record. One query gets both tiers.
  const upline = c.intendedDirectUplineId
    ? await prisma.associate.findUnique({
        where: { id: c.intendedDirectUplineId },
        select: { fullName: true, associateCode: true, directUpline: { select: { fullName: true, associateCode: true } } },
      })
    : null;
  // 🔴 Reserve the associate code BEFORE rendering, and render from the value
  // the database now holds. The owner's ruling moved allocation earlier
  // precisely so the ID exists in time to be printed: the signed PDF is never
  // modified after signing, so a number that arrives at approval can never be
  // added to it. Reserving first (rather than computing a number and writing it
  // alongside the PDF) is what keeps the document and the record in agreement —
  // the code is committed and arbitrated by its unique index before a single
  // byte of the agreement is rendered, so there is no window in which a
  // rendered PDF could print a number the row does not hold.
  //
  // Idempotent per candidate, so a double submit cannot allocate twice: see
  // reserveAssociateCodeForCandidate.
  const reservedAssociateCode = await reserveAssociateCodeForCandidate(c.id);

  // Owner request 2026-10-19: the applicant's name on the agreement is the full
  // legal name the candidate enters at onboarding (as per NRIC/passport), not
  // the inviter-set name on the candidate row. Trimmed; onboardingSchema has
  // already guaranteed it is non-empty.
  const submittedFullName = s.fullName.trim();
  const agreementPdf = await renderAgreementPdf({
    fullName: submittedFullName,
    designation: humanize(c.intendedDesignation ?? "Sales Associate"),
    email: normalizeEmail(c.email),
    mobile: c.mobileNumber,
    // When kept unchanged, s.nric is the MASK text itself — mask the real
    // prior plaintext (decrypted here, for this one line, then discarded)
    // instead of double-masking the mask.
    nricMasked: maskNric(nricKept ? decryptPiiRaw(priorPayload!.nric!) : s.nric.trim()),
    teamName: c.intendedTeam,
    uplineName: upline ? `${upline.fullName} (${upline.associateCode})` : null,
    signedDate: new Date(),
    signatureDataUrl: s.signature,
    // Official V.2026-04 particulars — filled from the onboarding submission.
    businessName: s.businessName?.trim() || null,
    nationality: s.nationality?.trim() || null,
    dateOfBirth: s.dateOfBirth ?? null,
    gender: s.gender ?? null,
    maritalStatus: s.maritalStatus ?? null,
    religion: s.religion?.trim() || null,
    homeAddress: s.residentialAddress?.trim() || null,
    // The candidate's OWN, mandatory date (owner ruling 2026-10-17) —
    // onboardingSchema guarantees a valid, in-range value here.
    commencementDate: s.commencementDate,
    spouseConflict: s.spouseConflict ?? null,
    spouseName: s.spouseConflict ? s.spouseName?.trim() || null : null,
    spouseCompany: s.spouseConflict ? s.spouseCompany?.trim() || null : null,
    spouseDesignation: s.spouseConflict ? s.spouseDesignation?.trim() || null : null,
    emergencyName: s.emergencyContactName?.trim() || null,
    emergencyContact: s.emergencyContactNumber?.trim() || null,
    // Owner ruling 2026-10-01: optional — flows to the box when given, stays
    // blank (no producer) when not.
    emergencyRelationship: s.emergencyContactRelationship?.trim() || null,
    emergencyAddress: s.emergencyContactAddress?.trim() || null,
    // Scoped exception (owner ruling): "NA" here means a KNOWN absence
    // (this associate genuinely has no upline at this tier) — never used
    // for a field that's merely uncollected.
    //
    // Associate ID: now printed, from the code reserved above. It used to be
    // withheld because the number did not exist until approveCandidate ran and
    // the signed PDF cannot be modified afterwards; the owner's ruling removed
    // the first half of that, and the second half is why it must be passed HERE
    // rather than stamped on later. approveCandidate consumes this same
    // reserved code, so the document and the associate record cannot disagree.
    associateId: reservedAssociateCode,
    tier1Manager: formatUplineOrNA(upline),
    tier2Manager: formatUplineOrNA(upline?.directUpline),
    companySignatoryName: companySignatory?.signatoryName ?? null,
    companySignatureDataUrl: companySignatureDataUrl,
  });
  signedAgreementFileKey = `candidates/${c.id}/signed-agreement.pdf`;
  await putObject(signedAgreementFileKey, agreementPdf);

  await prisma.candidate.update({
    where: { id: c.id },
    data: {
      submittedPayload: { ...payload, signedPdfSha256: createHash("sha256").update(agreementPdf).digest("hex") },
      // Owner request 2026-10-19: persist the candidate's own full legal name so
      // the admin views, approveCandidate → Associate, and any later agreement
      // render all read the same name the candidate signed under.
      fullName: submittedFullName,
      // The candidate's own choice, not the inviter's — admin views read
      // this same column (owner ruling 2026-10-17).
      commencementDate: new Date(s.commencementDate),
      photoFileKey,
      signedAgreementFileKey,
      companySignatoryNameAtSigning: companySignatory?.signatoryName ?? null,
      companySignatureFileKeyAtSigning: companySignatory?.signatureFileKey ?? null,
      onboardingStage: OnboardingStage.SignedPendingApproval,
    },
  });
  revalidatePath("/admin/recruitment");
  revalidatePath(`/admin/recruitment/${c.id}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// homeAddress fit warning (item 5) — this file is "use server", so this
// export is a PUBLIC callable endpoint on its own, not merely a helper for
// the onboarding page. Gated exactly like submitOnboarding above: rate-limit
// by token first, then a real token lookup, before doing any work — never
// callable anonymously. Returns true when the value WOULD be truncated on
// the signed agreement (i.e. the caller should show the warning) — true on
// every refusal path too (rate-limited, bad token, terminal stage, over the
// schema's own max(500)), since silently telling an unverified caller "you
// fit" is the wrong failure mode for a legal-document warning.
// ---------------------------------------------------------------------------
export async function homeAddressWouldTruncate(token: string, value: string): Promise<boolean> {
  if (!(await checkRateLimit(token, "onboard_check_address")).allowed) return true;

  const c = await prisma.candidate.findUnique({ where: { onboardingToken: token } });
  if (!c) {
    await recordFailure(token, "onboard_check_address");
    return true;
  }
  if (c.onboardingStage === OnboardingStage.Approved || c.onboardingStage === OnboardingStage.Rejected) {
    await recordFailure(token, "onboard_check_address");
    return true;
  }

  const trimmed = value.trim();
  // Bound BEFORE building a PDFDocument — this endpoint is reachable ahead
  // of full submission validation, so enforce onboardingSchema's own
  // residentialAddress max(500) here too rather than trusting the caller.
  if (trimmed.length > 500) return true;

  return wouldTruncate(trimmed);
}

// ---------------------------------------------------------------------------
// Approve (admin) — convert candidate → associate + provision login + P-file
// ---------------------------------------------------------------------------
type StoredPayload = {
  businessName?: string | null;
  nric?: string | null; // already encrypted
  dateOfBirth?: string | null;
  paymentMethod?: "PayNow" | "Bank Transfer" | null;
  paynowNumber?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null; // already encrypted
};

export async function approveCandidate(id: string): Promise<{ ok: boolean; error?: string; code?: string }> {
  const t = await getTranslations("errors");
  const session = await requireAdmin();
  if (!session) return { ok: false, error: t("forbidden") };

  const c = await prisma.candidate.findUnique({ where: { id } });
  if (!c) return { ok: false, error: t("notFound") };
  if (c.convertedAssociateId) return { ok: false, error: t("alreadyConverted") };
  if (c.onboardingStage !== OnboardingStage.SignedPendingApproval && c.onboardingStage !== OnboardingStage.FormSubmitted)
    return { ok: false, error: t("onboardingIncomplete") };
  if (!c.intendedDesignation) return { ok: false, error: t("noDesignationSet") };

  const p = (c.submittedPayload as StoredPayload | null) ?? {};
  const upline = c.intendedDirectUplineId
    ? await prisma.associate.findUnique({ where: { id: c.intendedDirectUplineId } })
    : null;

  // 🔴 CONSUME the code reserved at signing; never allocate a second one. The
  // agreement already prints the reserved number and is immutable, so a fresh
  // nextAssociateCode() here would leave the document saying one number and the
  // associate record another — worse than the blank box this replaced.
  //
  // The fallback covers rows that predate the reservation column: they signed
  // with an empty official-use box, so there is no number on their document to
  // contradict, and allocation at approval remains correct for them.
  const code = c.reservedAssociateCode ?? (await nextAssociateCode());
  // #29: the login gets no password anyone knows — a random value is hashed
  // in and immediately discarded (see below). Entry is by set-password link
  // only, same single-use hashed-token mechanism server/account/actions.ts
  // already uses for self-service reset and admin-issued sign-in links.
  const welcomeToken = randomBytes(32).toString("base64url");
  const pm = p.paymentMethod === "Bank Transfer" ? PaymentMethod.BankTransfer
    : p.paymentMethod === "PayNow" ? PaymentMethod.PayNow : null;

  let result: { code: string; provisioned: boolean };
  try {
  result = await prisma.$transaction(async (tx) => {
    let provisioned = false;
    const associate = await tx.associate.create({
      data: {
        associateCode: code,
        fullName: c.fullName,
        businessName: p.businessName ?? null,
        mobileNumber: c.mobileNumber,
        email: normalizeEmail(c.email),
        nric: p.nric ?? null, // already ciphertext
        dateOfBirth: p.dateOfBirth ? new Date(p.dateOfBirth) : null,
        designation: c.intendedDesignation!,
        directUplineId: upline?.id ?? null,
        secondUplineId: upline?.directUplineId ?? null,
        teamName: c.intendedTeam,
        paymentMethod: pm,
        paynowNumber: p.paynowNumber ?? null,
        bankName: p.bankName ?? null,
        bankAccountNumber: p.bankAccountNumber ?? null, // already ciphertext
        joinDate: new Date(),
        approvalStatus: ApprovalStatus.Approved,
        associateStatus: AssociateStatus.Active,
        // CR-0001: copied verbatim from the candidate's at-signing snapshot,
        // same as signedAgreementFileKey below — never re-read from
        // CompanySignatory here, or a signatory change between signing and
        // approval would silently restate history on the associate record.
        companySignatoryNameAtSigning: c.companySignatoryNameAtSigning,
        companySignatureFileKeyAtSigning: c.companySignatureFileKeyAtSigning,
      },
    });

    // Copy onboarding artifacts (photo, signed agreement) into the associate's
    // own namespace so they're viewable in the portal (serving route scopes
    // non-admins to associates/<id>/).
    if (c.photoFileKey) {
      const buf = await getObject(c.photoFileKey);
      if (buf) {
        const ext = c.photoFileKey.split(".").pop() ?? "jpg";
        const key = `associates/${associate.id}/photo.${ext}`;
        await putObject(key, buf);
        await tx.associate.update({ where: { id: associate.id }, data: { photoFileKey: key } });
      }
    }
    let associateAgreementKey: string | null = null;
    if (c.signedAgreementFileKey) {
      const buf = await getObject(c.signedAgreementFileKey);
      if (buf) {
        associateAgreementKey = `associates/${associate.id}/signed-agreement.pdf`;
        await putObject(associateAgreementKey, buf);
        await tx.associate.update({ where: { id: associate.id }, data: { signedAgreementFileKey: associateAgreementKey } });
      }
    }

    // provision a login if the candidate email is not already taken
    const existing = await tx.user.findUnique({ where: { email: normalizeEmail(c.email)! } });
    let filedUserId: string;
    if (!existing) {
      provisioned = true;
      // Random, hashed, and never bound to a variable the caller could read
      // back out — this account has no password anyone knows. The welcome
      // email's link is the only way in, via resetTokenHash below.
      const unusablePasswordHash = await hash(randomBytes(32).toString("base64url"));
      const user = await tx.user.create({
        data: {
          email: normalizeEmail(c.email)!,
          passwordHash: unusablePasswordHash,
          role: ROLE_FOR_DESIGNATION[c.intendedDesignation!],
          associateId: associate.id,
          mustResetPassword: true,
          resetTokenHash: sha256(welcomeToken),
          resetTokenExpiresAt: new Date(Date.now() + WELCOME_LINK_TTL_MS),
        },
      });
      filedUserId = user.id;
    } else {
      filedUserId = existing.id;
    }
    // C-4: file the signed agreement regardless of which branch above ran —
    // previously this only happened for a NEW login (inside the `if
    // (!existing)` block), so an existing-email candidate got
    // signedAgreementFileKey set on the Associate but no P-File document at
    // all. Same helper the offline-upload admin action uses, so "filed"
    // means the same thing on both paths.
    if (associateAgreementKey) {
      await fileSignedAgreement(tx, filedUserId, associate.id, associateAgreementKey, session.user.id);
    }

    await tx.candidate.update({
      where: { id: c.id },
      data: {
        onboardingStage: OnboardingStage.Approved,
        reviewedById: session.user.id,
        convertedAssociateId: associate.id,
      },
    });
    // Tier A: a new payee + login (role) is recorded with the conversion; payee masked.
    await auditTx(tx, {
      action: "candidate.approved", entityType: "Candidate", entityId: c.id, actorUserId: session.user.id,
      after: { associateCode: associate.associateCode, associateId: associate.id, designation: associate.designation, loginProvisioned: provisioned, payee: maskedPayee(associate) },
    });
    return { code: associate.associateCode, provisioned };
  });
  } catch (e) {
    if (e instanceof AuditWriteError) return { ok: false, error: t("auditUnavailable") }; // nothing converted, no email sent
    throw e;
  }

  // Email the new associate their set-password link (best-effort, post-commit).
  if (result.provisioned) {
    await sendMail({
      ...approvalEmail(c.fullName, `${await baseUrl()}/reset-password/${welcomeToken}`, c.email),
      to: c.email,
    });
  }

  revalidatePath("/admin/recruitment");
  revalidatePath("/admin/associates");
  revalidatePath("/admin/dashboard");
  return { ok: true, code: result.code };
}

export async function rejectCandidate(id: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations("errors");
  const session = await requireAdmin();
  if (!session) return { ok: false, error: t("forbidden") };
  const c = await prisma.candidate.findUnique({ where: { id } });
  if (!c) return { ok: false, error: t("notFound") };
  try {
    await prisma.$transaction(async (db) => {
      await db.candidate.update({
        where: { id },
        data: {
          onboardingStage: OnboardingStage.Rejected,
          rejectReason: reason?.trim() || null,
          reviewedById: session.user.id,
        },
      });
      await auditTx(db, { action: "candidate.rejected", entityType: "Candidate", entityId: id, actorUserId: session.user.id, after: { reason: reason?.trim() || null } });
    });
  } catch (e) {
    if (e instanceof AuditWriteError) return { ok: false, error: t("auditUnavailable") };
    throw e;
  }
  revalidatePath("/admin/recruitment");
  revalidatePath(`/admin/recruitment/${id}`);
  return { ok: true };
}
