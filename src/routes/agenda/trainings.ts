import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../../db/client";
import { auth, requireAuth, requirePermission } from "../../middleware/auth";
import {
  createTraining,
  getTrainingById,
  listTrainings,
  listTrainingsAdmin,
  setTrainingActive,
  updateTraining,
} from "../../repositories/trainings.repo";
import {
  crearEncuentro,
  editarEncuentro,
  generarEncuentros,
  listEncuentros,
} from "../../repositories/training-sessions.repo";
import {
  capacidadSchema,
  errorOrdenHoras,
  finPosteriorAInicio,
  finPosteriorAInicioOpcional,
  horaSchema,
} from "../../lib/horario-schema";
import type { AppBindings } from "../../env";

const trainings = new Hono<{ Bindings: AppBindings }>();

const listQuery = z.object({
  featured: z.string().optional().transform((v) => v === "true"),
});

function serializePrices<T extends { listPrice: string | null; cashPrice: string | null }>(r: T) {
  return {
    ...r,
    listPrice: r.listPrice != null ? Number(r.listPrice) : null,
    cashPrice: r.cashPrice != null ? Number(r.cashPrice) : null,
  };
}

trainings.get("/", zValidator("query", listQuery), async (c) => {
  const db = createDb(c.env);
  const filters = c.req.valid("query");
  const rows = await listTrainings(db, { featured: filters.featured });
  return c.json(rows.map(serializePrices));
});

// Lista para administración: visibles o no. `includeInactive=true` suma las
// archivadas, que es lo que pide la vista "Archivados" de Capacitaciones.
//
// El guard sigue siendo `sitio-web` y no `catalogo` porque esta ruta ya la usa
// la pantalla de Sitio Web. No cambia nada en la práctica: las dos secciones
// tienen exactamente los mismos roles en la matriz de permisos (§1.7).
trainings.get(
  "/admin",
  auth,
  requireAuth,
  requirePermission("sitio-web", "view"),
  zValidator("query", z.object({ includeInactive: z.string().optional() })),
  async (c) => {
    const db = createDb(c.env);
    const rows = await listTrainingsAdmin(db, c.req.valid("query").includeInactive === "true");
    return c.json(rows.map(serializePrices));
  },
);

trainings.get("/:id", async (c) => {
  const db = createDb(c.env);
  const row = await getTrainingById(db, c.req.param("id"));
  if (!row) return c.json({ error: "Training not found" }, 404);
  return c.json(serializePrices(row));
});

// Los campos de la capacitación. El PATCH los toma todos opcionales; el POST
// exige el nombre y nada más, igual que Servicios y Máquinas.
const trainingFields = {
  description: z.string().max(5000).nullish(),
  modality: z.string().max(50).nullish(),
  location: z.string().max(255).nullish(),
  totalSessions: z.number().int().min(0).nullish(),
  durationPerSessionMinutes: z.number().int().min(0).nullish(),
  prerequisitesText: z.string().max(5000).nullish(),
  maxParticipants: z.number().int().min(0).nullish(),
  includesCertification: z.boolean().nullish(),
  certificationTitle: z.string().max(255).nullish(),
  listPrice: z.number().min(0).nullish(),
  cashPrice: z.number().min(0).nullish(),
  taxCategory: z.string().max(50).nullish(),
  isVisible: z.boolean().nullish(),
  isFeatured: z.boolean().nullish(),
  webSortOrder: z.number().int().min(0).nullish(),
};

const createBody = z.object({ name: z.string().min(1).max(255), ...trainingFields });
const patchBody = z
  .object({ name: z.string().min(1).max(255).optional(), ...trainingFields })
  .refine((d) => Object.keys(d).length > 0, { message: "Nada para actualizar" });

// Crear — nivel `manage`, como el alta de servicios y máquinas.
trainings.post(
  "/",
  auth,
  requireAuth,
  requirePermission("catalogo", "manage"),
  zValidator("json", createBody),
  async (c) => {
    const db = createDb(c.env);
    const creada = await createTraining(db, c.req.valid("json"));
    return c.json(serializePrices(creada), 201);
  },
);

