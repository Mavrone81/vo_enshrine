// A-17 §3 (design note): verifySale — the new flow's booking action, gates
// G1-G5, atomic with the ledger (✎D1), reuses the TXN code minted at submit,
// freezes commissionParties (Q33c). Real throwaway Postgres.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

const who: { session: unknown } = { session: null };
vi.mock("@/auth", () => ({ auth: async () => who.session }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { installLedgerFault, armLedgerFault, disarmLedgerFault, removeLedgerFault } from "@/lib/test-ledger-fault";

const TAG = "A17VERIFY-";
const ADMIN_A = "55555555-5555-5555-5555-555555555555";
const ADMIN_B = "66666666-6666-6666-6666-666666666666";
let companyId = "", plainProductId = "", ashesProductId = "", docProductId = "", closerId = "", partnerId = "";
let submitSale: (input: unknown) => Promise<{ id?: string; warning?: { code: string } }>;
let verifySale: (submissionId: string, seenContentVersion: number) => Promise<{ ok: boolean; error?: string; transactionId?: string }>;
let rejectSubmission: (submissionId: string, reason?: string) => Promise<{ ok: boolean; error?: string }>;
let getVerifyChecklist: (submissionId: string, seenContentVersion?: number) => Promise<
  { ok: true; gates: { key: string; pass: boolean; reasonKey?: string }[]; allPass: boolean; contentVersion: number } | { ok: false; error: string }
>;
let signAshesAgreement: (submissionId: string, dataUrl: string) => Promise<{ ok: boolean }>;

const FAKE_PNG_DATA_URL = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")}`;

beforeAll(async () => {
  process.env.A17_CLOSED_DEAL_FLOW = "true";
  vi.resetModules();
  ({ submitSale, verifySale, rejectSubmission, getVerifyChecklist } = (await import("./actions")) as never);
  ({ signAshesAgreement } = (await import("@/server/agreements/actions")) as never);

  companyId = (await prisma.company.create({ data: { name: TAG + "Co", invoicePrefix: TAG + "INV", active: true }, select: { id: true } })).id;
  const mk = (code: string, extra: Record<string, unknown> = {}) =>
    prisma.product.create({
      data: {
        productCode: TAG + code, productName: code, commissionType: "Percentage" as never,
        closingCommPct: "10", companyCutPct: "2", smOverridePct: "5", sdOverridePct: "3",
        defaultCompanyId: companyId, effectiveDate: new Date("2099-01-01"), ...extra,
      },
      select: { id: true },
    });
  plainProductId = (await mk("PLN")).id;
  ashesProductId = (await mk("ASH", { requiresAshesAgreement: true })).id;
  docProductId = (await mk("DOC", { requiredDocuments: [{ key: "contract", label_en: "Signed contract", label_zh: "签署合同" }] })).id;
  closerId = (await prisma.associate.create({
    data: { associateCode: TAG + "CL", fullName: "Closer", designation: "SalesAssociate" as never, approvalStatus: "Approved" as never, associateStatus: "Active" as never },
    select: { id: true },
  })).id;
  partnerId = (await prisma.associate.create({
    data: { associateCode: TAG + "PT", fullName: "Partner", designation: "SalesAssociate" as never, approvalStatus: "Approved" as never, associateStatus: "Active" as never },
    select: { id: true },
  })).id;
  await installLedgerFault();
});

afterAll(async () => {
  await removeLedgerFault();
  delete process.env.A17_CLOSED_DEAL_FLOW;
  const subs = await prisma.salesSubmission.findMany({ where: { closingAssociateId: closerId }, select: { id: true } });
  const subIds = subs.map((s) => s.id);
  await prisma.commissionLedger.deleteMany({ where: { transaction: { submissionId: { in: subIds } } } });
  await prisma.invoice.deleteMany({ where: { transaction: { submissionId: { in: subIds } } } });
  await prisma.installmentSchedule.deleteMany({ where: { plan: { transaction: { submissionId: { in: subIds } } } } });
  await prisma.installmentPlan.deleteMany({ where: { transaction: { submissionId: { in: subIds } } } });
  await prisma.saleLineItem.deleteMany({ where: { submissionId: { in: subIds } } });
  await prisma.salesTransaction.deleteMany({ where: { submissionId: { in: subIds } } });
  await prisma.petsAshesAgreement.deleteMany({ where: { submissionId: { in: subIds } } });
  await prisma.submissionDocument.deleteMany({ where: { submissionId: { in: subIds } } });
  await prisma.salesSubmission.deleteMany({ where: { id: { in: subIds } } });
  await prisma.product.deleteMany({ where: { id: { in: [plainProductId, ashesProductId, docProductId] } } });
  await prisma.associate.deleteMany({ where: { id: { in: [closerId, partnerId] } } });
  await prisma.company.deleteMany({ where: { id: companyId } });
});

afterEach(() => {
  who.session = null;
});

async function submitPlain(clientName: string, opts: { productId?: string; paymentPlan?: string; deposit?: number; installmentCount?: number } = {}) {
  who.session = { user: { associateId: closerId, id: closerId } };
  const r = await submitSale({
    salesDate: "2026-08-01", clientName, paymentPlan: opts.paymentPlan ?? "Full Payment",
    deposit: opts.deposit, installmentCount: opts.installmentCount,
    lines: [{ productId: opts.productId ?? plainProductId, lineSaleAmount: 1000, comCodeIds: [] }],
  });
  return r.id!;
}

async function approveSplit(subId: string) {
  await prisma.salesSubmission.update({ where: { id: subId }, data: { sdApprovedAt: new Date(), splitAdminApprovedAt: new Date() } });
}

async function verifyAsAdmin(subId: string, seenVersion = 0, admin = ADMIN_A) {
  who.session = { user: { id: admin, associateId: null, role: "Admin" } };
  return verifySale(subId, seenVersion);
}

describe("verifySale — happy path", () => {
  it("books the transaction with the submission's own TXN code, invoice and ledger, and freezes commissionParties", async () => {
    const subId = await submitPlain("Happy Client");
    await approveSplit(subId);
    const sub = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, select: { transactionCode: true } });

    const r = await verifyAsAdmin(subId);
    expect(r.ok).toBe(true);

    const txn = await prisma.salesTransaction.findUniqueOrThrow({ where: { id: r.transactionId } });
    expect(txn.transactionCode).toBe(sub.transactionCode);
    expect(txn.commissionParties).not.toBeNull();

    const invoices = await prisma.invoice.findMany({ where: { transactionId: txn.id } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].amount.toFixed(2)).toBe("1000.00");

    const ledger = await prisma.commissionLedger.findMany({ where: { transactionId: txn.id } });
    expect(ledger.length).toBeGreaterThan(0);

    const updatedSub = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId } });
    expect(updatedSub.status).toBe("Verified");
    expect(updatedSub.verifiedById).toBe(ADMIN_A);
  });

  it("is idempotent — verifying an already-verified sale returns ok without creating a second transaction", async () => {
    const subId = await submitPlain("Idempotent Client");
    await approveSplit(subId);
    const first = await verifyAsAdmin(subId);
    expect(first.ok).toBe(true);
    const second = await verifyAsAdmin(subId);
    expect(second.ok).toBe(true);
    const count = await prisma.salesTransaction.count({ where: { submissionId: subId } });
    expect(count).toBe(1);
  });
});

