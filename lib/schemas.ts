import { z } from "zod";
import { NAME_CARD_CHINESE_NAME_MAX, NAME_CARD_CUSTOM_TITLE_MAX } from "./name-card-limits";
import { PRODUCT_DESCRIPTION_MAX } from "./product-limits";
import { D, closingPrice } from "./money";
import { DESIGNATION_VALUES } from "./roles";
import { isWithinCommencementDateRange } from "./commencement-date";

export { NAME_CARD_CHINESE_NAME_MAX, NAME_CARD_CUSTOM_TITLE_MAX };

// Centralized input-validation schemas for the write-side server actions
// (Phase 1d §4.2). Each schema mirrors — field-for-field — the existing input
// type of the action it will guard (Task 2/3 wire these in); see the type
// cited above each schema for the source of truth.
//
// Shared primitives ----------------------------------------------------------
// Decimal(14,2)'s own max representable value (12 integer digits + 2dp) —
// Added with product pricing, 2026-09-30: `.max(20)` below bounds
// the STRING length, not the numeric magnitude, so a syntactically valid
// 20-char amount could still overflow the column and throw a raw Postgres
// error (a 500) instead of a clean invalidInput. Bounding it here covers
// every existing `money` field too (e.g. closingCommFixed), not just pricing.
const MONEY_MAX = "999999999999.99";
// Decimal(14,2) SGD currency amounts, stored as strings (prisma/schema.prisma).
const money = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "money").max(20)
  .refine((v) => D(v).lessThanOrEqualTo(MONEY_MAX), "moneyTooLarge");
// Decimal(7,4) / Decimal(14,4) percentage or rate values, stored as strings.
const rate = z.string().trim().regex(/^\d+(\.\d{1,4})?$/, "rate").max(20);
// Opaque DB id (uuid primary/foreign key).
const id = z.string().trim().min(1).max(64);
// Free-text display name.
const name = z.string().trim().min(1).max(200);
// Date-ish string — a yyyy-mm-dd value from an <input type="date">, or an
// ISO datetime; downstream code does `new Date(str)`, so only the envelope
// (non-empty, sane length) is bounded here, not the exact format.
const dateStr = z.string().trim().min(1).max(32);
// Human-issued code (e.g. associate code "EN0001").
const code = z.string().trim().min(1).max(20);
// A Net-to-Closer split share (% of net or an absolute amount) for Associate 2/3.
// A percentage share can't exceed 100% of net (SEC-6); an absolute share is
// bounded against the real Net-to-Closer server-side (server/commission/split-bounds.ts).
const splitShare = z
  .object({
    associateId: id,
    valueType: z.enum(["Percentage", "Absolute"]),
    value: z.number().finite().nonnegative().max(100_000_000),
  })
  .refine((s) => s.valueType !== "Percentage" || s.value <= 100, { message: "splitPercentTooHigh", path: ["value"] });

