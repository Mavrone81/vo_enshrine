import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppRole } from "@prisma/client";

/**
 * The "not eligible for recruitment yet" card — the state a role that cannot
 * recruit sees in place of the downline table.
 *
 * Why this file exists: nothing anywhere asserted that card. The page-level
 * test (server/team/performance-page.test.ts) mocks RecruitmentView away
 * entirely, so it can only prove the component is MOUNTED — it cannot tell a
 * card from a table from an empty div. When the owner asked for the card to
 * appear for Sales Assistant Manager on Team Performance (7 Oct 2026), that
 * page test would have gone green on a component rendering nothing at all.
 *
 * So this renders the real component and reads what comes out. `downlineIds`
 * is the instrument for the second half of the claim: the ineligible branch
 * must not walk a downline, and a mock that records its calls proves that
 * directly rather than by inspecting markup.
 */
const h = vi.hoisted(() => ({
  role: "SalesManager" as string,
  downlineIds: vi.fn(async () => ["A1", "A2"]),
  fetchAssociates: vi.fn(async () => []),
}));

vi.mock("@/auth", () => ({ auth: async () => ({ user: { role: h.role, associateId: "A1" } }) }));
vi.mock("@/lib/db", () => ({ prisma: { salesTransaction: { findMany: async () => [] }, commissionLedger: { findMany: async () => [] } } }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("@/server/recruitment/team-dashboard", () => ({ fetchTeamDashboardAssociates: h.fetchAssociates }));
vi.mock("@/lib/rbac", async (orig) => ({ ...(await orig<object>()), downlineIds: h.downlineIds }));

import { RecruitmentView } from "@/components/recruitment/recruitment-view";

// Collect every string in the returned element tree, so an assertion reads the
// rendered output rather than a prop we chose to look at.
function text(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => text(n, out));
  else if (node && typeof node === "object") text((node as { props?: { children?: unknown } }).props?.children, out);
  return out;
}

const render = async (role: AppRole) => {
  h.role = role;
  const tree = await RecruitmentView({ mode: "performance", basePath: "/portal/team/performance", tab: "all", mgr: null, embedded: true });
  return text(tree);
};

beforeEach(() => {
  h.downlineIds.mockClear();
  h.fetchAssociates.mockClear();
});

describe("RecruitmentView — the not-eligible card", () => {
  it("SalesAssistantManager cannot recruit, so it gets the card and no downline walk", async () => {
    const strings = await render("SalesAssistantManager");
    expect(strings).toContain("notEligible");
    expect(h.downlineIds).not.toHaveBeenCalled();
    expect(h.fetchAssociates).toHaveBeenCalledWith(["A1"]);
  });

  for (const role of ["SalesManager", "SalesDirector"] as AppRole[]) {
    it(`${role} can recruit, so it gets no card and the downline is walked`, async () => {
      const strings = await render(role);
      expect(strings).not.toContain("notEligible");
      expect(h.downlineIds).toHaveBeenCalledWith("A1");
    });
  }

  // The control. Without it, a component that silently returned null would
  // satisfy every `not.toContain` above and the suite would still be green.
  it("the harness can see the card at all (control)", async () => {
    const strings = await render("SalesAssistantManager");
    expect(strings.length).toBeGreaterThan(0);
    expect(strings).toContain("notEligible");
  });
});

/**
 * Business name column (19 Oct 2026, owner-approved VO PR2): Director →
 * Recruitment tab ("people" mode) only. `fetchAssociates` stands in for
 * fetchTeamDashboardAssociates — it's mocked, so these tests prove the
 * COMPONENT's own behaviour (dash fallback, and that it never renders a row
 * outside the tree rooted at `me`), not the server-side select or the real
 * downlineIds SQL (those are proven elsewhere: team-dashboard.integration.test.ts
 * and lib/rbac's own tests).
 */
describe("RecruitmentView — Business name column (people mode)", () => {
  // tab: "direct" (not "all") deliberately — it sets showUpline to false,
  // suppressing the OTHER column on this exact table whose own fallback is
  // also "—" (a.directUpline?.associateCode ?? "—"). Using "all" would let
  // that column's dash satisfy a `toContain("—")` assertion even if the
  // business-name fallback below were deleted — caught by mutation-testing
  // this file (removing the `?? "—"` left the dash test green under "all").
  const renderPeople = async (rows: Array<{ id: string; directUplineId: string | null; associateCode: string; fullName: string; businessName: string | null; designation: string; associateStatus: string; directUpline: null }>) => {
    h.role = "SalesDirector";
    h.fetchAssociates.mockImplementation(async () => rows as never);
    const tree = await RecruitmentView({ mode: "people", basePath: "/portal/team", tab: "direct", mgr: null, embedded: true });
    return text(tree);
  };

  const row = (overrides: Partial<{ id: string; directUplineId: string | null; businessName: string | null }>) => ({
    id: "R1",
    directUplineId: "A1",
    associateCode: "VO-R1",
    fullName: "Real Recruit",
    businessName: "Acme Trading",
    designation: "SalesAssociate",
    associateStatus: "Active",
    directUpline: null,
    ...overrides,
  });

  it("renders the real business name when present", async () => {
    const strings = await renderPeople([row({ businessName: "Acme Trading" })]);
    expect(strings).toContain("Acme Trading");
  });

  it("renders a dash (the codebase's standard missing-value fallback) when business name is null, never an empty cell", async () => {
    const strings = await renderPeople([row({ businessName: null })]);
    // Same character every other optional column in this codebase falls back
    // to (components/team/downline-lookup-panel.tsx, app/portal/team/page.tsx,
    // etc.) — not a different "missing" glyph invented for this one column.
    expect(strings).toContain("—");
    expect(strings).not.toContain("Acme Trading");
  });

  it("never renders a business name for a row outside my downline tree — adding the column leaks no extra row", async () => {
    const strings = await renderPeople([
      row({ id: "R1", directUplineId: "A1", businessName: "Acme Trading" }), // in my tree (direct recruit)
      row({ id: "R2", directUplineId: "SOMEONE-ELSE", businessName: "Leaked Biz" }), // NOT reachable from me
    ]);
    // selectRecruits/descendants (lib/recruitment-view.ts) already drops R2
    // before the table ever sees it; this proves the new column doesn't
    // change that — it only ever renders alongside a row already in `rows`.
    expect(strings).toContain("Acme Trading");
    expect(strings).not.toContain("Leaked Biz");
  });
});
