import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { training } from "../db/schema";

const trainingSummary = {
  id: training.id,
  name: training.name,
  description: training.description,
  modality: training.modality,
  location: training.location,
  totalSessions: training.totalSessions,
  durationPerSessionMinutes: training.durationPerSessionMinutes,
  prerequisitesText: training.prerequisitesText,
  maxParticipants: training.maxParticipants,
  includesCertification: training.includesCertification,
  certificationTitle: training.certificationTitle,
  listPrice: training.listPrice,
  cashPrice: training.cashPrice,
  taxCategory: training.taxCategory,
  isFeatured: training.isFeatured,
  isVisible: training.isVisible,
  webSortOrder: training.webSortOrder,
};

export async function listTrainings(db: Db, filters: { featured?: boolean }) {
  const conditions = [eq(training.isActive, true), eq(training.isVisible, true)];
  if (filters.featured) conditions.push(eq(training.isFeatured, true));

  return db
    .select(trainingSummary)
    .from(training)
    .where(and(...conditions))
    .orderBy(asc(training.webSortOrder), asc(training.name));
}

export async function getTrainingById(db: Db, id: string) {
  const rows = await db
    .select(trainingSummary)
    .from(training)
    .where(eq(training.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateTrainingWebSettings(
  db: Db,
  id: string,
  patch: { isFeatured?: boolean; webSortOrder?: number },
) {
  const result = await db
    .update(training)
    .set({
      ...(patch.isFeatured !== undefined && { isFeatured: patch.isFeatured }),
      ...(patch.webSortOrder !== undefined && { webSortOrder: patch.webSortOrder }),
    })
    .where(eq(training.id, id))
    .returning({
      id: training.id,
      isFeatured: training.isFeatured,
      webSortOrder: training.webSortOrder,
    });

  return result[0] ?? null;
}