// ---------------------------------------------------------------------------
// Sales — mirrors SubmitSaleInput (server/sales/actions.ts)
// ---------------------------------------------------------------------------
export const saleSchema = z
  .object({
    salesDate: dateStr,
    // Date of quotation (23-Jul parallel workflow) — filled up front at submission.
    quoteDate: dateStr.optional(),
    clientName: name,
    clientContact: z.string().trim().max(200).optional(),
    paymentPlan: z.enum(["Full Payment", "Installment"]),
    deposit: z.number().finite().nonnegative().max(100_000_000).optional(),
    // A-0b: the count is 1–72 on the server (owner's ruling, 2026-10-09
    // addendum — six years, raised from 24, moving together with the
    // product side's own cap below); refined below (deposit ≤ sale too).
    installmentCount: z.number().finite().int().positive().max(72).optional(),
    lines: z
      .array(
        z.object({
          productId: id,
          lineSaleAmount: z.number().finite().positive().max(100_000_000),
          comCodeIds: z.array(id).max(50),
        }),
      )
      .min(1)
      .max(100),
    // Flow-3 Net-to-Closer split (optional).
    associate2: splitShare.optional(),
    associate3: splitShare.optional(),
    // A-17 §2: converting a quotation into this sale (informational FK; CAS'd
    // Issued -> Converted server-side in submitSale).
    quotationId: id.optional(),
  })
  // SEC-6: the percentage shares together can't exceed 100% of net, and the two
  // partners must be different people.
  .refine(
    (d) =>
      (d.associate2?.valueType === "Percentage" ? d.associate2.value : 0) +
        (d.associate3?.valueType === "Percentage" ? d.associate3.value : 0) <= 100,
    { message: "splitPercentTooHigh", path: ["associate3"] },
  )
  .refine((d) => !d.associate2 || !d.associate3 || d.associate2.associateId !== d.associate3.associateId, {
    message: "splitPartyInvalid", path: ["associate3"],
  })
  .refine(
    (d) => d.paymentPlan !== "Installment" || (d.installmentCount !== undefined && d.installmentCount >= 1),
    { message: "Installment count must be between 1 and 72", path: ["installmentCount"] },
  )
  .refine(
    (d) => {
      if (d.deposit === undefined) return true;
      const saleAmount = d.lines.reduce((s, l) => s + l.lineSaleAmount, 0);
      // Strict for Installment: deposit === sale would leave nothing to divide,
      // minting N schedule rows of $0.00 that still gate the eligibility count.
      return d.paymentPlan === "Installment" ? d.deposit < saleAmount : d.deposit <= saleAmount;
    },
    { message: "Deposit must be less than the sale amount for an installment plan", path: ["deposit"] },
  );
export type SaleInput = z.infer<typeof saleSchema>;

// ---------------------------------------------------------------------------
// A-17 — Quotation (mirrors CreateQuotationInput, server/quotations/actions.ts).
// No money/approval fields: a quotation is priced but never touches the engine.
// ---------------------------------------------------------------------------
export const quotationSchema = z.object({
  clientName: name,
  clientContact: z.string().trim().max(200).optional(),
  quoteDate: dateStr,
  validUntil: dateStr.optional(),
  lines: z
    .array(
      z.object({
        productId: id,
        lineSaleAmount: z.number().finite().positive().max(100_000_000),
        comCodeIds: z.array(id).max(50),
      }),
    )
    .min(1)
    .max(100),
});
export type QuotationInput = z.infer<typeof quotationSchema>;

// ---------------------------------------------------------------------------
// Com codes — mirrors the addComCode() second argument (server/products/actions.ts)
// ---------------------------------------------------------------------------
export const comCodeSchema = z.object({
  comCode: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(120),
  valueType: z.enum(["Percentage", "Absolute"]),
  value: rate,
});
export type ComCodeInput = z.infer<typeof comCodeSchema>;

// ---------------------------------------------------------------------------
// Product pricing (2026-09-30) — separate from commission/companyCut, which
// stay on their own versioned path (CommissionStructureVersion). `listedPrice`
// is required here (the admin form always requires it going forward) even
// though the DB column is nullable (existing rows predate this feature).
//
// ONE shared shape + ONE shared business-rule function, used two ways:
//   - `productPricingShape`/`pricingRefine` are folded into `productSchema`
//     below, so product CREATION enforces the same rules.
//   - `productPricingSchema` below wraps the SAME shape/refine with `.strict()`
//     for the standalone pricing-only update endpoint (server/products/
//     actions.ts's updateProductPricing) — PRICING FIELDS ONLY, structurally:
//     any other key (commission, codes, effectiveDate, ...) fails validation
//     rather than being silently ignored.
// ---------------------------------------------------------------------------
// Closing basis (2026-10-01): which price commission/company cut/overrides
// are calculated against. Independent of the instalment plan list below —
// see prisma/schema.prisma's ClosingBasis comment. Defaults to "ListedPrice" so
// every existing caller (admin form not yet updated, every pre-closing-basis
// test fixture) keeps working unchanged, matching the DB column's default.
const closingBasisEnum = z.enum(["ListedPrice", "DiscountedPrice"]);

