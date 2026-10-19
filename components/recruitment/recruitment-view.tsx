import Link from "next/link";
import { FileSearch } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { LedgerStatus } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canRecruit, downlineIds } from "@/lib/rbac";
import { humanize } from "@/lib/labels";
import { formatSGD } from "@/lib/money";
import { managerOptions, performanceByAssociate, RECRUIT_TABS, selectRecruits, type RecruitTab } from "@/lib/recruitment-view";
import { fetchTeamDashboardAssociates } from "@/server/recruitment/team-dashboard";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/status-pill";
import { TABLE_HEAD_ROW_CLS, TABLE_HEAD_CELL_CLS } from "@/components/ui/table";

/**
 * Recruitment Dashboard ("people") and Downline Performance ("performance") —
 * associate-portal changes, Sep 2026 (A8/A10). Same tabs and manager filter on
 * both; tabs and filter are URL params so a view can be bookmarked.
 *
 * Eligibility: designations that cannot recruit see the "not eligible yet"
 * state instead of the table. The rule is lib/rbac canRecruit (Manager and
 * above — A9, owner ruling 2026-09-26: the PDF wins over the earlier 1 Sep AM+
 * decision; Sales Assistant Manager is no longer eligible).
 *
 * Business name (19 Oct 2026, owner-approved VO PR2): "people" mode only —
 * the owner's request was specifically the Recruitment tab's associate list,
 * not Downline Performance. Reuses the exact row set `rows` already is
 * (same treeIds/downlineIds scoping as every other column here); this adds
 * no new query and no new row. Missing/null renders as "—" (the same
 * fallback every other optional column in this codebase uses), never blank.
 */
