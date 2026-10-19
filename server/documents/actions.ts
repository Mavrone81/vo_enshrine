"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { Prisma, DocumentType, DocumentAssignment } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isAdminRole } from "@/lib/rbac";
import { logAudit } from "@/lib/audit";
import { putObject, deleteObject } from "@/lib/storage";
import { assertDocumentUpload } from "@/lib/file-type";

async function requireAdmin() {
  const session = await auth();
  if (!session || !isAdminRole(session.user.role)) return null;
  return session;
}

export type DocumentUpload = {
  title: string;
  type: DocumentType;
  assignment: "All" | "Team" | "Associate";
  assignedTeam?: string;
  assignedAssociateCode?: string;
  file: File;
};

const MAX_BYTES = 150_000_000;

export async function uploadDocument(input: DocumentUpload): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations("errors");
  const session = await requireAdmin();
  if (!session) return { ok: false, error: t("forbidden") };
  if (!input.title?.trim()) return { ok: false, error: t("titleRequired") };
  if (!input.file || input.file.size === 0) return { ok: false, error: t("fileRequired") };
  if (input.file.size > MAX_BYTES) return { ok: false, error: t("fileTooLarge") };

  let assignedAssociateId: string | null = null;
  if (input.assignment === "Associate") {
    if (!input.assignedAssociateCode?.trim()) return { ok: false, error: t("associateCodeRequired") };
    const a = await prisma.associate.findUnique({ where: { associateCode: input.assignedAssociateCode.trim() }, select: { id: true } });
    if (!a) return { ok: false, error: t("associateCodeNotFound") };
    assignedAssociateId = a.id;
  }
  if (input.assignment === "Team" && !input.assignedTeam?.trim()) return { ok: false, error: t("teamNameRequired") };

  const bytes = Buffer.from(await input.file.arrayBuffer());
  try {
    assertDocumentUpload(bytes, input.file.name);
  } catch {
    return { ok: false, error: t("invalidFileType") };
  }

  const safeName = input.file.name.replace(/[^\w.\-]/g, "_").slice(-80) || "document";
  const key = `documents/${randomUUID()}/${safeName}`;
  await putObject(key, bytes);

  const doc = await prisma.document.create({
    data: {
      type: input.type,
      title: input.title.trim(),
      fileKey: key,
      assignment: DocumentAssignment[input.assignment],
      assignedTeam: input.assignment === "Team" ? input.assignedTeam!.trim() : null,
      assignedAssociateId,
      uploadedById: session.user.id,
    },
  });
  await logAudit({ action: "document.uploaded", entityType: "Document", entityId: doc.id, actorUserId: session.user.id });
  revalidatePath("/admin/documents");
  revalidatePath("/portal/documents");
  return { ok: true };
}

export async function deleteDocument(id: string): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations("errors");
  const session = await requireAdmin();
  if (!session) return { ok: false, error: t("forbidden") };
  // Collect this document AND its entire retired supersession history: every
  // row that chains up to it via superseded_by. `documents_superseded_by_fkey`
  // (documents.superseded_by -> documents.id, ON DELETE RESTRICT) refuses to
  // delete any row a retired predecessor still points at — and a re-upload
  // leaves exactly such a hidden retired row, with no UI path to it, which is
  // why deleting a re-uploaded document used to fail with documentStill
  // referenced and no way forward. Deleting the whole chain together is what
  // makes the delete succeed. Prisma has no recursive query, so the chain walk
  // is one raw CTE; the delete itself stays ordinary Prisma.
  const chain = await prisma.$queryRaw<{ id: string; file_key: string | null }[]>(Prisma.sql`
    WITH RECURSIVE chain AS (
      SELECT id, file_key FROM documents WHERE id = ${id}::uuid
      UNION ALL
      SELECT d.id, d.file_key FROM documents d JOIN chain c ON d.superseded_by = c.id
    )
    SELECT id, file_key FROM chain
  `);
  if (chain.length === 0) return { ok: true }; // already gone — idempotent
  const ids = chain.map((r) => r.id);

  // INT-5. Order matters and is not symmetrical: the row delete can be REFUSED,
  // the file delete essentially cannot. Commit the DB truth FIRST, then remove
  // the files — an orphaned file costs disk and breaks nothing, whereas a
  // surviving row pointing at a deleted file lists and opens but fails at
  // download. The explicit transaction matters because that FK is DEFERRABLE
  // INITIALLY DEFERRED: its check runs at COMMIT, so deleting a predecessor and
  // its successor together passes, and a genuine refusal is only known once the
  // transaction has resolved — nothing is destroyed before that point.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.document.deleteMany({ where: { id: { in: ids } } });
    });
  } catch (e) {
    // P2003 = FK constraint; P2014 = Prisma's own required-relation refusal.
    // Any other error rethrows exactly as before — in every case the files are
    // still untouched, because this runs before the file delete below.
    if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2003" || e.code === "P2014")) {
      return { ok: false, error: t("documentStillReferenced") };
    }
    throw e;
  }

  // The row is gone, so nothing references this object any more. If removing it
  // fails, the file is an orphan: it costs disk and breaks nothing, which is
  // strictly the better failure than the inverse, so it does not fail the
  // operation. Logged (tag, id and error class only) so it is not silent —
  // deleteObject itself already swallows a missing file.
  for (const row of chain) {
    if (row.file_key) {
      await deleteObject(row.file_key).catch((e: unknown) => {
        console.error(`[orphaned-object] document ${row.id} ${e instanceof Error ? e.name : "error"}`);
      });
    }
  }
  await logAudit({ action: "document.deleted", entityType: "Document", entityId: id, actorUserId: session.user.id });
  revalidatePath("/admin/documents");
  revalidatePath("/portal/documents");
  return { ok: true };
}