// Owner's change (2026-10-09): instalments are a repeatable add-on list, one
// row per admin-typed month count — replaces the fixed Months12/Months12or24
// enum. The cap below used to be a pure overflow/abuse sanity bound (1200,
// 100 years) with no business rule behind it, because the owner hadn't
// ruled on a maximum term; the 2026-10-09 addendum settled it at 72 months
// (six years) — now a policy decision, not arithmetic, and the SAME number
// as the SALE side's installmentCount a few lines up (also max(72)): the two
// caps move together deliberately. Mirrored in the DB as an actual CHECK
// constraint (prisma/migrations/.../months_within_policy), on the same
// reasoning as `months > 0` below it: a raw write, a seed, or a later
// backfill can all reach that table without passing through zod.
const instalmentPlanShape = z.object({
  months: z.number().int().positive().max(72),
});

const productPricingShape = {
  listedPrice: money,
  discountedPrice: money.optional(),
  bookingFee: money.optional(),
  // Capped at 12 rows as the same kind of sanity bound as `months` above —
  // not a business rule.
  instalmentPlans: z.array(instalmentPlanShape).max(12).default([]),
  closingBasis: closingBasisEnum.default("ListedPrice"),
};

type ProductPricingShape = {
  listedPrice: string;
  discountedPrice?: string;
  bookingFee?: string;
  instalmentPlans: { months: number }[];
  closingBasis: z.infer<typeof closingBasisEnum>;
};

function pricingRefine(v: ProductPricingShape, ctx: z.RefinementCtx): void {
  // Decimal-safe compare — never Number(), which can lose precision on a
  // 14-digit money string in a way a plain float comparison would not show.
  if (v.discountedPrice !== undefined && D(v.discountedPrice).greaterThan(D(v.listedPrice))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["discountedPrice"], message: "discountedPriceExceedsListed" });
  }
  // Owner's ruling (closing-basis-spec-2026-10-01.md): DiscountedPrice is a
  // valid basis ONLY when a discount is actually set. Clearing the discount
  // while the basis is still DiscountedPrice is rejected here rather than
  // silently falling back — the UI is expected to switch the basis back to
  // ListedPrice itself, so a normal edit never reaches this branch.
  if (v.closingBasis === "DiscountedPrice" && v.discountedPrice === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["closingBasis"], message: "closingBasisRequiresDiscount" });
  }
  if (v.instalmentPlans.length > 0 && v.bookingFee === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bookingFee"], message: "bookingFeeRequired" });
  }
  // A booking fee that exceeds the closing price makes the derived schedule
  // negative (lib/money.ts deriveInstalmentSchedule refuses to compute it
  // at all) — caught here too so the admin gets a field-level message at
  // save time instead of a silently-blank schedule discovered later. Blank
  // bookingFee reads as 0 here, matching the display's own "blank = zero"
  // convention (the owner's ruling) — it can never be the cause of this
  // particular issue, only a real typed fee can.
  if (v.bookingFee !== undefined && v.instalmentPlans.length > 0) {
    const basis = closingPrice(v.listedPrice, v.discountedPrice ?? null, v.closingBasis);
    if (D(v.bookingFee).greaterThan(basis)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bookingFee"], message: "bookingFeeExceedsClosingPrice" });
    }
  }
  // Two plans at the same month count is nonsense (the owner's own framing)
  // — mirrored here from the DB's own @@unique([productId, months]) so a bad
  // submission is refused with a field-level message, not a raw constraint
  // violation.
  const months = v.instalmentPlans.map((p) => p.months);
  if (new Set(months).size !== months.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instalmentPlans"], message: "instalmentPlanMonthsDuplicate" });
  }
}

