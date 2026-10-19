"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import type { FaqSection } from "@/lib/faq-content";

/**
 * Accordion + search for the FAQ tab (PM/UIUX spec §1: accordion,
 * searchable, phone-friendly). `sections` is already role-filtered and
 * fully translated server-side (see app/{admin,portal}/faq/page.tsx) — this
 * component never knows which roles exist or which one the viewer is; it
 * only ever renders the sections it was given, so a role this session isn't
 * allowed to see was never serialized to the client at all, not merely
 * hidden by this component choosing not to render it.
 */
export function FaqView({ sections }: { sections: FaqSection[] }) {
  const t = useTranslations("faq");
  const [query, setQuery] = useState("");
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;

  const filtered = sections
    .map((section) => ({
      ...section,
      items: searching
        ? section.items.filter(
            (item) => item.question.toLowerCase().includes(q) || item.answer.toLowerCase().includes(q),
          )
        : section.items,
    }))
    .filter((section) => section.items.length > 0);

  function toggle(id: string, open: boolean) {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      {sections.length > 1 && (
        <p className="rounded-lg bg-action-50 px-4 py-3 text-[13px] text-action">{t("adminAllRolesNote")}</p>
      )}

      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("searchPlaceholder")}
        aria-label={t("searchPlaceholder")}
      />

      {filtered.length === 0 && (
        <Card className="px-5 py-12 text-center text-[13px] text-muted">{t("noResults", { query })}</Card>
      )}

      {filtered.map((section) => (
        <div key={section.role} className="space-y-2">
          <h2 className="font-display text-[16px] text-ink">{section.roleLabel}</h2>
          <Card className="divide-y divide-line-200 overflow-hidden">
            {section.items.map((item) => (
              <details
                key={item.id}
                // Forced open while a search is active — hiding a matched
                // answer from someone who just searched for it would defeat
                // the point of searching. Manual toggling (below) applies
                // only once the search is cleared.
                open={searching || openIds.has(item.id)}
                onToggle={(e) => toggle(item.id, e.currentTarget.open)}
                className="group px-5 py-4"
              >
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-[14px] font-medium text-ink marker:content-none">
                  <span>{item.question}</span>
                  <span aria-hidden className="shrink-0 text-muted-2 transition-transform group-open:rotate-180">⌄</span>
                </summary>
                <p className="mt-2 text-[13px] leading-relaxed text-body">{item.answer}</p>
              </details>
            ))}
          </Card>
        </div>
      ))}
    </div>
  );
}