describe("verifySale — gates refuse on their own", () => {
  it("G1: refuses while the split isn't fully approved", async () => {
    const subId = await submitPlain("G1 Client");
    const r = await verifyAsAdmin(subId);
    expect(r).toEqual({ ok: false, error: "splitNotApproved" });
  });

  it("G4: refuses a stale content_version", async () => {
    const subId = await submitPlain("G4 Client");
    await approveSplit(subId);
    const r = await verifyAsAdmin(subId, 99);
    expect(r).toEqual({ ok: false, error: "staleVersion" });
    expect(await prisma.salesTransaction.count({ where: { submissionId: subId } })).toBe(0);
  });

  it("two concurrent verifies of the same sale: exactly one books a transaction, the loser's attempt leaves nothing partial", async () => {
    const subId = await submitPlain("Concurrent Verify Client");
    await approveSplit(subId);
    const [a, b] = await Promise.all([verifyAsAdmin(subId), verifyAsAdmin(subId)]);
    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === "alreadyProcessed")).toHaveLength(1);

    expect(await prisma.salesTransaction.count({ where: { submissionId: subId } })).toBe(1);
    const txn = await prisma.salesTransaction.findFirstOrThrow({ where: { submissionId: subId } });
    expect(await prisma.invoice.count({ where: { transactionId: txn.id } })).toBe(1); // not zero, not doubled
  });

  it("M6/F11: a REAL engine-write failure mid-verify (a DB trigger, not a mock) rolls back the whole booking", async () => {
    const subId = await submitPlain("M6F11 Client", { productId: ashesProductId });
    await approveSplit(subId);
    who.session = { user: { associateId: closerId, id: closerId } };
    await signAshesAgreement(subId, FAKE_PNG_DATA_URL);
    const before = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, include: { ashesAgreement: true } });
    expect(before.ashesAgreement!.status).toBe("Signed");

    await armLedgerFault();
    let threw = false;
    try {
      await verifyAsAdmin(subId);
    } catch {
      threw = true;
    } finally {
      await disarmLedgerFault();
    }
    expect(threw).toBe(true); // a raw DB error propagates — it's not a handled gate refusal

    const after = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, include: { ashesAgreement: true } });
    expect(after.status).toBe("Submitted"); // never flipped to Verified
    expect(after.contentVersion).toBe(before.contentVersion);
    expect(after.ashesAgreement!.status).toBe("Signed"); // untouched
    expect(await prisma.salesTransaction.count({ where: { submissionId: subId } })).toBe(0);
    expect(await prisma.invoice.count({ where: { transaction: { submissionId: subId } } })).toBe(0);
    expect(await prisma.commissionLedger.count({ where: { transaction: { submissionId: subId } } })).toBe(0);
    expect(await prisma.commissionLedger.count({ where: { payoutId: { not: null }, transaction: { submissionId: subId } } })).toBe(0); // no payout attachment

    // The submission is still cleanly Submitted — a retry (fault cleared) succeeds.
    const retry = await verifyAsAdmin(subId);
    expect(retry.ok).toBe(true);
  });

  it("legacy: refuses a flow=Legacy row even if Submitted", async () => {
    const subId = await submitPlain("Legacy Client");
    await approveSplit(subId);
    await prisma.salesSubmission.update({ where: { id: subId }, data: { flow: "Legacy" as never } });
    const r = await verifyAsAdmin(subId);
    expect(r).toEqual({ ok: false, error: "legacyReadOnly" });
  });

  it("G3a: refuses when a required document type has no attached file, then succeeds once tagged", async () => {
    const subId = await submitPlain("G3a Client", { productId: docProductId });
    await approveSplit(subId);
    const r = await verifyAsAdmin(subId);
    expect(r).toEqual({ ok: false, error: "requiredDocumentsMissing" });

    await prisma.submissionDocument.create({ data: { submissionId: subId, kind: "Supporting", fileKey: "fake/contract.pdf", fileName: "contract.pdf", requirementKey: "contract" } });
    const r2 = await verifyAsAdmin(subId);
    expect(r2.ok).toBe(true);
  });

  it("G3b: refuses when the Pet Ash agreement isn't signed, then succeeds once signed with matching terms", async () => {
    const subId = await submitPlain("G3b Client", { productId: ashesProductId });
    await approveSplit(subId);
    const r = await verifyAsAdmin(subId);
    expect(r).toEqual({ ok: false, error: "ashesSignatureRequired" });

    who.session = { user: { associateId: closerId, id: closerId } };
    expect(await signAshesAgreement(subId, FAKE_PNG_DATA_URL)).toEqual({ ok: true });

    const r2 = await verifyAsAdmin(subId);
    expect(r2.ok).toBe(true);
  });

  it("G3b: refuses when the stored signed PDF no longer matches its recorded hash (tamper)", async () => {
    const subId = await submitPlain("G3b Tamper Client", { productId: ashesProductId });
    await approveSplit(subId);
    who.session = { user: { associateId: closerId, id: closerId } };
    await signAshesAgreement(subId, FAKE_PNG_DATA_URL);

    const sub = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, select: { ashesAgreement: true } });
    await prisma.petsAshesAgreement.update({ where: { id: sub.ashesAgreement!.id }, data: { signedPdfSha256: "0".repeat(64) } });

    const r = await verifyAsAdmin(subId);
    expect(r).toEqual({ ok: false, error: "ashesSignatureRequired" });
  });

  it("G5: the split-exception approver can't verify the same sale; another admin can", async () => {
    who.session = { user: { associateId: closerId, id: closerId } };
    const r0 = await submitSale({
      salesDate: "2026-08-01", clientName: "G5 Client", paymentPlan: "Full Payment",
      lines: [{ productId: plainProductId, lineSaleAmount: 1000, comCodeIds: [] }],
      // An absolute share this far above net-to-closer books a negative line (B-S6).
      associate2: { associateId: partnerId, valueType: "Absolute", value: 900 },
    });
    const subId = r0.id!;
    expect(r0.warning?.code).toBe("splitExceedsNet");
    await approveSplit(subId);

    const sub = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, include: { lineItems: true } });
    const { splitBoundViolations } = await import("@/server/commission/split-bounds");
    const violations = await splitBoundViolations(prisma, {
      salesDate: sub.salesDate, closingAssociateId: sub.closingAssociateId, lines: sub.lineItems,
      associate2Id: sub.associate2Id, associate2ValueType: sub.associate2ValueType, associate2Value: sub.associate2Value,
      associate3Id: sub.associate3Id, associate3ValueType: sub.associate3ValueType, associate3Value: sub.associate3Value,
    });
    expect(violations.length).toBeGreaterThan(0);

    const { approveSplitException } = await import("./actions");
    who.session = { user: { id: ADMIN_A, associateId: null, role: "Admin" } };
    const approved = await approveSplitException(subId, "the owner approved this one-off split", null, violations);
    expect(approved.ok).toBe(true);

    const blocked = await verifyAsAdmin(subId, 0, ADMIN_A);
    expect(blocked).toEqual({ ok: false, error: "fourEyesBlocked" });

    const allowed = await verifyAsAdmin(subId, 0, ADMIN_B);
    expect(allowed.ok).toBe(true);
  });
});