export const productPricingSchema = z.object(productPricingShape).strict().superRefine(pricingRefine);
// Output type (post-parse): closingBasis is always present, defaulted where
// the caller omitted it — this is what updateProductPricing/createProduct
// work with internally, after validateInput() has run.
export type ProductPricingInput = z.infer<typeof productPricingSchema>;
// Input type (pre-parse): closingBasis is optional, matching the DB/zod
// default — this is what a CALLER (a server-action parameter, a test) may
// supply, so a form that hasn't been updated to send closingBasis yet still
// type-checks and gets "ListedPrice" at validation time.
export type ProductPricingRawInput = z.input<typeof productPricingSchema>;

// ---------------------------------------------------------------------------
// Product commission structure — the 12 fields that decide what people are
// paid (+ when it takes effect). ONE shape, spread into BOTH `productSchema`
// (create) and `productDetailsShape` (edit) below, so create and edit can't
// drift apart; the cross-field rules stay in `pricingRefine` + the action's
// own `validate()`, which both paths run.
// ---------------------------------------------------------------------------
const comValueTypeEnum = z.enum(["Percentage", "Absolute"]);
const productCommissionShape = {
  commissionType: z.enum(["Percentage", "Fixed"]),
  closingCommPct: rate.optional(),
  closingCommFixed: money.optional(),
  companyCutPct: rate,
  companyCutType: comValueTypeEnum.optional(),
  smOverridePct: rate,
  smOverrideType: comValueTypeEnum.optional(),
  sdOverridePct: rate,
  sdOverrideType: comValueTypeEnum.optional(),
  // Optional so a caller written before 2026-10-07 still validates; it then
  // snapshots as "0", i.e. no managing-director cut, which is the pre-change
  // behaviour. The 30%-of-company-cut default is the FORM's, not the schema's.
  mdCutPct: rate.optional(),
  mdCutType: comValueTypeEnum.optional(),
  isExternal: z.boolean(),
  externalCompanyRetainedPct: rate.optional(),
  externalCompanyRetainedType: comValueTypeEnum.optional(),
  effectiveDate: dateStr,
};

// ---------------------------------------------------------------------------
// Product details edit — the combined "edit product" screen: name/category/
// default company + commission structure + pricing, in ONE action/transaction
// (server/products/actions.ts's updateProduct). Everything `createProduct`
// accepts EXCEPT productCode. `.strict()` fences productCode off:
//   - productCode is IMMUTABLE. SaleLineItem carries no productId at all,
//     only a copied productCode, and CommissionStructureVersion resolves by
//     productCode — they are the links from historical sales and rate
//     history back to a product, so renaming it would orphan them. A caller
//     that sends it fails validation rather than it being silently applied
//     or silently dropped.
// Commission fields are NOT updated in place: changing any of them writes a
// new effective-dated CommissionStructureVersion (see updateProduct), because
// the commission engine reads rates from the version a sale line was
// resolved to, never from the product row.
//   - requiredDocuments/requiresAshesAgreement stay out: LIVE by design
//     (resolved fresh against the current product at every gate check, never
//     snapshotted) — their own add/remove/toggle actions.
// ---------------------------------------------------------------------------
export const productDetailsShape = {
  productName: name,
  productCategory: z.string().trim().max(100).optional(),
  // Owner-requested product description — same optional/trim/max shape as
  // productCategory just above. Bounded here (server-side, since this is
  // what the server actions validate against) and nowhere else: no database
  // length constraint (Product.description is a plain String? column,
  // destructive to widen later if one existed), and the admin list / portal
  // card clamp it visually on top of this, since 500 characters passing
  // validation is still too long for a dense grid row.
  description: z.string().trim().max(PRODUCT_DESCRIPTION_MAX).optional(),
  defaultCompanyId: id.optional(),
  ...productCommissionShape,
  ...productPricingShape,
};
export const productDetailsSchema = z.object(productDetailsShape).strict().superRefine(pricingRefine);
// Output type (post-parse) — what updateProduct works with internally.
export type ProductDetailsInput = z.infer<typeof productDetailsSchema>;
// Input type (pre-parse) — what a caller (the server action's own parameter,
// a test) supplies; matches productPricingSchema's own input/output split
// above for the same reason (a future defaulted field, e.g. closingBasis
// once lane A lands, stays optional here without another edit).
export type ProductDetailsRawInput = z.input<typeof productDetailsSchema>;

