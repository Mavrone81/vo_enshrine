import { describe, it, expect } from "vitest";
import { addDays, format } from "date-fns";
import { saleSchema, comCodeSchema, productSchema, productPricingSchema, newAssociateSchema, onboardingSchema, inviteCandidateSchema } from "./schemas";
import { validate } from "./validate";

// A real yyyy-mm-dd always inside candidateCommencementDate's today..+12-months
// window, computed at test-run time rather than hardcoded — a fixed literal
// would quietly start failing once "today" moves past it.
const VALID_COMMENCEMENT_DATE = format(addDays(new Date(), 7), "yyyy-MM-dd");

describe("saleSchema", () => {
  it("rejects empty clientName and empty lines", () => {
    expect(saleSchema.safeParse({ clientName: "", lines: [] }).success).toBe(false);
  });
  it("accepts a valid sale and caps clientName length", () => {
    const ok = saleSchema.safeParse({
      salesDate: "2026-07-01",
      clientName: "Acme",
      paymentPlan: "Full Payment",
      lines: [{ productId: "p1", comCodeIds: ["c1"], lineSaleAmount: 100 }],
    });
    expect(ok.success).toBe(true);
    expect(
      saleSchema.safeParse({
        salesDate: "2026-07-01",
        clientName: "x".repeat(300),
        paymentPlan: "Full Payment",
        lines: [{ productId: "p1", comCodeIds: [], lineSaleAmount: 1 }],
      }).success,
    ).toBe(false);
  });
  it("requires at least one line and rejects a non-numeric/negative lineSaleAmount", () => {
    expect(
      saleSchema.safeParse({
        salesDate: "2026-07-01",
        clientName: "Acme",
        paymentPlan: "Full Payment",
        lines: [{ productId: "p1", comCodeIds: [], lineSaleAmount: -5 }],
      }).success,
    ).toBe(false);
  });
  it("rejects an unknown paymentPlan", () => {
    expect(
      saleSchema.safeParse({
        salesDate: "2026-07-01",
        clientName: "Acme",
        paymentPlan: "Crypto",
        lines: [{ productId: "p1", comCodeIds: [], lineSaleAmount: 1 }],
      }).success,
    ).toBe(false);
  });

  // A-0b. Cap raised 24 -> 72 (owner's ruling, 2026-10-09 addendum): 72 months
  // (six years) is now the shared maximum on both the sale side and the
  // product side (lib/schemas.ts instalmentPlanShape).
  it("accepts any installment count 1–72 (not just 12/24) and rejects out of range", () => {
    const base = {
      salesDate: "2026-07-01", clientName: "Acme", paymentPlan: "Installment" as const,
      lines: [{ productId: "p1", comCodeIds: [], lineSaleAmount: 1200 }],
    };
    for (const n of [1, 6, 12, 18, 24, 36, 72]) {
      expect(saleSchema.safeParse({ ...base, installmentCount: n }).success).toBe(true);
    }
    expect(saleSchema.safeParse({ ...base, installmentCount: 0 }).success).toBe(false);
    expect(saleSchema.safeParse({ ...base, installmentCount: 73 }).success).toBe(false);
    expect(saleSchema.safeParse({ ...base, installmentCount: undefined }).success).toBe(false); // required for Installment
  });

  it("refuses a deposit at or above the sale amount for an Installment plan (strict <)", () => {
    const base = {
      salesDate: "2026-07-01", clientName: "Acme", paymentPlan: "Installment" as const, installmentCount: 12,
      lines: [{ productId: "p1", comCodeIds: [], lineSaleAmount: 100 }],
    };
    expect(saleSchema.safeParse({ ...base, deposit: 99.99 }).success).toBe(true);
    // Deposit == sale would leave nothing to divide — N schedule rows of $0.00
    // that still gate the eligibility count. Strictly less, not <=.
    expect(saleSchema.safeParse({ ...base, deposit: 100 }).success).toBe(false);
    expect(saleSchema.safeParse({ ...base, deposit: 100.01 }).success).toBe(false);
    expect(saleSchema.safeParse({ ...base, deposit: 500 }).success).toBe(false);
  });

  it("a Full Payment deposit may equal the sale amount (no installment schedule is minted)", () => {
    const base = {
      salesDate: "2026-07-01", clientName: "Acme", paymentPlan: "Full Payment" as const,
      lines: [{ productId: "p1", comCodeIds: [], lineSaleAmount: 100 }],
    };
    expect(saleSchema.safeParse({ ...base, deposit: 100 }).success).toBe(true);
    expect(saleSchema.safeParse({ ...base, deposit: 100.01 }).success).toBe(false);
  });
});

