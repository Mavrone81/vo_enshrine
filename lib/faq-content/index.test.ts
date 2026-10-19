import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppRole } from "@prisma/client";
import en from "@/messages/en.json";
import zhCN from "@/messages/zh-CN.json";
import { roleLabel } from "@/lib/rbac";
import { FAQ_ROLE_ORDER, FAQ_SECTIONS, visibleFaqRoles, resolveFaqSections } from "./index";

const ALL_ROLES = Object.values(AppRole);

describe("FAQ_ROLE_ORDER / FAQ_SECTIONS — structural completeness", () => {
  it("covers every real AppRole, exactly once, in the spec's §0 order", () => {
    expect(FAQ_ROLE_ORDER).toEqual([
      "SalesAssociate", "SalesAssistantManager", "SalesManager", "SalesDirector", "Admin", "Accounts",
    ]);
    expect(new Set(FAQ_ROLE_ORDER)).toEqual(new Set(ALL_ROLES));
  });

  it("every role has at least one question, with no duplicate ids within a role", () => {
    for (const role of ALL_ROLES) {
      const ids = FAQ_SECTIONS[role];
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("visibleFaqRoles — PM/UIUX spec §1: Business Admin sees all six, everyone else only their own", () => {
  it("Business Admin sees every role's section, in display order", () => {
    expect(visibleFaqRoles("Admin")).toEqual(FAQ_ROLE_ORDER);
  });

  // Named explicitly: the spec's own wording is "Business Admin", not
  // isAdminRole (which also covers Accounts) — Accounts must NOT get the
  // all-roles view, same as every non-admin role.
  it.each(ALL_ROLES.filter((r) => r !== "Admin"))("%s sees only its own section", (role) => {
    expect(visibleFaqRoles(role)).toEqual([role]);
  });
});

describe("resolveFaqSections — the exact shape FaqView receives", () => {
  const identityT = (key: string) => key; // mirrors how translated text would resolve, without a real catalogue

  it("resolves one section per visible role, each carrying its own roleLabel and every one of its question ids", () => {
    for (const role of ALL_ROLES) {
      const sections = resolveFaqSections(role, identityT);
      const expectedRoles = visibleFaqRoles(role);
      expect(sections.map((s) => s.role)).toEqual(expectedRoles);
      for (const section of sections) {
        expect(section.roleLabel).toBe(roleLabel[section.role]);
        expect(section.items.map((i) => i.id)).toEqual([...FAQ_SECTIONS[section.role]]);
      }
    }
  });

  it("builds keys scoped to sections.<role>.q.<id>.{question,answer} — a tampered id can never cross into another role's content", () => {
    const sections = resolveFaqSections("SalesAssociate", identityT);
    const firstId = FAQ_SECTIONS.SalesAssociate[0];
    expect(sections[0].items[0].question).toBe(`sections.SalesAssociate.q.${firstId}.question`);
    expect(sections[0].items[0].answer).toBe(`sections.SalesAssociate.q.${firstId}.answer`);
  });

  // Non-vacuous value-enumeration check (the class of test
  // lib/i18n-key-resolution.test.ts's own header comment says a computed-key
  // family like faq.sections.${role}.q.${id} needs, since that scan can only
  // log such calls as "unresolvable", never assert on them). Walks the REAL
  // catalogues, not a mock, and fails if a translation is missing OR is
  // merely the untranslated English string sitting in the zh-CN file.
  describe("every question id resolves to a real, present string in BOTH catalogues", () => {
    function get(catalog: unknown, path: string): unknown {
      return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), catalog);
    }
    for (const role of ALL_ROLES) {
      for (const id of FAQ_SECTIONS[role]) {
        for (const field of ["question", "answer"] as const) {
          const path = `faq.sections.${role}.q.${id}.${field}`;
          it(`${path}`, () => {
            const enText = get(en, path);
            const zhText = get(zhCN, path);
            expect(typeof enText, `en.json missing ${path}`).toBe("string");
            expect((enText as string).length).toBeGreaterThan(0);
            expect(typeof zhText, `zh-CN.json missing ${path}`).toBe("string");
            expect((zhText as string).length).toBeGreaterThan(0);
          });
        }
      }
    }
  });
});

// Page wiring — called as a plain function (same pattern as
// server/team/performance-page.test.ts), not rendered: proves each page
// actually calls resolveFaqSections with the SESSION's own role (never a
// hardcoded or client-supplied one), and that the FaqView prop it builds
// carries exactly the roles that session is allowed to see — i.e. the real
// RSC payload, not merely what a renderer chooses to display.
const h = vi.hoisted(() => ({
  role: "SalesAssociate" as string,
  FaqView: vi.fn(() => null),
}));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { role: h.role } }) }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("@/components/faq/faq-view", () => ({ FaqView: h.FaqView }));

import PortalFaqPage from "@/app/portal/faq/page";
import AdminFaqPage from "@/app/admin/faq/page";

type El = { type?: unknown; props?: { children?: unknown; [k: string]: unknown } };
function findProps(node: unknown, type: unknown): El["props"] | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findProps(n, type);
      if (found) return found;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const el = node as El;
    if (el.type === type) return el.props;
    return findProps(el.props?.children, type);
  }
  return undefined;
}

function sectionRoles(props: El["props"]): string[] {
  return ((props?.sections as { role: string }[] | undefined) ?? []).map((s) => s.role);
}

beforeEach(() => h.FaqView.mockClear());

describe("app/portal/faq/page.tsx wiring", () => {
  it("passes exactly the viewer's own role's section for a non-admin role", async () => {
    h.role = "SalesManager";
    const tree = await PortalFaqPage();
    const props = findProps(tree, h.FaqView);
    expect(sectionRoles(props)).toEqual(["SalesManager"]);
  });

  it("passes every role's section for Business Admin", async () => {
    h.role = "Admin";
    const tree = await PortalFaqPage();
    const props = findProps(tree, h.FaqView);
    expect(sectionRoles(props)).toEqual(FAQ_ROLE_ORDER);
  });
});

describe("app/admin/faq/page.tsx wiring", () => {
  it("passes exactly the viewer's own role's section for Accounts (not the all-roles view)", async () => {
    h.role = "Accounts";
    const tree = await AdminFaqPage();
    const props = findProps(tree, h.FaqView);
    expect(sectionRoles(props)).toEqual(["Accounts"]);
  });

  it("passes every role's section for Business Admin", async () => {
    h.role = "Admin";
    const tree = await AdminFaqPage();
    const props = findProps(tree, h.FaqView);
    expect(sectionRoles(props)).toEqual(FAQ_ROLE_ORDER);
  });
});
