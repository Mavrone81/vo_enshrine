import {
  LayoutDashboard, UserPlus, Users, BadgeCheck, Receipt, ReceiptText, Tags, Calculator,
  FileText, Banknote, Megaphone, FolderOpen, Handshake, FileSignature,
  IdCard, FolderLock, Network, ScrollText, ClipboardCheck, Split, FileCheck,
  TrendingUp, Wallet, HandCoins, ListChecks, Mail, Image, Palette,
  PartyPopper, Store, Sparkles, Landmark, Archive, Building2, HelpCircle, type LucideIcon,
} from "lucide-react";
import type { AppRole } from "@prisma/client";
import { RECRUITER_ROLES } from "@/lib/roles";

export type NavItem = {
  labelKey: string; // key into the `nav` message namespace
  href?: string; // omitted => not yet built (rendered disabled)
  icon: LucideIcon;
  badgeKey?: string; // dynamic count key resolved by the shell
  roles?: AppRole[]; // when set, item shows only for these roles
  children?: NavItem[]; // consolidated menu (Sep 2026): collapsible sub-items
};
export type NavGroup = { titleKey: string; items: NavItem[] };

const DIRECTOR_ROLES: AppRole[] = ["SalesDirector", "Admin"];

// ---------------------------------------------------------------------------
// Consolidated menu (Sep 2026 sketch): Personal Performance / Recruitment /
// Forms & Submission / Marketing / Products & Services, plus a small Resources
// tail for the workspace pages the sketch leaves in place.
// ---------------------------------------------------------------------------

export const adminNav: NavGroup[] = [
  {
    titleKey: "groupPerformance",
    items: [
      { labelKey: "myDashboard", href: "/admin/dashboard", icon: LayoutDashboard },
      {
        labelKey: "transactions", icon: Receipt,
        children: [
          { labelKey: "transactionList", href: "/admin/sales/transactions", icon: ListChecks },
          { labelKey: "transactionReceived", href: "/admin/sales/received", icon: Wallet },
          { labelKey: "transactionReceivable", href: "/admin/sales/receivable", icon: HandCoins },
        ],
      },
    ],
  },
  {
    titleKey: "groupRecruitment",
    items: [
      {
        labelKey: "recruitment", href: "/admin/recruitment", icon: UserPlus, badgeKey: "recruit",
        children: [
          { labelKey: "associatesList", href: "/admin/associates", icon: Users },
          { labelKey: "teams", href: "/admin/teams", icon: Network, roles: ["Admin"] },
        ],
      },
    ],
  },
  {
    titleKey: "groupFormsSubmission",
    items: [
      {
        labelKey: "groupFormsSubmission", icon: FileSignature,
        children: [
          // Item 9 (owner: admin must be able to submit a sale, same flow as
          // everyone else). Reuses the "transactionSubmission" labelKey
          // portalNav's own submit-a-sale entry already uses — same action,
          // same meaning, not a new translation.
          { labelKey: "transactionSubmission", href: "/admin/sales/new", icon: Receipt },
            // The admin's OWN submitted sales. /admin/sales has existed since
            // item 9 but nothing ever linked to it, so an admin could submit a
            // sale and then have nowhere to see it (owner, 2026-10-08). A page
            // with no route into it is the same as no page.
            { labelKey: "mySales", href: "/admin/sales", icon: ReceiptText },
          { labelKey: "quotations", href: "/admin/quotations", icon: BadgeCheck, badgeKey: "quotations" },
          { labelKey: "splitApprovals", href: "/admin/split-approvals", icon: Split },
          { labelKey: "salesVerify", href: "/admin/sales/verify", icon: FileCheck },
          { labelKey: "referralPartnerships", href: "/admin/vendors", icon: Handshake, badgeKey: "referrals" },
          { labelKey: "agreements", href: "/admin/agreements", icon: FileSignature },
        ],
      },
    ],
  },
  {
    titleKey: "groupFinance",
    items: [
      {
        labelKey: "groupFinance", icon: Landmark,
        children: [
          { labelKey: "commission", href: "/admin/commission", icon: Calculator },
          { labelKey: "invoices", href: "/admin/invoices", icon: FileText },
          { labelKey: "payouts", href: "/admin/payouts", icon: Banknote },
        ],
      },
    ],
  },
  {
    titleKey: "groupMarketing",
    items: [
      {
        labelKey: "groupMarketing", icon: Sparkles,
        children: [
          { labelKey: "nameCard", href: "/admin/name-card", icon: IdCard },
          { labelKey: "flyers", icon: Image },
          { labelKey: "edm", icon: Mail },
          { labelKey: "customisation", icon: Palette },
          { labelKey: "greetings", icon: PartyPopper },
        ],
      },
    ],
  },
  {
    titleKey: "groupProducts",
    items: [
      { labelKey: "products", href: "/admin/products", icon: Tags, roles: ["Admin"] },
    ],
  },
  {
    titleKey: "groupResources",
    items: [
      {
        labelKey: "groupResources", icon: Archive,
        children: [
          { labelKey: "notices", href: "/admin/notices", icon: Megaphone },
          { labelKey: "documents", href: "/admin/documents", icon: FolderOpen },
          // FAQ (owner's request, PM/UIUX spec): a help resource, so it sits
          // here next to Notices/Documents rather than in Personal
          // Performance or Finance. No `roles` — every role sees this item;
          // the CONTENT behind it is what's role-filtered (server-side, see
          // lib/faq-content), same pattern as Team Dashboard/Team
          // Performance above.
          { labelKey: "faq", href: "/admin/faq", icon: HelpCircle },
          { labelKey: "auditLog", href: "/admin/audit", icon: ScrollText, roles: ["Admin"] },
          { labelKey: "uat", href: "/admin/uat", icon: ClipboardCheck, roles: ["Admin"] },
          { labelKey: "companyData", href: "/admin/company", icon: Building2, roles: ["Admin"] },
        ],
      },
    ],
  },
];

