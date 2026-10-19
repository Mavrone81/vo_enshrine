"use server";

import { createHash } from "crypto";
import { revalidatePath } from "next/cache";
import { format } from "date-fns";
import {
  Prisma, PaymentPlan, SubmissionStatus, SubmissionFlow, AshesAgreementStatus, CommissionEligibility, InvoiceType, InvoiceStatus, ComValueType, SubmissionDocKind, Designation,
  AssociateStatus, ApprovalStatus, QuotationStatus,
} from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { isAdminRole, isFullAdmin } from "@/lib/rbac";
import { isSdApproved, sdApproverId, pickSplitDirectorId, splitFullyApproved } from "@/lib/approval";
import { D, round2, ZERO } from "@/lib/money";
import { ashesTermsSnapshot } from "@/lib/ashes-terms-snapshot";
import { auditTx, AuditWriteError } from "@/lib/audit";
import { runCommission, runCommissionTx, auditRunResultTx, buildCommissionPartiesSnapshot, COMMISSION_TX_OPTIONS } from "@/server/commission/run";
import { getObject, deleteObject } from "@/lib/storage";
import { splitBoundViolations, snapshotCovers, sameViolations, type SplitBoundViolation } from "@/server/commission/split-bounds";
import { validate } from "@/lib/validate";
import { saleSchema } from "@/lib/schemas";
import { addSubmissionDocuments, storeSubmissionUploadBytes, MAX_DOC_BYTES } from "@/server/documents/submission-docs";
import { createAshesDraftTx } from "@/server/agreements/ashes-draft";
import { resolveSaleLines } from "@/server/sales/resolve-sale-lines";
import { VERSION_RESOLUTION_ORDER } from "@/server/commission/version-order";


/**
 * Concurrency-safe transaction code. Postgres serializes `nextval`, so two
 * simultaneous verifications can never mint the same code — unlike the old
 * `count()+1`, where both counted N and both emitted TXN-{N+1}. Takes a tx
 * client so it runs inside approveQuotation's transaction; gaps on rollback are
 * acceptable for an opaque code.
 */

// Audit reliability (reviews/audit-reliability.md, Tier A): every sales money /
// approval action writes its audit in the SAME transaction as the change, so a
// failed audit rolls the change back. `write` does the change; `audits(result)`
// lists what to record (empty when nothing changed, e.g. a CAS that matched no row).
const AUDIT_UNAVAILABLE = Symbol("auditUnavailable");
async function writeAudited<T>(
  write: (db: Prisma.TransactionClient) => Promise<T>,
  audits: (result: T) => Parameters<typeof auditTx>[1][],
): Promise<T | typeof AUDIT_UNAVAILABLE> {
  try {
    return await prisma.$transaction(async (db) => {
      const result = await write(db);
      for (const entry of audits(result)) await auditTx(db, entry);
      return result;
    });
  } catch (e) {
    if (e instanceof AuditWriteError) return AUDIT_UNAVAILABLE;
    throw e;
  }
}

export async function nextTransactionCode(
  db: Prisma.TransactionClient | typeof prisma,
): Promise<string> {
  const rows = await db.$queryRaw<{ nextval: bigint }[]>`SELECT nextval('transaction_code_seq')`;
  const n = Number(rows[0].nextval);
  return `TXN-${String(n).padStart(4, "0")}`;
}

export type SubmitSaleInput = {
  salesDate: string;
  quoteDate?: string;
  clientName: string;
  clientContact?: string;
  paymentPlan: "Full Payment" | "Installment";
  deposit?: number;
  installmentCount?: number;
  lines: { productId: string; lineSaleAmount: number; comCodeIds: string[] }[];
  associate2?: { associateId: string; valueType: "Percentage" | "Absolute"; value: number };
  associate3?: { associateId: string; valueType: "Percentage" | "Absolute"; value: number };
  // A-17 §2: converting a quotation into a transaction. CAS'd Issued -> Converted
  // in the same DB transaction as the submission (see submitSale); the quotation
  // only prefills the form, the submitted lines below stay authoritative.
  quotationId?: string;
  documents?: File[]; // optional supporting documents (16-Jul quotation workflow); not validated by saleSchema
};

/** Thrown inside submitSale's transaction when the CAS finds the quotation
 * already converted/voided, or not owned by this closer — caught by the
 * caller and turned into a normal refusal (never a raw 500). */
class QuotationConvertConflict extends Error {}

/** The submission's split columns from the validated input. */
function splitColumns(
  a2?: { associateId: string; valueType: string; value: number },
  a3?: { associateId: string; valueType: string; value: number },
) {
  return {
    associate2Id: a2?.associateId ?? null, associate2ValueType: a2 ? (a2.valueType as ComValueType) : null, associate2Value: a2 ? round2(a2.value) : null,
    associate3Id: a3?.associateId ?? null, associate3ValueType: a3 ? (a3.valueType as ComValueType) : null, associate3Value: a3 ? round2(a3.value) : null,
  };
}

