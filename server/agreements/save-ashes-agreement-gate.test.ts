// A-17: saveAshesAgreement's status gate now uses isAgreementEditableStatus
// (flow-aware) instead of a hard-coded QuotationApproved — before this fix a
// ClosedDeal sale's Draft agreement (created by editSale while the
// submission sits at Submitted) could never be filled in or saved.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { authMock, prismaMock, logAuditMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  prismaMock: {
    salesSubmission: { findUnique: vi.fn() },
    petsAshesAgreement: { create: vi.fn(), update: vi.fn() },
  },
  logAuditMock: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: logAuditMock }));
// A-17 follow-up (ambient-flag release blocker): this file's mock replaces
// the whole @/lib/audit module (no auditTx/AuditWriteError), so N4's
// Legacy-frozen branch — reachable under ambient A17_CLOSED_DEAL_FLOW=true —
// would throw against this mock rather than testing anything. Forced off so
// this file (about the status gate, not about A-17's flag) isn't steered by
// ambient config either way; a named coverage gap is recorded in
// reviews/a17-flag-on-preconditions.md as a flag-flip precondition.
vi.mock("@/lib/env", async (orig) => ({ ...(await orig<typeof import("@/lib/env")>()), env: { ...(await orig<typeof import("@/lib/env")>()).env, A17_CLOSED_DEAL_FLOW: false } }));

import { saveAshesAgreement } from "@/server/agreements/actions";

const CLOSER = { user: { id: "u1", associateId: "closer1", role: "SalesAssociate" } };
const MIN_INPUT = { pets: [], applicant1Name: "Applicant One" };

function subFixture(overrides: Partial<{ status: string; flow: string; ashesAgreement: unknown }>) {
  return {
    closingAssociateId: "closer1",
    status: overrides.status ?? "Submitted",
    flow: overrides.flow ?? "ClosedDeal",
    ashesAgreement: overrides.ashesAgreement ?? null,
    paymentPlan: "FullPayment",
    saleAmount: { minus: () => ({ div: () => 0 }), toString: () => "1000" },
    deposit: null,
    installmentCount: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(CLOSER);
  prismaMock.petsAshesAgreement.create.mockResolvedValue({ id: "agreement1" });
  prismaMock.petsAshesAgreement.update.mockResolvedValue({ id: "agreement1" });
});

describe("saveAshesAgreement — status gate", () => {
  it("ClosedDeal + Submitted: allowed — the state editSale actually leaves the Draft in", async () => {
    prismaMock.salesSubmission.findUnique.mockResolvedValue(subFixture({ flow: "ClosedDeal", status: "Submitted" }));
    const r = await saveAshesAgreement("sub1", MIN_INPUT);
    expect(r.ok).toBe(true);
    expect(prismaMock.petsAshesAgreement.create).toHaveBeenCalledTimes(1);
  });

  it("ClosedDeal + QuotationApproved: refused — never reachable, but must not be silently allowed", async () => {
    prismaMock.salesSubmission.findUnique.mockResolvedValue(subFixture({ flow: "ClosedDeal", status: "QuotationApproved" }));
    const r = await saveAshesAgreement("sub1", MIN_INPUT);
    expect(r).toEqual({ ok: false, error: "quotationNotApproved" });
    expect(prismaMock.petsAshesAgreement.create).not.toHaveBeenCalled();
  });

  it("Legacy + QuotationApproved: allowed — unchanged pre-existing behaviour", async () => {
    prismaMock.salesSubmission.findUnique.mockResolvedValue(subFixture({ flow: "Legacy", status: "QuotationApproved" }));
    const r = await saveAshesAgreement("sub1", MIN_INPUT);
    expect(r.ok).toBe(true);
  });

  it("Legacy + Submitted: refused — unchanged pre-existing behaviour", async () => {
    prismaMock.salesSubmission.findUnique.mockResolvedValue(subFixture({ flow: "Legacy", status: "Submitted" }));
    const r = await saveAshesAgreement("sub1", MIN_INPUT);
    expect(r).toEqual({ ok: false, error: "quotationNotApproved" });
  });

  // Owner bug report, 19 Oct 2026: a REJECTED submission's agreement is a
  // terminal state (app/portal/sales/[id]/agreement/page.tsx's own fix for
  // the UI half of the same report — it now renders read-only instead of
  // redirecting). This proves the SERVER side independently refuses the
  // write too — not just the UI choosing not to show an edit form — for
  // BOTH flows and regardless of whether the agreement row is still a
  // never-signed Draft (the exact bug: "its draft agreement stayed draft").
  it("ClosedDeal + Rejected: refused — a terminal submission's agreement can't be edited server-side, UI-greying is not enough", async () => {
    prismaMock.salesSubmission.findUnique.mockResolvedValue(subFixture({ flow: "ClosedDeal", status: "Rejected", ashesAgreement: { id: "a1", status: "Draft" } }));
    const r = await saveAshesAgreement("sub1", MIN_INPUT);
    expect(r).toEqual({ ok: false, error: "quotationNotApproved" });
    expect(prismaMock.petsAshesAgreement.update).not.toHaveBeenCalled();
  });

  it("Legacy + Rejected: refused — same server-side terminal check, other flow", async () => {
    prismaMock.salesSubmission.findUnique.mockResolvedValue(subFixture({ flow: "Legacy", status: "Rejected", ashesAgreement: { id: "a1", status: "Draft" } }));
    const r = await saveAshesAgreement("sub1", MIN_INPUT);
    expect(r).toEqual({ ok: false, error: "quotationNotApproved" });
  });

  it("still refuses once already Signed, regardless of the status gate", async () => {
    prismaMock.salesSubmission.findUnique.mockResolvedValue(subFixture({ flow: "ClosedDeal", status: "Submitted", ashesAgreement: { id: "a1", status: "Signed" } }));
    const r = await saveAshesAgreement("sub1", MIN_INPUT);
    expect(r).toEqual({ ok: false, error: "alreadyProcessed" });
  });

  it("already Signed + a status the gate no longer considers editable: still alreadyProcessed, not quotationNotApproved — the stronger, more specific reason wins", async () => {
    prismaMock.salesSubmission.findUnique.mockResolvedValue(subFixture({ flow: "ClosedDeal", status: "Verified", ashesAgreement: { id: "a1", status: "Signed" } }));
    const r = await saveAshesAgreement("sub1", MIN_INPUT);
    expect(r).toEqual({ ok: false, error: "alreadyProcessed" });
  });
});