// Editar. Acepta todos los campos; la pantalla de Sitio Web sigue mandando
// sólo isFeatured / isVisible / webSortOrder y para ella nada cambió.
trainings.patch(
  "/:id",
  auth,
  requireAuth,
  requirePermission("sitio-web", "edit"),
  zValidator("json", patchBody),
  async (c) => {
    const db = createDb(c.env);
    const updated = await updateTraining(db, c.req.param("id"), c.req.valid("json"));
    if (!updated) return c.json({ error: "Training not found" }, 404);
    return c.json(serializePrices(updated));
  },
);

// Archivar (soft-delete). Nunca se borra: regla 1.3 — una capacitación puede
// tener inscripciones y suscripciones colgando.
trainings.delete("/:id", auth, requireAuth, requirePermission("catalogo", "manage"), async (c) => {
  const db = createDb(c.env);
  const archivada = await setTrainingActive(db, c.req.param("id"), false);
  if (!archivada) return c.json({ error: "Training not found" }, 404);
  return c.json(serializePrices(archivada));
});

trainings.post("/:id/restore", auth, requireAuth, requirePermission("catalogo", "manage"), async (c) => {
  const db = createDb(c.env);
  const restaurada = await setTrainingActive(db, c.req.param("id"), true);
  if (!restaurada) return c.json({ error: "Training not found" }, 404);
  return c.json(serializePrices(restaurada));
});

// ── Encuentros ───────────────────────────────────────────────────────────
// Horas locales ART "HH:MM:SS"; mismas reglas y mensajes que los horarios de
// actividades (src/lib/horario-schema.ts).
const encuentroCampos = {
  sessionNumber: z.number().int().min(1),
  sessionDate: z.string().date(),
  startTime: horaSchema,
  endTime: horaSchema,
  serviceProviderId: z.string().uuid().nullable().optional(),
  location: z.string().max(255).nullable().optional(),
  capacity: capacidadSchema.optional(),
};

// Exportados para testearlos sin base (trainings.sessions.test.ts).
export const encuentroBody = z.object(encuentroCampos).refine(finPosteriorAInicio, errorOrdenHoras);

export const encuentroPatchBody = z
  .object({
    sessionNumber: encuentroCampos.sessionNumber.optional(),
    sessionDate: encuentroCampos.sessionDate.optional(),
    startTime: horaSchema.optional(),
    endTime: horaSchema.optional(),
    serviceProviderId: encuentroCampos.serviceProviderId,
    location: encuentroCampos.location,
    capacity: capacidadSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(finPosteriorAInicioOpcional, errorOrdenHoras);

export const generarBody = z
  .object({
    desde: z.string().date(),
    diaDeLaSemana: z.number().int().min(0).max(6),
    startTime: horaSchema,
    endTime: horaSchema,
    serviceProviderId: z.string().uuid().nullable().optional(),
    cantidad: z.number().int().min(1).optional(),
  })
  .refine(finPosteriorAInicio, errorOrdenHoras);

trainings.get(
  "/:id/sessions",
  auth,
  requireAuth,
  requirePermission("catalogo", "view"),
  zValidator("query", z.object({ incluirInactivos: z.enum(["true", "false"]).optional() })),
  async (c) => {
    const db = createDb(c.env);
    const rows = await listEncuentros(db, c.req.param("id"), {
      incluirInactivos: c.req.valid("query").incluirInactivos === "true",
    });
    return c.json(rows);
  },
);

trainings.post(
  "/:id/sessions/generar",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  zValidator("json", generarBody),
  async (c) => {
    const db = createDb(c.env);
    return c.json(await generarEncuentros(db, c.req.param("id"), c.req.valid("json")), 201);
  },
);

trainings.post(
  "/:id/sessions",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  zValidator("json", encuentroBody),
  async (c) => {
    const db = createDb(c.env);
    return c.json(await crearEncuentro(db, c.req.param("id"), c.req.valid("json")), 201);
  },
);

trainings.patch(
  "/sessions/:sessionId",
  auth,
  requireAuth,
  requirePermission("catalogo", "edit"),
  zValidator("json", encuentroPatchBody),
  async (c) => {
    const db = createDb(c.env);
    return c.json(await editarEncuentro(db, c.req.param("sessionId"), c.req.valid("json")));
  },
);

export { trainings };
