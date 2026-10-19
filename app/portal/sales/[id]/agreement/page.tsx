import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SubmissionStatus } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isAdminRole } from "@/lib/rbac";
import { isAgreementEditableStatus } from "@/lib/ashes-terms-snapshot";
import { formatSGD } from "@/lib/money";
import { humanize } from "@/lib/labels";
import { PageHeader } from "@/components/ui/page-header";
import { AshesAgreementForm } from "./agreement-form";
import type { AshesPet } from "@/lib/pdf/ashes-agreement";
import { readNric } from "@/server/pii";

export const dynamic = "force-dynamic";
export const metadata = { title: "Storage of Pets Ashes Agreement · Enshrine Portal" };

// Application-details step (consolidated menu, Sep 2026): after the quotation
// is approved+signed the associate fills this form; the data auto-fills the
// Storage of Pets Ashes Agreement, which the client signs in person below.
export default async function AshesAgreementPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const { id } = await params;
  const t = await getTranslations("agreements");

  const sub = await prisma.salesSubmission.findUnique({
    where: { id },
    include: { ashesAgreement: true, lineItems: { select: { productName: true } } },
  });
  if (!sub) notFound();
  const mine = !!session.user.associateId && session.user.associateId === sub.closingAssociateId;
  if (!mine && !isAdminRole(session.user.role)) notFound();
  // A rejected submission is terminal, not merely "not yet editable" — its
  // agreement must render read-only (bug report, 19 Oct 2026: a rejected
  // submission's draft agreement stayed Draft and Open bounced to
  // /portal/quotations instead of showing anything). Every OTHER
  // not-yet-editable status (QuotationApproved/Verified for ClosedDeal,
  // Submitted for Legacy) keeps the existing redirect — unchanged, out of
  // scope for this fix.
  const rejected = sub.status === SubmissionStatus.Rejected;
  if (!rejected && !isAgreementEditableStatus(sub.flow, sub.status)) redirect("/portal/quotations");

  const a = sub.ashesAgreement;
  // SEC-12: decrypt for the edit-form prefill (or tolerate still-plaintext
  // legacy rows during the transition) — never a raw column pass-through.
  const [applicant1Nric, applicant2Nric, applicantWitnessNric, companyWitnessNric] = a
    ? await Promise.all([
        readNric({ blob: a.applicant1Nric, field: "applicant1Nric", subjectType: "PetsAshesAgreement", subjectId: a.id, actorUserId: session.user.id }),
        readNric({ blob: a.applicant2Nric, field: "applicant2Nric", subjectType: "PetsAshesAgreement", subjectId: a.id, actorUserId: session.user.id }),
        readNric({ blob: a.applicantWitnessNric, field: "applicantWitnessNric", subjectType: "PetsAshesAgreement", subjectId: a.id, actorUserId: session.user.id }),
        readNric({ blob: a.companyWitnessNric, field: "companyWitnessNric", subjectType: "PetsAshesAgreement", subjectId: a.id, actorUserId: session.user.id }),
      ])
    : [null, null, null, null];
  return (
    <>
      <PageHeader
        title={t("form.title")}
        subtitle={`${sub.clientName} · ${sub.lineItems.map((l) => l.productName).join(", ")} · ${formatSGD(sub.saleAmount)} · ${humanize(sub.paymentPlan)}`}
      />
      <div className="max-w-3xl">
        <AshesAgreementForm
          submissionId={sub.id}
          isInstalment={sub.paymentPlan === "Installment"}
          signed={a?.status === "Signed"}
          readOnly={rejected}
          agreementPdfKey={a?.agreementPdfKey ?? null}
          initial={{
            storageSpaceLocation: a?.storageSpaceLocation ?? "",
            nicheUnit: a?.nicheUnit ?? sub.lineItems.map((l) => l.productName).join(", "),
            pets: ((a?.pets as AshesPet[] | undefined) ?? []).length ? (a?.pets as AshesPet[]) : [{}],
            applicant1Name: a?.applicant1Name ?? sub.clientName,
            applicant1Nric: applicant1Nric ?? "",
            applicant1Address: a?.applicant1Address ?? "",
            applicant1Contact: a?.applicant1Contact ?? sub.clientContact ?? "",
            applicant1Email: a?.applicant1Email ?? "",
            applicant2Name: a?.applicant2Name ?? "",
            applicant2Nric: applicant2Nric ?? "",
            applicant2Address: a?.applicant2Address ?? "",
            applicant2Contact: a?.applicant2Contact ?? "",
            applicant2Email: a?.applicant2Email ?? "",
            instalmentDayOfMonth: a?.instalmentDayOfMonth ?? 1,
            maintenanceStartYear: a?.maintenanceStartYear ?? new Date().getFullYear() + 1,
            additionalTerms: a?.additionalTerms ?? "",
            applicantWitnessName: a?.applicantWitnessName ?? "",
            applicantWitnessNric: applicantWitnessNric ?? "",
            companyWitnessName: a?.companyWitnessName ?? "",
            companyWitnessNric: companyWitnessNric ?? "",
          }}
        />
      </div>
    </>
  );
}
