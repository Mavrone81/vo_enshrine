"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { SignaturePad } from "@/app/onboard/[token]/signature-pad";
import { saveAshesAgreement, signAshesAgreement, type AshesAgreementInput } from "@/server/agreements/actions";
import type { AshesPet } from "@/lib/pdf/ashes-agreement";

type F = Omit<AshesAgreementInput, "pets"> & { pets: AshesPet[] };

/**
 * Application-details form + in-person signing (consolidated menu, Sep 2026).
 * Save keeps a Draft the associate can revisit; once details are saved the
 * client signs on this device, which renders the final agreement PDF into the
 * sale's docket.
 */
export function AshesAgreementForm({
  submissionId,
  isInstalment,
  signed,
  readOnly = false,
  agreementPdfKey,
  initial,
}: {
  submissionId: string;
  isInstalment: boolean;
  signed: boolean;
  // The sale was rejected — terminal, checked ahead of `signed` below: a
  // rejected sale's agreement renders read-only regardless of whether it was
  // ever signed. No inputs/buttons are rendered at all (same "replace the
  // form with a message card" pattern `signed` already uses), which is what
  // satisfies "all edit/sign/submit controls disabled" — there's nothing to
  // re-enable, there's nothing rendered. The server actions refuse the writes
  // independently (saveAshesAgreement/signAshesAgreement's own
  // isAgreementEditableStatus gate) — this is belt, not suspenders.
  readOnly?: boolean;
  agreementPdfKey: string | null;
  initial: F;
}) {
  const router = useRouter();
  const t = useTranslations("agreements");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [savedOnce, setSavedOnce] = useState(signed || !!agreementPdfKey || !!initial.applicant1Nric || initial.pets.some((p) => p.name));
  const [signature, setSignature] = useState<string | null>(null);
  const [f, setF] = useState<F>(initial);
  const set = (patch: Partial<F>) => setF((p) => ({ ...p, ...patch }));
  const setPet = (i: number, patch: Partial<AshesPet>) =>
    setF((p) => ({ ...p, pets: p.pets.map((pet, j) => (j === i ? { ...pet, ...patch } : pet)) }));

  function save(after?: () => void) {
    setError(undefined);
    start(async () => {
      const r = await saveAshesAgreement(submissionId, f);
      if (r.ok) {
        setSavedOnce(true);
        router.refresh();
        after?.();
      } else setError(r.error);
    });
  }

  function sign() {
    if (!signature) return;
    setError(undefined);
    start(async () => {
      const saved = await saveAshesAgreement(submissionId, f);
      if (!saved.ok) { setError(saved.error); return; }
      const r = await signAshesAgreement(submissionId, signature);
      if (r.ok) router.refresh();
      else setError(r.error);
    });
  }

  if (readOnly) {
    return (
      <Card className="p-6">
        <h3 className="font-display text-[17px] text-muted">{t("form.rejectedTitle")}</h3>
        <p className="mt-1.5 text-[13px] text-muted">{t("form.rejectedBody")}</p>
        {agreementPdfKey && (
          <a href={`/api/files/${agreementPdfKey}`} target="_blank" rel="noopener"
            className="mt-3 inline-block text-[13px] text-action hover:underline">
            {t("form.viewPdf")}
          </a>
        )}
      </Card>
    );
  }

  if (signed) {
    return (
      <Card className="p-6">
        <h3 className="font-display text-[17px] text-ink">{t("form.signedTitle")}</h3>
        <p className="mt-1.5 text-[13px] text-muted">{t("form.signedBody")}</p>
        {agreementPdfKey && (
          <a href={`/api/files/${agreementPdfKey}`} target="_blank" rel="noopener"
            className="mt-3 inline-block text-[13px] text-action hover:underline">
            {t("form.viewPdf")}
          </a>
        )}
      </Card>
    );
  }

  const inputCls = "h-9";

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <h3 className="mb-3 font-display text-[16px] text-ink">{t("form.nicheHeading")}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="ssl">{t("form.storageSpace")}</Label>
            <Input id="ssl" className={inputCls} value={f.storageSpaceLocation ?? ""} onChange={(e) => set({ storageSpaceLocation: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="nu">{t("form.nicheUnit")}</Label>
            <Input id="nu" className={inputCls} value={f.nicheUnit ?? ""} onChange={(e) => set({ nicheUnit: e.target.value })} />
          </div>
        </div>
        {isInstalment && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="dom">{t("form.instalmentDay")}</Label>
              <Input id="dom" className={inputCls} type="number" min={1} max={28} value={f.instalmentDayOfMonth ?? 1}
                onChange={(e) => set({ instalmentDayOfMonth: Number(e.target.value) || 1 })} />
            </div>
          </div>
        )}
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="msy">{t("form.maintenanceYear")}</Label>
            <Input id="msy" className={inputCls} type="number" value={f.maintenanceStartYear ?? ""}
              onChange={(e) => set({ maintenanceStartYear: Number(e.target.value) || undefined })} />
          </div>
          <div>
            <Label htmlFor="at">{t("form.additionalTerms")}</Label>
            <Input id="at" className={inputCls} value={f.additionalTerms ?? ""} onChange={(e) => set({ additionalTerms: e.target.value })} />
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-display text-[16px] text-ink">{t("form.petsHeading")}</h3>
          {f.pets.length < 10 && (
            <Button size="sm" variant="secondary" onClick={() => set({ pets: [...f.pets, {}] })}>
              <Plus className="mr-1 h-3.5 w-3.5" /> {t("form.addPet")}
            </Button>
          )}
        </div>
        <div className="space-y-3">
          {f.pets.map((p, i) => (
            <div key={i} className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[2fr_2fr_1fr_1.3fr_1.3fr_auto]">
              <div>
                <Label>{t("form.petName")}</Label>
                <Input className={inputCls} value={p.name ?? ""} onChange={(e) => setPet(i, { name: e.target.value })} />
              </div>
              <div>
                <Label>{t("form.petBreed")}</Label>
                <Input className={inputCls} value={p.breed ?? ""} onChange={(e) => setPet(i, { breed: e.target.value })} />
              </div>
              <div>
                <Label>{t("form.petGender")}</Label>
                <Input className={inputCls} value={p.gender ?? ""} onChange={(e) => setPet(i, { gender: e.target.value })} />
              </div>
              <div>
                <Label>{t("form.petDob")}</Label>
                <Input className={inputCls} type="date" value={p.dob ?? ""} onChange={(e) => setPet(i, { dob: e.target.value })} />
              </div>
              <div>
                <Label>{t("form.petDismissed")}</Label>
                <Input className={inputCls} type="date" value={p.dateDismissed ?? ""} onChange={(e) => setPet(i, { dateDismissed: e.target.value })} />
              </div>
              <button type="button" aria-label={t("form.removePet")} disabled={f.pets.length === 1}
                onClick={() => set({ pets: f.pets.filter((_, j) => j !== i) })}
                className="mb-1 rounded-md p-2 text-muted hover:bg-paper-100 hover:text-danger disabled:opacity-30">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      </Card>

      {[1, 2].map((n) => (
        <Card key={n} className="p-5">
          <h3 className="mb-3 font-display text-[16px] text-ink">
            {n === 1 ? t("form.applicant1Heading") : t("form.applicant2Heading")}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>{t("form.name")}</Label>
              <Input className={inputCls} value={(n === 1 ? f.applicant1Name : f.applicant2Name) ?? ""}
                onChange={(e) => set(n === 1 ? { applicant1Name: e.target.value } : { applicant2Name: e.target.value })} />
            </div>
            <div>
              <Label>{t("form.nric")}</Label>
              <Input className={inputCls} value={(n === 1 ? f.applicant1Nric : f.applicant2Nric) ?? ""}
                onChange={(e) => set(n === 1 ? { applicant1Nric: e.target.value } : { applicant2Nric: e.target.value })} />
            </div>
          </div>
          <div className="mt-4">
            <Label>{t("form.address")}</Label>
            <Input className={inputCls} value={(n === 1 ? f.applicant1Address : f.applicant2Address) ?? ""}
              onChange={(e) => set(n === 1 ? { applicant1Address: e.target.value } : { applicant2Address: e.target.value })} />
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <Label>{t("form.contact")}</Label>
              <Input className={inputCls} value={(n === 1 ? f.applicant1Contact : f.applicant2Contact) ?? ""}
                onChange={(e) => set(n === 1 ? { applicant1Contact: e.target.value } : { applicant2Contact: e.target.value })} />
            </div>
            <div>
              <Label>{t("form.email")}</Label>
              <Input className={inputCls} value={(n === 1 ? f.applicant1Email : f.applicant2Email) ?? ""}
                onChange={(e) => set(n === 1 ? { applicant1Email: e.target.value } : { applicant2Email: e.target.value })} />
            </div>
          </div>
        </Card>
      ))}

      <Card className="p-5">
        <h3 className="mb-3 font-display text-[16px] text-ink">{t("form.witnessHeading")}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label>{t("form.applicantWitnessName")}</Label>
            <Input className={inputCls} value={f.applicantWitnessName ?? ""} onChange={(e) => set({ applicantWitnessName: e.target.value })} />
          </div>
          <div>
            <Label>{t("form.applicantWitnessNric")}</Label>
            <Input className={inputCls} value={f.applicantWitnessNric ?? ""} onChange={(e) => set({ applicantWitnessNric: e.target.value })} />
          </div>
          <div>
            <Label>{t("form.companyWitnessName")}</Label>
            <Input className={inputCls} value={f.companyWitnessName ?? ""} onChange={(e) => set({ companyWitnessName: e.target.value })} />
          </div>
          <div>
            <Label>{t("form.companyWitnessNric")}</Label>
            <Input className={inputCls} value={f.companyWitnessNric ?? ""} onChange={(e) => set({ companyWitnessNric: e.target.value })} />
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="mb-1 font-display text-[16px] text-ink">{t("form.signHeading")}</h3>
        <p className="mb-3 text-[12.5px] text-muted">{t("form.signHint")}</p>
        <SignaturePad onChange={setSignature} />
        {error && <p className="mt-3 rounded-lg bg-danger-50 px-3 py-2 text-[13px] text-danger">{error}</p>}
        <div className="mt-4 flex gap-3">
          <Button variant="secondary" disabled={pending || !f.applicant1Name?.trim()} onClick={() => save()}>
            {pending ? "…" : t("form.saveDraft")}
          </Button>
          <Button disabled={pending || !signature || !f.applicant1Name?.trim()} onClick={sign}>
            {pending ? "…" : t("form.signAndFinalize")}
          </Button>
        </div>
        {savedOnce && !signed && <p className="mt-2 text-[12px] text-muted-2">{t("form.draftNote")}</p>}
      </Card>
    </div>
  );
}
