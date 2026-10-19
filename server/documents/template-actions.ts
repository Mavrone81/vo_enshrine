"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { Prisma, TemplateCategory } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isAdminRole } from "@/lib/rbac";
import { auditTx } from "@/lib/audit";
import { putObject, deleteObject } from "@/lib/storage";
import { assertUpload } from "@/lib/file-type";

async function requireAdmin() {
  const session = await auth();
  if (!session || !isAdminRole(session.user.role)) return null;
  return session;
}

const MAX_BYTES = 150_000_000; // same cap as the generic document upload (server/documents/actions.ts)
const EXT_FOR_KIND: Record<"pdf" | "png" | "jpeg", string> = { pdf: "pdf", png: "png", jpeg: "jpg" };

export type DocTemplateUpload = { category: TemplateCategory; title: string; file: File };
export type DocTemplateUploadResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Admin upload for a Doc Template category (B-5, Option 1). Always does
 * "retire the current one (if any), then insert the new one", in the same
 * transaction — there is no separate "first upload" vs "replace" action, since
 * the behaviour is identical either way (retiring a non-existent current row
 * is simply skipped).
 *
 * The retire step is NOT a compare-and-set. The guarantee that exactly one
 * non-retired row per category can ever exist is the partial unique index in
 * migration.sql (20261002090000_b5_doc_template_category) alone: a losing
 * concurrent call's insert hits that index, throws P2002, and its WHOLE
 * transaction — including its retire of the row it read as "current" — rolls
 * back with it.
 *
 * Mutation result (2026-10-02, re-run and recorded here directly, not cited
 * to a separate doc): BASELINE — this file as shipped (no CAS), the 3 tests
 * in template-actions.integration.test.ts pass, 3/3, 3 runs. MUTATED — the
 * retire `update` changed to `updateMany({ where: { id, retiredAt: null } })`
 * and a count-!==-1 miss made to throw a P2002 (the SAME error the real
 * unique-index violation produces, so the comparison is apples-to-apples
 * rather than comparing two different failure contracts): same 3 tests,
 * still 3/3, 3 runs — IDENTICAL outcome to baseline. RESTORED to baseline
 * (this file) immediately after; re-confirmed 3/3 once more. Conclusion: the
 * CAS is redundant given the index plus single-transaction atomicity, so it
 * was not added — a second guard here would be one nobody could tell was
 * load-bearing. (The index's own necessity is proved separately: dropping it
 * on the test DB, reverted after, makes the same test fail with exactly the
 * predicted defect — two live rows for one category, not an abstract error.)
 */
export async function uploadDocTemplate(input: DocTemplateUpload): Promise<DocTemplateUploadResult> {
  const session = await requireAdmin();
  const t = await getTranslations("docTemplateAdmin");
  if (!session) return { ok: false, error: t("form.errorForbidden") };

  const title = input.title.trim();
  if (!title) return { ok: false, error: t("form.errorNoTitle") };
  if (!input.file || input.file.size === 0) return { ok: false, error: t("form.errorNoFile") };
  if (input.file.size > MAX_BYTES) return { ok: false, error: t("form.errorFileTooLarge") };

  const bytes = Buffer.from(await input.file.arrayBuffer());
  let kind: "pdf" | "png" | "jpeg";
  try {
    // D2: the storage key's extension comes from the SNIFFED type, never the
    // uploaded filename's extension — a file can't be stored as one type and
    // served as another.
    kind = assertUpload(bytes, ["pdf", "png", "jpeg"]);
  } catch {
    return { ok: false, error: t("form.errorInvalidFileType") };
  }

  const newId = randomUUID();
  const key = `documents/${newId}.${EXT_FOR_KIND[kind]}`;
  await putObject(key, bytes);

  let createdId: string;
  try {
    createdId = await prisma.$transaction(async (tx) => {
      const current = await tx.document.findFirst({
        where: { category: input.category, retiredAt: null },
      });

      if (current) {
        await tx.document.update({
          where: { id: current.id },
          data: { retiredAt: new Date(), supersededById: newId },
        });
      }

      const doc = await tx.document.create({
        data: {
          id: newId,
          type: "CompanyTemplate",
          title,
          fileKey: key,
          category: input.category,
          // Copies the current row's assignment/visibility so a replace never
          // widens who can see the template — a bare default would do that.
          assignment: current?.assignment ?? "All",
          assignedTeam: current?.assignedTeam ?? null,
          assignedAssociateId: current?.assignedAssociateId ?? null,
          visibility: current?.visibility ?? "All",
          uploadedById: session.user.id,
        },
      });

      await auditTx(tx, {
        action: current ? "document.template_replaced" : "document.template_uploaded",
        entityType: "Document",
        entityId: doc.id,
        before: current ? { id: current.id, fileKey: current.fileKey } : undefined,
        after: { id: doc.id, category: input.category, fileKey: key },
        actorUserId: session.user.id,
      });

      return doc.id;
    });
  } catch (e) {
    // The transaction did not commit — never leak the file this call wrote.
    await deleteObject(key);
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: t("form.errorConflict") };
    }
    throw e;
  }

  revalidatePath("/admin/documents");
  revalidatePath("/portal/agreements");
  return { ok: true, id: createdId };
}
