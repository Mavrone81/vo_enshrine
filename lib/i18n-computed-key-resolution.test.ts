import { describe, it, expect } from "vitest";
import en from "@/messages/en.json";
import zhCN from "@/messages/zh-CN.json";

/**
 * Covers the class lib/i18n-key-resolution.test.ts explicitly does NOT: a key
 * built from a template literal with interpolation (`t(\`status.${x.toLowerCase()}\`)`),
 * or a bare enum/union value passed directly as a key (`tRoles(session.user.role)`).
 * That test's own header says so (class 1) and its "unresolvable" log lists the
 * template-literal sites it can see but never checks; the bare-variable sites
 * (tRoles(...)) aren't even logged there — neither resolved nor unresolvable.
 *
 * Found live by this sweep: `roles.SalesAssistantManager` was missing from both
 * catalogues, so `tRoles(session.user.role)` rendered the raw key
 * "roles.SalesAssistantManager" for anyone with that role (app/admin/layout.tsx,
 * app/portal/layout.tsx, app/admin/name-card/page.tsx,
 * app/admin/associates/[id]/page.tsx). Fixed alongside this test.
 *
 * Each family below is the enumerable value set for one dynamic call site,
 * sourced from the actual enum/union/const that drives it (cited per family so
 * a future drift is a one-line diff here, not a silent gap). If a family's
 * source of truth changes shape, this file's list must change with it — that
 * coupling is deliberate, not a maintenance accident.
 */

type Family = {
  /** The dotted path prefix the computed suffix is appended to, e.g. "roles". */
  namespace: string;
  /** Every value the source enum/union/const can actually produce. */
  values: readonly string[];
  /** Where that value set comes from, for a human checking this still matches. */
  source: string;
};

