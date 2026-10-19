// A-17 §2/§3/§4 (C2): editSale, behind env.A17_CLOSED_DEAL_FLOW, refuses
// Legacy rows, bumps content_version, and voids/removes/creates the Pet Ash
// draft as a money-relevant term changes. Real throwaway Postgres.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

const who: { session: unknown } = { session: null };
vi.mock("@/auth", () => ({ auth: async () => who.session }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { AshesAgreementStatus } from "@prisma/client";

const TAG = "A17EDIT-";
let companyId = "", ashesProductId = "", plainProductId = "", closerId = "";
let submitSale: (input: unknown) => Promise<{ ok: boolean; id?: string }>;
let editSale: (input: unknown) => Promise<{ ok: boolean; error?: string }>;

beforeAll(async () => {
  process.env.A17_CLOSED_DEAL_FLOW = "true";
  vi.resetModules();
  ({ submitSale, editSale } = (await import("./actions")) as never);

  companyId = (await prisma.company.create({ data: { name: TAG + "Co", invoicePrefix: TAG + "INV", active: true }, select: { id: true } })).id;
  ashesProductId = (await prisma.product.create({
    data: {
      productCode: TAG + "ASH", productName: "Columbarium Niche", commissionType: "Percentage" as never,
      closingCommPct: "10", companyCutPct: "2", smOverridePct: "5", sdOverridePct: "3",
      defaultCompanyId: companyId, effectiveDate: new Date("2099-01-01"), requiresAshesAgreement: true,
    },
    select: { id: true },
  })).id;
  plainProductId = (await prisma.product.create({
    data: {
      productCode: TAG + "PLN", productName: "Grave Plot", commissionType: "Percentage" as never,
      closingCommPct: "10", companyCutPct: "2", smOverridePct: "5", sdOverridePct: "3",
      defaultCompanyId: companyId, effectiveDate: new Date("2099-01-01"), requiresAshesAgreement: false,
    },
    select: { id: true },
  })).id;
  closerId = (await prisma.associate.create({
    data: { associateCode: TAG + "CL", fullName: "Closer", designation: "SalesAssociate" as never, approvalStatus: "Approved" as never, associateStatus: "Active" as never },
    select: { id: true },
  })).id;
});

afterAll(async () => {
  delete process.env.A17_CLOSED_DEAL_FLOW;
  const subs = await prisma.salesSubmission.findMany({ where: { closingAssociateId: closerId }, select: { id: true } });
  const subIds = subs.map((s) => s.id);
  await prisma.petsAshesAgreement.deleteMany({ where: { submissionId: { in: subIds } } });
  await prisma.saleLineItem.deleteMany({ where: { submissionId: { in: subIds } } });
  await prisma.salesSubmission.deleteMany({ where: { id: { in: subIds } } });
  await prisma.product.deleteMany({ where: { id: { in: [ashesProductId, plainProductId] } } });
  await prisma.associate.deleteMany({ where: { id: closerId } });
  await prisma.company.deleteMany({ where: { id: companyId } });
});

afterEach(() => {
  who.session = null;
});

async function submitAshesSale(saleAmount: number) {
  who.session = { user: { associateId: closerId, id: closerId } };
  const r = await submitSale({
    salesDate: "2026-08-01", clientName: "Ashes Client", paymentPlan: "Full Payment",
    lines: [{ productId: ashesProductId, lineSaleAmount: saleAmount, comCodeIds: [] }],
  });
  return r.id!;
}

async function markSigned(agreementId: string) {
  await prisma.petsAshesAgreement.update({
    where: { id: agreementId },
    data: { status: "Signed" as never, signedAt: new Date(), applicantSignatureKey: "fake/sig.png", agreementPdfKey: "fake/agreement.pdf", signedPdfSha256: "a".repeat(64) },
  });
}

describe("editSale — legacy refusal + content_version", () => {
  it("refuses to edit a Legacy row while the flag is on", async () => {
    const subId = await submitAshesSale(1000);
    await prisma.salesSubmission.update({ where: { id: subId }, data: { flow: "Legacy" as never } });
    who.session = { user: { associateId: closerId, id: closerId } };
    const r = await editSale({ id: subId, salesDate: "2026-08-02", clientName: "Renamed", paymentPlan: "Full Payment", lines: [{ productId: ashesProductId, lineSaleAmount: 1000, comCodeIds: [] }] });
    expect(r).toEqual({ ok: false, error: "legacyReadOnly" });
  });

  it("bumps content_version on a successful edit", async () => {
    const subId = await submitAshesSale(1000);
    who.session = { user: { associateId: closerId, id: closerId } };
    const before = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, select: { contentVersion: true } });
    expect(before.contentVersion).toBe(0);
    const r = await editSale({ id: subId, salesDate: "2026-08-02", clientName: "Renamed Client", paymentPlan: "Full Payment", lines: [{ productId: ashesProductId, lineSaleAmount: 1000, comCodeIds: [] }] });
    expect(r.ok).toBe(true);
    const after = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, select: { contentVersion: true } });
    expect(after.contentVersion).toBe(1);
  });
});

