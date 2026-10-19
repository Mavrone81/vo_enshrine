import type { AppRole } from "@prisma/client";
import { isFullAdmin, roleLabel } from "@/lib/rbac";
import { SALES_ASSOCIATE_FAQ_IDS } from "./sales-associate";
import { SALES_ASSISTANT_MANAGER_FAQ_IDS } from "./sales-assistant-manager";
import { SALES_MANAGER_FAQ_IDS } from "./sales-manager";
import { SALES_DIRECTOR_FAQ_IDS } from "./sales-director";
import { ADMIN_FAQ_IDS } from "./admin";
import { ACCOUNTS_FAQ_IDS } from "./accounts";

// Display order, matching the spec's own §0 role table and §2-§7 ordering.
export const FAQ_ROLE_ORDER: AppRole[] = [
  "SalesAssociate",
  "SalesAssistantManager",
  "SalesManager",
  "SalesDirector",
  "Admin",
  "Accounts",
];

export const FAQ_SECTIONS: Record<AppRole, readonly string[]> = {
  SalesAssociate: SALES_ASSOCIATE_FAQ_IDS,
  SalesAssistantManager: SALES_ASSISTANT_MANAGER_FAQ_IDS,
  SalesManager: SALES_MANAGER_FAQ_IDS,
  SalesDirector: SALES_DIRECTOR_FAQ_IDS,
  Admin: ADMIN_FAQ_IDS,
  Accounts: ACCOUNTS_FAQ_IDS,
};

/**
 * Which roles' FAQ sections a session with this role may see (PM/UIUX spec
 * §1): Business Admin sees every role's section — "Admin's own job spans
 * every area already" — everyone else, including Accounts, sees only their
 * own. `isFullAdmin` specifically (not `isAdminRole`, which also covers
 * Accounts) — the spec names Business Admin alone for this, not Accounts.
 */
export function visibleFaqRoles(role: AppRole): AppRole[] {
  return isFullAdmin(role) ? FAQ_ROLE_ORDER : [role];
}

export type FaqItem = { id: string; question: string; answer: string };
export type FaqSection = { role: AppRole; roleLabel: string; items: FaqItem[] };

/**
 * Resolves the viewer's visible section(s) into fully-translated text —
 * this is what a page.tsx passes to the client accordion, so the SERIALIZED
 * payload sent to the browser never contains another role's content at all
 * (not merely hidden from it). `t` must already be scoped to the "faq"
 * namespace (`getTranslations("faq")`), so keys below are relative to it.
 */
export function resolveFaqSections(viewerRole: AppRole, t: (key: string) => string): FaqSection[] {
  return visibleFaqRoles(viewerRole).map((role) => ({
    role,
    roleLabel: roleLabel[role],
    items: FAQ_SECTIONS[role].map((id) => ({
      id,
      question: t(`sections.${role}.q.${id}.question`),
      answer: t(`sections.${role}.q.${id}.answer`),
    })),
  }));
}