describe("comCodeSchema", () => {
  it("coerces valueType enum + rejects unknown", () => {
    expect(comCodeSchema.safeParse({ comCode: "A", label: "L", valueType: "Percentage", value: "10" }).success).toBe(true);
    expect(comCodeSchema.safeParse({ comCode: "A", label: "L", valueType: "Nope", value: "10" }).success).toBe(false);
  });
  it("accepts up to 4 decimal places (Decimal(14,4) column)", () => {
    expect(comCodeSchema.safeParse({ comCode: "A", label: "L", valueType: "Absolute", value: "12.3456" }).success).toBe(true);
  });
});

const VALID_PRICING = { listedPrice: "199.99" };

describe("productSchema", () => {
  it("accepts a valid Percentage product and rejects a missing required rate", () => {
    const ok = productSchema.safeParse({
      productCode: "P1",
      productName: "Funeral Plan",
      commissionType: "Percentage",
      closingCommPct: "10",
      companyCutPct: "40",
      asmOverridePct: "5",
      smOverridePct: "10",
      sdOverridePct: "5",
      isExternal: false,
      effectiveDate: "2026-01-01",
      ...VALID_PRICING,
    });
    expect(ok.success).toBe(true);
    expect(
      productSchema.safeParse({
        productCode: "P1",
        productName: "Funeral Plan",
        commissionType: "Percentage",
        // companyCutPct missing — required
        asmOverridePct: "5",
        smOverridePct: "10",
        sdOverridePct: "5",
        isExternal: false,
        effectiveDate: "2026-01-01",
        ...VALID_PRICING,
      }).success,
    ).toBe(false);
  });
  it("rejects an unknown commissionType", () => {
    expect(
      productSchema.safeParse({
        productCode: "P1",
        productName: "Funeral Plan",
        commissionType: "Weird",
        companyCutPct: "40",
        asmOverridePct: "5",
        smOverridePct: "10",
        sdOverridePct: "5",
        isExternal: false,
        effectiveDate: "2026-01-01",
        ...VALID_PRICING,
      }).success,
    ).toBe(false);
  });
  it("rejects a product with no pricing at all (listedPrice required)", () => {
    expect(
      productSchema.safeParse({
        productCode: "P1",
        productName: "Funeral Plan",
        commissionType: "Percentage",
        closingCommPct: "10",
        companyCutPct: "40",
        asmOverridePct: "5",
        smOverridePct: "10",
        sdOverridePct: "5",
        isExternal: false,
        effectiveDate: "2026-01-01",
        // no listedPrice
      }).success,
    ).toBe(false);
  });

  it("a valid Fixed-commission product (closingCommFixed, the money helper's other real caller) still passes after the money-max bound", () => {
    const ok = productSchema.safeParse({
      productCode: "P1",
      productName: "Funeral Plan",
      commissionType: "Fixed",
      closingCommFixed: "1500.00",
      companyCutPct: "40",
      asmOverridePct: "5",
      smOverridePct: "10",
      sdOverridePct: "5",
      isExternal: false,
      effectiveDate: "2026-01-01",
      ...VALID_PRICING,
    });
    expect(ok.success).toBe(true);
  });

  it("closingBasis DiscountedPrice with no discountedPrice is rejected on CREATE too, not only on the pricing-only update schema", () => {
    const r = productSchema.safeParse({
      productCode: "P1",
      productName: "Funeral Plan",
      commissionType: "Percentage",
      closingCommPct: "10",
      companyCutPct: "40",
      asmOverridePct: "5",
      smOverridePct: "10",
      sdOverridePct: "5",
      isExternal: false,
      effectiveDate: "2026-01-01",
      ...VALID_PRICING,
      closingBasis: "DiscountedPrice",
    });
    expect(r.success).toBe(false);
  });
});

