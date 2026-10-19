"use server";

import { randomUUID, createHash } from "crypto";
import { revalidatePath } from "next/cache";
import { Prisma, AshesAgreementStatus, SubmissionFlow } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { isAdminRole } from "@/lib/rbac";
import { logAudit, auditTx, AuditWriteError } from "@/lib/audit";
import { putObject, deleteObject } from "@/lib/storage";
import { assertUpload } from "@/lib/file-type";
import { amountToWords } from "@/lib/amount-words";
import { renderAshesAgreementPdf } from "@/lib/pdf/ashes-agreement";
import type { AshesPet } from "@/lib/pdf/ashes-agreement";
import { encryptNric, LooksLikeEncryptedError } from "@/lib/crypto";
import { ashesTermsSnapshot, isAgreementEditableStatus } from "@/lib/ashes-terms-snapshot";
import { AGREEMENT_COMPANY_PREFIX, snapshotAgreementCompany } from "@/lib/company-identity";

// ---------------------------------------------------------------------------
// Storage of Pets Ashes Agreement (consolidated menu, Sep 2026). Pipeline:
// the sale's quotation is approved+signed → the associate fills the
// application-details form (auto-prefilled from the submission) → the client
// signs in person → the rendered PDF joins the sale's docket.
// ---------------------------------------------------------------------------

export type AshesAgreementInput = {
  storageSpaceLocation?: string;
  nicheUnit?: string;
  pets: AshesPet[];
  applicant1Name: string;
  applicant1Nric?: string;
  applicant1Address?: string;
  applicant1Contact?: string;
  applicant1Email?: string;
  applicant2Name?: string;
  applicant2Nric?: string;
  applicant2Address?: string;
  applicant2Contact?: string;
  applicant2Email?: string;
  instalmentDayOfMonth?: number;
  maintenanceStartYear?: number;
  additionalTerms?: string;
  applicantWitnessName?: string;
  applicantWitnessNric?: string;
  companyWitnessName?: string;
  companyWitnessNric?: string;
};

async function allowedSubmission(submissionId: string) {
  const session = await auth();
  if (!session?.user) return { session: null, sub: null };
  const sub = await prisma.salesSubmission.findUnique({
    where: { id: submissionId },
    include: { ashesAgreement: true, lineItems: { select: { productCode: true } } },
  });
  if (!sub) return { session, sub: null };
  const allowed =
    isAdminRole(session.user.role) ||
    (!!session.user.associateId && session.user.associateId === sub.closingAssociateId);
  return { session, sub: allowed ? sub : null };
}

/** Create/update the application details (Draft). Amounts and the payment plan
 *  auto-fill from the submission — the agreement mirrors the sale. */
