// FAQ question ids for the Sales Director role, in display order (PM/UIUX
// spec §5). See sales-associate.ts for the file-per-role convention.
export const SALES_DIRECTOR_FAQ_IDS = [
  "whatsUnique",
  "whereApproveSplit",
  "canIApproveAnyAssociate",
  "doISeeOtherDirectors",
  "howInviteCandidate",
  // PD, 2026-10-17 re-cut: the invite-time field is now optional.
  "commencementDateOptionalOnInvite",
  "whatCommissionFigures",
  "canISetQuota",
  "whoDoIContact",
] as const;
