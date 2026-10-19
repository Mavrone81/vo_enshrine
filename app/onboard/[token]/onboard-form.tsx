"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { submitOnboarding, homeAddressWouldTruncate, type OnboardingSubmission } from "@/server/recruitment/actions";
import { findInvalidOnboardingFields, ONBOARDING_FIELD_DOM_ID as FIELD_DOM_ID, ONBOARDING_REQUIRED_ERROR_CODE, type OnboardingField } from "@/lib/onboarding-fields";
import { commencementDateBounds } from "@/lib/commencement-date";
import type { OnboardingPrefill } from "@/lib/onboarding-prefill";
import { SignaturePad } from "./signature-pad";

// Debounce + blur pair keeps calls to the rate-limited (10/15min)
// homeAddressWouldTruncate check well under its limit in normal use — see
// reviews/homeaddress-warning-copy-2026-10-01.md §2.
const ADDRESS_FIT_DEBOUNCE_MS = 550;

// Stored (and printed on the agreement) as the English value; shown localised.
const RELIGIONS = [
  "Buddhism", "Taoism", "Christianity", "Catholicism", "Islam", "Hinduism", "Sikhism", "Free Thinker", "Others",
] as const;

const selectCls =
  "h-11 w-full rounded-lg border border-line bg-white px-3 text-sm text-ink focus:border-action focus:outline-none";

// Applied to a field that failed the required-field check. Same tokens as
// components/ui/banner.tsx's danger tone; the trailing `!` is Tailwind's
// important modifier, needed because Input/selectCls already set border-line and
// bg-white on the same element and class order does not decide which wins.
const invalidCls = "border-danger/40! bg-danger/5!";

