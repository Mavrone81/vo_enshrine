"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { DocumentType, TemplateCategory } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { uploadLibraryDocument } from "@/server/documents/library-actions";
import { useTranslations } from "next-intl";

const selectCls =
  "h-11 w-full rounded-lg border border-line bg-white px-3 text-sm text-ink focus:border-action focus:outline-none";

// currentTemplates: title of the live (non-retired) template per category, so a
// replace can be confirmed by name before anything is retired.
export function DocumentForm({ currentTemplates }: { currentTemplates: Partial<Record<TemplateCategory, string>> }) {
  const t = useTranslations("documents");
  const tc = useTranslations("agreements");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [title, setTitle] = useState("");
  const [type, setType] = useState<DocumentType>("CompanyTemplate");
  const [assignment, setAssignment] = useState<"All" | "Team" | "Associate">("All");
  const [team, setTeam] = useState("");
  const [code, setCode] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<TemplateCategory | "">("");
  const [confirming, setConfirming] = useState(false);

  const CATEGORIES: { v: TemplateCategory; label: string }[] = [
    { v: "PetsAfterlife", label: tc("docTemplate.cat.pets") },
    { v: "HumanAfterlife", label: tc("docTemplate.cat.human") },
  ];

  const TYPES: { v: DocumentType; label: string }[] = [
    { v: "CompanyTemplate", label: t("form.typeCompanyTemplate") },
    { v: "AssociateAgreement", label: t("form.typeAssociateAgreement") },
    { v: "VendorAgreement", label: t("form.typeVendorAgreement") },
    { v: "VendorMOU", label: t("form.typeVendorMOU") },
    { v: "SalesAgreement", label: t("form.typeSalesAgreement") },
    { v: "Other", label: t("form.typeOther") },
  ];

  function upload(confirmedReplace: boolean) {
    setError(undefined);
    if (!file) { setError(t("form.errorNoFile")); return; }
    // Reject oversized files in the browser with a clear message. Without this,
    // a file over the limit is rejected by the proxy mid-upload and surfaces as
    // a generic server-error page instead of a readable reason. 150 MB mirrors
    // the server cap (server/documents/{actions,template-actions}.ts MAX_BYTES).
    if (file.size > 150_000_000) { setError(t("form.errorTooLarge")); return; }
    start(async () => {
      // A category template takes no audience: it is always shared with everyone.
      const r = category
        ? await uploadLibraryDocument({ category, title, file, confirmedReplace })
        : await uploadLibraryDocument({ category: null, title, type, assignment, assignedTeam: team, assignedAssociateCode: code, file });
      setConfirming(false);
      if (r.ok) { setTitle(""); setTeam(""); setCode(""); setFile(null); router.refresh(); }
      else setError(r.error ?? t("form.errorDefault"));
    });
  }

  function submit() {
    // Uploading into a category retires its current template — ask first.
    if (category && currentTemplates[category]) { setError(undefined); setConfirming(true); return; }
    upload(false);
  }

  return (
    <Card className="p-5">
      <h2 className="mb-4 font-display text-[17px] text-ink">{t("form.heading")}</h2>
      <div className="space-y-4">
        <div>
          <Label htmlFor="t">{t("form.titleLabel")}</Label>
          <Input id="t" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Sales agreement template" />
        </div>
        <div>
          <Label htmlFor="cat">{t("form.categoryLabel")}</Label>
          <select id="cat" className={selectCls} value={category} onChange={(e) => { setCategory(e.target.value as TemplateCategory | ""); setConfirming(false); }}>
            <option value="">{t("form.categoryNone")}</option>
            {CATEGORIES.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
          </select>
          {category && <p className="mt-1 text-[12px] text-muted-2">{t("form.categoryHint")}</p>}
        </div>
        {!category && <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="ty">{t("form.typeLabel")}</Label>
            <select id="ty" className={selectCls} value={type} onChange={(e) => setType(e.target.value as DocumentType)}>
              {TYPES.map((tp) => <option key={tp.v} value={tp.v}>{tp.label}</option>)}
            </select>
          </div>
          <div>
            <Label htmlFor="as">{t("form.sharedWithLabel")}</Label>
            <select id="as" className={selectCls} value={assignment} onChange={(e) => setAssignment(e.target.value as "All" | "Team" | "Associate")}>
              <option value="All">{t("form.assignAll")}</option>
              <option value="Team">{t("form.assignTeam")}</option>
              <option value="Associate">{t("form.assignAssociate")}</option>
            </select>
          </div>
          {assignment === "Team" && (
            <div>
              <Label htmlFor="tm">{t("form.teamNameLabel")}</Label>
              <Input id="tm" value={team} onChange={(e) => setTeam(e.target.value)} />
            </div>
          )}
          {assignment === "Associate" && (
            <div>
              <Label htmlFor="ac">{t("form.associateCodeLabel")}</Label>
              <Input id="ac" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="EN0001" />
            </div>
          )}
        </div>}
        <div>
          <Label htmlFor="f">{t("form.fileLabel")}</Label>
          <input id="f" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-[13px] text-body file:mr-3 file:rounded-lg file:border-0 file:bg-ink file:px-3 file:py-2 file:text-[13px] file:text-white hover:file:bg-ink-700" />
          <p className="mt-1 text-[12px] text-muted-2">{category ? t("form.fileHintCategory") : t("form.fileHint")}</p>
        </div>
        {error && <p className="rounded-lg bg-danger-50 px-3 py-2 text-[13px] text-danger">{error}</p>}
        {confirming && category ? (
          <div className="space-y-3 rounded-lg border border-line bg-paper-50 px-3 py-3 text-[13px] text-ink">
            <p>{t("form.confirmReplace", { category: CATEGORIES.find((c) => c.v === category)!.label, title: currentTemplates[category] ?? "" })}</p>
            <div className="flex gap-2">
              <Button onClick={() => upload(true)} disabled={pending}>{pending ? t("form.submitting") : t("form.confirmYes")}</Button>
              <Button variant="secondary" onClick={() => setConfirming(false)} disabled={pending}>{t("form.confirmCancel")}</Button>
            </div>
          </div>
        ) : (
          <Button onClick={submit} disabled={pending || !title || !file}>{pending ? t("form.submitting") : t("form.submit")}</Button>
        )}
      </div>
    </Card>
  );
}