describe("editSale — C2 signature void (non-amount terms only)", () => {
  // CHANGED, not because it went red — because it asserted behaviour this
  // ruling supersedes. The original test here was "voids a signed agreement
  // on a money edit (amount change), keeping the signed file as history",
  // and it asserted r.ok === true with the agreement reset to Draft. PD's
  // ruling (settled after three revisions, see the "sale amount lock"
  // describe block below) makes that exact outcome wrong: an amount-
  // changing edit against a signed agreement must now be REFUSED, never
  // silently voided. Updating this test to match the new intended
  // behaviour meant moving its TRIGGER to a genuine non-amount term change
  // (a payment-plan edit, same amount) — the void-and-resign mechanism
  // itself is still real and still covered, just no longer reachable via
  // the amount. This is the distinction that matters at review: the
  // guarantee (void-and-resign exists for real term changes) survives
  // intact; only the amount's own path to it was removed, on purpose, by
  // the ruling — not by this test going red and getting patched to pass.
  it("voids a signed agreement on a non-money term change (product swap), keeping the signed file as history", async () => {
    const subId = await submitAshesSale(1000);
    const sub = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, select: { ashesAgreement: { select: { id: true } } } });
    await markSigned(sub.ashesAgreement!.id);

    who.session = { user: { associateId: closerId, id: closerId } };
    // Same amount (1000), different payment plan — a real ashesChanged term
    // that is NOT the sale amount, so the amount lock must not apply here.
    const r = await editSale({
      id: subId, salesDate: "2026-08-01", clientName: "Ashes Client", paymentPlan: "Installment", installmentCount: 3,
      lines: [{ productId: ashesProductId, lineSaleAmount: 1000, comCodeIds: [] }],
    });
    expect(r.ok).toBe(true);

    const agreement = await prisma.petsAshesAgreement.findUniqueOrThrow({ where: { id: sub.ashesAgreement!.id } });
    expect(agreement.status).toBe("Draft");
    expect(agreement.signatureVersion).toBe(1);
    // the signed-* columns are cleared (a re-sign must never inherit the
    // PREVIOUS signing's key/hash/terms) — the old values live only in the audit
    expect(agreement.applicantSignatureKey).toBeNull();
    expect(agreement.agreementPdfKey).toBeNull();
    expect(agreement.signedPdfSha256).toBeNull();
    expect(agreement.signedTerms).toBeNull();
    expect(agreement.signedAt).toBeNull();

    const voided = await prisma.auditLog.findMany({ where: { entityId: sub.ashesAgreement!.id, action: "ashes.signature_voided" } });
    expect(voided).toHaveLength(1);
    expect(voided[0].beforeJson).toMatchObject({ agreementPdfKey: "fake/agreement.pdf", applicantSignatureKey: "fake/sig.png", signedPdfSha256: "a".repeat(64), signatureVersion: 0 });
  });

  it("does NOT void a signed agreement on a non-money edit (client contact only)", async () => {
    const subId = await submitAshesSale(1000);
    const sub = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, select: { ashesAgreement: { select: { id: true } } } });
    await markSigned(sub.ashesAgreement!.id);

    who.session = { user: { associateId: closerId, id: closerId } };
    const r = await editSale({ id: subId, salesDate: "2026-08-01", clientName: "Ashes Client", clientContact: "+65 9123 4567", paymentPlan: "Full Payment", lines: [{ productId: ashesProductId, lineSaleAmount: 1000, comCodeIds: [] }] });
    expect(r.ok).toBe(true);

    const agreement = await prisma.petsAshesAgreement.findUniqueOrThrow({ where: { id: sub.ashesAgreement!.id } });
    expect(agreement.status).toBe("Signed");
    expect(agreement.signatureVersion).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sale amount lock (PD ruling, settled after three revisions). Scope: once