export function OnboardForm({ token, alreadySubmitted, prefill }: { token: string; alreadySubmitted: boolean; prefill: OnboardingPrefill }) {
  const t = useTranslations("onboarding");
  const te = useTranslations("errors");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  // The acceptance box only unlocks once the full agreement has been opened
  // or downloaded — "I have read the full agreement" should be at least
  // possible to be true when it's ticked.
  const [opened, setOpened] = useState(false);
  const agreementUrl = `/onboard/${encodeURIComponent(token)}/agreement`;
  const dateBounds = commencementDateBounds();
  // Resubmitting before approval keeps earlier answers (owner ruling
  // 2026-10-17): every field below comes from the server's own prefill
  // (lib/onboarding-prefill.ts), which already masks nric/bankAccountNumber
  // (e.g. "S•••••00A") rather than ever sending the real value. photo,
  // signature and agreementAccepted are deliberately NEVER prefilled — a
  // signature is an act, re-drawn and re-accepted on every submission.
  const [f, setF] = useState<OnboardingSubmission>({
    fullName: prefill.fullName ?? "",
    commencementDate: prefill.commencementDate ?? "",
    businessName: prefill.businessName ?? undefined,
    nric: prefill.nric ?? "",
    dateOfBirth: prefill.dateOfBirth ?? undefined,
    residentialAddress: prefill.residentialAddress ?? undefined,
    emergencyContactName: prefill.emergencyContactName ?? undefined,
    emergencyContactNumber: prefill.emergencyContactNumber ?? undefined,
    emergencyContactRelationship: prefill.emergencyContactRelationship ?? undefined,
    emergencyContactAddress: prefill.emergencyContactAddress ?? undefined,
    paymentMethod: prefill.paymentMethod ?? "PayNow",
    paynowNumber: prefill.paynowNumber ?? undefined,
    bankName: prefill.bankName ?? undefined,
    bankAccountNumber: prefill.bankAccountNumber ?? undefined,
    agreementAccepted: false,
    maritalStatus: prefill.maritalStatus ?? undefined,
    nationality: prefill.nationality ?? undefined,
    gender: prefill.gender ?? undefined,
    religion: prefill.religion ?? undefined,
    spouseConflict: prefill.spouseConflict ?? undefined,
    spouseName: prefill.spouseName ?? undefined,
    spouseCompany: prefill.spouseCompany ?? undefined,
    spouseDesignation: prefill.spouseDesignation ?? undefined,
  });
  // Set by the first failed submit. From then on the invalid set is recomputed
  // from the live values on every render, so a field's highlight clears the
  // moment it is fixed.
  const [attempted, setAttempted] = useState(false);
  const invalid = new Set<OnboardingField>(attempted ? findInvalidOnboardingFields(f).invalid : []);
  const cls = (field: OnboardingField, base = "") => `${base} ${invalid.has(field) ? invalidCls : ""}`.trim();
  const a11y = (field: OnboardingField) => (invalid.has(field)
    ? { "aria-invalid": true as const, "aria-describedby": `${FIELD_DOM_ID[field]}-error` }
    : {});
  // The message AT the field.
  const fieldError = (field: OnboardingField) => invalid.has(field) && (
    <p id={`${FIELD_DOM_ID[field]}-error`} role="alert" className="mt-1 text-[12px] text-danger">
      {te(ONBOARDING_REQUIRED_ERROR_CODE[field])}
    </p>
  );
  const set = (patch: Partial<OnboardingSubmission>) => setF((p) => ({ ...p, ...patch }));

  const [addressFitWarning, setAddressFitWarning] = useState(false);
  // Synchronous (unlike React state) so the in-flight check below can tell,
  // the moment its response arrives, whether the field has moved on since —
  // a stale "would truncate" answer must never apply to a newer value.
  const latestAddressRef = useRef("");
  const addressCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (addressCheckTimer.current) clearTimeout(addressCheckTimer.current); }, []);
  function checkAddressFit() {
    const value = latestAddressRef.current;
    const trimmed = value.trim();
    if (!trimmed) { setAddressFitWarning(false); return; } // matches wouldTruncate's own empty-string behaviour — no call needed
    homeAddressWouldTruncate(token, trimmed)
      .then((truncates) => {
        if (latestAddressRef.current !== value) return; // the field moved on; this answer is stale
        setAddressFitWarning(truncates);
      })
      .catch(() => {}); // advisory only — a failed check must never break the form
  }
  const religionLabel: Record<(typeof RELIGIONS)[number], string> = {
    Buddhism: t("details.religionBuddhism"),
    Taoism: t("details.religionTaoism"),
    Christianity: t("details.religionChristianity"),
    Catholicism: t("details.religionCatholicism"),
    Islam: t("details.religionIslam"),
    Hinduism: t("details.religionHinduism"),
    Sikhism: t("details.religionSikhism"),
    "Free Thinker": t("details.religionFreeThinker"),
    Others: t("details.religionOthers"),
  };

  function focusField(field: OnboardingField) {
    let id = FIELD_DOM_ID[field];
    if (field === "agreementAccepted" && !opened) id = "agreementView";
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.focus({ preventScroll: true });
  }

  function submit() {
    setError(undefined);
    // Every required field is checked here (the server enforces the same set).
    // Nationality, gender and religion are printed on the Associate Agreement's
    // particulars table. On failure: highlight every invalid field, then scroll
    // to and focus the first one in document order.
    const check = findInvalidOnboardingFields(f);
    if (check.first) {
      setAttempted(true);
      setError(t("errors.fixHighlighted"));
      focusField(check.first);
      return;
    }
    start(async () => {
      const r = await submitOnboarding(token, f);
      if (r.ok) setDone(true);
      else setError(r.error ?? t("errors.submitFailed"));
    });
  }

  if (done) {
    return (
      <div className="rounded-xl border border-line bg-white p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-success-50 text-2xl text-success">✓</div>
        <h2 className="font-display text-[20px] text-ink">{t("success.title")}</h2>
        <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-muted">
          {t("success.body")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {alreadySubmitted && (
        <div className="rounded-lg bg-action-50 px-4 py-3 text-[13px] text-action">
          {t("resubmitBanner")}
        </div>
      )}

      <div className="rounded-xl border border-line bg-white p-5">
        <h2 className="mb-4 font-display text-[16px] text-ink">{t("details.title")}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="fullName">{t("details.fullName")}</Label>
            <Input id="fullName" value={f.fullName} onChange={(e) => set({ fullName: e.target.value })}
              placeholder={t("details.fullNamePlaceholder")}
              className={cls("fullName")} {...a11y("fullName")} />
            {fieldError("fullName")}
          </div>
          <div>
            <Label htmlFor="commencementDate">{t("details.commencementDate")}</Label>
            <Input id="commencementDate" type="date" min={dateBounds.min} max={dateBounds.max}
              value={f.commencementDate} onChange={(e) => set({ commencementDate: e.target.value })}
              className={cls("commencementDate")} {...a11y("commencementDate")} />
            <p className="mt-1 text-[12px] text-muted-2">{t("details.commencementDateHint")}</p>
            {fieldError("commencementDate")}
          </div>
          <div>
            <Label htmlFor="bn">{t("details.businessName")}</Label>
            <Input id="bn" value={f.businessName ?? ""} onChange={(e) => set({ businessName: e.target.value })} placeholder={t("details.businessNamePlaceholder")} />
          </div>
          <div>
            <Label htmlFor="nric">{t("details.nric")}</Label>
            <Input id="nric" value={f.nric} onChange={(e) => set({ nric: e.target.value })} placeholder="SxxxxxxxA"
              className={cls("nric")} {...a11y("nric")} />
            {fieldError("nric")}
          </div>
          <div>
            <Label htmlFor="dob">{t("details.dob")}</Label>
            <Input id="dob" type="date" value={f.dateOfBirth ?? ""} onChange={(e) => set({ dateOfBirth: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="marital">{t("details.maritalStatus")}</Label>
            <select
              id="marital"
              className={selectCls}
              value={f.maritalStatus ?? ""}
              onChange={(e) => set({ maritalStatus: (e.target.value || undefined) as OnboardingSubmission["maritalStatus"] })}
            >
              <option value="">—</option>
              <option value="Single">{t("details.single")}</option>
              <option value="Married">{t("details.married")}</option>
              <option value="Divorced">{t("details.divorced")}</option>
              <option value="Widowed">{t("details.widowed")}</option>
            </select>
          </div>
          <div>
            <Label htmlFor="nationality">{t("details.nationality")}</Label>
            <Input id="nationality" value={f.nationality ?? ""} onChange={(e) => set({ nationality: e.target.value })}
              placeholder={t("details.nationalityPlaceholder")} className={cls("nationality")} {...a11y("nationality")}
              // `required` is inert here: there is no <form> element (submit is a
              // Button onClick), so native validation never fires. The real guard
              // is findInvalidOnboardingFields() in submit(), plus the server.
              required />
            {fieldError("nationality")}
          </div>
          <div>
            <Label htmlFor="gender">{t("details.gender")}</Label>
            {/* `required` is inert — no <form> element; see the note on nationality. */}
            <select id="gender" className={cls("gender", selectCls)} {...a11y("gender")} required value={f.gender ?? ""}
              onChange={(e) => set({ gender: (e.target.value || undefined) as OnboardingSubmission["gender"] })}>
              <option value="">—</option>
              <option value="Male">{t("details.male")}</option>
              <option value="Female">{t("details.female")}</option>
            </select>
            {fieldError("gender")}
          </div>
          <div>
            <Label htmlFor="religion">{t("details.religion")}</Label>
            {/* `required` is inert — no <form> element; see the note on nationality. */}
            <select id="religion" className={cls("religion", selectCls)} {...a11y("religion")} required value={f.religion ?? ""}
              onChange={(e) => set({ religion: e.target.value || undefined })}>
              <option value="">—</option>
              {RELIGIONS.map((r) => <option key={r} value={r}>{religionLabel[r]}</option>)}
            </select>
            {fieldError("religion")}
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="addr">{t("details.address")}</Label>
            <Input
              id="addr"
              value={f.residentialAddress ?? ""}
              aria-describedby={addressFitWarning ? "addr-fit-warning" : undefined}
              onChange={(e) => {
                const value = e.target.value;
                set({ residentialAddress: value });
                latestAddressRef.current = value;
                setAddressFitWarning(false); // stale the moment the value changes — the next debounce/blur decides afresh
                if (addressCheckTimer.current) clearTimeout(addressCheckTimer.current);
                addressCheckTimer.current = setTimeout(checkAddressFit, ADDRESS_FIT_DEBOUNCE_MS);
              }}
              onBlur={() => {
                if (addressCheckTimer.current) { clearTimeout(addressCheckTimer.current); addressCheckTimer.current = null; }
                checkAddressFit();
              }}
            />
            {addressFitWarning && (
              <p
                id="addr-fit-warning"
                role="status"
                aria-live="polite"
                className="mt-1 rounded-md bg-gold/10 px-2.5 py-1.5 text-[12px] leading-snug text-gold"
              >
                {t("details.addressFitWarning")}
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="ecn">{t("details.ecName")}</Label>
            <Input id="ecn" value={f.emergencyContactName ?? ""} onChange={(e) => set({ emergencyContactName: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="ecp">{t("details.ecNumber")}</Label>
            <Input id="ecp" value={f.emergencyContactNumber ?? ""} onChange={(e) => set({ emergencyContactNumber: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="ecr">{t("details.ecRelationship")}</Label>
            <Input id="ecr" value={f.emergencyContactRelationship ?? ""} onChange={(e) => set({ emergencyContactRelationship: e.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="eca">{t("details.ecAddress")}</Label>
            <Input id="eca" value={f.emergencyContactAddress ?? ""} onChange={(e) => set({ emergencyContactAddress: e.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="spouseConflict">{t("details.spouseConflict")}</Label>
            <select
              id="spouseConflict"
              className={cls("spouseConflict", selectCls)}
              {...a11y("spouseConflict")}
              // `required` is inert — no <form> element; see the note on nationality.
              required
              // C-2: this is now a required field — the old `? "yes" : "no"`
              // coercion couldn't represent "not yet answered" at all (it
              // silently displayed "No" before the applicant had touched it),
              // which would have let someone submit convinced they'd answered
              // when the stored value was still undefined. Mirrors the
              // gender/religion selects' own "" placeholder pattern above.
              value={f.spouseConflict === undefined ? "" : f.spouseConflict ? "yes" : "no"}
              onChange={(e) => set({ spouseConflict: e.target.value === "" ? undefined : e.target.value === "yes" })}
            >
              <option value="">—</option>
              <option value="no">{t("details.conflictNo")}</option>
              <option value="yes">{t("details.conflictYes")}</option>
            </select>
            <p className="mt-1 text-[12px] text-muted-2">{t("details.spouseConflictHint")}</p>
            {fieldError("spouseConflict")}
          </div>
          {f.spouseConflict && (
            <>
              <div>
                <Label htmlFor="spouseName">{t("details.spouseName")}</Label>
                <Input id="spouseName" value={f.spouseName ?? ""} onChange={(e) => set({ spouseName: e.target.value })}
                  className={cls("spouseName")} {...a11y("spouseName")} />
                {fieldError("spouseName")}
              </div>
              <div>
                <Label htmlFor="spouseCompany">{t("details.spouseCompany")}</Label>
                <Input id="spouseCompany" value={f.spouseCompany ?? ""} onChange={(e) => set({ spouseCompany: e.target.value })}
                  className={cls("spouseCompany")} {...a11y("spouseCompany")} />
                {fieldError("spouseCompany")}
              </div>
              <div>
                <Label htmlFor="spouseDesignation">{t("details.spouseDesignation")}</Label>
                <Input id="spouseDesignation" value={f.spouseDesignation ?? ""} onChange={(e) => set({ spouseDesignation: e.target.value })}
                  className={cls("spouseDesignation")} {...a11y("spouseDesignation")} />
                {fieldError("spouseDesignation")}
              </div>
            </>
          )}
          <div className="sm:col-span-2">
            <Label htmlFor="photo">{t("details.photo")}</Label>
            <input
              id="photo"
              type="file"
              accept="image/jpeg,image/png"
              onChange={(e) => set({ photo: e.target.files?.[0] ?? null })}
              className="block w-full text-[13px] text-body file:mr-3 file:rounded-lg file:border-0 file:bg-ink file:px-3 file:py-2 file:text-[13px] file:text-white hover:file:bg-ink-700"
            />
            <p className="mt-1 text-[12px] text-muted-2">{t("details.photoHint")}</p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-white p-5">
        <h2 className="mb-4 font-display text-[16px] text-ink">{t("payout.title")}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="pm">{t("payout.method")}</Label>
            <select id="pm" className={cls("paymentMethod", selectCls)} {...a11y("paymentMethod")} value={f.paymentMethod} onChange={(e) => set({ paymentMethod: e.target.value as OnboardingSubmission["paymentMethod"] })}>
              <option value="PayNow">PayNow</option>
              <option value="Bank Transfer">{t("payout.bankTransfer")}</option>
            </select>
            {fieldError("paymentMethod")}
          </div>
          {f.paymentMethod === "PayNow" ? (
            <div>
              <Label htmlFor="pn">{t("payout.paynowNumber")}</Label>
              <Input id="pn" value={f.paynowNumber ?? ""} onChange={(e) => set({ paynowNumber: e.target.value })} placeholder={t("payout.paynowPlaceholder")} />
            </div>
          ) : (
            <>
              <div>
                <Label htmlFor="bank">{t("payout.bankName")}</Label>
                <Input id="bank" value={f.bankName ?? ""} onChange={(e) => set({ bankName: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="acc">{t("payout.bankAccount")}</Label>
                <Input id="acc" value={f.bankAccountNumber ?? ""} onChange={(e) => set({ bankAccountNumber: e.target.value })} />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-line bg-white p-5">
        <h2 className="mb-3 font-display text-[16px] text-ink">{t("agreement.title")}</h2>
        <div className="rounded-lg border border-line bg-paper-100 p-4 text-[13px] leading-relaxed text-body">
          <p>{t("agreement.intro")}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <a id="agreementView" href={agreementUrl} target="_blank" rel="noopener" onClick={() => setOpened(true)}
              className="inline-flex h-10 items-center rounded-lg bg-ink px-4 text-[13px] font-medium text-white hover:opacity-90">
              {t("agreement.view")}
            </a>
            <a href={`${agreementUrl}?download=1`} onClick={() => setOpened(true)}
              className="inline-flex h-10 items-center rounded-lg border border-line bg-white px-4 text-[13px] font-medium text-ink hover:bg-paper-100">
              {t("agreement.download")}
            </a>
          </div>
          <p className="mt-3 text-[12px] text-muted">{t("agreement.dataNote")}</p>
        </div>
        <label className={`mt-4 flex items-start gap-2.5 text-[13px] ${opened ? "text-body" : "text-muted-2"} ${invalid.has("agreementAccepted") ? "text-danger" : ""}`}>
          <input id="agreementAccepted" type="checkbox" className="mt-0.5" {...a11y("agreementAccepted")} disabled={!opened} checked={f.agreementAccepted}
            onChange={(e) => set({ agreementAccepted: e.target.checked })} />
          <span>{t("agreement.checkbox")}</span>
        </label>
        {!opened && <p className="mt-1 pl-6 text-[12px] text-muted-2">{t("agreement.openFirst")}</p>}
        {fieldError("agreementAccepted")}

        <div id="signature" tabIndex={-1} {...a11y("signature")}
          className={cls("signature", "mt-4 rounded-lg focus:outline-none")}>
          <Label>{t("agreement.signatureLabel")}</Label>
          <SignaturePad onChange={(dataUrl) => set({ signature: dataUrl ?? undefined })} />
          {fieldError("signature")}
          <p className="mt-1 text-[12px] text-muted-2">{t("agreement.signatureHint")}</p>
        </div>
      </div>

      {error && <p className="rounded-lg bg-danger-50 px-3 py-2 text-[13px] text-danger">{error}</p>}
      <Button onClick={submit} disabled={pending || !f.commencementDate || !f.nric || !f.agreementAccepted || !f.signature} className="w-full sm:w-auto">
        {pending ? t("submitPending") : t("submit")}
      </Button>
    </div>
  );
}