export const portalNav: NavGroup[] = [
  {
    titleKey: "groupPerformance",
    items: [
      // Associate-portal changes (Sep 2026, A1): plain links, no dropdowns.
      // The three transaction views are tabs on the My Transactions page.
      { labelKey: "myDashboard", href: "/portal/dashboard", icon: LayoutDashboard },
      { labelKey: "myTransactions", href: "/portal/transactions", icon: Receipt },
    ],
  },
  {
    // C-7 (p.8) + C-8 (owner ruling, 2026-10-03): "Recruitment" renamed to
    // "My Team" for the associate portal, and the two formerly-separate "My
    // Team" sections are now ONE group under this single key
    // (`groupMyTeamBase`) — the pre-existing DIRECTOR_ROLES-only group
    // (`groupMyTeam`: Team Overview/Sales/Commissions/Split Approvals) is
    // retired as a separate group; its items (minus Team Overview, see
    // below) are folded in here.
    //
    // "Team Overview" is REMOVED, not merged in as its own item: the owner
    // ruled its page and "Recruitment Dashboard" are the same underlying
    // page, kept as one canonical page at /portal/team (the former Team
    // Overview route — its 4 stat tiles stay, the All/Direct/Downline tabs
    // this item used to point to are added to it). This item's href moves
    // to /portal/team; the labelKey stays `recruitmentDashboard` (its
    // existing translation already reads "Team Dashboard") to avoid an
    // unforced key rename — only the destination page changed.
    //
    // Locked order (owner-confirmed, 2026-10-03; C11 trimmed it to four):
    // Team Dashboard, Team Performance, Split Approvals, Invite Candidate.
    // Team Sales and Team Commissions were folded into Team Performance
    // (C11) and their routes redirect there. An earlier "Associate List" item was a relay error, not a
    // real client ask — Additional p9's associate list is the content of
    // Team Dashboard's own tabs, not a separate menu entry.
    //
    // Gating is NOT "copy each item's old nav gate forward," and an
    // earlier pass of this comment got it wrong in the other direction —
    // worth leaving the correction in place. FOUR items here each answer to
    // their OWN real authority; a nav/route mismatch only tells you one
    // side is stale, never which, so each was resolved by reading that
    // item's actual action/route-level check, not by picking a role set
    // that looked plausible:
    //   - Team Dashboard (recruitmentDashboard, /portal/team): OPEN to
    //     every associate, same as always — this is A8 (Additional p8/p9/
    //     p10), a DELIVERED client row. The page differentiates by CONTENT,
    //     not nav visibility: RecruitmentView's own `eligible =
    //     canRecruit(role)` branch (RECRUITER_ROLES = SalesManager/
    //     SalesDirector/Admin, NOT SalesAssistantManager) renders the
    //     tiles+roster for a recruiter and the "not eligible yet" card
    //     otherwise — unchanged by this merge. app/portal/team/layout.tsx
    //     no longer gates this subtree by role (it did briefly, during
    //     this same change — that was wrong, see its own comment); it only
    //     requires login now, so nav and route agree for every role here.
    //   - Team Performance (downlinePerformance, /portal/team/performance):
    //     OPEN to every associate, no `roles` — like Team Dashboard, it
    //     differentiates by CONTENT. isManagerRole (SAM/SM/SD, no Admin)
    //     gets the team sales + commission view; everyone else gets the
    //     RecruitmentView downline branch (or its "not eligible" card). The
    //     team-wide queries are guarded by role inside
    //     server/team/performance.ts, not just hidden in the page.
    //   - Split Approvals (/portal/approvals): DIRECTOR_ROLES, matching
    //     that page's own Director/Admin check — unaffected by this merge.
    //   - Invite Candidate (/portal/recruitment/new): RECRUITER_ROLES,
    //     unaffected — unrelated route.
    // Quota-editing on the Team Dashboard's roster table is a FOURTH,
    // separate authority again (canSetQuota, SAM and above, cell-level in
    // server/quota/actions.ts) — untouched by any of this, and not the same
    // role set as either canRecruit or the route gate. A Sales Assistant
    // Manager is the one role where all three disagree: not a recruiter
    // (gets the "not eligible" card, no roster), but can reach the route
    // and can set quota — each on its own check, never collapsed into one.
    titleKey: "groupMyTeamBase",
    items: [
      {
        labelKey: "groupMyTeamBase", icon: Users,
        children: [
          { labelKey: "recruitmentDashboard", href: "/portal/team", icon: Users },
          { labelKey: "downlinePerformance", href: "/portal/team/performance", icon: TrendingUp },
          { labelKey: "splitApprovals", href: "/portal/approvals", icon: BadgeCheck, roles: DIRECTOR_ROLES, badgeKey: "splitApprovals" },
          { labelKey: "directRecruits", href: "/portal/recruitment/new", icon: UserPlus, roles: RECRUITER_ROLES },
        ],
      },
    ],
  },
  {
    // C-6 (p.6): "Forms & Submission" renamed to "Submissions" for the
    // associate portal. Own key (`groupSubmissionsBase`), not a rewrite of
    // `groupFormsSubmission`, because adminNav's own "Forms & Submission"
    // group shares that key and is out of scope here.
    // Referral Partner List moved out to Resources, below Documents (C-6).
    // "Quotation Request" below: the form already exists at /portal/agreements,
    // itself gated behind A17_CLOSED_DEAL_FLOW — the owner's decision (relayed,
    // not guessed) is fail-closed: HIDDEN, not merely disabled, until A-17 is
    // live (see quotationRequestVisible below). Unlike the marketing-library
    // items, this one is NOT shown as a disabled "coming soon" row when off —
    // a shown item behind a disabled flow is a visible broken path for a real
    // associate; a hidden item that could have shown is just a question asked
    // later. The href is real and static (the page itself already flag-checks
    // server-side, redirecting to Documents when off); only the nav entry's
    // VISIBILITY is gated.
    //
    // C-6 (2026-10-02): the old "Doc Template" item is REMOVED, not renamed —
    // its Pets/Human Afterlife templates and signed-agreements list folded
    // into Documents below, so there's no separate destination left for it to
    // point to. The page that used to serve it (app/portal/agreements/page.tsx)
    // now serves only the quotation form; its URL/identity still carrying the
    // old name is a known, named follow-up (moving it to its own route), not
    // built here — see the comment at the top of that file.
    titleKey: "groupSubmissionsBase",
    items: [
      {
        labelKey: "groupSubmissionsBase", icon: FileSignature,
        children: [
          { labelKey: "transactionSubmission", href: "/portal/sales", icon: Receipt },
          // A-17 live-path finding: /portal/quotations (the old 16-Jul
          // quotation-to-close workflow — upload/sign the quotation, then
          // close the sale) carries real, live close-out actions for any
          // Legacy-flow sale still in flight, but had NO nav entry anywhere —
          // reachable only by typing the URL. Shown only to an associate who
          // actually has one (fail-closed, same pattern as C-6's
          // quotationRequestVisible): an entry that only exists with
          // something behind it can't be confused with "this workflow is
          // dead" the way a permanently-reachable-but-often-empty page could.
          { labelKey: "myQuotations", href: "/portal/quotations", icon: FileCheck },
          { labelKey: "referralSubmission", href: "/portal/referrals/new", icon: Handshake },
          { labelKey: "quotationRequest", href: "/portal/agreements", icon: BadgeCheck },
        ],
      },
    ],
  },
  {
    titleKey: "groupMarketing",
    items: [
      {
        labelKey: "groupMarketing", icon: Sparkles,
        children: [
          { labelKey: "nameCard", href: "/portal/name-card", icon: IdCard },
          { labelKey: "flyers", icon: Image },
          { labelKey: "edm", icon: Mail },
          // B-9: this now serves the same download library as flyers/edm/
          // greetings — but Customisation itself pre-dates B-9, so its href
          // stays unconditional (unlike those three, which are flag-gated
          // below via MARKETING_LIBRARY_NAV_SLUG). The shipping config
          // (flag off) must keep this link working exactly as it did before.
          { labelKey: "chineseNameMenu", href: "/portal/marketing/customisation", icon: Palette },
          { labelKey: "greetings", icon: PartyPopper },
        ],
      },
    ],
  },
  {
    titleKey: "groupProducts",
    items: [
      { labelKey: "productsCatalogue", href: "/portal/products", icon: Store },
    ],
  },
  // A16 (Sep 2026): associates no longer get a Finance section — My
  // Transactions already shows commissions and what has been paid. The
  // /portal/commissions and /portal/payouts pages still exist (not deleted).
  {
    titleKey: "groupResources",
    items: [
      {
        labelKey: "groupResources", icon: Archive,
        children: [
          { labelKey: "notices", href: "/portal/notices", icon: Megaphone, badgeKey: "notices" },
          { labelKey: "documents", href: "/portal/documents", icon: FolderOpen },
          // FAQ — see the matching comment on adminNav's own entry above.
          { labelKey: "faq", href: "/portal/faq", icon: HelpCircle },
          // C-6 (p.6): moved here from Submissions, directly below Documents.
          { labelKey: "referralPartnerList", href: "/portal/referrals", icon: ListChecks },
          { labelKey: "myPFile", href: "/portal/pfile", icon: FolderLock },
        ],
      },
    ],
  },
];