const FAMILIES: Family[] = [
  {
    namespace: "roles",
    // prisma/schema.prisma AppRole enum. Consumed via tRoles(session.user.role) /
    // tRoles(actor.role) — a bare enum value passed as the key, not a template
    // literal, so lib/i18n-key-resolution.test.ts cannot see it at all.
    values: ["Admin", "Accounts", "SalesDirector", "SalesManager", "SalesAssistantManager", "SalesAssociate"],
    source: "prisma/schema.prisma enum AppRole; app/admin/layout.tsx, app/portal/layout.tsx, app/admin/name-card/page.tsx, app/admin/associates/[id]/page.tsx",
  },
  {
    namespace: "quotation.status",
    // prisma/schema.prisma QuotationStatus enum, lower-cased by the call site.
    values: ["issued", "converted", "void"],
    source: "prisma/schema.prisma enum QuotationStatus; app/admin/quotations/admin-quotations-list.tsx, app/portal/agreements/quotation-form.tsx — t(`status.${q.status.toLowerCase()}`)",
  },
  {
    namespace: "invoices.payment",
    // prisma/schema.prisma InvoicePaymentMethod enum, lower-cased by the call site.
    values: ["cash", "credit", "bank"],
    source: "prisma/schema.prisma enum InvoicePaymentMethod; app/admin/invoices/page.tsx — t(`payment.${inv.paidMethod.toLowerCase()}`)",
  },
  {
    namespace: "quotations.tabs",
    values: ["records", "legacy"],
    source: "app/admin/quotations/page.tsx — (['records','legacy'] as const).map(tb => t(`tabs.${tb}`))",
  },
  {
    namespace: "verify.tabs",
    values: ["awaiting", "booked"],
    source: "app/admin/sales/verify/page.tsx — (['awaiting','booked'] as const).map(tb => t(`tabs.${tb}`))",
  },
  {
    namespace: "verify.gate",
    values: ["G1", "G2", "G3", "G4", "G5"],
    source: "app/admin/sales/verify/verify-panel.tsx GATE_KEYS — t(`gate.${key}`)",
  },
  {
    namespace: "adminMarketing.cat",
    // lib/marketing-categories.ts MARKETING_SLUGS keys — the only slugs categoryFromSlug accepts.
    values: ["flyers", "edms", "customisation", "greetings"],
    source: "lib/marketing-categories.ts MARKETING_SLUGS; app/admin/marketing/[category]/page.tsx — t(`cat.${slug}`)",
  },
  {
    namespace: "portalMarketing.cat",
    values: ["flyers", "edms", "customisation", "greetings"],
    source: "lib/marketing-categories.ts MARKETING_SLUGS; app/portal/marketing/[category]/page.tsx — t(`cat.${slug}`)",
  },
  {
    namespace: "portal.documents",
    // app/portal/documents/page.tsx CATEGORY_TEMPLATES — only these two entries have a `key`.
    values: ["tplAshes", "tplReferral"],
    source: "app/portal/documents/page.tsx CATEGORY_TEMPLATES — t(`documents.${tpl.key}`)",
  },
  {
    namespace: "agreements.docTemplate.cat",
    // prisma/schema.prisma TemplateCategory enum {PetsAfterlife, HumanAfterlife}, mapped by a ternary.
    values: ["pets", "human"],
    source: "prisma/schema.prisma enum TemplateCategory; app/portal/documents/page.tsx — ta(`docTemplate.cat.${cat === \"PetsAfterlife\" ? \"pets\" : \"human\"}`)",
  },
  {
    namespace: "portal.saleDetail.ashesAgreementStatus",
    // prisma/schema.prisma AshesAgreementStatus enum, lower-cased by the call site.
    values: ["draft", "signed", "superseded", "rejected"],
    source: "prisma/schema.prisma enum AshesAgreementStatus; app/portal/sales/[id]/page.tsx — t(`saleDetail.ashesAgreementStatus.${s.ashesAgreement.status.toLowerCase()}`)",
  },
  {
    namespace: "recruitment.board.tab",
    // lib/recruitment-view.ts RecruitTab union / RECRUIT_TABS const.
    values: ["all", "direct", "downline"],
    source: "lib/recruitment-view.ts RecruitTab/RECRUIT_TABS; components/recruitment/recruitment-view.tsx — t(`tab.${k}`)",
  },
  {
    namespace: "recruitment.board.perfTab",
    values: ["all", "direct", "downline"],
    source: "lib/recruitment-view.ts RecruitTab/RECRUIT_TABS; components/recruitment/recruitment-view.tsx — t(`perfTab.${k}`)",
  },
  {
    namespace: "sales.myTxn.scheme",
    // lib/my-share.ts MyScheme union — the only values ever added to the `schemes` set.
    values: ["closer", "split", "directOverride", "secondOverride", "addOn"],
    source: "lib/my-share.ts MyScheme; components/transactions/my-transactions-table.tsx — t(`scheme.${s}`)",
  },
  {
    namespace: "sales.myTxn.tab",
    values: ["list", "received", "receivable"],
    source: "components/transactions/my-transactions-view.tsx TABS — t(`tab.${tab.key}`)",
  },
  {
    namespace: "errors",
    // lib/company-identity.ts CompanyDetailsError union, prefixed with "companyDetails"
    // and the first letter capitalised by the call site.
    values: [
      "companyDetailsUenInvalid",
      "companyDetailsPaynowUenInvalid",
      "companyDetailsGstRegNoInvalid",
      "companyDetailsEmailInvalid",
      "companyDetailsTooLong",
    ],
    source:
      'lib/company-identity.ts CompanyDetailsError; server/company/actions.ts — t(`companyDetails${cleaned.error[0].toUpperCase()}${cleaned.error.slice(1)}`)',
  },
  {
    namespace: "portal.dashboard.band",
    // lib/rank-band.ts RANK_BANDS ids — invisible to the literal-key extractor because
    // the translator binding is a Promise.all array destructure, not `const t = ...`.
    values: ["top1", "top5", "top10", "top25", "top50", "rest"],
    source: "lib/rank-band.ts RANK_BANDS; components/dashboard/profile-band-card.tsx — t(`band.${result.band.id}`)",
  },
];

function get(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((cur, seg) => {
    if (typeof cur !== "object" || cur === null) return undefined;
    return (cur as Record<string, unknown>)[seg];
  }, root);
}

describe("every computed (enum/union-interpolated) t() key resolves in both catalogues", () => {
  const cases = FAMILIES.flatMap((f) => f.values.map((v) => ({ family: f.namespace, source: f.source, fullKey: `${f.namespace}.${v}` })));

  it("examined at least 16 call-site families covering at least 40 resolved keys", () => {
    // A guard that checks nothing passes just as easily as one that checks
    // everything — these floors fail loudly if FAMILIES is ever gutted by accident.
    expect(FAMILIES.length).toBeGreaterThanOrEqual(16);
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });

  it(`every one of the ${cases.length} enumerated values resolves under messages/en.json`, () => {
    const missing = cases.filter((c) => typeof get(en, c.fullKey) !== "string").map((c) => c.fullKey);
    expect(missing).toEqual([]);
  });

  it(`every one of the ${cases.length} enumerated values resolves under messages/zh-CN.json`, () => {
    const missing = cases.filter((c) => typeof get(zhCN, c.fullKey) !== "string").map((c) => c.fullKey);
    expect(missing).toEqual([]);
  });
});
