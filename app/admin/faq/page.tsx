import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { PageHeader } from "@/components/ui/page-header";
import { resolveFaqSections } from "@/lib/faq-content";
import { FaqView } from "@/components/faq/faq-view";

export const metadata = { title: "FAQ · Enshrine Admin" };

export default async function AdminFaqPage() {
  const session = await auth();
  const t = await getTranslations("faq");

  if (!session?.user) return <PageHeader title={t("pageTitle")} />;

  // Business Admin sees every role's section here (resolveFaqSections ->
  // visibleFaqRoles); everyone else (Accounts included) sees only their
  // own. Role-filtered server-side before this ever reaches the client —
  // see the matching comment on the portal page.
  const sections = resolveFaqSections(session.user.role, t);

  return (
    <>
      <PageHeader title={t("pageTitle")} subtitle={t("pageSubtitle")} />
      <FaqView sections={sections} />
    </>
  );
}
