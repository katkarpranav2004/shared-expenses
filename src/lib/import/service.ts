// Server side of the import pipeline. The validator (validate.ts) is pure;
// this module gives it context from the DB and commits confirmed batches.

import { prisma } from "../db";
import { validateCsv } from "./validate";
import type { ValidationCtx, ValidationResult } from "./types";

export async function buildValidationCtx(groupId: string): Promise<ValidationCtx> {
  const [members, priorRows, existingExpenses] = await Promise.all([
    // ALL members including departed — membership timing (A13) needs them.
    prisma.groupMember.findMany({
      where: { groupId },
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
    // Hashes from every previous batch in this group (idempotency, A11).
    prisma.importRow.findMany({
      where: { batch: { groupId }, outcome: { in: ["IMPORTED", "FLAGGED"] } },
      select: { rowHash: true },
    }),
    // Near-duplicate keys against already-existing expenses (A12).
    prisma.expense.findMany({
      where: { groupId },
      select: { date: true, paidById: true, amountCents: true },
    }),
  ]);

  return {
    members: members.map((m) => ({
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      joinedAt: m.joinedAt,
      leftAt: m.leftAt,
    })),
    existingHashes: new Set(priorRows.map((r) => r.rowHash)),
    existingNearKeys: new Set(
      existingExpenses.map(
        (e) => `${e.date.toISOString().slice(0, 10)}|${e.paidById}|${e.amountCents}`,
      ),
    ),
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
        emptyRows: result.summary.empty,
      },
    });

    for (const row of result.rows) {
      if (row.outcome === "EMPTY") continue; // counted in the batch, not persisted (A20)

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
        await tx.expense.create({
          data: {
            groupId,
            paidById: row.expense.paidById,
            description: row.expense.description,
            amountCents: row.expense.amountCents,
            date: new Date(`${row.expense.date}T00:00:00Z`),
            splitType: row.expense.splitType,
            importRowId: importRow.id, // provenance: expense -> CSV line
            splits: { create: row.expense.splits },
          },
        });
      }
    }
    return batch;
  });
}