export async function saveAshesAgreement(
  submissionId: string,
  input: AshesAgreementInput,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const t = await getTranslations("errors");
  const { session, sub } = await allowedSubmission(submissionId);
  if (!session || !sub) return { ok: false, error: t("forbidden") };
  // N4: Legacy rows are frozen — no edit at all — once the new flow is live
  // (same design note as editSale/rejectSubmission, server/sales/actions.ts).
  // Flag off: nothing is Legacy-refused (every row IS Legacy today), so this
  // can never change today's behaviour early.
  if (env.A17_CLOSED_DEAL_FLOW && sub.flow === SubmissionFlow.Legacy) {
    try {
      await auditTx(prisma, {
        action: "sale.legacy_write_refused", entityType: "SalesSubmission", entityId: submissionId,
        actorUserId: session.user.id, after: { attempted: "saveAshesAgreement" },
      });
    } catch (e) {
      if (e instanceof AuditWriteError) return { ok: false, error: t("auditUnavailable") };
      throw e;
    }
    return { ok: false, error: t("legacyReadOnly") };
  }
  if (sub.ashesAgreement?.status === AshesAgreementStatus.Signed) return { ok: false, error: t("alreadyProcessed") };
  if (!isAgreementEditableStatus(sub.flow, sub.status)) return { ok: false, error: t("quotationNotApproved") };
  if (!input.applicant1Name?.trim()) return { ok: false, error: t("allFieldsRequired") };

  const pets = (input.pets ?? [])
    .map((p) => ({
      name: p.name?.trim() || undefined,
      breed: p.breed?.trim() || undefined,
      gender: p.gender?.trim() || undefined,
      dob: p.dob?.trim() || undefined,
      dateDismissed: p.dateDismissed?.trim() || undefined,
    }))
    .filter((p) => Object.values(p).some(Boolean))
    .slice(0, 10);

  const isInstalment = sub.paymentPlan === "Installment";
  const monthly =
    isInstalment && sub.installmentCount
      ? sub.saleAmount.minus(sub.deposit ?? 0).div(sub.installmentCount)
      : null;

  // SEC-12: the 4 NRIC fields are encrypted at rest.
  let applicant1Nric: string | null, applicant2Nric: string | null, applicantWitnessNric: string | null, companyWitnessNric: string | null;
  try {
    applicant1Nric = encryptNric(input.applicant1Nric);
    applicant2Nric = encryptNric(input.applicant2Nric);
    applicantWitnessNric = encryptNric(input.applicantWitnessNric);
    companyWitnessNric = encryptNric(input.companyWitnessNric);
  } catch (e) {
    if (e instanceof LooksLikeEncryptedError) return { ok: false, error: t("invalidInput") };
    throw e;
  }

  const data = {
    storageSpaceLocation: input.storageSpaceLocation?.trim() || null,
    nicheUnit: input.nicheUnit?.trim() || null,
    pets,
    applicant1Name: input.applicant1Name.trim(),
    applicant1Nric,
    applicant1Address: input.applicant1Address?.trim() || null,
    applicant1Contact: input.applicant1Contact?.trim() || null,
    applicant1Email: input.applicant1Email?.trim() || null,
    applicant2Name: input.applicant2Name?.trim() || null,
    applicant2Nric,
    applicant2Address: input.applicant2Address?.trim() || null,
    applicant2Contact: input.applicant2Contact?.trim() || null,
    applicant2Email: input.applicant2Email?.trim() || null,
    // Auto-pushed from the submission (the user's pipeline requirement).
    amountNumeric: sub.saleAmount,
    amountWords: amountToWords(sub.saleAmount.toString()),
    paymentPlan: sub.paymentPlan,
    bookingFee: isInstalment ? sub.deposit : null,
    monthlyInstalment: monthly,
    instalmentMonths: isInstalment ? sub.installmentCount : null,
    instalmentDayOfMonth: isInstalment ? (input.instalmentDayOfMonth ?? null) : null,
    maintenanceStartYear: input.maintenanceStartYear ?? new Date().getFullYear() + 1,
    additionalTerms: input.additionalTerms?.trim() || null,
    applicantWitnessName: input.applicantWitnessName?.trim() || null,
    applicantWitnessNric,
    companyWitnessName: input.companyWitnessName?.trim() || null,
    companyWitnessNric,
  };

  const agreement = sub.ashesAgreement
    ? await prisma.petsAshesAgreement.update({ where: { id: sub.ashesAgreement.id }, data })
    : await prisma.petsAshesAgreement.create({
        data: { ...data, submissionId, createdById: session.user.id },
      });

  await logAudit({
    action: sub.ashesAgreement ? "ashes_agreement.updated" : "ashes_agreement.created",
    entityType: "PetsAshesAgreement",
    entityId: agreement.id,
    actorUserId: session.user.id,
  });
  revalidatePath("/portal/agreements");
  revalidatePath(`/portal/sales/${submissionId}/agreement`);
  return { ok: true, id: agreement.id };
}

/** In-person applicant signature: validates the PNG, marks the agreement
 *  Signed, renders the final PDF and files it into the sale's docket. */
