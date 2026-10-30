import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, like } from "drizzle-orm";
import * as schema from "../db/schema";
import { activities } from "../db/schema";
import type { Db } from "../db/client";
import type { AppBindings, Variables } from "../env";
import { activitiesRepository } from "../repositories/activitiesRepository";
import { activitiesRouter } from "./activities";
import { activitiesPublicRouter } from "./agenda/activities-public";
import { auth } from "../middleware/auth";

// #43 (2026-10-30): check "Publicar en la web" de las actividades (1.64.0).
// Integración real contra Postgres local, mismo arnés que
// routes/agenda/services.test.ts (auth por API_KEY como Bearer → admin).
const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const QA = "ZZ_QA_ACTIVIDAD_WEB_";
const pgClient = postgres(LOCAL_DB_URL, { max: 1, fetch_types: false, prepare: false });
const testDb = drizzle(pgClient, { schema }) as unknown as Db;
const API_KEY = "qa-actividades-web-key";
const ENV = { HYPERDRIVE: { connectionString: LOCAL_DB_URL }, API_KEY } as unknown as AppBindings;

const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();
// En el Worker, `auth` corre para toda la API antes de cada router.
app.use("*", auth);
app.route("/api", activitiesRouter);
app.route("/api/agenda/activities", activitiesPublicRouter);

const limpiar = () => testDb.delete(activities).where(like(activities.name, `${QA}%`));

let visibleId = "";
let ocultaId = "";

beforeAll(async () => {
  activitiesRepository.setDb(testDb);
  await limpiar();
  const rows = await testDb
    .insert(activities)
    .values([
      { name: `${QA}VISIBLE`, activityType: "class", classesPerMonth: 4, monthlyBasePrice: "1000", isActive: true },
      { name: `${QA}OCULTA`, activityType: "class", classesPerMonth: 4, monthlyBasePrice: "1000", isActive: true, isVisibleWeb: false },
    ])
    .returning({ id: activities.id, name: activities.name });
  visibleId = rows.find((r) => r.name === `${QA}VISIBLE`)!.id;
  ocultaId = rows.find((r) => r.name === `${QA}OCULTA`)!.id;
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

async function enLaWeb(): Promise<string[]> {
  const res = await app.request("/api/agenda/activities", {}, ENV);
  expect(res.status).toBe(200);
  return ((await res.json()) as { name: string }[]).map((a) => a.name).filter((n) => n.startsWith(QA));
}

describe("actividades — check \"Publicar en la web\"", () => {
  it("una actividad nueva arranca publicada (default de la columna)", async () => {
    const [fila] = await testDb.select({ v: activities.isVisibleWeb }).from(activities).where(eq(activities.id, visibleId));
    expect(fila!.v).toBe(true);
  });

  it("la web no recibe las que tienen el check destildado", async () => {
    expect(await enLaWeb()).toEqual([`${QA}VISIBLE`]);
  });

  it("PATCH guarda el check, y la web lo respeta", async () => {
    const patch = (id: string, isVisibleWeb: boolean) =>
      app.request(
        `/api/activities/${id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
          body: JSON.stringify({ isVisibleWeb }),
        },
        ENV,
      );
    expect((await patch(visibleId, false)).status).toBe(200);
    expect((await patch(ocultaId, true)).status).toBe(200);
    expect(await enLaWeb()).toEqual([`${QA}OCULTA`]);
  });

  it("el listado del dashboard trae el check", async () => {
    const res = await app.request("/api/activities", { headers: { Authorization: `Bearer ${API_KEY}` } }, ENV);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { name: string; isVisibleWeb: boolean }[] };
    expect(data.find((a) => a.name === `${QA}OCULTA`)?.isVisibleWeb).toBe(true);
  });
});
