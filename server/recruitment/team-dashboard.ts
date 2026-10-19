import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

// Team Dashboard (C-8, PDF p.9): PDPA removed Contact and Date of Birth from
// an upline's view of their downline on 22 Sep 2026; the owner's Q6 answer on
// 02 Oct confirmed that stands — the C-8 mockup's Contact/DOB columns are the
// PRE-22-Sep shape and are not coming back. mobileNumber, email and
// dateOfBirth are SELECTED OUT here, not merely left out of the rendered
// columns, so none of the three reach the query result for this read path at
// all. See team-dashboard.integration.test.ts for the proof (with controls
// that fail if this select is widened to include any of them).
//
// businessName added 19 Oct 2026 (owner-approved VO PR2, Director →
// Recruitment tab): unlike the PDPA-withdrawn fields above, this is not
// contact/identity PII — it's the associate's own business/trading name,
// same visibility class as fullName on this same row. Row scope is
// unchanged: this only adds a column to the existing select, over the same
// treeIds the caller already resolved (lib/rbac's downlineIds / the
// recruitment-view.tsx caller), never a broadened query.
export const TEAM_DASHBOARD_ASSOCIATE_SELECT = {
  id: true,
  associateCode: true,
  fullName: true,
  businessName: true,
  designation: true,
  directUplineId: true,
  associateStatus: true,
  directUpline: { select: { associateCode: true } },
} satisfies Prisma.AssociateSelect;

export type TeamDashboardAssociateRow = Prisma.AssociateGetPayload<{ select: typeof TEAM_DASHBOARD_ASSOCIATE_SELECT }>;

/** The raw rows for the Team Dashboard / Downline Performance tree, using the
 *  select above — the boundary the integration test exercises directly. */
export async function fetchTeamDashboardAssociates(ids: string[]): Promise<TeamDashboardAssociateRow[]> {
  return prisma.associate.findMany({
    where: { id: { in: ids }, archivedAt: null },
    orderBy: { associateCode: "asc" },
    select: TEAM_DASHBOARD_ASSOCIATE_SELECT,
  });
}
