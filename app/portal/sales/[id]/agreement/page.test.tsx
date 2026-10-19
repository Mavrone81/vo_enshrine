import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Owner bug report, 19 Oct 2026: a test submission was rejected, but Open on
 * its agreement just redirected to the dashboard instead of showing anything.
 * `redirect` is mocked to THROW (same idiom as server/team/performance-page.test.ts)
 * so a wrongly-taken redirect surfaces as a thrown error rather than silently
 * "passing" because nothing asserted the page's return value. AshesAgreementForm
 * is mocked so this test proves what THIS file is responsible for — the
 * redirect-vs-render decision and the props it hands down — not the form
 * component's own internal rendering (that's agreement-form.test.tsx).
 */
const h = vi.hoisted(() => ({
  sub: null as unknown,
  AshesAgreementForm: vi.fn((_props: Record<string, unknown>) => null),
}));

vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "u1", role: "Admin", associateId: null } }) }));
vi.mock("@/lib/db", () => ({ prisma: { salesSubmission: { findUnique: async () => h.sub } } }));
vi.mock("@/lib/rbac", () => ({ isAdminRole: () => true }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("next/navigation", () => ({
  redirect: (u: string) => { throw new Error("redirect:" + u); },
  notFound: () => { throw new Error("notFound"); },
}));
vi.mock("@/server/pii", () => ({ readNric: async () => null }));
vi.mock("./agreement-form", () => ({ AshesAgreementForm: h.AshesAgreementForm }));

import AshesAgreementPage from "@/app/portal/sales/[id]/agreement/page";

// The page is called as a plain function and its returned element tree is
// walked — same technique as server/team/performance-page.test.ts. JSX only
// CONSTRUCTS an element (`{type, props}`); nothing here actually RENDERS it,
// so AshesAgreementForm (mocked below) is never invoked as a function — it's
// found as a node's `type` and its props read directly off that node.
type El = { type?: unknown; props?: { children?: unknown; [k: string]: unknown } };
function findAll(node: unknown, type: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => findAll(n, type, out));
  else if (node && typeof node === "object") {
    const el = node as El;
    if (el.type === type) out.push(el);
    findAll(el.props?.children, type, out);
  }
  return out;
}

function subFixture(overrides: Partial<{ status: string; flow: string; ashesAgreement: unknown }>) {
  return {
    id: "sub1",
    closingAssociateId: "closer1",
    clientName: "Jane Tan",
    clientContact: null,
    saleAmount: "1000",
    paymentPlan: "FullPayment",
    lineItems: [],
    status: overrides.status ?? "Submitted",
    flow: overrides.flow ?? "ClosedDeal",
    ashesAgreement: overrides.ashesAgreement ?? null,
  };
}

const render = async (sub: unknown) => {
  h.sub = sub;
  const tree = await AshesAgreementPage({ params: Promise.resolve({ id: "sub1" }) });
  return findAll(tree, h.AshesAgreementForm);
};

describe("Agreement page — rejected submissions render read-only, they don't redirect", () => {
  it("Rejected + a still-Draft agreement: renders (no redirect), readOnly=true", async () => {
    const found = await render(subFixture({ status: "Rejected", flow: "ClosedDeal", ashesAgreement: { id: "a1", status: "Draft", agreementPdfKey: null, pets: [] } }));
    expect(found).toHaveLength(1);
    expect(found[0].props).toMatchObject({ readOnly: true, signed: false });
  });

  // The control: a non-rejected, not-yet-editable status keeps the PRE-EXISTING
  // redirect behaviour unchanged — proves this fix didn't just delete the
  // redirect outright for every status, only for Rejected specifically.
  it("CONTROL — Verified (not Rejected, not editable): still redirects, same as before this fix", async () => {
    await expect(render(subFixture({ status: "Verified", flow: "ClosedDeal" }))).rejects.toThrow("redirect:/portal/quotations");
  });

  it("editable status (Submitted/ClosedDeal): renders, readOnly=false — unchanged pre-existing behaviour", async () => {
    const found = await render(subFixture({ status: "Submitted", flow: "ClosedDeal" }));
    expect(found).toHaveLength(1);
    expect(found[0].props).toMatchObject({ readOnly: false });
  });
});
