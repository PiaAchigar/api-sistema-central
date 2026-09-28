import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../../db/schema";
import { machines, service, serviceProviders, serviceProviderService } from "../../db/schema";
import type { Db } from "../../db/client";
import type { AppBindings, Variables } from "../../env";
import { providersRouter, services } from "./services";
import { anclaDeDepilacion } from "../../repositories/ancla-de-depilacion.repo";

// ── Integración real contra Postgres local ──────────────────────────────────
// El rechazo de `percentage` sobre el ancla depende de una fila real en
// `depilation_pricing_config` (la resuelve `anclaDeDepilacion`) y de la
// restricción `chk_sps_rate` de `service_provider_service` — un doble de `Db`
// no ejercitaría ninguna de las dos. Mismo harness que
// `routes/crm/compras.test.ts` (Hono + auth por API_KEY como Bearer, que pasa
// por el mismo `middleware/auth.ts` de siempre y asigna role=admin).
const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const QA_PREFIX = "ZZ_QA_AGREEMENTS_";

const pgClient = postgres(LOCAL_DB_URL, { max: 1, fetch_types: false, prepare: false });
const testDb = drizzle(pgClient, { schema }) as unknown as Db;

const API_KEY = "qa-agreements-test-key";
const TOKEN = API_KEY;
const ENV = { HYPERDRIVE: { connectionString: LOCAL_DB_URL }, API_KEY } as unknown as AppBindings;

const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();
app.onError((err, c) => {
  if ("status" in err && typeof err.status === "number") {
    return c.json(
      { error: err.message },
      err.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502,
    );
  }
  return c.json({ error: "Internal server error" }, 500);
});
app.route("/", services);
// Las rutas de máquinas de una proveedora viven en `providersRouter`, que
// `services.ts` exporta aparte (no en `services`) — se monta bajo `/providers`
// igual que hace `index.ts` en el Worker real.
app.route("/providers", providersRouter);

// Cierra el pool una sola vez, después de TODOS los describe del archivo:
// el describe de abajo (agreements) cerraba `pgClient` en su propio
// `afterAll`, y con un segundo describe corriendo después en el mismo
// archivo eso lo dejaba sin conexión a mitad de suite.
afterAll(async () => {
  await pgClient.end();
});

async function limpiarQA() {
  // `service_provider_service` cuelga de FK a ambas tablas: hay que borrarlo
  // antes de borrar el servicio o la proveedora QA que lo sostienen. Los ids
  // se resuelven primero y se pasan con `inArray()` — un array literal como
  // parámetro no sirve acá (Hyperdrive corre con `fetch_types: false`).
  const provs = await testDb
    .select({ id: serviceProviders.id })
    .from(serviceProviders)
    .where(like(serviceProviders.fullName, `${QA_PREFIX}%`));
  const svcs = await testDb
    .select({ id: service.id })
    .from(service)
    .where(like(service.name, `${QA_PREFIX}%`));
  const provIds = provs.map((p) => p.id);
  const svcIds = svcs.map((s) => s.id);

  if (provIds.length > 0) {
    await testDb
      .delete(serviceProviderService)
      .where(inArray(serviceProviderService.serviceProviderId, provIds));
  }
  if (svcIds.length > 0) {
    await testDb.delete(serviceProviderService).where(inArray(serviceProviderService.serviceId, svcIds));
  }
  if (svcIds.length > 0) {
    await testDb.delete(service).where(inArray(service.id, svcIds));
  }
  if (provIds.length > 0) {
    await testDb.delete(serviceProviders).where(inArray(serviceProviders.id, provIds));
  }
}

