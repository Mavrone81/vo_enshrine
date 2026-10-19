import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { PageHeader } from "@/components/ui/page-header";
import { resolveFaqSections } from "@/lib/faq-content";
import { FaqView } from "@/components/faq/faq-view";

export const metadata = { title: "FAQ · Enshrine Portal" };

export default async function PortalFaqPage() {
  const session = await auth();
  const t = await getTranslations("faq");

  if (!session?.user) return <PageHeader title={t("pageTitle")} />;

  // Role-filtered HERE, server-side, before anything is sent to the client
  // (PM/UIUX spec §1: "never client-hidden-only. A Sales Associate's
  // browser must never receive another role's FAQ JSON at all"). The
  // sections array passed to FaqView below is the full serialized RSC
  // payload the browser gets — a role not in it was never transmitted.
  const sections = resolveFaqSections(session.user.role, t);

  return (
    <>
      <PageHeader title={t("pageTitle")} subtitle={t("pageSubtitle")} />
      <FaqView sections={sections} />
    </>
  );
}
