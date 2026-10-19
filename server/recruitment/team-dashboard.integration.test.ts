// Team Dashboard (C-8, 02 Oct 2026): proves Contact (mobile number, email)
// and Date of Birth are SELECTED OUT of the Team Dashboard's associate read,
// not merely unused by what the table renders. The owner's Q6 answer: these
// were deliberately removed from an upline's view of their downline on 22 Sep
// (PDPA) and that stands — the PDF's p.9 mockup columns are the pre-22-Sep
// shape and are not coming back. A UI-only check (asserting the rendered
// <th>/<td> list) would pass even if the component received the field and
// simply chose not to print it; this tests the raw prisma rows
// (fetchTeamDashboardAssociates), the server response the UI is built from.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Designation } from "@prisma/client";
import { prisma } from "@/lib/db";
import { fetchTeamDashboardAssociates, TEAM_DASHBOARD_ASSOCIATE_SELECT } from "./team-dashboard";

const TAG = "TEAMDASH-";

// The class of PDPA-withdrawn fields — every one of these must be both
// ABSENT from a real row and OUTSIDE the select's own declared key set. Each
// gets a distinctive non-default value below so a leak is unmistakable.
const WITHDRAWN_FIELDS = ["mobileNumber", "email", "dateOfBirth"] as const;

const ALLOWED_TOP_LEVEL_KEYS = ["id", "associateCode", "fullName", "businessName", "designation", "directUplineId", "associateStatus", "directUpline"].sort();

let uplineId = "";
let childId = "";

beforeAll(async () => {
  const upline = await prisma.associate.create({
    data: {
      associateCode: TAG + "UP",
      fullName: "Fake upline",
      designation: Designation.SalesManager,
      mobileNumber: "+65 9000 0001", // distinctive — must not surface anywhere below
      email: "upline@teamdash.test",
      dateOfBirth: new Date("1980-01-01"),
    },
  });
  uplineId = upline.id;

  const child = await prisma.associate.create({
    data: {
      associateCode: TAG + "CHILD",
      fullName: "Fake child",
      designation: Designation.SalesAssociate,
      directUplineId: uplineId,
      mobileNumber: "+65 9000 0002",
      email: "child@teamdash.test",
      dateOfBirth: new Date("1995-06-15"),
    },
  });
  childId = child.id;
});
afterAll(async () => {
  await prisma.associate.deleteMany({ where: { associateCode: { startsWith: TAG } } });
});

describe("Team Dashboard — Contact and Date of Birth are selected out, not just left off the table", () => {
  it("the select's own key set equals the explicit allow-list — exactly, not a subset", () => {
    expect(Object.keys(TEAM_DASHBOARD_ASSOCIATE_SELECT).sort()).toEqual(ALLOWED_TOP_LEVEL_KEYS);
  });

  it("a REAL RETURNED ROW's key set equals the same allow-list", async () => {
    const rows = await fetchTeamDashboardAssociates([uplineId, childId]);
    const row = rows.find((r) => r.associateCode === TAG + "CHILD");
    expect(row).toBeDefined();
    expect(Object.keys(row as object).sort()).toEqual(ALLOWED_TOP_LEVEL_KEYS);
  });

  it("RECURSIVE — the nested directUpline carries only associateCode, not the rest of Associate", async () => {
    const rows = await fetchTeamDashboardAssociates([uplineId, childId]);
    const row = rows.find((r) => r.associateCode === TAG + "CHILD");
    expect(row?.directUpline).toBeDefined();
    expect(Object.keys(row?.directUpline as object).sort()).toEqual(["associateCode"]);
  });

  it.each(WITHDRAWN_FIELDS)("%s specifically is absent from the returned row", async (field) => {
    const rows = await fetchTeamDashboardAssociates([uplineId, childId]);
    const row = rows.find((r) => r.associateCode === TAG + "CHILD");
    expect(row).not.toHaveProperty(field);
  });

  it("sanity: the row is real, not a vacuous pass from an empty/missing result", async () => {
    const rows = await fetchTeamDashboardAssociates([uplineId, childId]);
    const row = rows.find((r) => r.associateCode === TAG + "CHILD");
    expect(row?.fullName).toBe("Fake child");
    expect(row?.directUpline?.associateCode).toBe(TAG + "UP");
  });

  it("CONTROL — the key-set equality fails once the select is widened to include a withdrawn field", async () => {
    const widenedRows = await prisma.associate.findMany({
      where: { associateCode: TAG + "CHILD" },
      select: { ...TEAM_DASHBOARD_ASSOCIATE_SELECT, mobileNumber: true, email: true, dateOfBirth: true },
    });
    const widened = widenedRows[0];
    // Same shape of assertion as the real test above, against a select that
    // DOES carry the withdrawn fields — it must NOT equal the allow-list
    // here, proving the equality check above would have failed had the real
    // select leaked any of them. A control that can't be violated is decoration.
    expect(Object.keys(widened).sort()).not.toEqual(ALLOWED_TOP_LEVEL_KEYS);
    expect(widened).toHaveProperty("mobileNumber");
    expect(widened.mobileNumber).toBe("+65 9000 0002");
    expect(widened).toHaveProperty("email");
    expect(widened.email).toBe("child@teamdash.test");
    expect(widened).toHaveProperty("dateOfBirth");
    expect(widened.dateOfBirth?.toISOString().slice(0, 10)).toBe("1995-06-15");
  });

  it("CONTROL — the recursive directUpline check fails once that relation is widened to the whole row", async () => {
    const widenedRows = await prisma.associate.findMany({
      where: { associateCode: TAG + "CHILD" },
      select: { ...TEAM_DASHBOARD_ASSOCIATE_SELECT, directUpline: true },
    });
    const widened = widenedRows[0];
    // directUpline: true pulls the WHOLE upline Associate row (mobileNumber,
    // email, dateOfBirth, ...) — the top-level key set is unchanged (still
    // just "directUpline"), which is exactly why a non-recursive check would
    // miss this. The nested key set must now differ from ["associateCode"].
    expect(Object.keys(widened.directUpline as object).sort()).not.toEqual(["associateCode"]);
    expect(widened.directUpline).toHaveProperty("mobileNumber");
  });
});
