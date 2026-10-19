// FAQ question ids for the Sales Manager role, in display order (PM/UIUX
// spec §4). See sales-associate.ts for the file-per-role convention.
export const SALES_MANAGER_FAQ_IDS = [
  "whatCanIDoMore",
  "doIApproveSplits",
  "howInviteCandidate",
  // PD, 2026-10-17 re-cut: the invite-time field is now optional.
  "commencementDateOptionalOnInvite",
  "whatsOnTeamDashboard",
  "whereSubmitTrack",
  "whatCommissionCanISee",
  "canISetQuota",
  "whoDoIContact",
] as const;