export async function RecruitmentView({ mode, basePath, tab, mgr, embedded = false }: {
  mode: "people" | "performance";
  basePath: string;
  tab: RecruitTab;
  mgr: string | null;
  // C-8 (2026-10-03): true when composed inside another page (Team Dashboard)
  // that already renders its own PageHeader — skips this component's own.
  embedded?: boolean;
}) {
  const t = await getTranslations("recruitment.board");
  const tc = await getTranslations("common");
  const session = await auth();
  const me = session?.user.associateId ?? null;
  const title = mode === "people" ? t("peopleTitle") : t("performanceTitle");

  if (!session || !me) return embedded ? null : <PageHeader title={title} subtitle={t("noProfile")} />;
  const eligible = canRecruit(session.user.role);

  const treeIds = eligible ? await downlineIds(me) : [me];
  // Contact details and date of birth are selected out at the query level —
  // see server/recruitment/team-dashboard.ts.
  const tree = await fetchTeamDashboardAssociates(treeIds);
  const managers = managerOptions(tree, me);
  const mgrValid = mgr && managers.some((m) => m.id === mgr) ? mgr : null;
  const rows = selectRecruits(tree, me, tab, mgrValid);

  let perf: ReturnType<typeof performanceByAssociate> | null = null;
  if (mode === "performance" && rows.length) {
    const ids = rows.map((r) => r.id);
    const txns = await prisma.salesTransaction.findMany({
      where: { closingAssociateId: { in: ids } },
      select: { id: true, closingAssociateId: true, saleAmount: true, directUplineId: true, secondUplineId: true },
    });
    const lines = await prisma.commissionLedger.findMany({
      where: {
        status: { not: LedgerStatus.Cancelled },
        OR: [{ associateId: { in: ids } }, { associateId: me, transactionId: { in: txns.map((x) => x.id) } }],
      },
      select: { transactionId: true, associateId: true, lineType: true, status: true, amount: true },
    });
    perf = performanceByAssociate(ids, txns, lines, me);
  }

  const href = (next: { tab?: RecruitTab; mgr?: string | null }) => {
    const p = new URLSearchParams();
    const nt = next.tab ?? tab;
    const nm = next.mgr === undefined ? mgrValid : next.mgr;
    if (nt !== "all") p.set("tab", nt);
    if (nm) p.set("mgr", nm);
    const q = p.toString();
    return q ? `${basePath}?${q}` : basePath;
  };
  const tabLabel = (k: RecruitTab) => (mode === "people" ? t(`tab.${k}`) : t(`perfTab.${k}`));
  const showUpline = tab !== "direct";
  const th = `px-4 py-3 font-medium ${TABLE_HEAD_CELL_CLS}`;

  return (
    <>
      {!embedded && <PageHeader title={title} subtitle={mode === "people" ? t("peopleSubtitle") : t("performanceSubtitle")} />}

      <nav className="mb-4 flex flex-wrap gap-2" aria-label={title}>
        {RECRUIT_TABS.map((k) => (
          <Link
            key={k}
            href={href({ tab: k })}
            aria-current={k === tab ? "page" : undefined}
            className={
              "rounded-xl border-2 border-ink px-5 py-2.5 text-[14px] font-semibold transition-colors " +
              (k === tab ? "bg-ink text-white" : "bg-white text-ink hover:bg-paper-100")
            }
          >
            {tabLabel(k)}
          </Link>
        ))}
      </nav>

      {eligible && managers.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-muted">{t("filterByManager")}</span>
          <Link href={href({ mgr: null })} className={"rounded-full border px-3 py-1 " + (!mgrValid ? "border-ink bg-ink text-white" : "border-line text-ink hover:bg-paper-100")}>
            {t("everyone")}
          </Link>
          {managers.map((m) => (
            <Link key={m.id} href={href({ mgr: m.id })} className={"rounded-full border px-3 py-1 " + (mgrValid === m.id ? "border-ink bg-ink text-white" : "border-line text-ink hover:bg-paper-100")}>
              {m.associateCode} · {m.fullName}
            </Link>
          ))}
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className={TABLE_HEAD_ROW_CLS}>
                <th className={th}>{t("col.id")}</th>
                <th className={th}>{t("col.associate")}</th>
                {mode === "people" && <th className={th}>{t("col.businessName")}</th>}
                <th className={th}>{t("col.designation")}</th>
                {showUpline && <th className={th}>{t("col.upline")}</th>}
                {mode === "people" ? (
                  // Contact + date of birth deliberately NOT shown to uplines (owner ruling, 2026-09-22).
                  <th className={th}>{tc("status")}</th>
                ) : (
                  <>
                    <th className={th}>{t("col.transacted")}</th>
                    <th className={th}>{t("col.commission")}</th>
                    <th className={th}>{t("col.myDirect")}</th>
                    <th className={th}>{t("col.mySecond")}</th>
                  </>
                )}
              </tr>
            </thead>
            {eligible && rows.length > 0 && (
              <tbody>
                {rows.map((a) => {
                  const p = perf?.get(a.id);
                  return (
                    <tr key={a.id} className="border-b border-line-200 last:border-0 hover:bg-paper-100">
                      <td className="px-4 py-3 font-medium text-ink">{a.associateCode}</td>
                      <td className="px-4 py-3 text-ink">{a.fullName}</td>
                      {mode === "people" && <td className="px-4 py-3 text-ink">{a.businessName ?? "—"}</td>}
                      <td className="px-4 py-3 text-muted">{humanize(a.designation)}</td>
                      {showUpline && <td className="px-4 py-3 text-muted">{a.directUpline?.associateCode ?? "—"}</td>}
                      {mode === "people" ? (
                        <td className="px-4 py-3"><StatusPill status={a.associateStatus} /></td>
                      ) : (
                        <>
                          <td className="px-4 py-3 text-right tabular-nums text-ink">{formatSGD(p?.transacted ?? 0)}</td>
                          <td className="px-4 py-3 text-right tabular-nums text-ink">{formatSGD(p?.commission ?? 0)}</td>
                          <td className="px-4 py-3 text-right tabular-nums text-ink">{formatSGD(p?.myDirect ?? 0)}</td>
                          <td className="px-4 py-3 text-right tabular-nums text-ink">{formatSGD(p?.mySecond ?? 0)}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            )}
          </table>
        </div>

        {!eligible ? (
          <div className="flex flex-col items-center gap-4 px-5 py-16 text-center">
            <FileSearch className="h-16 w-16 text-ink/70" strokeWidth={1.4} aria-hidden />
            <p className="font-display text-[22px] text-ink">{t("notEligible")}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="px-5 py-12 text-center text-[13px] text-muted">{t("empty")}</div>
        ) : null}
      </Card>
    </>
  );
}