export async function signAshesAgreement(
  submissionId: string,
  signatureDataUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations("errors");
  const { session, sub } = await allowedSubmission(submissionId);
  if (!session || !sub) return { ok: false, error: t("forbidden") };
  // N4: Legacy rows are frozen — no edit at all — once the new flow is live
  // (same design note as editSale/rejectSubmission, server/sales/actions.ts).
  if (env.A17_CLOSED_DEAL_FLOW && sub.flow === SubmissionFlow.Legacy) {
    try {
      await auditTx(prisma, {
        action: "sale.legacy_write_refused", entityType: "SalesSubmission", entityId: submissionId,
        actorUserId: session.user.id, after: { attempted: "signAshesAgreement" },
      });
    } catch (e) {
      if (e instanceof AuditWriteError) return { ok: false, error: t("auditUnavailable") };
      throw e;
    }
    return { ok: false, error: t("legacyReadOnly") };
  }
  const agreement = sub.ashesAgreement;
  if (!agreement) return { ok: false, error: t("notFound") };
  // Superseded (✎6): not re-signable directly — an edit that re-adds the
  // product it needs reinstates it to Draft first. Rejected (owner decision,
  // follow-up to #3): the submission itself is terminal by the time this
  // value exists on a row — rejectSubmission's own CAS (status: Submitted)
  // already makes this unreachable in practice, same distributed-invariant
  // defense-in-depth this function's own comment below already describes;
  // named explicitly here rather than left to fall through to the CAS
  // mismatch further down, matching Signed/Superseded's existing style.
  if (
    agreement.status === AshesAgreementStatus.Signed ||
    agreement.status === AshesAgreementStatus.Superseded ||
    agreement.status === AshesAgreementStatus.Rejected
  ) {
    return { ok: false, error: t("alreadyProcessed") };
  }
  // Defense-in-depth (DevLead review of 0393c0a): nothing currently reaches
  // this function with a Draft agreement outside the editable window — that
  // safety is a distributed invariant across editSale's CAS, verifySale's
  // G3b+G4, and rejectSubmission's CAS, not a property of this function. Same
  // gate as saveAshesAgreement, so this stops relying on the other four.
  if (!isAgreementEditableStatus(sub.flow, sub.status)) return { ok: false, error: t("quotationNotApproved") };

  const m = signatureDataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!m) return { ok: false, error: t("signatureInvalid") };
  const bytes = new Uint8Array(Buffer.from(m[1], "base64"));
  try {
    assertUpload(bytes, ["png"]);
  } catch {
    return { ok: false, error: t("signatureInvalid") };
  }

  // A new key every time, never reused — a re-sign (after a reinstate) must
  // never overwrite an earlier signature image (✎6's "kept as history").
  const signatureKey = `submissions/${submissionId}/${randomUUID()}-signature.png`;
  await putObject(signatureKey, Buffer.from(bytes));

  // A-17 C2/§4: snapshot the terms this signature covers now, so a later
  // money edit can detect drift against exactly this shape (server/sales/
  // actions.ts's ashesTermsChanged uses the identical function).
  //
  // The same record also freezes the company block as printed (name, UEN, GST
  // number, address, phone, email, website) at THIS moment, so the agreement
  // keeps showing what the signer saw even after /admin/company is edited.
  // ashesTermsEqual compares named fields only, so the extra key is invisible
  // to the drift check.
  const companyRow = await prisma.company.findUnique({
    where: { invoicePrefix: AGREEMENT_COMPANY_PREFIX },
    select: { legalName: true, address: true, uen: true, gstRegNo: true, contactEmail: true, phone: true, website: true },
  });
  const signedTerms = { ...ashesTermsSnapshot(sub, sub.lineItems), company: snapshotAgreementCompany(companyRow) };
  // MD B3: amountNumeric/amountWords/paymentPlan/bookingFee/monthlyInstalment
  // are "auto-pushed from the submission" (saveAshesAgreement's own words) —
  // but editSale's void-to-Draft reversion (this same file's caller,
  // server/sales/actions.ts) only clears the signed-* columns, never
  // re-pushes these. A Draft reverted after a money edit could otherwise be
  // re-signed with THESE stale fields while signedTerms above (computed
  // fresh, from this same live `sub`) correctly reflects the new amount —
  // the rendered PDF would show the old money while G3b's drift check
  // (which compares against signedTerms, not these columns) sees no drift at
  // all. Refreshing them here, in the SAME CAS update that flips to Signed,
  // means the signed PDF and signedTerms can never disagree, regardless of
  // whether saveAshesAgreement happened to be called again after the edit.
  const isInstalment = sub.paymentPlan === "Installment";
  const monthlyInstalment = isInstalment && sub.installmentCount
    ? sub.saleAmount.minus(sub.deposit ?? 0).div(sub.installmentCount)
    : null;
  // CAS: only a Draft can be signed, and the flip to Signed IS the claim —
  // two concurrent signs can't both win (count 0 on the loser).
  const cas = await prisma.petsAshesAgreement.updateMany({
    where: { id: agreement.id, status: AshesAgreementStatus.Draft },
    data: {
      status: AshesAgreementStatus.Signed, signedAt: new Date(), applicantSignatureKey: signatureKey, signedTerms,
      amountNumeric: sub.saleAmount, amountWords: amountToWords(sub.saleAmount.toString()),
      paymentPlan: sub.paymentPlan, bookingFee: isInstalment ? sub.deposit : null, monthlyInstalment,
      instalmentMonths: isInstalment ? sub.installmentCount : null,
    },
  });
  if (cas.count !== 1) {
    await deleteObject(signatureKey).catch(() => {});
    return { ok: false, error: t("alreadyProcessed") };
  }

  let pdf: { buffer: Buffer; filename: string } | null;
  try {
    pdf = await renderAshesAgreementPdf(agreement.id);
    if (!pdf) throw new Error("render returned null");
  } catch {
    // Revert only THIS call's own claim (keyed on its own signatureKey), never
    // a concurrent successful sign — and never leave a half-signed row: no
    // pdf key/hash means no real signed document exists yet.
    await prisma.petsAshesAgreement.updateMany({
      where: { id: agreement.id, status: AshesAgreementStatus.Signed, applicantSignatureKey: signatureKey, agreementPdfKey: null },
      data: { status: AshesAgreementStatus.Draft, signedAt: null, applicantSignatureKey: null, signedTerms: Prisma.DbNull },
    });
    await deleteObject(signatureKey).catch(() => {});
    return { ok: false, error: t("signingFailed") };
  }
  // A new key every time (never reused): an old signed file is never
  // overwritten, even across a void/supersede/re-sign cycle (ADR-0001).
  // N2: the object write stays OUTSIDE the transaction, deliberately —
  // an orphaned PDF in storage with no row pointing at it is acceptable
  // (nothing reads storage without a key from the DB first); a row that
  // says Signed with no recorded PDF is not. Don't make the object write
  // transactional; make everything that follows it atomic instead.
  const pdfKey = `submissions/${submissionId}/${randomUUID()}.pdf`;
  await putObject(pdfKey, pdf.buffer);
  const signedPdfSha256 = createHash("sha256").update(pdf.buffer).digest("hex");
  // N2 (reviews/a17-flag-on-preconditions.md §2.4): the pdfKey/hash write,
  // the docket row and the audit used to be three separate statements plus
  // a best-effort logAudit — a crash between any of them left the row
  // Signed with no PDF, in production, for every sale needing a Pet Ash
  // agreement (Legacy or ClosedDeal), regardless of the flag. One
  // transaction now, with auditTx (Tier A) instead of logAudit, so an
  // audit failure rolls back the pdfKey/docket write too rather than
  // leaving an unaudited state change.
  try {
    await prisma.$transaction(async (db) => {
      await db.petsAshesAgreement.update({ where: { id: agreement.id }, data: { agreementPdfKey: pdfKey, signedPdfSha256 } });
      await db.submissionDocument.create({
        data: { submissionId, kind: "Signed", fileKey: pdfKey, fileName: pdf!.filename, uploadedById: session.user.id },
      });
      await auditTx(db, {
        action: "ashes_agreement.signed",
        entityType: "PetsAshesAgreement",
        entityId: agreement.id,
        actorUserId: session.user.id,
      });
    });
  } catch (e) {
    // Same revert-to-Draft shape as the render-failure catch above, keyed
    // on this call's own signatureKey with agreementPdfKey still null — the
    // transaction rolling back is what guarantees that condition still
    // holds here, so this can never revert a row a DIFFERENT, successful
    // sign already attached a PDF to.
    await prisma.petsAshesAgreement.updateMany({
      where: { id: agreement.id, status: AshesAgreementStatus.Signed, applicantSignatureKey: signatureKey, agreementPdfKey: null },
      data: { status: AshesAgreementStatus.Draft, signedAt: null, applicantSignatureKey: null, signedTerms: Prisma.DbNull },
    });
    await deleteObject(signatureKey).catch(() => {});
    if (e instanceof AuditWriteError) return { ok: false, error: t("auditUnavailable") };
    return { ok: false, error: t("signingFailed") };
  }
  revalidatePath("/portal/agreements");
  revalidatePath("/portal/quotations");
  revalidatePath(`/portal/sales/${submissionId}/agreement`);
  return { ok: true };
}
