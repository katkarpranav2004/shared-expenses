// Server side of the import pipeline. The validator (validate.ts) is pure;
// this module gives it context from the DB and commits confirmed batches.

import { prisma } from "../db";
import { validateCsv } from "./validate";
import type { ValidationCtx, ValidationResult } from "./types";

export async function buildValidationCtx(groupId: string): Promise<ValidationCtx> {
  const [group, members, priorRows] = await Promise.all([
    prisma.group.findUnique({ where: { id: groupId }, select: { baseCurrency: true } }),
    // ALL members including departed — membership timing needs them.
    prisma.groupMember.findMany({
      where: { groupId },
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
    // Hashes from every previous batch in this group (idempotency).
    prisma.importRow.findMany({
      where: { batch: { groupId }, outcome: { in: ["IMPORTED", "FLAGGED", "RECLASSIFIED"] } },
      select: { rowHash: true },
    }),
  ]);

  return {
    baseCurrency: group?.baseCurrency ?? "INR",
    members: members.map((m) => ({
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      joinedAt: m.joinedAt,
      leftAt: m.leftAt,
    })),
    existingHashes: new Set(priorRows.map((r) => r.rowHash)),
    today: new Date(),
  };
}

export async function validateForGroup(groupId: string, csv: string): Promise<ValidationResult> {
  return validateCsv(csv, await buildValidationCtx(groupId));
}

// Commit: one transaction for the whole batch — a serverless cold-start or
// crash mid-import leaves either a complete batch or nothing (no partial
// batches can exist; retry is safe because re-validation dedupes by hash).
export async function commitImport(
  groupId: string,
  uploadedById: string,
  filename: string,
  result: ValidationResult,
) {
  return prisma.$transaction(async (tx) => {
    const batch = await tx.importBatch.create({
      data: {
        groupId,
        uploadedById,
        filename,
        totalRows: result.summary.total,
        importedRows: result.summary.imported,
        flaggedRows: result.summary.flagged,
        rejectedRows: result.summary.rejected,
        duplicateRows: result.summary.duplicate,
        reclassifiedRows: result.summary.reclassified,
        emptyRows: result.summary.empty,
      },
    });

    for (const row of result.rows) {
      if (row.outcome === "EMPTY") continue; // counted in the batch, not persisted

      const importRow = await tx.importRow.create({
        data: {
          batchId: batch.id,
          rowNumber: row.rowNumber,
          rawData: row.raw,
          rowHash: row.hash,
          outcome: row.outcome,
          reasons: row.reasons,
        },
      });

      if ((row.outcome === "IMPORTED" || row.outcome === "FLAGGED") && row.expense) {
        const e = row.expense;
        await tx.expense.create({
          data: {
            groupId,
            paidById: e.paidById,
            description: e.description,
            amountCents: e.amountCents,
            originalAmountCents: e.originalAmountCents,
            currency: e.currency,
            fxRateBp: e.fxRateBp,
            isRefund: e.isRefund ?? false,
            notes: e.notes ?? null,
            date: new Date(`${e.date}T00:00:00Z`),
            splitType: e.splitType,
            importRowId: importRow.id, // provenance: expense -> CSV line
            splits: { create: e.splits },
          },
        });
      } else if (row.outcome === "RECLASSIFIED" && row.settlement) {
        const s = row.settlement;
        await tx.settlement.create({
          data: {
            groupId,
            fromUserId: s.fromUserId,
            toUserId: s.toUserId,
            amountCents: s.amountCents,
            originalAmountCents: s.originalAmountCents,
            currency: s.currency,
            fxRateBp: s.fxRateBp,
            date: new Date(`${s.date}T00:00:00Z`),
            note: s.note ?? null,
          },
        });
      }
    }
    return batch;
  });
}