// ---------------------------------------------------------------------------
// Products — mirrors ProductInput (server/products/actions.ts)
// ---------------------------------------------------------------------------
export const productSchema = z.object({
  productCode: z.string().trim().min(1).max(40),
  productName: name,
  productCategory: z.string().trim().max(100).optional(),
  description: z.string().trim().max(PRODUCT_DESCRIPTION_MAX).optional(),
  defaultCompanyId: id.optional(),
  ...productCommissionShape,
  ...productPricingShape,
}).superRefine(pricingRefine);
export type ProductSchemaInput = z.infer<typeof productSchema>;

// ---------------------------------------------------------------------------
// A-17 screen 6 — per-product required documents (add only; the key is
// server-generated, never part of the input — see lib/product-requirement-key.ts).
// ---------------------------------------------------------------------------
export const addProductRequiredDocumentSchema = z.object({
  labelEn: z.string().trim().min(1).max(200),
  labelZh: z.string().trim().min(1).max(200),
});
export type AddProductRequiredDocumentInput = z.infer<typeof addProductRequiredDocumentSchema>;

// Bounded so the list (and the checklist UI it drives) can't grow unbounded.
export const MAX_REQUIRED_DOCUMENTS_PER_PRODUCT = 20;

// ---------------------------------------------------------------------------
// Associates — mirrors NewAssociateInput (server/associates/actions.ts)
// ---------------------------------------------------------------------------
export const newAssociateSchema = z.object({
  fullName: name,
  businessName: z.string().trim().max(200).optional(),
  mobileNumber: z.string().trim().max(30).optional(),
  // MANDATORY. setApprovalStatus provisions the login only when the associate
  // already has an email at the moment of approval, and nothing re-runs that
  // afterwards — so an associate created without one is approved, active and
  // permanently unable to log in, with no way to fix it from any screen.
  // inviteCandidate has always required an email; this closes the other door.
  email: z.string().trim().email().max(200),
  // Encrypted at rest (lib/crypto.ts encryptPII) — validate shape/length only.
  nric: z.string().trim().min(1).max(40).optional(),
  dateOfBirth: dateStr.optional(),
  // From the ONE list in lib/roles.ts. Hand-written here before, which meant
  // a designation could exist in the database and still be rejected on the
  // way in — see DESIGNATION_OPTIONS for what that cost.
  designation: z.enum(DESIGNATION_VALUES),
  directUplineCode: code.optional(),
  secondUplineCode: code.optional(),
  teamName: z.string().trim().max(200).optional(),
  recruitingManager: z.string().trim().max(200).optional(),
  paymentMethod: z.enum(["PayNow", "Bank Transfer"]).optional(),
  paynowNumber: z.string().trim().max(40).optional(),
  bankName: z.string().trim().max(200).optional(),
  // Encrypted at rest — validate shape/length only.
  bankAccountNumber: z.string().trim().min(1).max(40).optional(),
});
export type NewAssociateSchemaInput = z.infer<typeof newAssociateSchema>;