export const navByArea = { admin: adminNav, portal: portalNav } as const;
export type ShellArea = keyof typeof navByArea;

// B-9: these items have no href above — the underlying pages exist
// (app/{admin,portal}/marketing/[category]) but 404 while
// MARKETING_LIBRARY_ENABLED is off, and nav.ts can't read that flag itself
// (see the comment above chineseNameMenu: importing @/lib/env here broke
// the shell for every signed-in user). The shell reads the flag server-side
// and passes it down as a prop instead; this map is pure data (safe to
// import from client code) letting the sidebar turn a labelKey into the
// matching /[area]/marketing/<slug> route.
//
// Deliberately NOT flyers/edm/greetings/customisation-portal's full set:
// the portal's "chineseNameMenu" (Customisation) pre-dates B-9 and already
// carries its own unconditional href above, so it's absent here on purpose
// — adding it back would make withMarketingLibraryHref a no-op for it
// either way (it only fills a MISSING href), but an entry for an item that
// never needs filling is misleading, not merely redundant. The admin-side
// "customisation" item has no such history (B-9 is its first page) and
// stays flag-gated like flyers/edm/greetings.
export const MARKETING_LIBRARY_NAV_SLUG: Record<string, string> = {
  flyers: "flyers",
  edm: "edms",
  customisation: "customisation",
  greetings: "greetings",
};