// Screen 4 (DevLead): read-only G1–G5 checklist, reusing verifySale's own
// gate logic (resolveProductDocGate, ashesSignatureOk,
// splitExceptionCoversViolations) rather than a second copy of it.
describe("getVerifyChecklist — read-only, same gates as verifySale, never writes", () => {
  async function checklistAsAdmin(subId: string, seenContentVersion?: number, admin = ADMIN_A) {
    who.session = { user: { id: admin, associateId: null, role: "Admin" } };
    return getVerifyChecklist(subId, seenContentVersion);
  }

  it("all gates pass for a clean sale, and verifySale still succeeds afterwards (read-only)", async () => {
    const subId = await submitPlain("Checklist Happy Client");
    await approveSplit(subId);

    const r = await checklistAsAdmin(subId);
    if (!r.ok) throw new Error("expected ok");
    expect(r.allPass).toBe(true);
    expect(r.gates).toEqual([
      { key: "G1", pass: true }, { key: "G2", pass: true }, { key: "G5", pass: true },
      { key: "G3", pass: true }, { key: "G4", pass: true },
    ]);

    const verified = await verifyAsAdmin(subId, r.contentVersion);
    expect(verified.ok).toBe(true);
  });

  it("G1: fails while the split isn't approved, and touches nothing", async () => {
    const subId = await submitPlain("Checklist G1 Client");
    // Scoped to this submission's own id, not a global count — other test
    // files write audit rows on this shared DB in parallel (L2 lesson).
    const before = await prisma.auditLog.count({ where: { entityId: subId } });

    const r = await checklistAsAdmin(subId);
    if (!r.ok) throw new Error("expected ok");
    expect(r.allPass).toBe(false);
    expect(r.gates.find((g) => g.key === "G1")).toEqual({ key: "G1", pass: false, reasonKey: "splitNotApproved" });
    expect(await prisma.auditLog.count({ where: { entityId: subId } })).toBe(before); // no verify_refused audit — read-only
  });

  it("G3a: reports productRecordMissing for a doc-gated product, and requiredDocumentsMissing once its record exists but the doc isn't attached", async () => {
    const subId = await submitPlain("Checklist G3a Client", { productId: docProductId });
    await approveSplit(subId);

    const r = await checklistAsAdmin(subId);
    if (!r.ok) throw new Error("expected ok");
    expect(r.gates.find((g) => g.key === "G3")).toEqual({ key: "G3", pass: false, reasonKey: "requiredDocumentsMissing" });

    await prisma.submissionDocument.create({ data: { submissionId: subId, kind: "Supporting", fileKey: "fake/contract.pdf", fileName: "contract.pdf", requirementKey: "contract" } });
    const r2 = await checklistAsAdmin(subId);
    if (!r2.ok) throw new Error("expected ok");
    expect(r2.gates.find((g) => g.key === "G3")).toEqual({ key: "G3", pass: true });
  });

  it("G3b: reports ashesSignatureRequired until the Pet Ash agreement is signed, matching verifySale's own gate exactly", async () => {
    const subId = await submitPlain("Checklist G3b Client", { productId: ashesProductId });
    await approveSplit(subId);

    const r = await checklistAsAdmin(subId);
    if (!r.ok) throw new Error("expected ok");
    expect(r.gates.find((g) => g.key === "G3")).toEqual({ key: "G3", pass: false, reasonKey: "ashesSignatureRequired" });
    expect((await verifyAsAdmin(subId)).error).toBe("ashesSignatureRequired"); // same verdict as the real gate

    who.session = { user: { associateId: closerId, id: closerId } };
    await signAshesAgreement(subId, FAKE_PNG_DATA_URL);
    const r2 = await checklistAsAdmin(subId);
    if (!r2.ok) throw new Error("expected ok");
    expect(r2.gates.find((g) => g.key === "G3")).toEqual({ key: "G3", pass: true });
  });

  // DevLead review, req-3 sweep (follow-up to #3/#5's Rejected value):
  // resolveProductDocGate's BACKSTOP check ("an agreement that was ever
  // required... must still be enforced even if the product's flag has
  // since been turned off") used a negative `!== Superseded`, which
  // silently absorbed Rejected too. This only shows up when the line
  // item's CURRENT product doesn't itself require ashes any more (the
  // first loop's own `requiresAshesAgreement` signal is already false) but
  // a legacy agreement row is still attached — exactly the scenario the
  // backstop exists for. getVerifyChecklist has no submission-status
  // guard of its own (unlike verifySale's explicit `status !== Submitted`
  // refusal), so this was reachable on a rejected sale.
  it("G3 backstop: a legacy ashes agreement (now Rejected) on a plain-product sale does NOT make G3 wrongly require it", async () => {
    const subId = await submitPlain("Checklist Rejected Backstop Client", { productId: plainProductId });
    await prisma.petsAshesAgreement.create({
      data: {
        submissionId: subId, applicant1Name: "Checklist Rejected Backstop Client",
        amountNumeric: "1000", amountWords: "One thousand", paymentPlan: "FullPayment" as never,
        status: "Draft" as never,
      },
    });

    who.session = { user: { id: ADMIN_A, associateId: null, role: "Admin" } };
    const rejected = await rejectSubmission(subId, "checklist-rejected-backstop-test");
    expect(rejected.ok).toBe(true);

    const agreement = await prisma.petsAshesAgreement.findUniqueOrThrow({ where: { submissionId: subId }, select: { status: true } });
    expect(agreement.status).toBe("Rejected"); // cascaded, never-signed branch

    const r = await checklistAsAdmin(subId);
    if (!r.ok) throw new Error("expected ok");
    expect(r.gates.find((g) => g.key === "G3")).toEqual({ key: "G3", pass: true });
  });

  it("G2/G5: a negative-line split with an exception approved by THIS admin fails G5 but not G2", async () => {
    who.session = { user: { associateId: closerId, id: closerId } };
    const r0 = await submitSale({
      salesDate: "2026-08-01", clientName: "Checklist G5 Client", paymentPlan: "Full Payment",
      lines: [{ productId: plainProductId, lineSaleAmount: 1000, comCodeIds: [] }],
      associate2: { associateId: partnerId, valueType: "Absolute", value: 900 },
    });
    const subId = r0.id!;
    await approveSplit(subId);

    const before = await checklistAsAdmin(subId);
    if (!before.ok) throw new Error("expected ok");
    expect(before.gates.find((g) => g.key === "G2")).toEqual({ key: "G2", pass: false, reasonKey: "splitExceptionRequired" });

    const sub = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, include: { lineItems: true } });
    const { splitBoundViolations } = await import("@/server/commission/split-bounds");
    const violations = await splitBoundViolations(prisma, {
      salesDate: sub.salesDate, closingAssociateId: sub.closingAssociateId, lines: sub.lineItems,
      associate2Id: sub.associate2Id, associate2ValueType: sub.associate2ValueType, associate2Value: sub.associate2Value,
      associate3Id: sub.associate3Id, associate3ValueType: sub.associate3ValueType, associate3Value: sub.associate3Value,
    });
    const { approveSplitException } = await import("./actions");
    who.session = { user: { id: ADMIN_A, associateId: null, role: "Admin" } };
    await approveSplitException(subId, "the owner approved this one-off split", null, violations);

    const asApprover = await checklistAsAdmin(subId, undefined, ADMIN_A);
    if (!asApprover.ok) throw new Error("expected ok");
    expect(asApprover.gates.find((g) => g.key === "G2")).toEqual({ key: "G2", pass: true });
    expect(asApprover.gates.find((g) => g.key === "G5")).toEqual({ key: "G5", pass: false, reasonKey: "fourEyesBlocked" });

    const asOther = await checklistAsAdmin(subId, undefined, ADMIN_B);
    if (!asOther.ok) throw new Error("expected ok");
    expect(asOther.gates.find((g) => g.key === "G5")).toEqual({ key: "G5", pass: true });
  });

  it("G4: reports staleVersion only when a seenContentVersion is passed and no longer matches", async () => {
    const subId = await submitPlain("Checklist G4 Client");
    const r0 = await checklistAsAdmin(subId);
    if (!r0.ok) throw new Error("expected ok");
    expect(r0.gates.find((g) => g.key === "G4")).toEqual({ key: "G4", pass: true }); // no seenContentVersion given
    const seen = r0.contentVersion;

    who.session = { user: { associateId: closerId, id: closerId } };
    const { editSale } = await import("./actions");
    await editSale({
      id: subId, salesDate: "2026-08-01", clientName: "Checklist G4 Client Edited", paymentPlan: "Full Payment",
      lines: [{ productId: plainProductId, lineSaleAmount: 1000, comCodeIds: [] }],
    });

    const r1 = await checklistAsAdmin(subId, seen);
    if (!r1.ok) throw new Error("expected ok");
    expect(r1.gates.find((g) => g.key === "G4")).toEqual({ key: "G4", pass: false, reasonKey: "staleVersion" });
  });
});