describe("productPricingSchema", () => {
  const base = { listedPrice: "199.99" };

  it("accepts listedPrice alone, no instalment plans", () => {
    expect(productPricingSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a negative listedPrice", () => {
    expect(productPricingSchema.safeParse({ ...base, listedPrice: "-1.00" }).success).toBe(false);
  });

  it("rejects more than 2 decimal places", () => {
    expect(productPricingSchema.safeParse({ ...base, listedPrice: "199.999" }).success).toBe(false);
  });

  describe("money is bounded to what Decimal(14,2) can actually store", () => {
    it("accepts the boundary itself: 12 integer digits (999999999999.99)", () => {
      expect(productPricingSchema.safeParse({ ...base, listedPrice: "999999999999.99" }).success).toBe(true);
    });
    it("rejects one digit past it: 13 integer digits (1000000000000.00)", () => {
      expect(productPricingSchema.safeParse({ ...base, listedPrice: "1000000000000.00" }).success).toBe(false);
    });
  });

  describe("discountedPrice <= listedPrice, both halves of the bound", () => {
    it("accepts a discount equal to the listed price (the boundary itself)", () => {
      expect(productPricingSchema.safeParse({ ...base, listedPrice: "100.00", discountedPrice: "100.00" }).success).toBe(true);
    });
    it("accepts a discount strictly below the listed price", () => {
      expect(productPricingSchema.safeParse({ ...base, listedPrice: "100.00", discountedPrice: "99.99" }).success).toBe(true);
    });
    it("rejects a discount even 0.01 above the listed price", () => {
      const r = productPricingSchema.safeParse({ ...base, listedPrice: "100.00", discountedPrice: "100.01" });
      expect(r.success).toBe(false);
    });
  });

  describe("instalment plans — a repeatable add-on list (owner's change, 2026-10-09), not a fixed 12/24-month enum", () => {
    it("no plans: bookingFee is NOT required, and defaults to an empty list when omitted", () => {
      const r = productPricingSchema.safeParse({ listedPrice: "199.99" });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.instalmentPlans).toEqual([]);
    });
    it("one plan: bookingFee required, and the plan's own monthlyAmount required", () => {
      expect(productPricingSchema.safeParse({ listedPrice: "199.99", instalmentPlans: [{ months: 12, monthlyAmount: "16.66" }] }).success).toBe(false); // bookingFee missing
      expect(
        productPricingSchema.safeParse({
          listedPrice: "199.99", bookingFee: "20.00", instalmentPlans: [{ months: 12, monthlyAmount: "16.66" }],
        }).success,
      ).toBe(true);
    });
    it("several plans with DIFFERENT month counts: accepted", () => {
      expect(
        productPricingSchema.safeParse({
          listedPrice: "199.99", bookingFee: "20.00",
          instalmentPlans: [{ months: 12, monthlyAmount: "16.66" }, { months: 24, monthlyAmount: "8.33" }, { months: 6, monthlyAmount: "33.33" }],
        }).success,
      ).toBe(true);
    });
    it("two plans at the SAME month count: rejected — nonsense per the owner's own framing, mirrors the DB's unique(productId, months)", () => {
      const r = productPricingSchema.safeParse({
        listedPrice: "199.99", bookingFee: "20.00",
        instalmentPlans: [{ months: 12, monthlyAmount: "16.66" }, { months: 12, monthlyAmount: "99.00" }],
      });
      expect(r.success).toBe(false);
    });
    // The owner has now ruled on what was an unmade question: 72 months (six
    // years) is the shared maximum on BOTH sides — this schema's own cap
    // (instalmentPlanShape) and the sale side's installmentCount (above)
    // move together, deliberately, not by coincidence.
    it("accepts up to and including 72 months, rejects 73", () => {
      expect(
        productPricingSchema.safeParse({
          listedPrice: "199.99", bookingFee: "20.00", instalmentPlans: [{ months: 72 }],
        }).success,
      ).toBe(true);
      expect(
        productPricingSchema.safeParse({
          listedPrice: "199.99", bookingFee: "20.00", instalmentPlans: [{ months: 73 }],
        }).success,
      ).toBe(false);
    });
    it("a non-positive or non-integer months value is rejected", () => {
      expect(productPricingSchema.safeParse({ listedPrice: "199.99", bookingFee: "20.00", instalmentPlans: [{ months: 0, monthlyAmount: "5.00" }] }).success).toBe(false);
      expect(productPricingSchema.safeParse({ listedPrice: "199.99", bookingFee: "20.00", instalmentPlans: [{ months: -1, monthlyAmount: "5.00" }] }).success).toBe(false);
      expect(productPricingSchema.safeParse({ listedPrice: "199.99", bookingFee: "20.00", instalmentPlans: [{ months: 1.5, monthlyAmount: "5.00" }] }).success).toBe(false);
    });
  });

  it("PRICING FIELDS ONLY: an extra non-pricing key (e.g. commissionType) is rejected, not silently ignored", () => {
    const r = productPricingSchema.safeParse({ ...base, commissionType: "Fixed" });
    expect(r.success).toBe(false);
  });

  describe("closingBasis (2026-10-01) — defaults to ListedPrice, and DiscountedPrice requires an actual discount", () => {
    it("omitted entirely: defaults to ListedPrice (every pre-closing-basis caller keeps working)", () => {
      const r = productPricingSchema.safeParse(base);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.closingBasis).toBe("ListedPrice");
    });

    it("explicit ListedPrice, no discount set: accepted", () => {
      expect(productPricingSchema.safeParse({ ...base, closingBasis: "ListedPrice" }).success).toBe(true);
    });

    it("explicit ListedPrice while a discount IS set: accepted — the basis, not the presence of a discount, decides", () => {
      expect(productPricingSchema.safeParse({ ...base, discountedPrice: "99.99", closingBasis: "ListedPrice" }).success).toBe(true);
    });

    it("DiscountedPrice with a discount set: accepted", () => {
      expect(productPricingSchema.safeParse({ ...base, discountedPrice: "99.99", closingBasis: "DiscountedPrice" }).success).toBe(true);
    });

    it("DiscountedPrice with NO discount set: rejected (invalidInput), not silently treated as ListedPrice", () => {
      const r = productPricingSchema.safeParse({ ...base, closingBasis: "DiscountedPrice" });
      expect(r.success).toBe(false);
    });

    it("DiscountedPrice with discountedPrice explicitly undefined (a cleared field, the real UI shape): still rejected", () => {
      const r = productPricingSchema.safeParse({ ...base, discountedPrice: undefined, closingBasis: "DiscountedPrice" });
      expect(r.success).toBe(false);
    });

    it("rejects an unknown closingBasis value", () => {
      expect(productPricingSchema.safeParse({ ...base, closingBasis: "Negotiated" }).success).toBe(false);
    });
  });
});

