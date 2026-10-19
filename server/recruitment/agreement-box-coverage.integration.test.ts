import { describe, test, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "child_process";
import { writeFileSync, mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { AGREEMENT_FIELD_BOXES, type FieldBox } from "@/lib/pdf/associate-agreement-coordinates";

// Tmpfs hotfix (2026-10-01) — same convention as lib/pdf/agreement.integration.test.ts's
// own mkTempDir: always the live tmpdir(), and the cleanup-proof test below
// asserts against these exact tracked paths rather than scanning tmpdir()
// for a prefix (unsafe under this file's own parallel unit-test workers).
const createdTempDirs: string[] = [];
function mkTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdTempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// The allow-list test (2026-09-29): drives the REAL producer —
// `submitOnboarding` itself, not a hand-built AgreementData fixture — and
// asserts every one of the 32 AGREEMENT_FIELD_BOXES entries receives real
// content, except a named, reasoned allow-list.
//
// Why this has to be `submitOnboarding` and not `renderAgreementPdf` called
// directly: a hand-built AgreementData fixture can supply a value for ANY
// field, including one the real app never collects — see
// `lib/pdf/agreement.integration.test.ts`'s own `BASE` + per-test overrides, which is
// exactly why it doesn't (and per the standing review, can't) catch this
// class of defect. Driving the real producer means only mocking the I/O
// boundaries (DB, object storage, rate limiter, mail, translations) and
// letting `@/lib/pdf/agreement`, `@/lib/crypto`, `@/lib/labels` run for
// real — the same mock shape `onboarding-validation.test.ts` already uses
// successfully for a full happy-path run, minus its mock of
// `@/lib/pdf/agreement`.
// ---------------------------------------------------------------------------

const { prismaMock, putObjectMock, getObjectMock, rateLimitMock } = vi.hoisted(() => ({
  prismaMock: {
    candidate: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    associate: { findUnique: vi.fn(), findMany: vi.fn() },
    companySignatory: { findUnique: vi.fn() },
  },
  putObjectMock: vi.fn(),
  getObjectMock: vi.fn(),
  rateLimitMock: {
    checkRateLimit: vi.fn(async () => ({ allowed: true })),
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/rate-limit", () => rateLimitMock);
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/storage", () => ({ putObject: putObjectMock, getObject: getObjectMock }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(), onboardingInviteEmail: vi.fn(), approvalEmail: vi.fn() }));
// Deliberately NOT mocking @/lib/pdf/agreement, @/lib/crypto or @/lib/labels
// — the whole point is to run the real renderer against what the real
// producer builds.

import { submitOnboarding, type OnboardingSubmission } from "./actions";

// ---------------------------------------------------------------------------
// pdftotext-bbox helpers, intentionally duplicated (not imported) from
// `lib/pdf/agreement.integration.test.ts` — that file's helpers aren't exported, and
// this test lives in a different directory driving a different entry point
// (`submitOnboarding`, not `renderAgreementPdf` directly); keeping this
// file's own small, self-contained copy avoids a cross-directory test-to-
// test import for ~5 short functions. Same REQUIRES poppler-utils caveat as
// that file: pdfinfo/pdftotext/pdftoppm must be on PATH, and a missing
// binary must fail loudly (ENOENT), never silently skip.
// ---------------------------------------------------------------------------
function toTempPdf(bytes: Buffer): string {
  const dir = mkTempDir("agbox-test-");
  const file = join(dir, "out.pdf");
  writeFileSync(file, bytes);
  return file;
}

type Word = { text: string; xMin: number; yMin: number; xMax: number; yMax: number };

function pdfWords(bytes: Buffer, page: number): Word[] {
  const file = toTempPdf(bytes);
  let xml: string;
  try {
    xml = execFileSync("pdftotext", ["-bbox", "-f", String(page), "-l", String(page), file, "-"], {
      encoding: "utf8",
    });
  } finally {
    rmSync(dirname(file), { recursive: true, force: true });
  }
  const words: Word[] = [];
  const re = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    words.push({ xMin: +m[1], yMin: +m[2], xMax: +m[3], yMax: +m[4], text: m[5] });
  }
  return words;
}

/** All text whose word bbox falls inside a box's own row on its own page —
 *  read from the rendered PDF itself, never assumed from what was asked to
 *  stamp there.
 *
 *  tol=2.5, not agreement.integration.test.ts's own tol=1: measured (this file's first
 *  run) that `signatureName`/`signatureNric` anchor their baseline at the
 *  box's own bottom edge (`SIGNATURE_NAME_LABEL_BASELINE` sits 0.17pt above
 *  `box.y+box.height`), so any stamped value with a descender ("Nathan")
 *  prints ink up to 1.78pt past the box's nominal bottom — real ink from a
 *  real producer, not a defect, and tol=1 falsely read it as empty. tol=2.5
 *  clears that with margin and doesn't weaken the census: a genuinely
 *  producer-less field prints ZERO words anywhere near its box regardless
 *  of tolerance, so widening it can't hide a real gap, only stop a false one. */
function textInBoxRow(bytes: Buffer, box: FieldBox): string {
  const tol = 2.5;
  return pdfWords(bytes, box.page)
    .filter((w) => w.yMin >= box.y - tol && w.yMax <= box.y + box.height + tol && w.xMin >= box.x - tol && w.xMax <= box.x + box.width + tol)
    .map((w) => w.text)
    .join(" ");
}

/** Rasterize one page for a dark-pixel probe — needed for the vector marks
 *  (checkbox X, circle ellipse, signature image) that pdftotext can't see
 *  at all. Same convention as agreement.integration.test.ts's own `rasterizePage`. */
function rasterizePage(bytes: Buffer, page: number, dpi = 200): { isDark: (xPt: number, yPt: number) => boolean } {
  const file = toTempPdf(bytes);
  const dir = mkTempDir("agbox-raster-");
  try {
    execFileSync("pdftoppm", ["-r", String(dpi), "-f", String(page), "-l", String(page), file, join(dir, "p")]);
    const ppmPath = execFileSync("sh", ["-c", `ls ${dir}/p*.ppm`], { encoding: "utf8" }).trim();
    const buf = readFileSync(ppmPath);
    let idx = 0;
    function readToken(): string {
      while (buf[idx] === 0x23) { while (buf[idx] !== 0x0a) idx++; idx++; }
      while (buf[idx] === 0x20 || buf[idx] === 0x0a || buf[idx] === 0x09 || buf[idx] === 0x0d) idx++;
      const start = idx;
      while (idx < buf.length && buf[idx] !== 0x20 && buf[idx] !== 0x0a && buf[idx] !== 0x09 && buf[idx] !== 0x0d) idx++;
      return buf.toString("ascii", start, idx);
    }
    const magic = readToken();
    if (magic !== "P6") throw new Error(`unexpected PPM magic ${magic}`);
    const width = Number(readToken());
    const height = Number(readToken());
    readToken();
    idx += 1;
    const scale = dpi / 72;
    const dataStart = idx;
    return {
      isDark(xPt: number, yPt: number): boolean {
        const x = Math.round(xPt * scale), y = Math.round(yPt * scale);
        if (x < 0 || y < 0 || x >= width || y >= height) return false;
        const off = dataStart + (y * width + x) * 3;
        return buf[off] < 150 && buf[off + 1] < 150 && buf[off + 2] < 150;
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dirname(file), { recursive: true, force: true });
  }
}

/** Any dark pixel anywhere inside `box`, sampled on a fine grid. Safe ONLY
 *  for a box with no pre-existing printed ink of its own — true for
 *  `signatureImage` (blank space in the master) but NOT for the checkbox or
 *  circle boxes, which are why those two get their own differential
 *  detectors below instead of this. */
function hasInkInBox(raster: { isDark: (x: number, y: number) => boolean }, box: FieldBox): boolean {
  const step = 1;
  for (let x = box.x; x <= box.x + box.width; x += step) {
    for (let y = box.y; y <= box.y + box.height; y += step) {
      if (raster.isDark(x, y)) return true;
    }
  }
  return false;
}

/** Fraction of non-white pixels in the padded region AROUND `box`, EXCLUDING
 *  `box` itself — ported unchanged (same pads, same 150dpi, same threshold
 *  convention) from `lib/pdf/agreement.integration.test.ts`'s own proven circle
 *  detector. Required because `spouseWorkingYes`/`spouseWorkingNo`'s boxes
 *  ARE the tight bbox of the master's own printed "Yes"/"No" glyphs — a
 *  same-box ink check would read true whether or not `stampCircle` ran at
 *  all (confirmed empirically below before this was written down, not
 *  assumed from the comment in agreement.integration.test.ts). */
function annulusInkFraction(
  bytes: Buffer,
  page: number,
  box: FieldBox,
  pad: { top: number; bottom: number; left: number; right: number },
): number {
  const file = toTempPdf(bytes);
  const dir = mkTempDir("agbox-raster-");
  try {
    const dpi = 150;
    execFileSync("pdftoppm", ["-r", String(dpi), "-f", String(page), "-l", String(page), file, join(dir, "p")]);
    const ppmPath = execFileSync("sh", ["-c", `ls ${dir}/p*.ppm`], { encoding: "utf8" }).trim();
    const buf = readFileSync(ppmPath);
    let idx = 0;
    function readToken(): string {
      while (buf[idx] === 0x23) { while (buf[idx] !== 0x0a) idx++; idx++; }
      while (buf[idx] === 0x20 || buf[idx] === 0x0a || buf[idx] === 0x09 || buf[idx] === 0x0d) idx++;
      const start = idx;
      while (idx < buf.length && buf[idx] !== 0x20 && buf[idx] !== 0x0a && buf[idx] !== 0x09 && buf[idx] !== 0x0d) idx++;
      return buf.toString("ascii", start, idx);
    }
    const magic = readToken();
    if (magic !== "P6") throw new Error(`unexpected PPM magic ${magic}`);
    const w = Number(readToken());
    const h = Number(readToken());
    readToken();
    idx += 1;
    const scale = dpi / 72;
    const outer = { x: box.x - pad.left, y: box.y - pad.top, width: box.width + pad.left + pad.right, height: box.height + pad.top + pad.bottom };
    const ox0 = Math.floor(outer.x * scale), oy0 = Math.floor(outer.y * scale);
    const ox1 = Math.ceil((outer.x + outer.width) * scale), oy1 = Math.ceil((outer.y + outer.height) * scale);
    const ix0 = Math.ceil(box.x * scale), iy0 = Math.ceil(box.y * scale);
    const ix1 = Math.floor((box.x + box.width) * scale), iy1 = Math.floor((box.y + box.height) * scale);
    let nonWhite = 0, total = 0;
    for (let y = Math.max(0, oy0); y < Math.min(h, oy1); y++) {
      for (let x = Math.max(0, ox0); x < Math.min(w, ox1); x++) {
        if (x >= ix0 && x < ix1 && y >= iy0 && y < iy1) continue;
        const off = idx + (y * w + x) * 3;
        const r = buf[off], g = buf[off + 1], b = buf[off + 2];
        total++;
        if (r < 230 || g < 230 || b < 230) nonWhite++;
      }
    }
    return total === 0 ? 0 : nonWhite / total;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dirname(file), { recursive: true, force: true });
  }
}
const CIRCLE_FULL_PAD = 6, CIRCLE_NARROW_PAD = 2; // same values as agreement.integration.test.ts's proven yesPad/noPad
const CIRCLE_INK_THRESHOLD = 0.02; // same threshold as agreement.integration.test.ts

/** Fraction of dark pixels in `box` shrunk inward by `shrink` on every
 *  side — required because the checkbox boxes ARE the printed square's own
 *  border, so a same-box ink check reads true from the border stroke alone
 *  whether or not `stampCheckbox` drew its X (confirmed empirically: at
 *  shrink=2 the undrawn box still read 4% ink from border leakage; shrink=3
 *  cleanly separates 32.6% (X drawn) from 0% (not drawn) — see the removed
 *  DEBUG measurement this constant is derived from). */
function interiorInkFraction(raster: { isDark: (x: number, y: number) => boolean }, box: FieldBox, shrink: number): number {
  let dark = 0, total = 0;
  for (let x = box.x + shrink; x <= box.x + box.width - shrink; x += 0.5) {
    for (let y = box.y + shrink; y <= box.y + box.height - shrink; y += 0.5) {
      total++;
      if (raster.isDark(x, y)) dark++;
    }
  }
  return total === 0 ? 0 : dark / total;
}
const CHECKBOX_SHRINK = 3;
const CHECKBOX_INK_THRESHOLD = 0.05; // clears the 0% (undrawn) / measured 32.6% (drawn) gap with margin

// ---------------------------------------------------------------------------
// FALSIFIABLE PREDICTION — written before this test was run, from reading
// the producer code (server/recruitment/actions.ts) and the onboarding
// schema (lib/schemas.ts), NOT from the rendered output. A surprise (a box
// outside this list rendering empty, or a listed one rendering non-empty
// when it shouldn't) is the finding, not a thing to quietly reconcile away.
//
// 2026-10-01 owner ruling: emergencyContactRelationship and
// emergencyContactAddress are now collected (optional, en + zh) and wired to
// the agreement boxes — this CLOSES the open question that used to exempt
// them here (see git history for the prior OPEN_QUESTION_ALLOW_LIST entries
// and their stated end condition). They're covered below by a dedicated
// fill/blank pair test, not an allow-list entry.
//
// NEVER_STAMPED_BY_DESIGN is now EMPTY. Its single entry, associateIdOfficial,
// gained a producer when the owner ruled that the associate code is allocated at
// signing instead of at approval: submitOnboarding reserves it and passes it to
// the render, so the box is censused like any other text box. The immutability
// rule that justified the exemption still holds and is why the ID is stamped on
// the original render rather than added to a signed document afterwards.
//
// MUTUALLY-EXCLUSIVE MARK PAIRS (4 boxes, own category — "non-empty value"
// doesn't apply to a vector mark, and only one member of each pair can ever
// carry ink in a single render by the form's own semantics: commencement is
// either Immediate or On-a-date, never both; spouse conflict is declared or
// not, never both). This fixture uses commencementDate SET and
// spouseConflict TRUE, so the prediction is: commencementOnCheckbox +
// spouseWorkingYes carry ink, commencementImmediateCheckbox + spouseWorkingNo
// do not — and that absence is the OTHER branch of a real producer, not a
// gap, asserted explicitly rather than silently allow-listed.
//
// IMAGE FIELD (1 box, own category): signatureImage — not text, checked by
// ink presence via rasterization rather than textInBoxRow.
//
// Everything else (26 boxes) is predicted to render non-empty text in this
// maximal-submission fixture.
//
// SURPRISE ENCOUNTERED AND RESOLVED WHILE BUILDING THIS TEST, kept in the
// record: the first run failed on signatureName/signatureNric (a tolerance
// bug in this test's own textInBoxRow, fixed above — see that function's
// comment) AND on both mark-pair boxes reading ink=true regardless of which
// branch was active (this test's first hasInkInBox implementation sampled
// the SAME box the master's own printed checkbox border / "Yes"/"No" glyphs
// already occupy, so it read true unconditionally — replaced with
// interiorInkFraction/annulusInkFraction below, which isolate only the
// STAMPED mark). Neither surprise was in the producer code; both were the
// harness not yet proven against the real render.
// ---------------------------------------------------------------------------

// Now EMPTY. associateIdOfficial used to live here; the owner's ruling to allocate
// the associate code at signing gave it a real producer (submitOnboarding reserves
// the code and passes it to renderAgreementPdf), so it is censused like any other
// text box below rather than exempted. The immutability rule it was justified by is
// unchanged — that is precisely why the ID is stamped on the ORIGINAL render and
// never added to an already-signed document.
const NEVER_STAMPED_BY_DESIGN: Record<string, string> = {};

const MUTUALLY_EXCLUSIVE_PAIRS: { active: string; inactive: string; note: string }[] = [
  { active: "commencementOnCheckbox", inactive: "commencementImmediateCheckbox", note: "commencementDate is set in this fixture" },
  { active: "spouseWorkingYes", inactive: "spouseWorkingNo", note: "spouseConflict is true in this fixture" },
];
const IMAGE_FIELDS = new Set(["signatureImage", "companySignatureImage"]);
// commencementOnDate is text but only drawn alongside commencementOnCheckbox
// (same `if (a.commencementDate)` branch) — it goes through the ordinary
// non-empty-text census below, not the mark-pair category, since it IS text.

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitMock.checkRateLimit.mockResolvedValue({ allowed: true });
  // The reservation path (lib/associate-code.ts) runs inside submitOnboarding now.
  // These mocks model the real protocol rather than returning a fixed string:
  // no code reserved yet, no codes issued anywhere, so the sequence starts at
  // EN0001 and the conditional write succeeds.
  prismaMock.associate.findMany.mockResolvedValue([]);
  prismaMock.candidate.findMany.mockResolvedValue([]);
  prismaMock.candidate.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.candidate.findUnique.mockResolvedValue({
    id: "cand-1",
    reservedAssociateCode: null,
    onboardingStage: "Invited",
    photoFileKey: null,
    signedAgreementFileKey: null,
    intendedDirectUplineId: "upline-1",
    intendedDesignation: "SalesAssociate",
    fullName: "Priya Nathan",
    email: "priya@example.com",
    mobileNumber: "91234567",
    intendedTeam: "Team Orion",
    commencementDate: new Date("2026-10-15T00:00:00.000Z"),
  });
  prismaMock.associate.findUnique.mockResolvedValue({
    fullName: "Marcus Lee",
    associateCode: "A1001",
    directUpline: { fullName: "Grace Ong", associateCode: "A1000" },
  });
  prismaMock.candidate.update.mockResolvedValue({});
  // CR-0001: a configured signatory — this IS the "maximal" case for the
  // company's own half of the agreement, same convention as every other
  // field here (the real producer path, not a hand-built AgreementData).
  prismaMock.companySignatory.findUnique.mockResolvedValue({
    signatoryName: "Jane Director",
    signatureFileKey: "company/signatory-signature.png",
  });
  putObjectMock.mockResolvedValue(undefined);
  getObjectMock.mockResolvedValue(
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  );
});

/** Every optional field in onboardingSchema populated — the "maximal"
 *  submission a real candidate could actually send, not a synthetic
 *  overfill of fields the schema doesn't have. */
function maximalSubmission() {
  return {
    fullName: "Priya Nathan",
    commencementDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    businessName: "Nathan Ventures",
    nric: "S1234567A",
    dateOfBirth: "1990-05-15",
    residentialAddress: "1 Example Avenue, #01-01, Singapore 123456",
    emergencyContactName: "Devi Nathan",
    emergencyContactNumber: "98765432",
    emergencyContactRelationship: "Sister",
    emergencyContactAddress: "9 Example Street, #05-10, Singapore 654321",
    paymentMethod: "PayNow" as const,
    paynowNumber: "91234567",
    agreementAccepted: true,
    maritalStatus: "Married" as const,
    nationality: "Singaporean",
    gender: "Female" as const,
    religion: "Hindu",
    spouseConflict: true,
    spouseName: "Arjun Nathan",
    spouseCompany: "Eternal Rest Funeral Services",
    spouseDesignation: "Operations Manager",
    signature: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  };
}

async function renderAgreementPdfFrom(submission: OnboardingSubmission): Promise<Buffer> {
  const r = await submitOnboarding("tok-coverage", submission);
  expect(r).toEqual({ ok: true });
  const call = putObjectMock.mock.calls.find(([key]) => String(key).endsWith("signed-agreement.pdf"));
  if (!call) throw new Error("submitOnboarding did not store a signed-agreement.pdf — nothing to check");
  return call[1] as Buffer;
}

async function renderMaximalAgreementPdf(): Promise<Buffer> {
  return renderAgreementPdfFrom(maximalSubmission());
}

/** The actual per-entry check the "non-empty" census runs, factored out so
 *  it can be exercised directly (not just through the committed
 *  categorization) by the control test below — "does adding a real,
 *  producer-backed field to an exemption list make the check fail?" */
function findEmptyExemptedBoxes(pdf: Buffer, exemptList: Record<string, string>): string[] {
  const stillHasText: string[] = [];
  for (const name of Object.keys(exemptList)) {
    const box = AGREEMENT_FIELD_BOXES[name];
    if (textInBoxRow(pdf, box).trim()) stillHasText.push(name);
  }
  return stillHasText;
}

describe("associate agreement — every coordinate box has a producer (or a reasoned exemption)", () => {
  test("PRE-REGISTRATION: every category accounts for exactly the boxes it claims, count is a cross-check only", () => {
    const total = Object.keys(AGREEMENT_FIELD_BOXES).length;
    const markPairKeys = MUTUALLY_EXCLUSIVE_PAIRS.flatMap((p) => [p.active, p.inactive]);
    const categorized = [...Object.keys(NEVER_STAMPED_BY_DESIGN), ...markPairKeys, ...Array.from(IMAGE_FIELDS)];
    // Every key must be classified exactly once — a key in two categories, or
    // a category naming a key that isn't a real box, is itself a finding.
    for (const k of categorized) expect(AGREEMENT_FIELD_BOXES).toHaveProperty(k);
    expect(new Set(categorized).size).toBe(categorized.length); // no key double-counted across categories
    const expectedTextCount = total - categorized.length;
    // Built-in control: the census reports how many boxes it checked, per the
    // standing "a tool must report how many inputs it consumed" rule.
    console.log(`agreement-box-coverage: ${total} total boxes, ${categorized.length} exempt/categorized, ${expectedTextCount} expected non-empty`);
    expect(expectedTextCount).toBe(28); // pre-registered count, cross-check only — the per-entry assertions below are the real test (was 26 before CR-0001, 27 after; associateIdOfficial leaving NEVER_STAMPED_BY_DESIGN makes it 28)
  });

  test("every non-exempt text box receives real, non-empty text from the real producer path", async () => {
    const pdf = await renderMaximalAgreementPdf();
    const markPairKeys = new Set(MUTUALLY_EXCLUSIVE_PAIRS.flatMap((p) => [p.active, p.inactive]));
    const checked: string[] = [];
    const failures: string[] = [];
    for (const [name, box] of Object.entries(AGREEMENT_FIELD_BOXES)) {
      if (name in NEVER_STAMPED_BY_DESIGN || markPairKeys.has(name) || IMAGE_FIELDS.has(name)) continue;
      checked.push(name);
      const text = textInBoxRow(pdf, box);
      if (!text.trim()) failures.push(name);
    }
    // Built-in control: input count.
    console.log(`agreement-box-coverage: checked ${checked.length} text boxes for non-empty content`);
    expect(checked.length).toBe(28); // built-in control: a census over the wrong subject set reports 0 failures for the wrong reason (was 27 before the associate-ID change, see the PRE-REGISTRATION test above)
    expect(failures).toEqual([]);
  });

  test("PER-ENTRY CONTROL: a producer-backed field wrongly added to the never-stamped exemption would be caught, not waved through", async () => {
    const pdf = await renderMaximalAgreementPdf();
    // fullName demonstrably HAS a producer (c.fullName, always set) — this is
    // the false exemption entry this control proves the check would reject.
    const wrongList = { ...NEVER_STAMPED_BY_DESIGN, fullName: "WRONG — fullName has a real producer, placed here only to prove the check fires" };
    const falselyExempted = findEmptyExemptedBoxes(pdf, wrongList);
    // A field with a real producer is NOT expected to render blank — so if it
    // were wrongly exempted, findEmptyExemptedBoxes (which only flags an
    // exempted box that unexpectedly HAS text) would name it here. Assert the
    // control actually distinguishes the real entry from the planted wrong
    // one, rather than asserting a bare non-zero count.
    expect(falselyExempted).toEqual(["fullName"]);
    // And the real entry must NOT be flagged by the same check — it really
    // does render blank, so a working check leaves it alone.
    expect(findEmptyExemptedBoxes(pdf, NEVER_STAMPED_BY_DESIGN)).toEqual([]);
  });

  // Split into two tests (not two render calls in one test) deliberately —
  // putObjectMock.mock.calls accumulates across calls within a single test,
  // and .find() returns the FIRST match, so a second render in the same test
  // would silently read back the first render's PDF. beforeEach's
  // vi.clearAllMocks() gives each test its own clean call history instead.
  test("emergency contact relationship/address: fill the boxes when the fields are given (owner ruling 2026-10-01)", async () => {
    // Also covered, redundantly, by the general census above; asserted
    // directly here because this is the behaviour the ruling specifically
    // requires, not an incidental pass of a broader loop.
    const filled = await renderMaximalAgreementPdf();
    expect(textInBoxRow(filled, AGREEMENT_FIELD_BOXES.emergencyContactRelationship).trim()).not.toBe("");
    expect(textInBoxRow(filled, AGREEMENT_FIELD_BOXES.emergencyContactAddress).trim()).not.toBe("");
  });

  test("emergency contact relationship/address: stay blank when the fields are not given (owner ruling 2026-10-01)", async () => {
    // The fields are optional — a submission omitting them must still
    // succeed, and the boxes must render blank, not error or stale text.
    const { emergencyContactRelationship, emergencyContactAddress, ...withoutExtras } = maximalSubmission();
    void emergencyContactRelationship;
    void emergencyContactAddress;
    const blank = await renderAgreementPdfFrom(withoutExtras);
    expect(textInBoxRow(blank, AGREEMENT_FIELD_BOXES.emergencyContactRelationship).trim()).toBe("");
    expect(textInBoxRow(blank, AGREEMENT_FIELD_BOXES.emergencyContactAddress).trim()).toBe("");
  });

  test("never-stamped-by-design boxes render blank, and the reason states it's a closed ruling, not an open question", async () => {
    const pdf = await renderMaximalAgreementPdf();
    for (const [name, reason] of Object.entries(NEVER_STAMPED_BY_DESIGN)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(reason).not.toMatch(/remove this entry/i); // no removal instruction — it isn't waiting on an answer
      expect(reason).toMatch(/permanent|ruling/i);
      const box = AGREEMENT_FIELD_BOXES[name];
      expect(textInBoxRow(pdf, box).trim()).toBe("");
    }
  });

  test("mutually-exclusive mark pairs: exactly the active member carries ink, never both, never neither", async () => {
    // Fixture: commencementDate SET, spouseConflict TRUE — so the "On"/"Yes"
    // side of each pair is the active one this render is predicted to ink.
    const pdf = await renderMaximalAgreementPdf();
    const page7 = rasterizePage(pdf, 7);
    // commencementOnCheckbox / commencementImmediateCheckbox: interior-only
    // sampling (shrink=3) to avoid the master's own printed square border,
    // which both boxes have regardless of which one stampCheckbox draws into
    // — measured empirically: 0% (undrawn) vs 32.6% (drawn) at this shrink.
    expect(interiorInkFraction(page7, AGREEMENT_FIELD_BOXES.commencementOnCheckbox, CHECKBOX_SHRINK)).toBeGreaterThan(CHECKBOX_INK_THRESHOLD);
    expect(interiorInkFraction(page7, AGREEMENT_FIELD_BOXES.commencementImmediateCheckbox, CHECKBOX_SHRINK)).toBeLessThan(CHECKBOX_INK_THRESHOLD);
    // spouseWorkingYes / spouseWorkingNo: annulus sampling (same pads/
    // threshold as lib/pdf/agreement.integration.test.ts's own proven circle detector)
    // to avoid the master's own printed "Yes"/"No" glyphs, which the tight
    // box IS the bbox of regardless of whether stampCircle drew a ring.
    expect(annulusInkFraction(pdf, 7, AGREEMENT_FIELD_BOXES.spouseWorkingYes, { top: CIRCLE_FULL_PAD, bottom: CIRCLE_FULL_PAD, left: CIRCLE_FULL_PAD, right: CIRCLE_NARROW_PAD })).toBeGreaterThan(CIRCLE_INK_THRESHOLD);
    expect(annulusInkFraction(pdf, 7, AGREEMENT_FIELD_BOXES.spouseWorkingNo, { top: CIRCLE_FULL_PAD, bottom: CIRCLE_FULL_PAD, left: CIRCLE_NARROW_PAD, right: CIRCLE_FULL_PAD })).toBeLessThan(CIRCLE_INK_THRESHOLD);
  });

  test("the image field carries ink (a real embedded signature), not text", async () => {
    const pdf = await renderMaximalAgreementPdf();
    const page7 = rasterizePage(pdf, 7);
    for (const name of IMAGE_FIELDS) {
      expect(hasInkInBox(page7, AGREEMENT_FIELD_BOXES[name])).toBe(true);
    }
  });
});

describe("temp-dir cleanup (tmpfs hotfix, 2026-10-01)", () => {
  // Same convention and same reasoning as lib/pdf/agreement.integration.test.ts's own
  // cleanup-proof test — this file's helpers were copied from there (agbox-*
  // vs agpdf-*, same leak). Scoped to this test's own tracked paths, not a
  // directory-wide tmpdir() scan, for the same parallel-worker reason.
  test("every directory created while extracting text + rasterizing a real agreement is removed again — not merely assumed", async () => {
    createdTempDirs.length = 0;
    const pdf = await renderMaximalAgreementPdf();
    textInBoxRow(pdf, AGREEMENT_FIELD_BOXES.fullName); // exercises toTempPdf via pdfWords
    rasterizePage(pdf, 7); // exercises toTempPdf + its own raster dir
    annulusInkFraction(pdf, 7, AGREEMENT_FIELD_BOXES.spouseWorkingYes, { top: CIRCLE_FULL_PAD, bottom: CIRCLE_FULL_PAD, left: CIRCLE_FULL_PAD, right: CIRCLE_NARROW_PAD }); // exercises toTempPdf + its own raster dir

    // Control: a run that created nothing would make "every dir is gone"
    // vacuously true. At least 4 dirs: toTempPdf x3, plus 2 raster dirs.
    expect(createdTempDirs.length).toBeGreaterThanOrEqual(5);

    for (const dir of createdTempDirs) {
      expect(dir.startsWith(tmpdir())).toBe(true); // measured the LIVE tmpdir(), not a hardcoded "/tmp"
      expect(existsSync(dir)).toBe(false);
    }
  });
});