// the Pet Ash agreement carries a real signature (status is not Draft), an
// amount-changing edit is refused outright — never silently voided and
// resigned. Closes the window where a ClosedDeal sale's status stays
// Submitted all the way through the client's e-signature (there is no
// QuotationApproved step for this flow), so without this, the closing
// associate alone could edit the amount after a real signature with no
// admin step at all.
// ---------------------------------------------------------------------------
describe("editSale — sale amount lock", () => {
  // Defence in depth, per enum value: assert each AshesAgreementStatus value
  // explicitly, so a lock-applies/doesn't-apply decision is never implicit.
  it("REJECTS an amount-changing edit when the agreement is Signed — audited, signature untouched", async () => {
    const subId = await submitAshesSale(1000);
    const sub = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, select: { ashesAgreement: { select: { id: true } } } });
    await markSigned(sub.ashesAgreement!.id);

    who.session = { user: { associateId: closerId, id: closerId } };
    const r = await editSale({ id: subId, salesDate: "2026-08-01", clientName: "Ashes Client", paymentPlan: "Full Payment", lines: [{ productId: ashesProductId, lineSaleAmount: 1500, comCodeIds: [] }] });
    expect(r).toEqual({ ok: false, error: "amountLocked" });

    // The signature must be left completely untouched — no void, no resign,
    // no column cleared. This is the defect the old behaviour had: a silent
    // void where the reader expects a hard refusal.
    const agreement = await prisma.petsAshesAgreement.findUniqueOrThrow({ where: { id: sub.ashesAgreement!.id } });
    expect(agreement.status).toBe("Signed");
    expect(agreement.signatureVersion).toBe(0);
    expect(agreement.applicantSignatureKey).toBe("fake/sig.png");
    expect(agreement.agreementPdfKey).toBe("fake/agreement.pdf");
    expect(agreement.signedPdfSha256).toBe("a".repeat(64));

    // And the submission itself must be untouched too — a refusal before the
    // transaction, not a partial write.
    const after = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, select: { saleAmount: true, contentVersion: true } });
    expect(after.saleAmount.toNumber()).toBe(1000);
    expect(after.contentVersion).toBe(0);

    const voided = await prisma.auditLog.findMany({ where: { entityId: sub.ashesAgreement!.id, action: "ashes.signature_voided" } });
    expect(voided).toHaveLength(0);
    const locked = await prisma.auditLog.findMany({ where: { entityId: subId, action: "sale.amount_edit_locked" } });
    expect(locked).toHaveLength(1);
    expect(locked[0].afterJson).toMatchObject({ agreementStatus: "Signed" });
  });

  it("REJECTS an amount-changing edit when the agreement is Superseded", async () => {
    const subId = await submitAshesSale(1000);
    const sub = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, select: { ashesAgreement: { select: { id: true } } } });
    await markSigned(sub.ashesAgreement!.id);

    who.session = { user: { associateId: closerId, id: closerId } };
    // Same amount, product swap away from ashes — supersedes the signed row
    // (✎6), not an amount change, so this setup step itself is unaffected
    // by the lock.
    const setup = await editSale({ id: subId, salesDate: "2026-08-01", clientName: "Ashes Client", paymentPlan: "Full Payment", lines: [{ productId: plainProductId, lineSaleAmount: 1000, comCodeIds: [] }] });
    expect(setup.ok).toBe(true);
    const superseded = await prisma.petsAshesAgreement.findUniqueOrThrow({ where: { id: sub.ashesAgreement!.id } });
    expect(superseded.status).toBe("Superseded");

    const r = await editSale({ id: subId, salesDate: "2026-08-01", clientName: "Ashes Client", paymentPlan: "Full Payment", lines: [{ productId: plainProductId, lineSaleAmount: 1500, comCodeIds: [] }] });
    expect(r).toEqual({ ok: false, error: "amountLocked" });

    const agreement = await prisma.petsAshesAgreement.findUniqueOrThrow({ where: { id: sub.ashesAgreement!.id } });
    expect(agreement.status).toBe("Superseded"); // unchanged by the rejected edit
    const after = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, select: { saleAmount: true } });
    expect(after.saleAmount.toNumber()).toBe(1000);
  });

  it("CONTROL: the identical amount-changing edit SUCCEEDS while the agreement is Draft (never signed)", async () => {
    const subId = await submitAshesSale(1000);
    const sub = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, select: { ashesAgreement: { select: { id: true, status: true } } } });
    expect(sub.ashesAgreement!.status).toBe("Draft");

    who.session = { user: { associateId: closerId, id: closerId } };
    const r = await editSale({ id: subId, salesDate: "2026-08-01", clientName: "Ashes Client", paymentPlan: "Full Payment", lines: [{ productId: ashesProductId, lineSaleAmount: 1500, comCodeIds: [] }] });
    // Without this control, a rejection-only test suite would pass even
    // against a path that rejects every edit unconditionally.
    expect(r.ok).toBe(true);
    const after = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, select: { saleAmount: true } });
    expect(after.saleAmount.toNumber()).toBe(1500);
  });

  // BEFORE/AFTER CONTROL on the OTHER dimension (submission status, not
  // agreement status) — this feature does not widen editSale's existing
  // Submitted-only gate; this proves that gate already locks an amount edit
  // at the right point, rather than assuming it.
  //
  // The ruling names "Submitted → QuotationApproved" — that is Legacy's
  // transition, and for THIS flow (ClosedDeal) it is unreachable:
  // approveQuotation explicitly refuses ClosedDeal rows (server/sales/
  // actions.ts, "a ClosedDeal row must never reach QuotationApproved via
  // this path") — verifySale's Submitted → Verified is ClosedDeal's real
  // admin-approval transition. This is not a gap against the ruling:
  // QuotationApproved is Legacy's instance of the exact same condition
  // editSale already checks (status !== Submitted), and this test proves
  // that single mechanism directly — it doesn't need a second, Legacy-only
  // fixture repeating the same proof under a different status name. Status
  // is set directly rather than driving the full verifySale pipeline
  // (ledger/split-approval machinery is out of scope for this test).
  it("BEFORE/AFTER CONTROL (submission status): an amount edit succeeds while Submitted, refused once the submission leaves Submitted via admin approval", async () => {
    const subId = await submitAshesSale(1000);
    who.session = { user: { associateId: closerId, id: closerId } };

    const before = await editSale({ id: subId, salesDate: "2026-08-01", clientName: "Ashes Client", paymentPlan: "Full Payment", lines: [{ productId: ashesProductId, lineSaleAmount: 1200, comCodeIds: [] }] });
    expect(before.ok).toBe(true);

    await prisma.salesSubmission.update({ where: { id: subId }, data: { status: "Verified" as never } });
    const after = await editSale({ id: subId, salesDate: "2026-08-01", clientName: "Ashes Client", paymentPlan: "Full Payment", lines: [{ productId: ashesProductId, lineSaleAmount: 1500, comCodeIds: [] }] });
    expect(after).toEqual({ ok: false, error: "alreadyProcessed" });
  });

  it("does not lock a non-amount edit, even when the agreement is Signed (scoped to amount only)", async () => {
    const subId = await submitAshesSale(1000);
    const sub = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, select: { ashesAgreement: { select: { id: true } } } });
    await markSigned(sub.ashesAgreement!.id);

    who.session = { user: { associateId: closerId, id: closerId } };
    // Same amount (1000), client contact only — must still succeed, matching
    // "editSale — C2 signature void" coverage of the same shape.
    const r = await editSale({ id: subId, salesDate: "2026-08-01", clientName: "Ashes Client", clientContact: "+65 9123 4567", paymentPlan: "Full Payment", lines: [{ productId: ashesProductId, lineSaleAmount: 1000, comCodeIds: [] }] });
    expect(r.ok).toBe(true);
  });

  // 🔴 Exhaustiveness guard: if AshesAgreementStatus ever grows a 5th value,
  // this breaks instead of silently leaving it unclassified by the lock
  // above (which only ever asks "is it Draft?" — a new value defaults to
  // "locks" today, but that default has never been a reviewed decision).
  //
  // `Rejected` (owner decision, 19 Oct 2026, follow-up to the rejected-
  // submission bug, #3): reviewed under this same lock check — a Rejected
  // agreement's submission is already terminal (editSale's own CAS at
  // status: Submitted already refuses it before this line is ever reached),
  // so defaulting to "locks" here is correct and was explicitly checked,
  // not inherited silently.
  it("ENUM EXHAUSTIVENESS: AshesAgreementStatus is exactly {Draft, Signed, Superseded, Rejected} — a new value must be a reviewed decision, not a silent default", () => {
    expect(Object.values(AshesAgreementStatus).sort()).toEqual(["Draft", "Rejected", "Signed", "Superseded"].sort());
  });
});