// Recruit-invite email bound. inviteCandidate (server/recruitment/actions.ts) is
// the ONLY writer of Candidate.email, which propagates to Associate.email and
// User.email at onboarding approval and is emailed via lib/mail.ts sendMail ->
// nodemailer's address parser (super-linear on some shapes at length). Bounding
// it here is what keeps a hostile or over-long address off that parser. 254 is
// the RFC 5321 maximum (newAssociateSchema.email above uses a tighter house
// bound of 200; both are safe — this path takes the RFC max deliberately).
//
// Owner ruling 2026-10-17: the CANDIDATE now sets their own, mandatory
// Commencement Date at final onboarding submission (onboardingSchema's
// candidateCommencementDate below, which adds a range check on top of this).
// The inviter's own field here is a non-binding suggestion only, so it is
// OPTIONAL — but when given, it still gets the same format/calendar check: a
// stray typo shouldn't silently slot in as a real date. The messages are
// i18n error keys, surfaced via validate()'s `code`.
const commencementDate = z.string({ error: "commencementDateRequired" }).trim()
  .min(1, "commencementDateRequired")
  .refine((v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) return false;
    const d = new Date(`${v}T00:00:00.000Z`);
    // Round-trip rejects impossible dates (2026-02-31) that Date would roll over.
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "commencementDateInvalid");
// The candidate's OWN date (onboardingSchema only): same required/format
// check, PLUS the range an onboarding submission must fall in — today
// (the app's own day) through 12 months ahead. A separate derived schema
// so this range rule can never leak onto the inviter's now-optional field
// above, which carries no range requirement.
const candidateCommencementDate = commencementDate.refine(isWithinCommencementDateRange, "commencementDateOutOfRange");
export const inviteCandidateSchema = z.object({
  email: z.string().trim().email().max(254),
  commencementDate: commencementDate.optional(),
});
export type InviteCandidateSchemaInput = z.infer<typeof inviteCandidateSchema>;

// Editing an existing associate (admin). Same core fields as creation minus the
// uplines (managed by the dedicated UplineEditor with cycle guards), plus an
// editable joinDate. nric / bankAccountNumber are keep-if-blank on edit — the
// form never prefills the encrypted values, so an empty field means "unchanged".
export const updateAssociateSchema = newAssociateSchema
  .omit({ directUplineCode: true, secondUplineCode: true })
  // email is MANDATORY on create and OPTIONAL here on purpose. The create path is
  // where the login gets provisioned from, so an associate must not be born
  // without one. An EDIT is a different question: every associate on file already
  // has an address, the form's other identity fields are keep-if-blank here, and
  // making a rename or a bank-detail change fail because an unrelated field was
  // not re-sent would be a new failure mode in exchange for nothing.
  .extend({ email: z.string().trim().email().max(200).optional(), joinDate: dateStr.optional() });
export type UpdateAssociateSchemaInput = z.infer<typeof updateAssociateSchema>;

// ---------------------------------------------------------------------------
// Name card (B-8) — chineseName/customTitle print on a fixed-layout card
// (components/name-card/studio.tsx), so length is capped well short of
// anything that could overflow it or break its PNG export (architect review
// Low note 1; DevLead review). chineseName renders in one centered line at a
// fixed font size — much less room than the title line, hence the tighter cap.
// The limits themselves live in ./name-card-limits (see the re-export above)
// so the client editor and the server action share one source of truth for
// matching maxLength/counters and a specific tooLong error (UIUX review)
// instead of a generic one.
// ---------------------------------------------------------------------------
export const nameCardSchema = z.object({
  chineseName: z.string().trim().max(NAME_CARD_CHINESE_NAME_MAX).optional(),
  customTitle: z.string().trim().max(NAME_CARD_CUSTOM_TITLE_MAX).optional(),
});