describe("newAssociateSchema", () => {
  it("accepts a minimal valid associate and rejects a bad email", () => {
    expect(
      newAssociateSchema.safeParse({ fullName: "Jane Tan", designation: "SalesAssociate", email: "jane@example.com" }).success,
    ).toBe(true);
    expect(
      newAssociateSchema.safeParse({ fullName: "Jane Tan", designation: "SalesAssociate", email: "not-an-email" }).success,
    ).toBe(false);
  });

  // The login email is what setApprovalStatus provisions the account from, and it
  // is read ONCE at approval — an associate approved without one can never log in
  // and no screen can repair it. So "no email" is rejected at the door, not later.
  it("REJECTS an associate with no email at all — the login provisioning depends on it", () => {
    expect(newAssociateSchema.safeParse({ fullName: "Jane Tan", designation: "SalesAssociate" }).success).toBe(false);
    expect(newAssociateSchema.safeParse({ fullName: "Jane Tan", designation: "SalesAssociate", email: "" }).success).toBe(false);
  });
  it("rejects an unknown designation", () => {
    expect(newAssociateSchema.safeParse({ fullName: "Jane Tan", designation: "CEO" }).success).toBe(false);
  });
});

describe("onboardingSchema", () => {
  it("rejects junk input and requires nric/paymentMethod/agreementAccepted", () => {
    // commencementDate (owner ruling 2026-10-17) is the first required field
    // to fail on this input, so validate() surfaces its own matched code.
    expect(validate(onboardingSchema, { junk: true })).toEqual({ ok: false, code: "commencementDateRequired" });
  });
  it("accepts a valid minimal submission", () => {
    expect(
      onboardingSchema.safeParse({
        commencementDate: VALID_COMMENCEMENT_DATE,
        fullName: "Jane Tan",
        nric: "S1234567A",
        paymentMethod: "PayNow",
        agreementAccepted: true,
        nationality: "Singaporean",
        gender: "Male",
        religion: "Buddhism",
        spouseConflict: false,
      }).success,
    ).toBe(true);
  });

  // C-2 (owner ruling): spouseConflict is required at final submit — see
  // lib/schemas.ts's own comment on the field for why that's safe (no
  // draft-save path exists for this form to lock anyone out of).
  it("rejects a submission that omits spouseConflict entirely", () => {
    expect(
      onboardingSchema.safeParse({
        commencementDate: VALID_COMMENCEMENT_DATE,
        fullName: "Jane Tan",
        nric: "S1234567A", paymentMethod: "PayNow", agreementAccepted: true,
        nationality: "Singaporean", gender: "Male", religion: "Buddhism",
      }).success,
    ).toBe(false);
  });

  const base = {
    commencementDate: VALID_COMMENCEMENT_DATE,
        fullName: "Jane Tan",
    nric: "S1234567A", paymentMethod: "PayNow" as const, agreementAccepted: true,
    nationality: "Singaporean", gender: "Male" as const, religion: "Buddhism",
    spouseConflict: false as const,
  };

  // Owner ruling 2026-10-17: the candidate's OWN, mandatory commencement date
  // — supersedes the inviter's now-optional one on inviteCandidateSchema.
  describe("commencementDate (candidate's own, onboarding-submit path)", () => {
    it("rejects a submission that omits it, or sends it blank", () => {
      const { commencementDate: _omit, ...without } = base;
      expect(onboardingSchema.safeParse(without).success).toBe(false);
      expect(onboardingSchema.safeParse({ ...base, commencementDate: "" }).success).toBe(false);
    });
    it("rejects a malformed or impossible date", () => {
      expect(onboardingSchema.safeParse({ ...base, commencementDate: "not-a-date" }).success).toBe(false);
      expect(onboardingSchema.safeParse({ ...base, commencementDate: "2026-02-31" }).success).toBe(false);
    });
    it("rejects a date before today", () => {
      const yesterday = format(addDays(new Date(), -1), "yyyy-MM-dd");
      expect(onboardingSchema.safeParse({ ...base, commencementDate: yesterday }).success).toBe(false);
    });
    it("rejects a date more than 12 months ahead", () => {
      const tooFar = format(addDays(new Date(), 366 + 30), "yyyy-MM-dd"); // comfortably past 12 months
      expect(onboardingSchema.safeParse({ ...base, commencementDate: tooFar }).success).toBe(false);
    });
    it("accepts today itself", () => {
      const today = format(new Date(), "yyyy-MM-dd");
      expect(onboardingSchema.safeParse({ ...base, commencementDate: today }).success).toBe(true);
    });
    // inviteCandidateSchema's own field carries no range check — the inviter's
    // date is a non-binding suggestion only, and must never inherit this rule.
    it("does not leak the range check onto inviteCandidateSchema", () => {
      const farPast = "2000-01-01";
      expect(inviteCandidateSchema.safeParse({ email: "a@b.com", commencementDate: farPast }).success).toBe(true);
    });
  });

  // Printed on the Associate Agreement's particulars table (28 Sep) — each is
  // required, and a blank one is as bad as a missing one.
  it.each(["nationality", "gender", "religion"] as const)("requires %s", (key) => {
    const { [key]: _omit, ...without } = base;
    expect(onboardingSchema.safeParse(without).success).toBe(false);
    expect(onboardingSchema.safeParse({ ...base, [key]: "  " }).success).toBe(false);
  });
  it("rejects a gender outside the listed values", () => {
    expect(onboardingSchema.safeParse({ ...base, gender: "Unknown" }).success).toBe(false);
  });

  it("accepts an optional marital status", () => {
    expect(onboardingSchema.safeParse({ ...base, maritalStatus: "Married" }).success).toBe(true);
  });

  it("rejects an unknown marital status", () => {
    expect(onboardingSchema.safeParse({ ...base, maritalStatus: "Complicated" }).success).toBe(false);
  });

  it("accepts a No spouse-conflict declaration without spouse details", () => {
    expect(onboardingSchema.safeParse({ ...base, spouseConflict: false }).success).toBe(true);
  });

  it("requires spouse name + company + designation when the conflict is declared Yes", () => {
    expect(onboardingSchema.safeParse({ ...base, spouseConflict: true }).success).toBe(false);
    // C-2: name + company alone is no longer enough — designation joined them.
    expect(
      onboardingSchema.safeParse({ ...base, spouseConflict: true, spouseName: "Jane Tan", spouseCompany: "Rival Funeral Pte Ltd" }).success,
    ).toBe(false);
    expect(
      onboardingSchema.safeParse({
        ...base, spouseConflict: true, spouseName: "Jane Tan", spouseCompany: "Rival Funeral Pte Ltd", spouseDesignation: "Director",
      }).success,
    ).toBe(true);
  });
});

describe("validate()", () => {
  it("returns {ok:false} without throwing on bad input", () => {
    expect(validate(onboardingSchema, { junk: true })).toEqual({ ok: false, code: "commencementDateRequired" });
  });
  it("returns {ok:true, data} on good input", () => {
    const r = validate(comCodeSchema, { comCode: "A", label: "L", valueType: "Percentage", value: "10" });
    expect(r).toEqual({ ok: true, data: { comCode: "A", label: "L", valueType: "Percentage", value: "10" } });
  });
});