describe("editSale — draft create/remove as lines change", () => {
  it("hard-deletes a never-signed draft once no line needs it any more", async () => {
    const subId = await submitAshesSale(1000);
    const sub = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, select: { ashesAgreement: { select: { id: true } } } });
    const agreementId = sub.ashesAgreement!.id;

    who.session = { user: { associateId: closerId, id: closerId } };
    const r = await editSale({ id: subId, salesDate: "2026-08-01", clientName: "Ashes Client", paymentPlan: "Full Payment", lines: [{ productId: plainProductId, lineSaleAmount: 1000, comCodeIds: [] }] });
    expect(r.ok).toBe(true);

    expect(await prisma.petsAshesAgreement.findUnique({ where: { id: agreementId } })).toBeNull();
    const removed = await prisma.auditLog.findMany({ where: { entityId: agreementId, action: "ashes.draft_removed" } });
    expect(removed).toHaveLength(1);
    expect(removed[0].afterJson).toBeNull(); // no contents
  });

  it("✎6: a once-signed agreement is Superseded (not deleted, not left as Draft) once the product is removed", async () => {
    const subId = await submitAshesSale(1000);
    const sub = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, select: { ashesAgreement: { select: { id: true } } } });
    await markSigned(sub.ashesAgreement!.id);

    who.session = { user: { associateId: closerId, id: closerId } };
    const r = await editSale({ id: subId, salesDate: "2026-08-01", clientName: "Ashes Client", paymentPlan: "Full Payment", lines: [{ productId: plainProductId, lineSaleAmount: 1000, comCodeIds: [] }] });
    expect(r.ok).toBe(true);

    const agreement = await prisma.petsAshesAgreement.findUnique({ where: { id: sub.ashesAgreement!.id } });
    expect(agreement).not.toBeNull();
    expect(agreement!.status).toBe("Superseded");
    expect(agreement!.agreementPdfKey).toBe("fake/agreement.pdf"); // untouched
    expect(agreement!.signedPdfSha256).toBe("a".repeat(64)); // untouched

    const audits = await prisma.auditLog.findMany({ where: { entityId: sub.ashesAgreement!.id, action: "ashes.superseded" } });
    expect(audits).toHaveLength(1);
    expect(audits[0].beforeJson).toMatchObject({ agreementPdfKey: "fake/agreement.pdf", signedPdfSha256: "a".repeat(64), signatureVersion: 0 });
  });

  it("✎6: reinstates a Superseded agreement to Draft (signatureVersion bumped) once a qualifying product is added back", async () => {
    const subId = await submitAshesSale(1000);
    const sub = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, select: { ashesAgreement: { select: { id: true } } } });
    await markSigned(sub.ashesAgreement!.id);

    who.session = { user: { associateId: closerId, id: closerId } };
    await editSale({ id: subId, salesDate: "2026-08-01", clientName: "Ashes Client", paymentPlan: "Full Payment", lines: [{ productId: plainProductId, lineSaleAmount: 1000, comCodeIds: [] }] });
    const superseded = await prisma.petsAshesAgreement.findUniqueOrThrow({ where: { id: sub.ashesAgreement!.id } });
    expect(superseded.status).toBe("Superseded");

    const r = await editSale({ id: subId, salesDate: "2026-08-01", clientName: "Ashes Client", paymentPlan: "Full Payment", lines: [{ productId: ashesProductId, lineSaleAmount: 1000, comCodeIds: [] }] });
    expect(r.ok).toBe(true);

    const reinstated = await prisma.petsAshesAgreement.findUniqueOrThrow({ where: { id: sub.ashesAgreement!.id } });
    expect(reinstated.status).toBe("Draft");
    expect(reinstated.signatureVersion).toBe(1);
    // cleared for the coming re-sign — the old file/key/hash live on in the audit only
    expect(reinstated.agreementPdfKey).toBeNull();
    expect(reinstated.signedPdfSha256).toBeNull();
    expect(reinstated.applicantSignatureKey).toBeNull();

    const audits = await prisma.auditLog.findMany({ where: { entityId: sub.ashesAgreement!.id, action: "ashes.reinstated" } });
    expect(audits).toHaveLength(1);
    expect(audits[0].beforeJson).toMatchObject({ agreementPdfKey: "fake/agreement.pdf", signedPdfSha256: "a".repeat(64) });
  });

  it("creates a draft when an ashes product is added to a sale that had none", async () => {
    who.session = { user: { associateId: closerId, id: closerId } };
    const r0 = await submitSale({
      salesDate: "2026-08-01", clientName: "No Ashes Client", paymentPlan: "Full Payment",
      lines: [{ productId: plainProductId, lineSaleAmount: 1000, comCodeIds: [] }],
    });
    expect((await prisma.salesSubmission.findUniqueOrThrow({ where: { id: r0.id }, select: { ashesAgreement: true } })).ashesAgreement).toBeNull();

    const r = await editSale({ id: r0.id, salesDate: "2026-08-01", clientName: "No Ashes Client", paymentPlan: "Full Payment", lines: [{ productId: ashesProductId, lineSaleAmount: 1000, comCodeIds: [] }] });
    expect(r.ok).toBe(true);

    const sub = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: r0.id }, select: { ashesAgreement: true } });
    expect(sub.ashesAgreement).not.toBeNull();
    expect(sub.ashesAgreement!.status).toBe("Draft");
    const created = await prisma.auditLog.findMany({ where: { entityId: r0.id, action: "ashes.generated" } });
    expect(created).toHaveLength(1);
  });
});