// ---------------------------------------------------------------------------
// Onboarding — mirrors OnboardingSubmission (server/recruitment/actions.ts).
// photo/signature BYTES are sniffed by the magic-byte upload task (Phase 1d
// Task 7), not content-validated here — only their shape/size envelope is.
// ---------------------------------------------------------------------------
export const onboardingSchema = z.object({
  // Owner ruling 2026-10-17: the candidate's own, mandatory commencement
  // date — required/format-checked AND range-checked (today..+12 months);
  // see candidateCommencementDate above. Supersedes the inviter's own,
  // now-optional and non-binding field on inviteCandidateSchema.
  commencementDate: candidateCommencementDate,
  // Owner request 2026-10-19: the candidate fills their own full legal name as
  // per NRIC/passport at onboarding (before only the inviter-set name stood).
  // Required; this is the value stamped onto the Associate Agreement's "Name of
  // Applicant as in NRIC/Passport" box (server/recruitment/actions.ts →
  // renderAgreementPdf), so a blank here would leave that box empty.
  fullName: z.string().trim().min(1, "fullNameRequired").max(200),
  businessName: z.string().trim().max(200).optional(),
  // Encrypted at rest — validate shape/length only. Both local NRIC/FIN and
  // foreign-passport-style identifiers flow through here, so no fixed regex.
  nric: z.string().trim().min(1).max(40),
  dateOfBirth: dateStr.optional(),
  residentialAddress: z.string().trim().max(500).optional(),
  emergencyContactName: z.string().trim().max(200).optional(),
  emergencyContactNumber: z.string().trim().max(30).optional(),
  // Owner ruling 2026-10-01: optional, en + zh, flows to the agreement boxes
  // when given and stays blank when not (see
  // server/recruitment/agreement-box-coverage.integration.test.ts).
  emergencyContactRelationship: z.string().trim().max(100).optional(),
  emergencyContactAddress: z.string().trim().max(500).optional(),
  paymentMethod: z.enum(["PayNow", "Bank Transfer"]),
  paynowNumber: z.string().trim().max(40).optional(),
  bankName: z.string().trim().max(200).optional(),
  // Encrypted at rest — validate shape/length only.
  bankAccountNumber: z.string().trim().min(1).max(40).optional(),
  agreementAccepted: z.boolean(),
  // V-2026-07 identity addition.
  maritalStatus: z.enum(["Single", "Married", "Divorced", "Widowed"]).optional(),
  // Printed on the Associate Agreement's particulars table, so required (28 Sep).
  nationality: z.string().trim().min(1).max(100),
  gender: z.enum(["Male", "Female"]),
  religion: z.string().trim().min(1).max(100),
  // Spouse / Conflict of Interest Declaration (V-2026-07): is the spouse working
  // for or supplying a funeral / afterlife company? If declared Yes, capture who.
  // C-2 (owner ruling): required at final submit — there is no draft-save path in
  // this flow (one schema call site, submitOnboarding; the form starts blank on
  // every load and nothing persists before a valid submit), so "required" here
  // can't retroactively lock anyone out of a stored draft. Don't add
  // draft-exemption logic for a draft path that doesn't exist.
  spouseConflict: z.boolean(),
  spouseName: z.string().trim().max(200).optional(),
  spouseCompany: z.string().trim().max(200).optional(),
  spouseDesignation: z.string().trim().max(200).optional(),
  // Presence/type only; actual bytes are sniffed downstream (Task 7).
  photo: z.instanceof(File).nullable().optional(),
  // Base64 PNG data-URL from the signature pad — capped to bound payload
  // size; magic bytes verified downstream (Task 7), not here.
  signature: z.string().max(8_000_000).optional(),
}).superRefine((v, ctx) => {
  // C-2 (owner ruling): a declared conflict must name the spouse, their company,
  // AND their designation — all three, not just the first two.
  if (v.spouseConflict === true) {
    if (!v.spouseName?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["spouseName"], message: "required" });
    if (!v.spouseCompany?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["spouseCompany"], message: "required" });
    if (!v.spouseDesignation?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["spouseDesignation"], message: "required" });
  }
});
export type OnboardingSchemaInput = z.infer<typeof onboardingSchema>;
