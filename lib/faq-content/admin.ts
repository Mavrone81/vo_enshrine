// FAQ question ids for the Business Admin role, in display order (PM/UIUX
// spec §6). See sales-associate.ts for the file-per-role convention.
export const ADMIN_FAQ_IDS = [
  "whatCanISeeVsAccounts",
  "whereApproveOnboarding",
  // PD, 2026-10-17 re-cut: the invite-time field is now optional (Admin is
  // one of the three invite-capable roles — RECRUITER_ROLES).
  "commencementDateOptionalOnInvite",
  "howHandleApprovals",
  "whereMoneySide",
  "canISubmitSale",
  "whereManageProducts",
  "whatsAdminOnly",
  "whoContactsMe",
] as const;
