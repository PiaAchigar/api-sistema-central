import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { createDb } from "../../db/client";
import { activities } from "../../db/schema";
import type { AppBindings, Variables } from "../../env";

type ActivityRow = {
  id: string; name: string | null; description: string | null;
  activityType: string | null; classesPerMonth: number | null;
  monthlyBasePrice: string | null;
};

/** Recorta la fila a lo que puede ver un visitante anónimo. La proveedora
 *  asignada es dato interno: no sale a la web. */
export function buildPublicActivity(row: ActivityRow & Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    activityType: row.activityType,
    classesPerMonth: row.classesPerMonth,
    monthlyBasePrice: row.monthlyBasePrice,
  };
}

const activitiesPublicRouter = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

// Público a propósito, como /categories y /services: lo consume piubella_web
// desde el server component de /servicios, sin sesión.
activitiesPublicRouter.get("/", async (c) => {
  const db = createDb(c.env);
  const rows = await db
    .select({
      id: activities.id, name: activities.name, description: activities.description,
      activityType: activities.activityType, classesPerMonth: activities.classesPerMonth,
      monthlyBasePrice: activities.monthlyBasePrice,
    })
    .from(activities)
    .where(eq(activities.isActive, true))
    .orderBy(asc(activities.name));
  return c.json(rows.map(buildPublicActivity));
});

export { activitiesPublicRouter };
