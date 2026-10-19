// A-17 §3: rejectSubmission (Admin/Accounts, reason, Submitted-only, CAS).
// Flag on: refuses Legacy, requires a reason, stamps rejectedAt (drives §4a).
// Flag off: byte-for-byte the pre-A-17 legacy behaviour (reason optional).
// Real throwaway Postgres.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

const who: { session: unknown } = { session: null };
vi.mock("@/auth", () => ({ auth: async () => who.session }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";

const TAG = "A17REJECT-";
let companyId = "", productId = "", closerId = "", adminId = "";

beforeAll(async () => {
  companyId = (await prisma.company.create({ data: { name: TAG + "Co", invoicePrefix: TAG + "INV", active: true }, select: { id: true } })).id;
  productId = (await prisma.product.create({
    data: {
      productCode: TAG + "P1", productName: "Grave Plot", commissionType: "Percentage" as never,
      closingCommPct: "10", companyCutPct: "2", smOverridePct: "5", sdOverridePct: "3",
      defaultCompanyId: companyId, effectiveDate: new Date("2099-01-01"),
    },
    select: { id: true },
  })).id;
  closerId = (await prisma.associate.create({
    data: { associateCode: TAG + "CL", fullName: "Closer", designation: "SalesAssociate" as never, approvalStatus: "Approved" as never, associateStatus: "Active" as never },
    select: { id: true },
  })).id;
  adminId = "55555555-5555-5555-5555-555555555555";
});

afterAll(async () => {
  const subs = await prisma.salesSubmission.findMany({ where: { closingAssociateId: closerId }, select: { id: true } });
  const subIds = subs.map((s) => s.id);
  // pets_ashes_agreements_submission_id_fkey is ON DELETE RESTRICT — any
  // agreement rows the cascade tests below create must go before the
  // submission delete, same FK-ordering reason saleLineItem already does.
  await prisma.petsAshesAgreement.deleteMany({ where: { submissionId: { in: subIds } } });
  await prisma.saleLineItem.deleteMany({ where: { submissionId: { in: subIds } } });
  await prisma.salesSubmission.deleteMany({ where: { id: { in: subIds } } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.associate.deleteMany({ where: { id: closerId } });
  await prisma.company.deleteMany({ where: { id: companyId } });
});

afterEach(() => {
  who.session = null;
});

async function makeSubmission(submit: (input: unknown) => Promise<{ id?: string }>) {
  who.session = { user: { associateId: closerId, id: closerId } };
  const r = await submit({
    salesDate: "2026-08-01", clientName: "Reject Me", paymentPlan: "Full Payment",
    lines: [{ productId, lineSaleAmount: 1000, comCodeIds: [] }],
  });
  return r.id!;
}

describe("rejectSubmission — flag OFF (default): unchanged legacy behaviour", () => {
  // Forced explicitly rather than relying on ambient process env being unset
  // — a static top-level import here would silently mis-test under A-17's
  // own shipping configuration (A17_CLOSED_DEAL_FLOW=true ambient).
  let rejectFlagOff: (id: string, reason?: string) => Promise<{ ok: boolean; error?: string }>;
  let submitFlagOff: (input: unknown) => Promise<{ ok: boolean; id?: string }>;

  beforeAll(async () => {
    delete process.env.A17_CLOSED_DEAL_FLOW;
    vi.resetModules();
    ({ rejectSubmission: rejectFlagOff, submitSale: submitFlagOff } = (await import("./actions")) as never);
  });

  it("rejects with no reason at all, exactly as before A-17", async () => {
    const subId = await makeSubmission(submitFlagOff as never);
    who.session = { user: { id: "66666666-6666-6666-6666-666666666666", associateId: null, role: "Admin" } };
    const r = await rejectFlagOff(subId);
    expect(r.ok).toBe(true);
    const sub = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, select: { status: true, flow: true } });
    expect(sub.status).toBe("Rejected");
    expect(sub.flow).toBe("Legacy"); // never touched by the flag-off path
  });
});

describe("rejectSubmission — flag ON", () => {
  let submitSale: (input: unknown) => Promise<{ id?: string }>;
  let rejectSubmission: (id: string, reason?: string) => Promise<{ ok: boolean; error?: string }>;

  beforeAll(async () => {
    process.env.A17_CLOSED_DEAL_FLOW = "true";
    vi.resetModules();
    ({ submitSale, rejectSubmission } = (await import("./actions")) as never);
  });
  afterAll(() => {
    delete process.env.A17_CLOSED_DEAL_FLOW;
  });

  it("rejects a non-admin", async () => {
    const subId = await makeSubmission(submitSale);
    who.session = { user: { associateId: closerId, id: closerId, role: "SalesAssociate" } };
    const r = await rejectSubmission(subId, "not good enough");
    expect(r).toEqual({ ok: false, error: "forbidden" });
  });

  it("requires a reason", async () => {
    const subId = await makeSubmission(submitSale);
    who.session = { user: { id: adminId, associateId: null, role: "Admin" } };
    const r = await rejectSubmission(subId, "");
    expect(r).toEqual({ ok: false, error: "reasonRequired" });
  });

  it("rejects a Submitted sale, stamping rejectedAt and auditing the reason", async () => {
    const subId = await makeSubmission(submitSale);
    who.session = { user: { id: adminId, associateId: null, role: "Accounts" } };
    const r = await rejectSubmission(subId, "missing signed contract");
    expect(r.ok).toBe(true);

    const sub = await prisma.salesSubmission.findUniqueOrThrow({ where: { id: subId }, select: { status: true, rejectedAt: true } });
    expect(sub.status).toBe("Rejected");
    expect(sub.rejectedAt).not.toBeNull();

    const audits = await prisma.auditLog.findMany({ where: { entityId: subId, action: "submission.rejected" } });
    expect(audits).toHaveLength(1);
    expect((audits[0].afterJson as { reason: string }).reason).toBe("missing signed contract");
  });

  it("is a CAS — rejecting twice refuses the second with alreadyProcessed", async () => {
    const subId = await makeSubmission(submitSale);
    who.session = { user: { id: adminId, associateId: null, role: "Admin" } };
    expect((await rejectSubmission(subId, "first reason")).ok).toBe(true);
    expect(await rejectSubmission(subId, "second reason")).toEqual({ ok: false, error: "alreadyProcessed" });
  });

  it("refuses a Legacy row", async () => {
    const subId = await makeSubmission(submitSale);
    await prisma.salesSubmission.update({ where: { id: subId }, data: { flow: "Legacy" as never } });
    who.session = { user: { id: adminId, associateId: null, role: "Admin" } };
    const r = await rejectSubmission(subId, "some reason");
    expect(r).toEqual({ ok: false, error: "legacyReadOnly" });
  });
});

// Owner bug report, 19 Oct 2026: a rejected submission's agreement must not
// stay in a state that reads as "still live." An EVER-SIGNED agreement
// cascades to the SAME Superseded value editSale already uses for "no
// longer needed at all" (server/sales/actions.ts ✎6) — same meaning, reused
// trigger. A NEVER-SIGNED (still Draft) agreement cascades to the NEW
// `Rejected` value (owner decision, follow-up to this same bug — the
// migration that adds it: 20261019100000_ashes_rejected_status) — hard-
// delete was ruled out, it would delete the agreement the read-only page
// opens. This suite proves both halves, in the same transaction as the
// reject.
describe("rejectSubmission — ashes agreement cascade", () => {
  let submitSale: (input: unknown) => Promise<{ id?: string }>;
  let rejectSubmission: (id: string, reason?: string) => Promise<{ ok: boolean; error?: string }>;
  let saveAshesAgreement: (id: string, input: unknown) => Promise<{ ok: boolean; error?: string }>;
  let signAshesAgreement: (id: string, signatureDataUrl: string) => Promise<{ ok: boolean; error?: string }>;

  beforeAll(async () => {
    process.env.A17_CLOSED_DEAL_FLOW = "true";
    vi.resetModules();
    ({ submitSale, rejectSubmission } = (await import("./actions")) as never);
    ({ saveAshesAgreement, signAshesAgreement } = (await import("../agreements/actions")) as never);
  });
  afterAll(() => {
    delete process.env.A17_CLOSED_DEAL_FLOW;
  });

  async function makeAgreement(subId: string, overrides: { status: "Draft" | "Signed"; signatureVersion?: number; signedAt?: Date | null }) {
    return prisma.petsAshesAgreement.create({
      data: {
        submissionId: subId, applicant1Name: "Reject Me", amountNumeric: "1000", amountWords: "One thousand",
        paymentPlan: "FullPayment" as never, status: overrides.status as never,
        signatureVersion: overrides.signatureVersion ?? 0, signedAt: overrides.signedAt ?? null,
      },
      select: { id: true },
    });
  }

  it("an EVER-SIGNED agreement cascades to Superseded, audited with the rejection reason", async () => {
    const subId = await makeSubmission(submitSale);
    const agreement = await makeAgreement(subId, { status: "Signed", signatureVersion: 1, signedAt: new Date() });
    who.session = { user: { id: adminId, associateId: null, role: "Admin" } };
    const r = await rejectSubmission(subId, "ever-signed cascade");
    expect(r.ok).toBe(true);

    const updated = await prisma.petsAshesAgreement.findUniqueOrThrow({ where: { id: agreement.id }, select: { status: true } });
    expect(updated.status).toBe("Superseded");

    const audits = await prisma.auditLog.findMany({ where: { entityId: agreement.id, action: "ashes.superseded" } });
    expect(audits).toHaveLength(1);
    expect((audits[0].afterJson as { reason: string }).reason).toBe("submission_rejected");
  });

  it("a once-voided-then-reinstated agreement (Draft NOW, but everSigned via signatureVersion > 0) still cascades to Superseded — current status alone would miss this", async () => {
    const subId = await makeSubmission(submitSale);
    const agreement = await makeAgreement(subId, { status: "Draft", signatureVersion: 2, signedAt: null });
    who.session = { user: { id: adminId, associateId: null, role: "Admin" } };
    const r = await rejectSubmission(subId, "reinstated-then-rejected");
    expect(r.ok).toBe(true);
    const updated = await prisma.petsAshesAgreement.findUniqueOrThrow({ where: { id: agreement.id }, select: { status: true } });
    expect(updated.status).toBe("Superseded");
  });

  it("a NEVER-SIGNED Draft agreement cascades to Rejected, audited with the rejection reason", async () => {
    const subId = await makeSubmission(submitSale);
    const agreement = await makeAgreement(subId, { status: "Draft" });
    who.session = { user: { id: adminId, associateId: null, role: "Admin" } };
    const r = await rejectSubmission(subId, "never-signed cascade");
    expect(r.ok).toBe(true);

    const updated = await prisma.petsAshesAgreement.findUniqueOrThrow({ where: { id: agreement.id }, select: { status: true } });
    expect(updated.status).toBe("Rejected");

    // Never Superseded for this row — that value's own precondition
    // (everSigned) was never satisfied; proves the two branches don't bleed
    // into each other.
    const supersededAudits = await prisma.auditLog.findMany({ where: { entityId: agreement.id, action: "ashes.superseded" } });
    expect(supersededAudits).toHaveLength(0);

    const audits = await prisma.auditLog.findMany({ where: { entityId: agreement.id, action: "ashes.rejected" } });
    expect(audits).toHaveLength(1);
    expect((audits[0].afterJson as { reason: string }).reason).toBe("submission_rejected");
  });

  // Server-side refusal, end to end: once the cascade above has set the
  // agreement to Rejected, BOTH write actions must independently refuse —
  // not relying on the UI not showing an edit form (the owner's other ask,
  // #3's part (b)). Real DB, real Rejected value, real functions.
  it("a Rejected agreement refuses both saveAshesAgreement and signAshesAgreement, server-side", async () => {
    const subId = await makeSubmission(submitSale);
    const agreement = await makeAgreement(subId, { status: "Draft" });
    who.session = { user: { id: adminId, associateId: null, role: "Admin" } };
    expect((await rejectSubmission(subId, "then try to edit")).ok).toBe(true);

    const confirmed = await prisma.petsAshesAgreement.findUniqueOrThrow({ where: { id: agreement.id }, select: { status: true } });
    expect(confirmed.status).toBe("Rejected");

    who.session = { user: { associateId: closerId, id: closerId, role: "SalesAssociate" } };
    const save = await saveAshesAgreement(subId, { pets: [], applicant1Name: "Reject Me" });
    expect(save).toEqual({ ok: false, error: "quotationNotApproved" });

    const sign = await signAshesAgreement(subId, "data:image/png;base64,aGVsbG8=");
    expect(sign).toEqual({ ok: false, error: "alreadyProcessed" });

    // Unchanged by both refused attempts.
    const stillRejected = await prisma.petsAshesAgreement.findUniqueOrThrow({ where: { id: agreement.id }, select: { status: true } });
    expect(stillRejected.status).toBe("Rejected");
  });

  // The control: a submission with NO agreement at all must still reject
  // cleanly (the cascade lookup must not throw on a null relation).
  it("CONTROL — no ashesAgreement at all: rejects cleanly, no cascade attempted", async () => {
    const subId = await makeSubmission(submitSale);
    who.session = { user: { id: adminId, associateId: null, role: "Admin" } };
    const r = await rejectSubmission(subId, "no agreement at all");
    expect(r.ok).toBe(true);
  });
});