// Pure (no React, no env) so the sidebar's decision is directly testable —
// only ever fills in an href that's currently missing, so a NavItem that's
// unwired for a reason OTHER than this flag (nothing in that set today) is
// left alone.
export function withMarketingLibraryHref(item: NavItem, area: ShellArea, marketingLibraryEnabled: boolean): NavItem {
  const slug = MARKETING_LIBRARY_NAV_SLUG[item.labelKey];
  return slug && marketingLibraryEnabled && !item.href ? { ...item, href: `/${area}/marketing/${slug}` } : item;
}

// "My Quotations" has a real, static href regardless — this gates VISIBILITY
// (per-associate, computed server-side from a live DB count, never cached —
// see app/portal/layout.tsx), not the href itself, same shape as C-6's
// quotationRequestVisible but driven by data instead of a flag.
//
// INVARIANT this relies on: the count behind this predicate must stay a
// SUBSET of what app/portal/quotations/page.tsx itself queries (both key off
// closingAssociateId + status: QuotationApproved today; this predicate adds
// `flow: Legacy, transaction: null` on top). That containment is what makes
// "nav shows, page is empty" impossible by construction rather than by
// coincidence — the whole reason this item exists. Narrowing the PAGE's query
// later on some other axis (e.g. by submitting associate instead of closing
// associate) without narrowing this one the same way would break that and
// silently reintroduce the ambiguity this was built to remove. The two
// queries live in separate files and nothing enforces agreement between them
// — keep this comment in sync if either one changes.
export function myQuotationsVisible(item: NavItem, hasInFlightLegacyQuotation: boolean): boolean {
  return item.labelKey !== "myQuotations" || hasInFlightLegacyQuotation;
}

// C-6: "Quotation Request" (portalNav only) has a real, static href — the
// page it points to already flag-checks A17_CLOSED_DEAL_FLOW server-side —
// but nav.ts can't read that flag itself (same constraint as the
// marketing-library items), so VISIBILITY crosses the server/client boundary
// as this one boolean prop instead. Pure and named distinctly from
// `visible` (the role check in sidebar.tsx) because this is a flag gate, not
// a role gate, and only ever touches this one labelKey — everything else is
// unaffected regardless of the flag's value.
export function quotationRequestVisible(item: NavItem, quotationRequestEnabled: boolean): boolean {
  return item.labelKey !== "quotationRequest" || quotationRequestEnabled;
}
