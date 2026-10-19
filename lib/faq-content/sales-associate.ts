// FAQ question ids for the Sales Associate role, in display order (owner's
// FAQ request, PM/UIUX spec §2 — deliverables/virtualoffice-plan/
// faq-content-spec.md). The question/answer TEXT lives in
// messages/{en,zh-CN}.json under faq.sections.SalesAssociate.q.<id>.
// {question,answer} — one content file per role so adding/editing a
// question later doesn't touch layout code (lib/faq-content/index.ts,
// the shared view component).
export const SALES_ASSOCIATE_FAQ_IDS = [
  "whatCanIDo",
  "howWasIOnboarded",
  // PD, 2026-10-17 re-cut (same PR as the commencement-date/resubmission
  // ownership change landing): who sets the commencement date now, and
  // what resubmitting before approval actually does.
  "whoDecidesCommencementDate",
  "resubmittingDoIStartOver",
  "whereSubmitSale",
  "splitPartnerNext",
  "whereQuotationsAgreements",
  "whatCommissionCanISee",
  "whereAreMyDocuments",
  "whoDoIContact",
] as const;