describe("PUT /api/agenda/services/:id/agreements — el ancla de depilación", () => {
  let provId = "";
  let servicioNormalId = "";

  beforeAll(async () => {
    await limpiarQA();

    const [prov] = await testDb
      .insert(serviceProviders)
      .values({ fullName: `${QA_PREFIX}PROVEEDORA`, status: "active" })
      .returning({ id: serviceProviders.id });
    provId = prov!.id;

    // Servicio propio del test, NO "uno cualquiera" con `limit 1`: otro
    // archivo de la suite borra los `ZZ_QA%` a mitad de corrida, así que un
    // servicio elegido al azar es una causa conocida de no-determinismo acá.
    const [svc] = await testDb
      .insert(service)
      .values({ name: `${QA_PREFIX}SERVICIO_NORMAL`, isActive: true })
      .returning({ id: service.id });
    servicioNormalId = svc!.id;
  });

  afterAll(async () => {
    await limpiarQA();
  });

  it("rechaza percentage sobre el ancla, con el motivo", async () => {
    const ancla = await anclaDeDepilacion(testDb);
    const res = await app.request(
      `/${ancla}/agreements`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          agreements: [{ serviceProviderId: provId, paymentType: "percentage", rate: 40 }],
        }),
      },
      ENV,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; message?: string };
    expect(JSON.stringify(body)).toMatch(/porcentaje/i);
  });

  it("acepta fixed_per_service sobre el ancla", async () => {
    const ancla = await anclaDeDepilacion(testDb);
    const res = await app.request(
      `/${ancla}/agreements`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          agreements: [
            { serviceProviderId: provId, paymentType: "fixed_per_service", rate: 20000 },
          ],
        }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
  });

  // La no-regresión importa más que el rechazo: percentage es lo que Laura usa
  // en todos los demás servicios del salón.
  it("sigue aceptando percentage sobre CUALQUIER OTRO servicio", async () => {
    const res = await app.request(
      `/${servicioNormalId}/agreements`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          agreements: [{ serviceProviderId: provId, paymentType: "percentage", rate: 40 }],
        }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
  });
});

describe("máquinas de una proveedora (providersRouter)", () => {
  const PREFIX = "ZZ_QA_PROV_MACHINES_";
  let provId = "";
  let maqId = "";

  beforeAll(async () => {
    const [prov] = await testDb
      .insert(serviceProviders)
      .values({ fullName: `${PREFIX}PROVEEDORA`, status: "active" })
      .returning({ id: serviceProviders.id });
    provId = prov!.id;

    // `machines.id` no tiene DEFAULT en Postgres: lo genera Drizzle en runtime.
    const [maq] = await testDb
      .insert(machines)
      .values({ name: `${PREFIX}MAQUINA`, status: "active" })
      .returning({ id: machines.id });
    maqId = maq!.id;
  });

  afterAll(async () => {
    await testDb
      .delete(schema.serviceProviderMachine)
      .where(eq(schema.serviceProviderMachine.serviceProviderId, provId));
    await testDb.delete(machines).where(eq(machines.id, maqId));
    await testDb.delete(serviceProviders).where(eq(serviceProviders.id, provId));
  });

  it("habilita, lista y deshabilita", async () => {
    const h = { Authorization: `Bearer ${TOKEN}` };

    const put = await app.request(
      `/providers/${provId}/machines/${maqId}`,
      { method: "PUT", headers: h },
      ENV,
    );
    expect(put.status).toBe(200);

    const get = await app.request(`/providers/${provId}/machines`, { headers: h }, ENV);
    const lista = (await get.json()) as { machineId: string }[];
    expect(lista.map((m) => m.machineId)).toContain(maqId);

    const del = await app.request(
      `/providers/${provId}/machines/${maqId}`,
      { method: "DELETE", headers: h },
      ENV,
    );
    expect(del.status).toBe(200);

    const get2 = await app.request(`/providers/${provId}/machines`, { headers: h }, ENV);
    expect(((await get2.json()) as { machineId: string }[]).map((m) => m.machineId)).not.toContain(
      maqId,
    );
  });

  it("sin token da 401", async () => {
    const res = await app.request(`/providers/${provId}/machines`, {}, ENV);
    expect(res.status).toBe(401);
  });
});