/** Validation codes from saleSchema refinements that have their own message. */
const SALE_ERROR_CODES = new Set(["splitPercentTooHigh", "splitPartyInvalid"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SEC-6: a split partner must be a real, active, approved, non-archived associate
 * other than the closer (the UI only offered those; the server never checked).
 */
async function splitPartiesError(
  closerId: string,
  a2?: { associateId: string } | null,
  a3?: { associateId: string } | null,
): Promise<"splitPartyInvalid" | null> {
  const ids = [a2?.associateId, a3?.associateId].filter((x): x is string => !!x);
  if (ids.length === 0) return null;
  if (ids.includes(closerId) || new Set(ids).size !== ids.length || !ids.every((i) => UUID_RE.test(i))) return "splitPartyInvalid";
  const ok = await prisma.associate.count({
    where: { id: { in: ids }, associateStatus: AssociateStatus.Active, approvalStatus: ApprovalStatus.Approved, archivedAt: null },
  });
  return ok === ids.length ? null : "splitPartyInvalid";
}

/** A sale that books a negative commission line (B-S6): allowed, but flagged for a split exception. */
export type SplitWarning = { code: "splitExceedsNet"; lines: SplitBoundViolation[] };

export async function submitSale(input: SubmitSaleInput): Promise<{ ok: boolean; error?: string; id?: string; warning?: SplitWarning; transactionCode?: string }> {
  const t = await getTranslations("errors");
  const v = validate(saleSchema, input);
  if (!v.ok) return { ok: false, error: t(v.code && SALE_ERROR_CODES.has(v.code) ? v.code : "invalidInput") };
  const validInput = v.data;

  const session = await auth();
  if (!session?.user.associateId) return { ok: false, error: t("noAssociateProfile") };
  const closerId = session.user.associateId;
  const partyError = await splitPartiesError(closerId, validInput.associate2, validInput.associate3);
  if (partyError) return { ok: false, error: t(partyError) };

  // Split director defaults to the closer's team director (23-Jul, issue 2): the
  // earliest active directed team the closer belongs to (the "first" SD when in
  // several teams); fall back to the nearest upline SD.
  const [teams, closer] = await Promise.all([
    prisma.team.findMany({
      where: { active: true, directorId: { not: null }, members: { some: { associateId: closerId } } },
      orderBy: { createdAt: "asc" },
      select: { directorId: true },
    }),
    prisma.associate.findUnique({
      where: { id: closerId },
      select: {
        directUplineId: true, secondUplineId: true,
        directUpline: { select: { designation: true } },
        secondUpline: { select: { designation: true } },
      },
    }),
  ]);
  const splitDirectorId = pickSplitDirectorId(teams) ?? (closer ? sdApproverId(closer) : null);

  const { lineData, saleAmount, needsAshesAgreement } = await resolveSaleLines(validInput.lines, validInput.salesDate);

  // B-S6 (owner ruling: warn, don't block): a split that would book any commission line below
  // zero is ALLOWED, but flagged — it needs a Business Admin split exception before closing.
  const violations = await splitBoundViolations(prisma, {
    salesDate: new Date(validInput.salesDate), closingAssociateId: closerId, lines: lineData,
    ...splitColumns(validInput.associate2, validInput.associate3),
  });

  // A-17 (design note §3, phase 1): behind the flag, new sales get the
  // ClosedDeal flow — a TXN code assigned immediately, and a Pet Ash draft
  // when a line needs it. Both minted in the same transaction as the
  // submission so neither can exist without the other. Flag off: unchanged.
  const closedDeal = env.A17_CLOSED_DEAL_FLOW;
  const paymentPlan = validInput.paymentPlan === "Installment" ? PaymentPlan.Installment : PaymentPlan.FullPayment;
  const deposit = validInput.deposit ? round2(validInput.deposit) : null;
  const installmentCount = validInput.paymentPlan === "Installment" ? validInput.installmentCount ?? null : null;
  const clientName = validInput.clientName.trim();

  // Tier A (reviews/audit-reliability.md): the sale itself, the split
  // exception flag and A-17's sale.submitted/ashes.generated all record with
  // the write they describe, in the same transaction (writeAudited).
  let result: Awaited<ReturnType<typeof writeAudited<{ id: string; transactionCode: string | null; quotationConverted: boolean }>>>;
  try {
    result = await writeAudited(
    async (db) => {
      const transactionCode = closedDeal ? await nextTransactionCode(db) : null;
      const created = await db.salesSubmission.create({
        select: { id: true },
        data: {
          salesDate: new Date(validInput.salesDate),
          quoteDate: validInput.quoteDate ? new Date(validInput.quoteDate) : null,
          splitDirectorId,
          clientName,
          clientContact: validInput.clientContact?.trim() || null,
          saleAmount,
          paymentPlan,
          deposit,
          installmentCount,
          amountCollected: 0,
          closingAssociateId: closerId,
          associate2Id: validInput.associate2?.associateId ?? null,
          associate2ValueType: validInput.associate2 ? (validInput.associate2.valueType as ComValueType) : null,
          associate2Value: validInput.associate2 ? round2(validInput.associate2.value) : null,
          associate3Id: validInput.associate3?.associateId ?? null,
          associate3ValueType: validInput.associate3 ? (validInput.associate3.valueType as ComValueType) : null,
          associate3Value: validInput.associate3 ? round2(validInput.associate3.value) : null,
          status: SubmissionStatus.Submitted,
          splitExceptionRequired: violations.length > 0,
          lineItems: { create: lineData },
          // L1 (DevLead review): the quotation-conversion flow is A-17 only —
          // ignored entirely (not stored, no CAS) while the flag is off.
          quotationId: closedDeal && validInput.quotationId ? validInput.quotationId : null,
          ...(closedDeal ? { flow: SubmissionFlow.ClosedDeal, transactionCode } : {}),
        },
      });
      if (closedDeal && needsAshesAgreement) {
        await createAshesDraftTx(db, {
          submissionId: created.id, clientName, saleAmount, paymentPlan, deposit, installmentCount,
          createdById: session.user.id,
        });
      }
      let quotationConverted = false;
      if (closedDeal && validInput.quotationId) {
        // CAS: only the closer's own still-Issued, still-valid quotation
        // converts, and only once — a concurrent double-submit (or reusing an
        // already-converted / voided / EXPIRED quotation) loses here and
        // rolls the whole submission back. N6: validUntil was stored on the
        // quotation but never checked anywhere — an expired quote could still
        // convert into a real sale with no gate at all.
        const converted = await db.quotation.updateMany({
          where: {
            id: validInput.quotationId, status: QuotationStatus.Issued, associateId: closerId,
            OR: [{ validUntil: null }, { validUntil: { gte: new Date() } }],
          },
          data: { status: QuotationStatus.Converted },
        });
        if (converted.count !== 1) throw new QuotationConvertConflict();
        quotationConverted = true;
      }
      return { id: created.id, transactionCode, quotationConverted };
    },
    (r) => {
      const entries: Parameters<typeof auditTx>[1][] = [];
      if (violations.length) {
        entries.push({ action: "split.exception_flagged", entityType: "SalesSubmission", entityId: r.id, actorUserId: session.user.id, after: { lines: violations } });
      }
      if (closedDeal) {
        entries.push({ action: "sale.submitted", entityType: "SalesSubmission", entityId: r.id, actorUserId: session.user.id, after: { flow: "ClosedDeal", transactionCode: r.transactionCode, saleAmount: saleAmount.toFixed(2) } });
        if (needsAshesAgreement) {
          entries.push({ action: "ashes.generated", entityType: "SalesSubmission", entityId: r.id, actorUserId: session.user.id });
        }
      }
      if (r.quotationConverted) {
        entries.push({ action: "quotation.converted", entityType: "Quotation", entityId: validInput.quotationId!, actorUserId: session.user.id, after: { submissionId: r.id } });
      }
      return entries;
    },
    );
  } catch (e) {
    if (e instanceof QuotationConvertConflict) return { ok: false, error: t("quotationNotConvertible") };
    throw e;
  }
  if (result === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
  const { id: createdId, transactionCode } = result;

  // Optional supporting documents (freeform) — never fail the sale over a doc.
  if (input.documents?.length) {
    await addSubmissionDocuments(createdId, input.documents, SubmissionDocKind.Supporting, session.user.id);
  }

  revalidatePath("/portal/sales");
  revalidatePath("/admin/quotations");
  if (violations.length) revalidatePath("/admin/split-approvals");
  const txnField = { transactionCode: transactionCode ?? undefined };
  return violations.length
    ? { ok: true, id: createdId, warning: { code: "splitExceedsNet", lines: violations }, ...txnField }
    : { ok: true, id: createdId, ...txnField };
}

/**
 * Edit a still-Submitted sale (Issues v1.0 — My Sales). The closing associate
 * may change client / line / split details until an admin has approved it.
 * Rebuilds the line items + total; supporting documents are managed separately.
 */
export async function editSale(input: SubmitSaleInput & { id: string }): Promise<{ ok: boolean; error?: string; warning?: SplitWarning }> {
  const t = await getTranslations("errors");
  const v = validate(saleSchema, input);
  if (!v.ok) return { ok: false, error: t(v.code && SALE_ERROR_CODES.has(v.code) ? v.code : "invalidInput") };
  const validInput = v.data;

  const session = await auth();
  if (!session?.user.associateId) return { ok: false, error: t("noAssociateProfile") };

  const existing = await prisma.salesSubmission.findUnique({
    where: { id: input.id },
    select: {
      closingAssociateId: true, status: true, salesDate: true, saleAmount: true,
      paymentPlan: true, deposit: true, installmentCount: true, flow: true,
      associate2Id: true, associate2ValueType: true, associate2Value: true,
      associate3Id: true, associate3ValueType: true, associate3Value: true,
      sdApprovedAt: true, splitAdminApprovedAt: true, splitExceptionApprovedAt: true,
      lineItems: { select: { productCode: true, lineSaleAmount: true, selectedComCodes: true } },
      ashesAgreement: { select: { id: true, status: true, signatureVersion: true, signedAt: true, agreementPdfKey: true, applicantSignatureKey: true, signedPdfSha256: true, signedTerms: true } },
    },
  });
  if (!existing) return { ok: false, error: t("notFound") };
  if (existing.closingAssociateId !== session.user.associateId) return { ok: false, error: t("forbidden") };
  // A-17 (design note §3): Legacy rows are frozen — no edit at all — once the
  // new flow is live. Flag off: nothing is Legacy-refused (every row IS
  // Legacy today), so this can never change today's behaviour early.
  const closedDeal = env.A17_CLOSED_DEAL_FLOW;
  if (closedDeal && existing.flow === SubmissionFlow.Legacy) {
    const refused = await writeAudited(
      async () => {},
      () => [{ action: "sale.legacy_write_refused", entityType: "SalesSubmission", entityId: input.id, actorUserId: session.user.id, after: { attempted: "editSale" } }],
    );
    if (refused === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
    return { ok: false, error: t("legacyReadOnly") };
  }
  if (existing.status !== SubmissionStatus.Submitted) return { ok: false, error: t("alreadyProcessed") };
  const partyError = await splitPartiesError(existing.closingAssociateId, validInput.associate2, validInput.associate3);
  if (partyError) return { ok: false, error: t(partyError) };

  const { lineData, saleAmount, needsAshesAgreement: needsAshesAgreementAfter } = await resolveSaleLines(validInput.lines, validInput.salesDate);
  const next = {
    salesDate: new Date(validInput.salesDate),
    quoteDate: validInput.quoteDate ? new Date(validInput.quoteDate) : null,
    clientName: validInput.clientName.trim(),
    clientContact: validInput.clientContact?.trim() || null,
    saleAmount,
    paymentPlan: validInput.paymentPlan === "Installment" ? PaymentPlan.Installment : PaymentPlan.FullPayment,
    deposit: validInput.deposit ? round2(validInput.deposit) : null,
    installmentCount: validInput.paymentPlan === "Installment" ? validInput.installmentCount ?? null : null,
    associate2Id: validInput.associate2?.associateId ?? null,
    associate2ValueType: validInput.associate2 ? (validInput.associate2.valueType as ComValueType) : null,
    associate2Value: validInput.associate2 ? round2(validInput.associate2.value) : null,
    associate3Id: validInput.associate3?.associateId ?? null,
    associate3ValueType: validInput.associate3 ? (validInput.associate3.valueType as ComValueType) : null,
    associate3Value: validInput.associate3 ? round2(validInput.associate3.value) : null,
  };

  // B-S6: re-check the edited sale; still allowed, but flagged when a line would go negative.
  const violations = await splitBoundViolations(prisma, {
    salesDate: next.salesDate, closingAssociateId: existing.closingAssociateId, lines: lineData,
    associate2Id: next.associate2Id, associate2ValueType: next.associate2ValueType, associate2Value: next.associate2Value,
    associate3Id: next.associate3Id, associate3ValueType: next.associate3ValueType, associate3Value: next.associate3Value,
  });

  // SEC-5 / M2: the split approvals (SD + Business Admin) were given for a specific
  // split on specific amounts. If anything that feeds the commission split changes —
  // the split parties/values, the lines (product, amount, add-on codes) or the sales
  // date (which picks the rate version) — those approvals no longer cover the sale
  // and are cleared, so flow A must be approved again before it can close.
  const before = splitTerms(existing);
  const after = splitTerms({ ...next, lineItems: lineData });
  const splitChanged = JSON.stringify(before) !== JSON.stringify(after);
  const hadApproval = !!existing.sdApprovedAt || !!existing.splitAdminApprovedAt;
  const clearApprovals = splitChanged
    ? {
        sdApprovedAt: null, sdApprovedById: null, splitAdminApprovedAt: null, splitAdminApprovedById: null, splitEditedAt: new Date(),
        // B-S6: any split edit voids a split exception too — it was given for the old terms.
        splitExceptionApprovedAt: null, splitExceptionApprovedById: null, splitExceptionReason: null,
        splitExceptionSnapshot: Prisma.DbNull, splitExceptionVersion: null,
      }
    : {};
  const exceptionVoided = splitChanged && !!existing.splitExceptionApprovedAt;

  // A-17 §2/§4 (C2): a term the Pet Ash agreement carries (amount, plan,
  // deposit/booking fee, instalments, products) changed. Client name/contact
  // are deliberately excluded — a non-money correction doesn't void a signature.
  // Computed only when the flag is on: only then does `existing` carry the
  // extra fields this needs (legacy call sites/tests never selected them).
  const ashesChanged = closedDeal && ashesTermsChanged(existing, next, lineData);
  const existingAshes = existing.ashesAgreement;
  let ashesRemoved = false, ashesCreated = false;

  // Sale amount lock (PD ruling, settled after three revisions): once the Pet
  // Ash agreement carries a real signature — status is anything but Draft,
  // Signed OR Superseded both lock — an amount-changing edit is refused
  // outright, never silently voided and resigned. Scoped to the amount only:
  // a non-money term change (plan/deposit/products) still legitimately goes
  // through the C2 void-and-resign path below.
  //
  // Why this check exists independently of the Submitted-only gate above:
  // editSale already refuses once the submission leaves Submitted (admin
  // quotation approval for Legacy, verifySale for ClosedDeal) — that's the
  // primary lock point and this does not widen it. But a ClosedDeal sale's
  // status stays Submitted all the way through the client's e-signature
  // (approveQuotation refuses ClosedDeal rows; the only admin step is
  // verifySale, which happens later) — so without this second, independent
  // check, the window between "client signed" and "admin verified" lets the
  // closing associate alone edit the amount and auto-void a REAL signature,
  // with no admin step at all. Defence in depth: this reads the agreement's
  // OWN status, never a SubmissionDocument's existence (uploadDocketDocuments
  // can create one at any point with no real signature and no status gate).
  if (closedDeal && existingAshes && existingAshes.status !== AshesAgreementStatus.Draft) {
    const amountChanged = D(existing.saleAmount).toFixed(2) !== D(next.saleAmount).toFixed(2);
    if (amountChanged) {
      const refused = await writeAudited(
        async () => {},
        () => [{ action: "sale.amount_edit_locked", entityType: "SalesSubmission", entityId: input.id, actorUserId: session.user.id, after: { agreementStatus: existingAshes.status } }],
      );
      if (refused === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
      return { ok: false, error: t("amountLocked") };
    }
  }

  // Architect ✎6: any void/supersede audit carries the PRIOR key/hash/version/
  // terms — it's the only pointer back to the file being superseded, since
  // re-signing overwrites those columns on this 1:1 row. Never the raw NRIC-free
  // signedTerms payload itself, just a hash of it (still no PII, but smaller).
  const priorSignedSnapshot = (a: NonNullable<typeof existingAshes>) => ({
    agreementPdfKey: a.agreementPdfKey,
    applicantSignatureKey: a.applicantSignatureKey,
    signedPdfSha256: a.signedPdfSha256,
    signatureVersion: a.signatureVersion,
    signedTermsHash: a.signedTerms ? createHash("sha256").update(JSON.stringify(a.signedTerms)).digest("hex") : null,
  });

  try {
    await prisma.$transaction(async (db) => {
      // Compare-and-swap: only a still-Submitted sale of this closer is edited, so an
      // approval of the quotation landing after the read above can't be edited past.
      const res = await db.salesSubmission.updateMany({
        where: { id: input.id, closingAssociateId: session.user.associateId!, status: SubmissionStatus.Submitted },
        data: { ...next, ...clearApprovals, splitExceptionRequired: violations.length > 0, contentVersion: { increment: 1 } },
      });
      if (res.count !== 1) throw new EditConflict();
      await db.saleLineItem.deleteMany({ where: { submissionId: input.id } });
      await db.saleLineItem.createMany({ data: lineData.map((l) => ({ ...l, submissionId: input.id })) });

      // Tier A: the edit (and any approvals it cleared / exception it voided or
      // flagged) is recorded in the same transaction.
      await auditTx(db, {
        action: "sale.edited", entityType: "SalesSubmission", entityId: input.id, actorUserId: session.user.id,
        before, after: { ...after, splitChanged, approvalsCleared: splitChanged && hadApproval },
      });
      if (exceptionVoided) {
        await auditTx(db, { action: "split.exception_voided", entityType: "SalesSubmission", entityId: input.id, actorUserId: session.user.id, after: { reason: "edit" } });
      }
      if (violations.length && splitChanged) {
        await auditTx(db, { action: "split.exception_flagged", entityType: "SalesSubmission", entityId: input.id, actorUserId: session.user.id, after: { lines: violations } });
      }

      if (closedDeal && existingAshes) {
        let effectiveStatus = existingAshes.status;
        // DevLead (33f975f review): signatureVersion, not signedAt, is the
        // durable "once signed" marker — void/reinstate below clear signedAt
        // (and every other signed-* column) so a re-sign never inherits the
        // PREVIOUS signing's pdf key/hash/terms.
        const everSigned = existingAshes.signatureVersion > 0 || existingAshes.signedAt !== null;
        // Clears every signed-* column so a re-sign starts from a genuinely
        // clean Draft — signAshesAgreement's own revert-on-failure guard
        // (agreementPdfKey: null) only works if this row actually has one.
        const clearSignedColumns = { agreementPdfKey: null, signedPdfSha256: null, signedTerms: Prisma.DbNull, applicantSignatureKey: null, signedAt: null };

        // C2: still needed, but a term the signature covers changed — re-sign.
        if (effectiveStatus === AshesAgreementStatus.Signed && ashesChanged && needsAshesAgreementAfter) {
          await auditTx(db, {
            action: "ashes.signature_voided", entityType: "PetsAshesAgreement", entityId: existingAshes.id, actorUserId: session.user.id,
            before: priorSignedSnapshot(existingAshes), after: { signatureVersion: existingAshes.signatureVersion + 1 },
          });
          await db.petsAshesAgreement.update({ where: { id: existingAshes.id }, data: { status: AshesAgreementStatus.Draft, signatureVersion: { increment: 1 }, ...clearSignedColumns } });
          effectiveStatus = AshesAgreementStatus.Draft;
        }

        // ✎6: a once-signed row that's no longer needed at all → Superseded,
        // never hard-deleted, never left as a misleading "still needs signing" Draft.
        // Its signed-* columns are deliberately NOT cleared here — Superseded IS
        // the preserved historical record (unlike void/reinstate, which are about
        // to be re-signed).
        if (everSigned && effectiveStatus !== AshesAgreementStatus.Superseded && !needsAshesAgreementAfter) {
          await auditTx(db, {
            action: "ashes.superseded", entityType: "PetsAshesAgreement", entityId: existingAshes.id, actorUserId: session.user.id,
            before: priorSignedSnapshot(existingAshes), after: { status: "Superseded" },
          });
          await db.petsAshesAgreement.update({ where: { id: existingAshes.id }, data: { status: AshesAgreementStatus.Superseded } });
          effectiveStatus = AshesAgreementStatus.Superseded;
        } else if (effectiveStatus === AshesAgreementStatus.Superseded && needsAshesAgreementAfter) {
          // ✎6: reinstated — a product that needs it came back. The prior
          // signed snapshot (still intact on a Superseded row) goes in the
          // audit before it's cleared for the coming re-sign.
          await auditTx(db, {
            action: "ashes.reinstated", entityType: "PetsAshesAgreement", entityId: existingAshes.id, actorUserId: session.user.id,
            before: priorSignedSnapshot(existingAshes), after: { status: "Draft", signatureVersion: existingAshes.signatureVersion + 1 },
          });
          await db.petsAshesAgreement.update({ where: { id: existingAshes.id }, data: { status: AshesAgreementStatus.Draft, signatureVersion: { increment: 1 }, ...clearSignedColumns } });
          effectiveStatus = AshesAgreementStatus.Draft;
        }

        // Never hard-delete a row that has ever carried a real signature — it's
        // Superseded by now instead. Only a never-signed Draft is deleted outright.
        if (effectiveStatus === AshesAgreementStatus.Draft && !everSigned && !needsAshesAgreementAfter) {
          await db.petsAshesAgreement.delete({ where: { id: existingAshes.id } });
          ashesRemoved = true;
        }
      } else if (closedDeal && !existingAshes && needsAshesAgreementAfter) {
        await createAshesDraftTx(db, {
          submissionId: input.id, clientName: next.clientName, saleAmount: next.saleAmount,
          paymentPlan: next.paymentPlan, deposit: next.deposit, installmentCount: next.installmentCount,
          createdById: session.user.id,
        });
        ashesCreated = true;
      }
      // Tier A: both ashes side-effects are recorded in the same transaction too.
      if (ashesRemoved) {
        await auditTx(db, { action: "ashes.draft_removed", entityType: "PetsAshesAgreement", entityId: existingAshes!.id, actorUserId: session.user.id });
      }
      if (ashesCreated) {
        await auditTx(db, { action: "ashes.generated", entityType: "SalesSubmission", entityId: input.id, actorUserId: session.user.id });
      }
    });
  } catch (e) {
    if (e instanceof EditConflict) return { ok: false, error: t("alreadyProcessed") };
    if (e instanceof AuditWriteError) return { ok: false, error: t("auditUnavailable") };
    throw e;
  }
  revalidatePath("/portal/sales");
  revalidatePath(`/portal/sales/${input.id}`);
  if (splitChanged && (hadApproval || violations.length)) {
    revalidatePath("/portal/approvals");
    revalidatePath("/admin/split-approvals");
  }
  return violations.length ? { ok: true, warning: { code: "splitExceedsNet", lines: violations } } : { ok: true };
}

/** A-17 C2: has a term the Pet Ash agreement carries changed? */
function ashesTermsChanged(
  before: { saleAmount: Prisma.Decimal; paymentPlan: PaymentPlan; deposit: Prisma.Decimal | null; installmentCount: number | null; lineItems: { productCode: string }[] },
  after: { saleAmount: Prisma.Decimal; paymentPlan: PaymentPlan; deposit: Prisma.Decimal | null; installmentCount: number | null },
  afterLines: { productCode: string }[],
): boolean {
  return !ashesTermsEqual(ashesTermsSnapshot(before, before.lineItems), ashesTermsSnapshot(after, afterLines));
}

/**
 * Field-by-field, never JSON.stringify — a snapshot read back from a jsonb
 * column (G3b: `signedTerms`) can have its object keys reordered by Postgres,
 * so a naive string comparison against a freshly-computed snapshot can differ
 * only in key order and wrongly read as "changed".
 */
function ashesTermsEqual(a: ReturnType<typeof ashesTermsSnapshot> | null | undefined, b: ReturnType<typeof ashesTermsSnapshot>): boolean {
  if (!a) return false;
  return a.saleAmount === b.saleAmount && a.paymentPlan === b.paymentPlan && a.deposit === b.deposit
    && a.installmentCount === b.installmentCount && JSON.stringify(a.products) === JSON.stringify(b.products);
}

class EditConflict extends Error {}

/**
 * After a missed approval compare-and-swap: true when someone already approved the
 * SAME split version (a double click / two approvers at once — idempotent success),
 * false when the split was edited since the page was rendered.
 */
async function sameTermsAlready(id: string, seen: Date | null, step: "sd" | "admin"): Promise<boolean> {
  const now = await prisma.salesSubmission.findUnique({
    where: { id }, select: { splitEditedAt: true, sdApprovedAt: true, splitAdminApprovedAt: true },
  });
  if (!now) return false;
  const sameVersion = (now.splitEditedAt?.getTime() ?? null) === (seen?.getTime() ?? null);
  return sameVersion && (step === "sd" ? now.sdApprovedAt !== null : now.splitAdminApprovedAt !== null);
}

/** The splitEditedAt an approver's page rendered (ISO string, or null = never edited). */
function seenAt(v: string | null | undefined): Date | null | "invalid" {
  if (v === null || v === undefined) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

type SplitSource = {
  salesDate: Date; saleAmount: Prisma.Decimal | string | number;
  associate2Id: string | null; associate2ValueType: ComValueType | null; associate2Value: Prisma.Decimal | string | number | null;
  associate3Id: string | null; associate3ValueType: ComValueType | null; associate3Value: Prisma.Decimal | string | number | null;
  lineItems: { productCode: string; lineSaleAmount: Prisma.Decimal | string | number; selectedComCodes?: unknown }[];
};

/** The commission-relevant terms of a sale, normalised so before/after compare exactly (and audit cleanly). */
function splitTerms(s: SplitSource) {
  const money = (v: Prisma.Decimal | string | number | null) => (v === null ? null : D(v).toFixed(2));
  const codes = (c: unknown) =>
    (Array.isArray(c) ? c : []).map((x) => String((x as { comCode?: unknown }).comCode ?? "")).sort();
  return {
    salesDate: format(s.salesDate, "yyyy-MM-dd"),
    saleAmount: money(s.saleAmount),
    associate2: s.associate2Id ? { id: s.associate2Id, type: s.associate2ValueType, value: money(s.associate2Value) } : null,
    associate3: s.associate3Id ? { id: s.associate3Id, type: s.associate3ValueType, value: money(s.associate3Value) } : null,
    lines: s.lineItems
      .map((l) => ({ product: l.productCode, amount: money(l.lineSaleAmount), codes: codes(l.selectedComCodes) }))
      .sort((a, b) => (a.product + a.amount).localeCompare(b.product + b.amount)),
  };
}

/**
 * SD approval of a submission's share-com split (16-Jul §4). The team SD (or a
 * Business Admin) approves; after 3 days it auto-approves without this call.
 * Idempotent; only valid while the submission is still Submitted.
 */
export async function approveSubmissionSplit(
  submissionId: string,
  seenSplitEditedAt: string | null = null,
): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations("errors");
  const session = await auth();
  if (!session) return { ok: false, error: t("forbidden") };

  const sub = await prisma.salesSubmission.findUnique({ where: { id: submissionId }, select: { status: true, sdApprovedAt: true, closingAssociateId: true, closedAt: true, splitEditedAt: true } });
  if (!sub) return { ok: false, error: t("notFound") };

  // Approval follows the team (16-Jul §7): a Business Admin, or a Director of a
  // team the closer belongs to, may approve the split.
  let allowed = isFullAdmin(session.user.role);
  if (!allowed && session.user.associateId) {
    const team = await prisma.team.findFirst({
      where: { directorId: session.user.associateId, active: true, members: { some: { associateId: sub.closingAssociateId } } },
      select: { id: true },
    });
    allowed = !!team;
  }
  if (!allowed) return { ok: false, error: t("forbidden") };

  // Flow A (split) runs in parallel with flow B (quotation), so the SD step stays
  // open until the sale closes — same window as adminApproveSplit. This matters when
  // an edit cleared the split approvals after the quotation was already approved
  // (SEC-5): the SD must still be able to re-approve rather than wait for the 3-day auto.
  if (sub.status === SubmissionStatus.Rejected || sub.closedAt) return { ok: false, error: t("alreadyProcessed") };
  if (sub.sdApprovedAt) { revalidatePath("/admin/quotations"); return { ok: true }; }

  // SA-1: approve only the split terms the approver saw. The page sends the
  // splitEditedAt it rendered; if the closer edited the split since, the approval is
  // refused (compare-and-swap), so a stale page can't approve terms nobody saw.
  const seen = seenAt(seenSplitEditedAt);
  if (seen === "invalid") return { ok: false, error: t("splitChangedReload") };
  const res = await writeAudited(
    (db) => db.salesSubmission.updateMany({
      where: { id: submissionId, sdApprovedAt: null, splitEditedAt: seen },
      data: { sdApprovedAt: new Date(), sdApprovedById: session.user.id },
    }),
    (r) => (r.count ? [{ action: "submission.sd_approved", entityType: "SalesSubmission", entityId: submissionId, actorUserId: session.user.id }] : []),
  );
  if (res === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
  if (res.count === 0) return (await sameTermsAlready(submissionId, seen, "sd")) ? { ok: true } : { ok: false, error: t("splitChangedReload") };
  revalidatePath("/admin/quotations");
  revalidatePath("/portal/approvals");
  return { ok: true };
}

/**
 * Revert a split approval (Issues v1.0 — Split Approvals). The Director (or a
 * Business Admin) may undo their approval as long as the admin has not yet
 * approved the quotation (status still Submitted). Same team-based permission as
 * approving. Clears the approval stamp so it returns to the pending queue.
 */
export async function revertSplitApproval(submissionId: string): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations("errors");
  const session = await auth();
  if (!session) return { ok: false, error: t("forbidden") };

  const sub = await prisma.salesSubmission.findUnique({ where: { id: submissionId }, select: { status: true, sdApprovedAt: true, splitAdminApprovedAt: true, closingAssociateId: true } });
  if (!sub) return { ok: false, error: t("notFound") };

  let allowed = isFullAdmin(session.user.role);
  if (!allowed && session.user.associateId) {
    const team = await prisma.team.findFirst({
      where: { directorId: session.user.associateId, active: true, members: { some: { associateId: sub.closingAssociateId } } },
      select: { id: true },
    });
    allowed = !!team;
  }
  if (!allowed) return { ok: false, error: t("forbidden") };

  if (sub.status !== SubmissionStatus.Submitted) return { ok: false, error: t("alreadyProcessed") };
  if (!sub.sdApprovedAt) return { ok: false, error: t("alreadyProcessed") };
  // Once the Business Admin has signed off the split, the SD step is locked.
  if (sub.splitAdminApprovedAt) return { ok: false, error: t("alreadyProcessed") };

  const reverted = await writeAudited(
    (db) => db.salesSubmission.update({ where: { id: submissionId }, data: { sdApprovedAt: null, sdApprovedById: null } }),
    () => [{ action: "submission.split_reverted", entityType: "SalesSubmission", entityId: submissionId, actorUserId: session.user.id }],
  );
  if (reverted === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
  revalidatePath("/portal/approvals");
  revalidatePath("/admin/quotations");
  return { ok: true };
}

/**
 * Business Admin signs off the share-com split (23-Jul parallel workflow, flow
 * A step 2). Follows the SD's approval (or the 3-day auto-approve); this is the
 * second, admin step shown on /admin/split-approvals. When the SD step only
 * auto-approved (never an explicit SD action), stamp sdApprovedAt now as a
 * system approval so the split's history is complete. Idempotent; only valid
 * while the sale is unclosed (no transaction yet).
 */
export async function adminApproveSplit(
  submissionId: string,
  seenSplitEditedAt: string | null = null,
): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations("errors");
  const session = await auth();
  if (!session || !isAdminRole(session.user.role)) return { ok: false, error: t("forbidden") };

  const sub = await prisma.salesSubmission.findUnique({
    where: { id: submissionId },
    select: { status: true, sdApprovedAt: true, createdAt: true, splitEditedAt: true, splitAdminApprovedAt: true, splitDirectorId: true, closedAt: true },
  });
  if (!sub) return { ok: false, error: t("notFound") };
  if (sub.status === SubmissionStatus.Rejected || sub.closedAt) return { ok: false, error: t("alreadyProcessed") };
  if (sub.splitAdminApprovedAt) { revalidatePath("/admin/split-approvals"); return { ok: true }; }

  // The admin step opens once the SD step has landed (explicit or 3-day auto).
  // A sale with no SD assigned has no one to wait on, so the admin may sign off
  // straight away (the sdApprovedAt stamp below records it as a system approval).
  if (sub.splitDirectorId && !isSdApproved(sub).approved) return { ok: false, error: t("pendingSdApproval") };

  // SA-1: compare-and-swap on the splitEditedAt the admin's page rendered.
  const seen = seenAt(seenSplitEditedAt);
  if (seen === "invalid") return { ok: false, error: t("splitChangedReload") };
  const res = await writeAudited(
    (db) => db.salesSubmission.updateMany({
      where: { id: submissionId, splitAdminApprovedAt: null, splitEditedAt: seen },
      data: {
        splitAdminApprovedAt: new Date(),
        splitAdminApprovedById: session.user.id,
        // If it was never explicitly SD-approved (3-day auto), record the auto now.
        ...(sub.sdApprovedAt === null ? { sdApprovedAt: new Date() } : {}),
      },
    }),
    (r) => (r.count
      ? [
          ...(sub.sdApprovedAt === null ? [{ action: "submission.sd_approved", entityType: "SalesSubmission", entityId: submissionId, actorUserId: null, after: { auto: true } }] : []),
          { action: "submission.split_admin_approved", entityType: "SalesSubmission", entityId: submissionId, actorUserId: session.user.id },
        ]
      : []),
  );
  if (res === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
  if (res.count === 0) return (await sameTermsAlready(submissionId, seen, "admin")) ? { ok: true } : { ok: false, error: t("splitChangedReload") };
  revalidatePath("/admin/split-approvals");
  revalidatePath("/portal/quotations");
  return { ok: true };
}

/**
 * B-S6: a Business Admin approves a sale whose split books a commission line below zero
 * (owner ruling 2026-09-26: warn, don't block — but require admin approval). Business Admin only
 * (not Accounts), a reason is required, and the approval is bound to (a) the split version
 * the admin's page rendered (SA-1 style CAS on splitEditedAt) and (b) a snapshot of the
 * negative lines as computed NOW, which closeSale re-checks with the rates then in force.
 */
export async function approveSplitException(
  submissionId: string,
  reason: string,
  seenSplitEditedAt: string | null,
  seenLines: SplitBoundViolation[],
): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations("errors");
  const session = await auth();
  if (!session || !isFullAdmin(session.user.role)) return { ok: false, error: t("forbidden") };
  const why = (reason ?? "").trim();
  if (why.length < 5 || why.length > 500) return { ok: false, error: t("splitExceptionReasonRequired") };
  const seen = seenAt(seenSplitEditedAt);
  if (seen === "invalid") return { ok: false, error: t("splitChangedReload") };

  const sub = await prisma.salesSubmission.findUnique({
    where: { id: submissionId },
    include: { lineItems: true },
  });
  if (!sub) return { ok: false, error: t("notFound") };
  if (sub.status === SubmissionStatus.Rejected || sub.closedAt) return { ok: false, error: t("alreadyProcessed") };

  const violations = await splitBoundViolations(prisma, {
    salesDate: sub.salesDate, closingAssociateId: sub.closingAssociateId, lines: sub.lineItems,
    associate2Id: sub.associate2Id, associate2ValueType: sub.associate2ValueType, associate2Value: sub.associate2Value,
    associate3Id: sub.associate3Id, associate3ValueType: sub.associate3ValueType, associate3Value: sub.associate3Value,
  });
  if (violations.length === 0) {
    // Nothing negative any more (e.g. rates changed in the associate's favour): clear the flag.
    const cleared = await writeAudited(
      (db) => db.salesSubmission.updateMany({ where: { id: submissionId, splitEditedAt: seen }, data: { splitExceptionRequired: false } }),
      (r) => (r.count ? [{ action: "split.exception_cleared", entityType: "SalesSubmission", entityId: submissionId, actorUserId: session.user.id, after: { reason: "no_negative_lines" } }] : []),
    );
    if (cleared === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
    revalidatePath("/admin/split-approvals");
    return { ok: true };
  }
  // E1: approve exactly the figures the admin saw. If the recompute differs from what the page
  // rendered (rates or upline eligibility changed since), refuse; the admin must review again.
  if (!Array.isArray(seenLines) || !sameViolations(violations, seenLines)) {
    return { ok: false, error: t("splitFiguresChanged") };
  }

  const res = await writeAudited(
    (db) => db.salesSubmission.updateMany({
      where: { id: submissionId, splitEditedAt: seen, closedAt: null, status: { not: SubmissionStatus.Rejected } },
      data: {
        splitExceptionRequired: true,
        splitExceptionApprovedAt: new Date(),
        splitExceptionApprovedById: session.user.id,
        splitExceptionReason: why,
        splitExceptionSnapshot: violations as unknown as Prisma.InputJsonValue,
        splitExceptionVersion: seen,
      },
    }),
    // N4: record both admin actors, so "same person approved the split and the exception" is visible.
    (r) => (r.count
      ? [{
          action: "split.exception_approved", entityType: "SalesSubmission", entityId: submissionId, actorUserId: session.user.id,
          after: { reason: why, snapshot: violations as unknown as Prisma.InputJsonValue, splitAdminApprovedById: sub.splitAdminApprovedById, sameApproverAsSplit: sub.splitAdminApprovedById === session.user.id },
        }]
      : []),
  );
  if (res === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
  if (res.count === 0) return { ok: false, error: t("splitChangedReload") };
  revalidatePath("/admin/split-approvals");
  revalidatePath(`/portal/sales/${submissionId}`);
  return { ok: true };
}

/**
 * Reassign a submission's split Sales Director (23-Jul, issue 2 add-on). The SD
 * is defaulted from the closer's team at submission; if it routed to the wrong
 * director (leave, wrong team) a Business Admin can point it at another SD — but
 * only while that SD step is still open (the SD hasn't approved, it hasn't
 * auto-approved, and the sale isn't admin-signed / closed / rejected). Pass null
 * to clear it (falls through to the 3-day auto + admin sign-off).
 */
export async function reassignSplitDirector(submissionId: string, directorId: string | null): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations("errors");
  const session = await auth();
  if (!session || !isAdminRole(session.user.role)) return { ok: false, error: t("forbidden") };

  const sub = await prisma.salesSubmission.findUnique({
    where: { id: submissionId },
    select: { status: true, sdApprovedAt: true, splitAdminApprovedAt: true, closedAt: true },
  });
  if (!sub) return { ok: false, error: t("notFound") };
  if (sub.status === SubmissionStatus.Rejected || sub.closedAt || sub.splitAdminApprovedAt || sub.sdApprovedAt) {
    return { ok: false, error: t("alreadyProcessed") };
  }

  // The target must be an active, approved Sales Director (or null to clear).
  if (directorId) {
    const dir = await prisma.associate.findFirst({
      where: { id: directorId, designation: Designation.SalesDirector, associateStatus: "Active", approvalStatus: "Approved", archivedAt: null },
      select: { id: true },
    });
    if (!dir) return { ok: false, error: t("notADirector") };
  }

  const reassigned = await writeAudited(
    (db) => db.salesSubmission.update({ where: { id: submissionId }, data: { splitDirectorId: directorId } }),
    () => [{ action: "submission.split_director_reassigned", entityType: "SalesSubmission", entityId: submissionId, actorUserId: session.user.id, after: { splitDirectorId: directorId } }],
  );
  if (reassigned === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
  revalidatePath("/admin/split-approvals");
  revalidatePath("/portal/approvals");
  return { ok: true };
}

/**
 * Business Admin approves the rep's right to generate the quotation (23-Jul
 * parallel workflow, flow B). Runs in PARALLEL with split approval — it is NOT
 * gated on the split — after the admin has reviewed the uploaded documents. This
 * only unlocks generation (status → QuotationApproved); the SalesTransaction /
 * commission ledger / invoice are minted later, when the rep closes the sale.
 */
export async function approveQuotation(submissionId: string): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations("errors");
  const session = await auth();
  if (!session || !isAdminRole(session.user.role)) return { ok: false, error: t("forbidden") };

  const sub = await prisma.salesSubmission.findUnique({ where: { id: submissionId }, select: { status: true, flow: true } });
  if (!sub) return { ok: false, error: t("notFound") };
  // MD B1: this is the OLD quotation workflow — it has no verifySale gate
  // (G3/G3b/G4/G5), doesn't freeze commissionParties, and closeSale below
  // would mint a SECOND transaction code for a row that flow=ClosedDeal is
  // meant to close through the new flow instead. A ClosedDeal row must never
  // reach QuotationApproved via this path.
  //
  // NOT the same condition as N4's Legacy-frozen check elsewhere in this
  // file: this refuses ClosedDeal; N4 refuses Legacy once the flag is on. A
  // flow=Legacy row deliberately STAYS OPEN here — the owner confirmed (28 Sep,
  // reviews/a17-flag-on-preconditions.md §3) that an in-flight Legacy sale
  // may finish through this same old workflow after the flag flips, losing
  // only edit/reject, not approve/close. One refusal and one deliberate
  // non-refusal, same function, different flows — not a gap.
  if (env.A17_CLOSED_DEAL_FLOW && sub.flow === SubmissionFlow.ClosedDeal) {
    const refused = await writeAudited(
      async () => {},
      () => [{ action: "sale.closed_deal_flow_required", entityType: "SalesSubmission", entityId: submissionId, actorUserId: session.user.id, after: { attempted: "approveQuotation" } }],
    );
    if (refused === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
    // Distinct key from editSale/rejectSubmission's legacyReadOnly (a
    // different condition — Legacy-frozen, not ClosedDeal-must-use-verifySale)
    // to avoid a catalogue key collision with release/a17-03-ui, which adds
    // its own legacyReadOnly wording. Same text for now; semantics and final
    // wording per the 4-meaning key audit are deferred to follow-up F1 — this
    // is only the minimal duplicate-key fix, not a considered naming ruling.
    return { ok: false, error: t("flowNotAvailable") };
  }
  if (sub.status !== SubmissionStatus.Submitted) return { ok: false, error: t("alreadyProcessed") };

  const approved = await writeAudited(
    (db) => db.salesSubmission.update({ where: { id: submissionId }, data: { status: SubmissionStatus.QuotationApproved } }),
    () => [{ action: "submission.quotation_approved", entityType: "SalesSubmission", entityId: submissionId, actorUserId: session.user.id }],
  );
  if (approved === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
  revalidatePath("/admin/quotations");
  revalidatePath("/portal/quotations");
  return { ok: true };
}

/**
 * The closing associate closes the sale (23-Jul parallel workflow, issue 4).
 * Requires BOTH flows complete — quotation generation approved (status
 * QuotationApproved) AND the split fully approved (SD + admin) — plus a signed
 * quotation in the docket. This is where the money artifacts are minted: the
 * SalesTransaction + commission ledger (PendingCollection) and, for a full
 * payment, an OUTSTANDING invoice per company entity; installments get a
 * schedule. Commission becomes payable later, when the admin marks it Paid in
 * Sales & Verify. Idempotent — a sale that already has a transaction is a no-op.
 */
export async function closeSale(submissionId: string): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations("errors");
  const session = await auth();
  if (!session) return { ok: false, error: t("forbidden") };

  const sub = await prisma.salesSubmission.findUnique({
    where: { id: submissionId },
    include: {
      lineItems: true,
      transaction: { select: { id: true } },
      closingAssociate: {
        include: {
          directUpline: { select: { designation: true } },
          secondUpline: { select: { designation: true } },
        },
      },
      _count: { select: { documents: { where: { kind: SubmissionDocKind.Signed } } } },
    },
  });
  if (!sub) return { ok: false, error: t("notFound") };

  // Only the closing associate (or an admin) may close the sale.
  const isCloser = !!session.user.associateId && session.user.associateId === sub.closingAssociateId;
  if (!isCloser && !isAdminRole(session.user.role)) return { ok: false, error: t("forbidden") };

  // MD B1: closeSale is the OLD quotation workflow's minting path — no
  // verifySale gate (G3/G3b/G4/G5), no commissionParties freeze, and it mints
  // its own transaction code below. verifySale is the ONLY minting path for
  // flow=ClosedDeal (its own salesTransaction.create, separate from this
  // one) — closeSale must never reach a ClosedDeal row at all, so this comes
  // before even the idempotency short-circuit below.
  //
  // NOT the same condition as N4's Legacy-frozen check elsewhere in this
  // file: this refuses ClosedDeal; a flow=Legacy row deliberately STAYS OPEN
  // here — the owner confirmed (28 Sep, reviews/a17-flag-on-preconditions.md
  // §3) an in-flight Legacy sale may still close through this same old
  // workflow after the flag flips, losing only edit/reject. One refusal and
  // one deliberate non-refusal, same function, different flows — not a gap.
  if (env.A17_CLOSED_DEAL_FLOW && sub.flow === SubmissionFlow.ClosedDeal) {
    const refused = await writeAudited(
      async () => {},
      () => [{ action: "sale.closed_deal_flow_required", entityType: "SalesSubmission", entityId: submissionId, actorUserId: session.user.id, after: { attempted: "closeSale" } }],
    );
    if (refused === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
    // Distinct key — see the same note in approveQuotation above.
    return { ok: false, error: t("flowNotAvailable") };
  }

  if (sub.transaction) { revalidatePath("/portal/quotations"); return { ok: true }; } // already closed
  if (sub.status !== SubmissionStatus.QuotationApproved) return { ok: false, error: t("quotationNotApproved") };
  if (!splitFullyApproved(sub)) return { ok: false, error: t("splitNotApproved") };
  if (sub._count.documents === 0) return { ok: false, error: t("signedDocRequired") };

  // SEC-6: authoritative bound at closing, with the rates in force on the sales date —
  // a split larger than Net-to-Closer would otherwise book a negative closer line.
  const violations = await splitBoundViolations(prisma, {
    salesDate: sub.salesDate, closingAssociateId: sub.closingAssociateId, lines: sub.lineItems,
    associate2Id: sub.associate2Id, associate2ValueType: sub.associate2ValueType, associate2Value: sub.associate2Value,
    associate3Id: sub.associate3Id, associate3ValueType: sub.associate3ValueType, associate3Value: sub.associate3Value,
  });
  // B-S6: negative lines are allowed only under a split exception that still covers the
  // sale as it books NOW — same split version, and every negative line within the approved
  // snapshot (not new, not deeper, e.g. after a rate change). Otherwise the exception is
  // voided and a fresh Business Admin approval is needed.
  if (violations.length) {
    const approved = sub.splitExceptionApprovedAt !== null
      && (sub.splitExceptionVersion?.getTime() ?? null) === (sub.splitEditedAt?.getTime() ?? null)
      && snapshotCovers(violations, sub.splitExceptionSnapshot as SplitBoundViolation[] | null);
    if (!approved) {
      const refused = await writeAudited(
        async (db) => {
          if (sub.splitExceptionApprovedAt !== null) {
            return (await db.salesSubmission.updateMany({
              where: { id: sub.id, splitExceptionApprovedAt: sub.splitExceptionApprovedAt },
              data: { splitExceptionApprovedAt: null, splitExceptionApprovedById: null, splitExceptionReason: null, splitExceptionSnapshot: Prisma.DbNull, splitExceptionVersion: null, splitExceptionRequired: true },
            })).count > 0;
          }
          if (!sub.splitExceptionRequired) await db.salesSubmission.update({ where: { id: sub.id }, data: { splitExceptionRequired: true } });
          return false;
        },
        (voided) => [
          ...(voided ? [{ action: "split.exception_voided", entityType: "SalesSubmission", entityId: sub.id, actorUserId: session.user.id, after: { reason: "rates_changed", lines: violations as unknown as Prisma.InputJsonValue } }] : []),
          { action: "sale.close_refused", entityType: "SalesSubmission", entityId: sub.id, actorUserId: session.user.id, after: { reason: "splitExceptionRequired", violations: violations as unknown as Prisma.InputJsonValue } },
        ],
      );
      if (refused === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
      revalidatePath("/admin/split-approvals");
      return { ok: false, error: t("splitExceptionRequired") };
    }
  }

  const closer = sub.closingAssociate;
  const fullPayment = sub.paymentPlan === PaymentPlan.FullPayment;

  let txId: string;
  try {
  txId = await prisma.$transaction(async (db) => {
    const code = await nextTransactionCode(db);

    const transaction = await db.salesTransaction.create({
      data: {
        transactionCode: code,
        submissionId: sub.id,
        salesDate: sub.salesDate,
        clientName: sub.clientName,
        clientContact: sub.clientContact,
        saleAmount: sub.saleAmount,
        paymentPlan: sub.paymentPlan,
        deposit: sub.deposit,
        installmentCount: sub.installmentCount,
        amountCollected: 0, // nothing collected at closing — collected on mark-Paid
        closingAssociateId: sub.closingAssociateId,
        directUplineId: closer.directUplineId,
        secondUplineId: closer.secondUplineId,
        // Commission is only confirmed at payment (mark-Paid / 3rd installment).
        commissionEligibility: CommissionEligibility.PendingCollection,
        verifiedById: session.user.id,
        verifiedAt: new Date(),
      },
    });

    // attach line items + resolve the structure version active on the sales date
    const byCompany = new Map<string, ReturnType<typeof D>>();
    for (const li of sub.lineItems) {
      const version = await db.commissionStructureVersion.findFirst({
        where: { productCode: li.productCode, effectiveDate: { lte: sub.salesDate } },
        orderBy: [...VERSION_RESOLUTION_ORDER],
      });
      await db.saleLineItem.update({
        where: { id: li.id },
        data: { transactionId: transaction.id, structureVersionId: version?.id ?? null },
      });
      byCompany.set(li.companyId, (byCompany.get(li.companyId) ?? D(0)).add(D(li.lineSaleAmount)));
    }

    // Full Payment → one invoice per company entity, OUTSTANDING (unpaid). The
    // admin marks it Paid later in Sales & Verify, which flips commission
    // Eligible. Installments are represented by the schedule below instead.
    if (fullPayment) {
      for (const [companyId, amount] of byCompany) {
        const company = await db.company.update({
          where: { id: companyId },
          data: { invoiceNextSeq: { increment: 1 } },
        });
        const seq = company.invoiceNextSeq - 1;
        const invoiceNumber = `INV-${company.invoicePrefix}-${format(sub.salesDate, "yyyy")}-${String(seq).padStart(5, "0")}`;
        await db.invoice.create({
          data: {
            transactionId: transaction.id,
            companyId,
            invoiceNumber,
            invoiceType: InvoiceType.ComputerGenerated,
            amount,
            status: InvoiceStatus.Outstanding,
          },
        });
      }
    }

    // installment plan + schedule
    if (!fullPayment && sub.installmentCount && sub.installmentCount > 0) {
      const plan = await db.installmentPlan.create({
        data: {
          transactionId: transaction.id,
          totalAmount: sub.saleAmount,
          deposit: sub.deposit ?? 0,
          installmentCount: sub.installmentCount,
        },
      });
      // A-0b: the per-installment amount is rounded to 2dp, so it won't divide
      // the remaining balance exactly (e.g. 10,000/3 = 33.33... x3 = 99.99,
      // 1¢ short). The last installment absorbs whatever rounding leaves over
      // so the schedule always sums to exactly (sale − deposit).
      const remaining = D(sub.saleAmount).sub(D(sub.deposit ?? 0));
      // Deposit row (owner, Q9): sequence 0, so Accounts marks it paid with
      // the B-7 payment acknowledgement like any other installment — that's
      // what makes amountCollected (A-0) count the deposit as collected. It is
      // NOT one of the N installments (see eligibility.ts's `sequence > 0`
      // threshold filter) — it's the entry fee, not progress toward the
      // installment count.
      if (D(sub.deposit ?? 0).gt(0)) {
        await db.installmentSchedule.create({ data: { planId: plan.id, sequence: 0, dueAmount: round2(D(sub.deposit ?? 0)), paid: false } });
      }
      const per = round2(remaining.div(sub.installmentCount));
      let running = ZERO;
      for (let i = 1; i <= sub.installmentCount; i++) {
        const dueAmount = i === sub.installmentCount ? round2(remaining.sub(running)) : per;
        running = running.add(dueAmount);
        await db.installmentSchedule.create({ data: { planId: plan.id, sequence: i, dueAmount, paid: false } });
      }
    }

    await db.salesSubmission.update({
      where: { id: sub.id },
      data: { closedAt: new Date(), closedById: session.user.id },
    });
    // Tier A: the booking and its record commit together.
    await auditTx(db, { action: "sale.closed", entityType: "SalesTransaction", entityId: transaction.id, actorUserId: session.user.id, after: { submissionId } });
    return transaction.id;
  });
  } catch (e) {
    if (e instanceof AuditWriteError) return { ok: false, error: t("auditUnavailable") };
    throw e;
  }

  try {
    await runCommission(txId, session.user.id);
  } catch (e) {
    // The sale is closed (committed above, with its audit). If the first commission
    // run can't be recorded it rolls back as a whole — nothing unrecorded — and the
    // lines are booked (and audited) by the next recompute, at the latest when a
    // payment is marked. Don't report a committed close as a failure.
    if (!(e instanceof AuditWriteError)) throw e;
  }
  revalidatePath("/portal/quotations");
  revalidatePath("/admin/sales/verify");
  revalidatePath("/admin/sales/transactions");
  revalidatePath("/admin/commission");
  revalidatePath("/admin/dashboard");
  return { ok: true };
}

class VerifyConflict extends Error {}

/** G2: does the current split-exception approval (if any) still cover these
 * violations? Pure — no writes. Shared by verifySale (which additionally
 * voids a stale approval when this is false) and the read-only
 * getVerifyChecklist (screen 4), so the two definitions can never drift. */
function splitExceptionCoversViolations(
  sub: { splitExceptionApprovedAt: Date | null; splitExceptionVersion: Date | null; splitEditedAt: Date | null; splitExceptionSnapshot: unknown },
  violations: SplitBoundViolation[],
): boolean {
  return sub.splitExceptionApprovedAt !== null
    && (sub.splitExceptionVersion?.getTime() ?? null) === (sub.splitEditedAt?.getTime() ?? null)
    && snapshotCovers(violations, sub.splitExceptionSnapshot as SplitBoundViolation[] | null);
}

/** G3a/G3b: the sale's products' CURRENT required-document keys and whether
 * any of them (or an existing non-Superseded ashes agreement) needs the Pet
 * Ash agreement. Pure read (no writes). Shared by verifySale and
 * getVerifyChecklist. */
type RequiredDocumentEntry = { key: string; label_en: string; label_zh: string };

async function resolveProductDocGate(
  lineItems: { productCode: string }[],
  ashesAgreement: { status: AshesAgreementStatus } | null,
): Promise<{ missingProductCodes: string[]; requiredKeys: string[]; requiredDocs: RequiredDocumentEntry[]; needsAshes: boolean }> {
  const productCodes = [...new Set(lineItems.map((l) => l.productCode))];
  const products = await prisma.product.findMany({
    where: { productCode: { in: productCodes } },
    orderBy: { effectiveDate: "desc" },
    select: { productCode: true, requiredDocuments: true, requiresAshesAgreement: true },
  });
  const currentByCode = new Map<string, (typeof products)[number]>();
  for (const p of products) if (!currentByCode.has(p.productCode)) currentByCode.set(p.productCode, p); // newest row per code

  const missingProductCodes = productCodes.filter((code) => !currentByCode.has(code));
  const requiredDocsByKey = new Map<string, RequiredDocumentEntry>();
  let needsAshes = false;
  if (!missingProductCodes.length) {
    for (const code of productCodes) {
      const p = currentByCode.get(code)!;
      for (const d of (p.requiredDocuments as RequiredDocumentEntry[] | null) ?? []) {
        if (!requiredDocsByKey.has(d.key)) requiredDocsByKey.set(d.key, d);
      }
      if (p.requiresAshesAgreement) needsAshes = true;
    }
  }
  // An agreement that was ever required and hasn't been Superseded by a later
  // edit (✎6) must still be enforced even if the product's flag has since
  // been turned off with no edit in between to retire it.
  if (ashesAgreement && ashesAgreement.status !== AshesAgreementStatus.Superseded) needsAshes = true;
  const requiredDocs = [...requiredDocsByKey.values()];
  return { missingProductCodes, requiredKeys: requiredDocs.map((d) => d.key), requiredDocs, needsAshes };
}

/**
 * A-17 §Q6: attach a document that satisfies ONE of the sale's products'
 * required-document keys (G3). requirementKey is validated against
 * resolveProductDocGate's CURRENT read — the same rule verifySale and
 * getVerifyChecklist enforce — never against whatever was required when the
 * sale was submitted, so a since-retired key is refused here too (retired
 * keys are only inert on EXISTING rows, never a valid target for a new one).
 * Append-only: re-uploading the same key adds another row; "satisfied" is
 * decided at read time by verifySale/getVerifyChecklist, never here.
 * Tier A (reviews/audit-reliability.md): linked and recorded in one
 * transaction, same shape as signQuotationOnSystem — if the audit can't be
 * written, neither is the row, and the stored file is removed.
 */
export async function addSubmissionRequiredDocument(
  submissionId: string,
  requirementKey: string,
  file: File,
): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations("errors");
  // MD B2: flag-OFF must be genuinely dark — this whole A-17 mechanism has no
  // Legacy-flow counterpart, so a flag-off deploy must not be able to reach
  // it at all, callable server action or not.
  if (!env.A17_CLOSED_DEAL_FLOW) return { ok: false, error: t("notFound") };
  const session = await auth();
  if (!session) return { ok: false, error: t("forbidden") };

  const sub = await prisma.salesSubmission.findUnique({
    where: { id: submissionId },
    select: { status: true, closingAssociateId: true, lineItems: { select: { productCode: true } } },
  });
  if (!sub) return { ok: false, error: t("notFound") };

  const allowed = isAdminRole(session.user.role) || (!!session.user.associateId && session.user.associateId === sub.closingAssociateId);
  if (!allowed) return { ok: false, error: t("forbidden") };

  // N5: a Verified or Rejected sale is terminal — there is no live checklist
  // left to satisfy a required-document key against (verifySale/
  // getVerifyChecklist have already run their course), so a new upload here
  // would just be silently unreachable evidence, never checked by anything.
  if (sub.status === SubmissionStatus.Verified || sub.status === SubmissionStatus.Rejected) {
    return { ok: false, error: t("alreadyProcessed") };
  }

  if (!file || file.size === 0) return { ok: false, error: t("fileRequired") };
  if (file.size > MAX_DOC_BYTES) return { ok: false, error: t("fileTooLarge") };

  const { missingProductCodes, requiredKeys } = await resolveProductDocGate(sub.lineItems, null);
  if (missingProductCodes.length || !requiredKeys.includes(requirementKey)) {
    return { ok: false, error: t("invalidRequirementKey") };
  }

  const key = await storeSubmissionUploadBytes(submissionId, file);
  if (!key) return { ok: false, error: t("invalidFileType") };

  try {
    await prisma.$transaction(async (db) => {
      await db.submissionDocument.create({
        data: { submissionId, kind: SubmissionDocKind.Supporting, fileKey: key, fileName: file.name, uploadedById: session.user.id, requirementKey },
      });
      await auditTx(db, { action: "sale.required_document_added", entityType: "SalesSubmission", entityId: submissionId, actorUserId: session.user.id, after: { requirementKey } });
    });
  } catch (e) {
    await deleteObject(key);
    if (e instanceof AuditWriteError) return { ok: false, error: t("auditUnavailable") };
    throw e;
  }

  revalidatePath("/portal/sales");
  revalidatePath(`/portal/sales/${submissionId}`);
  revalidatePath("/admin/sales/verify");
  return { ok: true };
}

export type RequiredDocumentGate =
  | { ok: true; requiredDocs: RequiredDocumentEntry[]; attachedKeys: string[]; productRecordMissing: boolean }
  | { ok: false; error: string };

/**
 * Associate-or-admin read of the sale's products' CURRENT required-document
 * keys (G3a) and which are already attached, via the SAME resolveProductDocGate
 * source verifySale/getVerifyChecklist use — the sale detail page's "still
 * missing" list can never disagree with what actually gates verification.
 * Pure read, no writes.
 *
 * `resolveProductDocGate` returns an empty requiredKeys set BOTH when the
 * sale genuinely needs no documents and when one of its products has no
 * current record — the two are indistinguishable from requiredKeys alone,
 * but verifySale/getVerifyChecklist treat the latter as a hard refusal
 * (G3 "productRecordMissing"). productRecordMissing carries that distinction
 * through so the page can say the same thing verify will say, instead of
 * silently rendering "nothing required" (Backend finding, reviews/
 * get-required-document-gate-missing-product-signal.md).
 */
export async function getRequiredDocumentGate(submissionId: string): Promise<RequiredDocumentGate> {
  const t = await getTranslations("errors");
  // MD B2: flag-OFF must be genuinely dark — same reasoning as
  // addSubmissionRequiredDocument above (this is its read-side counterpart).
  if (!env.A17_CLOSED_DEAL_FLOW) return { ok: false, error: t("notFound") };
  const session = await auth();
  if (!session) return { ok: false, error: t("forbidden") };

  const sub = await prisma.salesSubmission.findUnique({
    where: { id: submissionId },
    select: { closingAssociateId: true, lineItems: { select: { productCode: true } }, documents: { select: { requirementKey: true } } },
  });
  if (!sub) return { ok: false, error: t("notFound") };

  const allowed = isAdminRole(session.user.role) || (!!session.user.associateId && session.user.associateId === sub.closingAssociateId);
  if (!allowed) return { ok: false, error: t("forbidden") };

  const { missingProductCodes, requiredDocs } = await resolveProductDocGate(sub.lineItems, null);
  if (missingProductCodes.length) return { ok: true, requiredDocs: [], attachedKeys: [], productRecordMissing: true };

  const attachedKeys = [...new Set(sub.documents.map((d) => d.requirementKey).filter((k): k is string => !!k))];
  return { ok: true, requiredDocs, attachedKeys, productRecordMissing: false };
}

/** G3b: the signed Pet Ash agreement's terms match the sale's CURRENT terms
 * (C2), and its stored PDF's SHA-256 matches what was recorded at signing (a
 * tampered file fails). Pure read (a storage GET, no writes). Shared by
 * verifySale and getVerifyChecklist. */
async function ashesSignatureOk(
  sub: Parameters<typeof ashesTermsSnapshot>[0],
  lineItems: Parameters<typeof ashesTermsSnapshot>[1],
  ashesAgreement: { status: AshesAgreementStatus; signedTerms: unknown; agreementPdfKey: string | null; signedPdfSha256: string | null } | null,
): Promise<boolean> {
  const a = ashesAgreement;
  const currentTerms = ashesTermsSnapshot(sub, lineItems);
  const termsMatch = !!a && a.status === AshesAgreementStatus.Signed && ashesTermsEqual(a.signedTerms as ReturnType<typeof ashesTermsSnapshot> | null, currentTerms);
  if (!termsMatch || !a!.agreementPdfKey || !a!.signedPdfSha256) return false;
  const stored = await getObject(a!.agreementPdfKey);
  return !!stored && createHash("sha256").update(stored).digest("hex") === a!.signedPdfSha256;
}

/**
 * A-17 §3 (design note; replaces closeSale for ClosedDeal sales): Admin or
 * Accounts books a Submitted sale once every gate passes. `seenContentVersion`
 * is the content_version the admin's page rendered (G4: refuses a stale page).
 * Reuses closeSale's DB-only booking body — same lines/invoices/instalments —
 * but the TXN code was already minted at submit (never mints a second one),
 * freezes commissionParties (Q33c) before the engine runs, and runs the
 * ledger (runCommissionTx) in this SAME transaction (✎D1), not a second one.
 * Idempotent: a submission that already has a transaction returns ok.
 */
export async function verifySale(submissionId: string, seenContentVersion: number): Promise<{ ok: boolean; error?: string; transactionId?: string }> {
  const t = await getTranslations("errors");
  const session = await auth();
  if (!session || !isAdminRole(session.user.role)) return { ok: false, error: t("forbidden") };

  const sub = await prisma.salesSubmission.findUnique({
    where: { id: submissionId },
    include: {
      lineItems: true,
      transaction: { select: { id: true } },
      closingAssociate: { include: { directUpline: { select: { designation: true } }, secondUpline: { select: { designation: true } } } },
      ashesAgreement: true,
      documents: { select: { requirementKey: true } },
    },
  });
  if (!sub) return { ok: false, error: t("notFound") };
  if (!env.A17_CLOSED_DEAL_FLOW || sub.flow !== SubmissionFlow.ClosedDeal) return { ok: false, error: t("legacyReadOnly") };
  if (sub.transaction) { revalidatePath("/admin/sales/verify"); return { ok: true }; } // already verified
  if (sub.status !== SubmissionStatus.Submitted) return { ok: false, error: t("alreadyProcessed") };

  // G4: the admin verifies the version their page actually rendered.
  if (sub.contentVersion !== seenContentVersion) return { ok: false, error: t("staleVersion") };

  // G1: split fully approved (SD + Business Admin, SEC-5a).
  if (!splitFullyApproved(sub)) return { ok: false, error: t("splitNotApproved") };

  // G2: re-check with the rates in force NOW — same rule as closeSale/B-S6.
  const violations = await splitBoundViolations(prisma, {
    salesDate: sub.salesDate, closingAssociateId: sub.closingAssociateId, lines: sub.lineItems,
    associate2Id: sub.associate2Id, associate2ValueType: sub.associate2ValueType, associate2Value: sub.associate2Value,
    associate3Id: sub.associate3Id, associate3ValueType: sub.associate3ValueType, associate3Value: sub.associate3Value,
  });
  if (violations.length) {
    const approved = splitExceptionCoversViolations(sub, violations);
    if (!approved) {
      const refused = await writeAudited(
        async (db) => {
          if (sub.splitExceptionApprovedAt !== null) {
            return (await db.salesSubmission.updateMany({
              where: { id: sub.id, splitExceptionApprovedAt: sub.splitExceptionApprovedAt },
              data: { splitExceptionApprovedAt: null, splitExceptionApprovedById: null, splitExceptionReason: null, splitExceptionSnapshot: Prisma.DbNull, splitExceptionVersion: null, splitExceptionRequired: true },
            })).count > 0;
          }
          if (!sub.splitExceptionRequired) await db.salesSubmission.update({ where: { id: sub.id }, data: { splitExceptionRequired: true } });
          return false;
        },
        (voided) => [
          ...(voided ? [{ action: "split.exception_voided", entityType: "SalesSubmission", entityId: sub.id, actorUserId: session.user.id, after: { reason: "rates_changed", lines: violations as unknown as Prisma.InputJsonValue } }] : []),
          { action: "sale.verify_refused", entityType: "SalesSubmission", entityId: sub.id, actorUserId: session.user.id, after: { gate: "G2-split-exception", violations: violations as unknown as Prisma.InputJsonValue } },
        ],
      );
      if (refused === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
      revalidatePath("/admin/split-approvals");
      return { ok: false, error: t("splitExceptionRequired") };
    }
    // G5: four-eyes — the split-exception approver can't also be the verifier.
    if (sub.splitExceptionApprovedById === session.user.id) {
      const refused = await writeAudited(
        async () => {},
        () => [{ action: "sale.verify_refused", entityType: "SalesSubmission", entityId: sub.id, actorUserId: session.user.id, after: { gate: "G5-four-eyes" } }],
      );
      if (refused === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
      return { ok: false, error: t("fourEyesBlocked") };
    }
  }

  // G3a/G3b: products' current required-document keys + whether the Pet Ash
  // agreement is needed (shared with getVerifyChecklist — see above).
  const { missingProductCodes, requiredKeys, needsAshes } = await resolveProductDocGate(sub.lineItems, sub.ashesAgreement);
  if (missingProductCodes.length) {
    const refused = await writeAudited(
      async () => {},
      () => [{ action: "sale.verify_refused", entityType: "SalesSubmission", entityId: sub.id, actorUserId: session.user.id, after: { gate: "G3a-product-missing", productCodes: missingProductCodes } }],
    );
    if (refused === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
    return { ok: false, error: t("productRecordMissing") };
  }

  const attachedKeys = new Set(sub.documents.map((d) => d.requirementKey).filter((k): k is string => !!k));
  const missingDocKeys = requiredKeys.filter((k) => !attachedKeys.has(k));
  if (missingDocKeys.length) {
    const refused = await writeAudited(
      async () => {},
      () => [{ action: "sale.verify_refused", entityType: "SalesSubmission", entityId: sub.id, actorUserId: session.user.id, after: { gate: "G3-documents", missing: missingDocKeys } }],
    );
    if (refused === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
    return { ok: false, error: t("requiredDocumentsMissing") };
  }

  // G3b: when a product needs the Pet Ash agreement, it must be Signed, its
  // signed_terms must equal the sale's CURRENT terms (C2), and its stored PDF's
  // SHA-256 must match signed_pdf_sha256 (a tampered file is refused).
  if (needsAshes) {
    const signatureOk = await ashesSignatureOk(sub, sub.lineItems, sub.ashesAgreement);
    if (!signatureOk) {
      const refused = await writeAudited(
        async () => {},
        () => [{ action: "sale.verify_refused", entityType: "SalesSubmission", entityId: sub.id, actorUserId: session.user.id, after: { gate: "G3-terms" } }],
      );
      if (refused === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
      return { ok: false, error: t("ashesSignatureRequired") };
    }
  }

  const closer = sub.closingAssociate;
  const fullPayment = sub.paymentPlan === PaymentPlan.FullPayment;
  if (!sub.transactionCode) throw new Error("ClosedDeal submission is missing its transaction code (invariant from submitSale)");

  let txId: string;
  try {
    txId = await prisma.$transaction(async (db) => {
      // G4 (the real guard): only a still-Submitted row at the seen version
      // flips to Verified. A concurrent edit or a second verify click loses.
      const res = await db.salesSubmission.updateMany({
        where: { id: sub.id, status: SubmissionStatus.Submitted, contentVersion: seenContentVersion },
        data: { status: SubmissionStatus.Verified, verifiedAt: new Date(), verifiedById: session.user.id },
      });
      if (res.count !== 1) throw new VerifyConflict();

      const transaction = await db.salesTransaction.create({
        data: {
          transactionCode: sub.transactionCode!, // minted at submit — never a second one
          submissionId: sub.id,
          salesDate: sub.salesDate,
          clientName: sub.clientName,
          clientContact: sub.clientContact,
          saleAmount: sub.saleAmount,
          paymentPlan: sub.paymentPlan,
          deposit: sub.deposit,
          installmentCount: sub.installmentCount,
          amountCollected: 0, // nothing collected at verify — collected on mark-Paid
          closingAssociateId: sub.closingAssociateId,
          directUplineId: closer.directUplineId,
          secondUplineId: closer.secondUplineId,
          commissionEligibility: CommissionEligibility.PendingCollection,
          verifiedById: session.user.id,
          verifiedAt: new Date(),
        },
      });

      // attach line items + resolve the structure version active on the sales date
      const byCompany = new Map<string, ReturnType<typeof D>>();
      for (const li of sub.lineItems) {
        const version = await db.commissionStructureVersion.findFirst({
          where: { productCode: li.productCode, effectiveDate: { lte: sub.salesDate } },
          orderBy: [...VERSION_RESOLUTION_ORDER],
        });
        await db.saleLineItem.update({ where: { id: li.id }, data: { transactionId: transaction.id, structureVersionId: version?.id ?? null } });
        byCompany.set(li.companyId, (byCompany.get(li.companyId) ?? D(0)).add(D(li.lineSaleAmount)));
      }

      if (fullPayment) {
        for (const [companyId, amount] of byCompany) {
          const company = await db.company.update({ where: { id: companyId }, data: { invoiceNextSeq: { increment: 1 } } });
          const seq = company.invoiceNextSeq - 1;
          const invoiceNumber = `INV-${company.invoicePrefix}-${format(sub.salesDate, "yyyy")}-${String(seq).padStart(5, "0")}`;
          await db.invoice.create({ data: { transactionId: transaction.id, companyId, invoiceNumber, invoiceType: InvoiceType.ComputerGenerated, amount, status: InvoiceStatus.Outstanding } });
        }
      }
      if (!fullPayment && sub.installmentCount && sub.installmentCount > 0) {
        const plan = await db.installmentPlan.create({ data: { transactionId: transaction.id, totalAmount: sub.saleAmount, deposit: sub.deposit ?? 0, installmentCount: sub.installmentCount } });
        const remaining = D(sub.saleAmount).sub(D(sub.deposit ?? 0));
        if (D(sub.deposit ?? 0).gt(0)) {
          await db.installmentSchedule.create({ data: { planId: plan.id, sequence: 0, dueAmount: round2(D(sub.deposit ?? 0)), paid: false } });
        }
        const per = round2(remaining.div(sub.installmentCount));
        let running = ZERO;
        for (let i = 1; i <= sub.installmentCount; i++) {
          const dueAmount = i === sub.installmentCount ? round2(remaining.sub(running)) : per;
          running = running.add(dueAmount);
          await db.installmentSchedule.create({ data: { planId: plan.id, sequence: i, dueAmount, paid: false } });
        }
      }

      // Q33c: freeze WHO earns (and each upline's own Approved&&Active flag)
      // BEFORE the engine runs, so the engine reads the snapshot, not live data.
      const txForParties = await db.salesTransaction.findUniqueOrThrow({ where: { id: transaction.id }, include: { closingAssociate: true, submission: true } });
      const snapshot = await buildCommissionPartiesSnapshot(db, txForParties);
      await db.salesTransaction.update({ where: { id: transaction.id }, data: { commissionParties: snapshot as unknown as Prisma.InputJsonValue } });

      // ✎D1: the ledger is booked by THIS transaction's own client, so it can
      // see the SalesTransaction created above (still uncommitted to anyone else).
      const result = await runCommissionTx(db, transaction.id);
      await auditRunResultTx(db, transaction.id, result, session.user.id);

      await auditTx(db, {
        action: "sale.verified", entityType: "SalesTransaction", entityId: transaction.id, actorUserId: session.user.id,
        after: { submissionId, transactionCode: sub.transactionCode, lineCount: result.lineCount },
      });
      return transaction.id;
    }, COMMISSION_TX_OPTIONS);
  } catch (e) {
    if (e instanceof VerifyConflict) return { ok: false, error: t("alreadyProcessed") };
    if (e instanceof AuditWriteError) return { ok: false, error: t("auditUnavailable") };
    throw e;
  }

  revalidatePath("/admin/sales/verify");
  revalidatePath("/portal/sales");
  revalidatePath(`/portal/sales/${submissionId}`);
  revalidatePath("/admin/commission");
  revalidatePath("/admin/dashboard");
  return { ok: true, transactionId: txId };
}

export type VerifyGateKey = "G1" | "G2" | "G3" | "G4" | "G5";
export type VerifyGateResult = { key: VerifyGateKey; pass: boolean; reasonKey?: string };
export type VerifyChecklist = { ok: true; gates: VerifyGateResult[]; allPass: boolean; contentVersion: number } | { ok: false; error: string };

/**
 * A-17 §7 (design note): read-only G1–G5 checklist for the verify screen
 * (screen 4) — the SAME gate logic verifySale uses (splitFullyApproved,
 * splitBoundViolations, splitExceptionCoversViolations, resolveProductDocGate,
 * ashesSignatureOk), so the checklist and the real verify can never
 * disagree. Never writes anything: no audit rows, no voiding of a stale
 * split-exception approval (verifySale does that only when it actually
 * refuses). `seenContentVersion`, when passed, checks G4 against it (for a
 * re-check just before submitting); omitted, G4 always passes and the
 * current contentVersion is returned for the caller to hold onto.
 */
export async function getVerifyChecklist(submissionId: string, seenContentVersion?: number): Promise<VerifyChecklist> {
  const t = await getTranslations("errors");
  const session = await auth();
  if (!session || !isAdminRole(session.user.role)) return { ok: false, error: t("forbidden") };

  const sub = await prisma.salesSubmission.findUnique({
    where: { id: submissionId },
    include: { lineItems: true, ashesAgreement: true, documents: { select: { requirementKey: true } } },
  });
  if (!sub) return { ok: false, error: t("notFound") };
  if (!env.A17_CLOSED_DEAL_FLOW || sub.flow !== SubmissionFlow.ClosedDeal) return { ok: false, error: t("legacyReadOnly") };

  const gates: VerifyGateResult[] = [];
  gates.push(splitFullyApproved(sub) ? { key: "G1", pass: true } : { key: "G1", pass: false, reasonKey: "splitNotApproved" });

  const violations = await splitBoundViolations(prisma, {
    salesDate: sub.salesDate, closingAssociateId: sub.closingAssociateId, lines: sub.lineItems,
    associate2Id: sub.associate2Id, associate2ValueType: sub.associate2ValueType, associate2Value: sub.associate2Value,
    associate3Id: sub.associate3Id, associate3ValueType: sub.associate3ValueType, associate3Value: sub.associate3Value,
  });
  let g2: VerifyGateResult = { key: "G2", pass: true };
  let g5: VerifyGateResult = { key: "G5", pass: true };
  if (violations.length) {
    const approved = splitExceptionCoversViolations(sub, violations);
    g2 = approved ? { key: "G2", pass: true } : { key: "G2", pass: false, reasonKey: "splitExceptionRequired" };
    if (approved && sub.splitExceptionApprovedById === session.user.id) {
      g5 = { key: "G5", pass: false, reasonKey: "fourEyesBlocked" };
    }
  }
  gates.push(g2, g5);

  const { missingProductCodes, requiredKeys, needsAshes } = await resolveProductDocGate(sub.lineItems, sub.ashesAgreement);
  let g3: VerifyGateResult = { key: "G3", pass: true };
  if (missingProductCodes.length) {
    g3 = { key: "G3", pass: false, reasonKey: "productRecordMissing" };
  } else {
    const attachedKeys = new Set(sub.documents.map((d) => d.requirementKey).filter((k): k is string => !!k));
    const missingDocKeys = requiredKeys.filter((k) => !attachedKeys.has(k));
    if (missingDocKeys.length) {
      g3 = { key: "G3", pass: false, reasonKey: "requiredDocumentsMissing" };
    } else if (needsAshes && !(await ashesSignatureOk(sub, sub.lineItems, sub.ashesAgreement))) {
      g3 = { key: "G3", pass: false, reasonKey: "ashesSignatureRequired" };
    }
  }
  gates.push(g3);

  const g4Pass = seenContentVersion === undefined || sub.contentVersion === seenContentVersion;
  gates.push(g4Pass ? { key: "G4", pass: true } : { key: "G4", pass: false, reasonKey: "staleVersion" });

  return { ok: true, gates, allPass: gates.every((g) => g.pass), contentVersion: sub.contentVersion };
}

/**
 * Business Admin/Accounts rejects a still-Submitted submission (16-Jul
 * quotation workflow; A-17 §3 extends it to the new flow). Terminal — only
 * valid while Submitted, CAS so two admins can't both "succeed" on a race.
 * A-17 (flag on): refuses Legacy rows, requires a reason, and stamps
 * rejectedAt (drives the §4a NRIC retention job). Flag off: unchanged —
 * reason stays optional, matching every existing legacy caller.
 */
export async function rejectSubmission(submissionId: string, reason?: string): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations("errors");
  const session = await auth();
  if (!session || !isAdminRole(session.user.role)) return { ok: false, error: t("forbidden") };

  const sub = await prisma.salesSubmission.findUnique({ where: { id: submissionId }, select: { status: true, flow: true } });
  if (!sub) return { ok: false, error: t("notFound") };

  const closedDeal = env.A17_CLOSED_DEAL_FLOW;
  if (closedDeal && sub.flow === SubmissionFlow.Legacy) {
    const refused = await writeAudited(
      async () => {},
      () => [{ action: "sale.legacy_write_refused", entityType: "SalesSubmission", entityId: submissionId, actorUserId: session.user.id, after: { attempted: "rejectSubmission" } }],
    );
    if (refused === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
    return { ok: false, error: t("legacyReadOnly") };
  }
  const trimmedReason = reason?.trim() || null;
  if (closedDeal && !trimmedReason) return { ok: false, error: t("reasonRequired") };

  // CAS: only a still-Submitted row is rejected, so two admins can't both "succeed".
  //
  // Cascade (owner bug report, 19 Oct 2026): a rejected submission's linked
  // ashesAgreement must not stay in a state that reads as "still live" (the
  // report: a rejected submission's draft agreement stayed Draft; Open on it
  // bounced to the dashboard instead of showing anything read-only — see
  // app/portal/sales/[id]/agreement/page.tsx's fix for that half).
  //
  // An EVER-SIGNED agreement cascades to Superseded here — the SAME value
  // and the SAME trigger condition editSale already uses for "no longer
  // needed at all" (this file's own void-to-Superseded block, ✎6):
  // Superseded is not a new meaning being introduced, it's the existing one,
  // reused for a second trigger that satisfies its own documented
  // precondition (everSigned).
  //
  // A NEVER-SIGNED (still Draft) agreement cascades to the NEW `Rejected`
  // value (owner decision, 19 Oct 2026, follow-up to this same bug): the
  // only prior precedent for a never-signed "no longer needed" row was
  // hard-delete (this file's editSale), which the owner ruled out — it would
  // delete the agreement the read-only page opens, contradicting "open but
  // grey out." `Rejected` is its own migration
  // (20261019100000_ashes_rejected_status, ALTER TYPE ADD VALUE only, per
  // the same-transaction-can't-use-a-just-added-enum-value rule) and is
  // written ONLY here — never by anything that treats a submission as
  // still live.
  //
  // The agreement is re-read INSIDE this transaction (not from a pre-transaction
  // snapshot) so a sign-then-reject race can't cascade on stale data.
  const rejected = await writeAudited(
    async (db) => {
      const res = await db.salesSubmission.updateMany({
        where: { id: submissionId, status: SubmissionStatus.Submitted },
        data: { status: SubmissionStatus.Rejected, rejectedAt: new Date() },
      });
      let cascadedAgreement: { id: string; to: "Superseded" | "Rejected" } | null = null;
      if (res.count === 1) {
        const agreement = await db.petsAshesAgreement.findUnique({
          where: { submissionId },
          select: { id: true, status: true, signatureVersion: true, signedAt: true },
        });
        const everSigned = !!agreement && (agreement.signatureVersion > 0 || agreement.signedAt !== null);
        if (agreement && everSigned && agreement.status !== AshesAgreementStatus.Superseded) {
          await db.petsAshesAgreement.update({ where: { id: agreement.id }, data: { status: AshesAgreementStatus.Superseded } });
          cascadedAgreement = { id: agreement.id, to: "Superseded" };
        } else if (agreement && !everSigned && agreement.status === AshesAgreementStatus.Draft) {
          await db.petsAshesAgreement.update({ where: { id: agreement.id }, data: { status: AshesAgreementStatus.Rejected } });
          cascadedAgreement = { id: agreement.id, to: "Rejected" };
        }
      }
      return { res, cascadedAgreement };
    },
    ({ res, cascadedAgreement }) => {
      if (res.count !== 1) return [];
      const entries: Parameters<typeof auditTx>[1][] = [{ action: "submission.rejected", entityType: "SalesSubmission", entityId: submissionId, actorUserId: session.user.id, after: { reason: trimmedReason } }];
      if (cascadedAgreement) {
        const action = cascadedAgreement.to === "Superseded" ? "ashes.superseded" : "ashes.rejected";
        entries.push({ action, entityType: "PetsAshesAgreement", entityId: cascadedAgreement.id, actorUserId: session.user.id, after: { status: cascadedAgreement.to, reason: "submission_rejected" } });
      }
      return entries;
    },
  );
  if (rejected === AUDIT_UNAVAILABLE) return { ok: false, error: t("auditUnavailable") };
  if (rejected.res.count === 0) return { ok: false, error: t("alreadyProcessed") };
  revalidatePath("/admin/quotations");
  revalidatePath("/admin/sales/verify");
  revalidatePath(`/portal/sales/${submissionId}`);
  return { ok: true };
}
