import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestLogger } from "./middleware/logger";
import { api } from "./routes";
import { whatsappWebhookRouter } from "./routes/webhooks/whatsapp";
import { requireAuth, requirePermission } from "./middleware/auth";
import { createDb } from "./db/client";
import { drenarPendientes, recalculateEmbeddingsWorker } from "./workers/embedding-calculator";
import { processMessageQueue } from "./workers/queue-processor";
import { cleanupOldBuckets } from "./services/rate-limiter.service";
import { trainingSubscriptionsRepository } from "./repositories/trainingSubscriptionsRepository";
import { activitiesRepository } from "./repositories/activitiesRepository";
import { activitySchedulesRepository } from "./repositories/activitySchedulesRepository";
import { trainingSubscriptionsService } from "./services/trainingSubscriptionsService";
import type { AppBindings, Variables } from "./env";

// Паттерн cron de queue-processor.ts (Task 2 — procesa message_queue). Vive acá
// como constante porque `scheduled()` necesita comparar `event.cron` contra
// este mismo string para decidir qué handler correr — ver wrangler.toml
// ([triggers] crons) donde se registra el trigger real.
const MESSAGE_QUEUE_CRON = "* * * * *";
const EMBEDDINGS_CRON = "0 * * * *";

const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

// Middleware: Inject database once at app startup for singleton repositories and services
// This runs on the first request and caches the database connection per app instance
app.use("*", async (c, next) => {
  const db = createDb(c.env);
  // Inject db into singleton repositories (idempotent — safe to call multiple times)
  trainingSubscriptionsRepository.setDb(db);
  activitiesRepository.setDb(db);
  activitySchedulesRepository.setDb(db);
  trainingSubscriptionsService.setDb(db);
  await next();
});

app.use("*", requestLogger);
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return null;
      if (
        origin === "http://localhost:3000" ||
        origin === "http://localhost:5173" ||
        origin === "http://localhost:5174" ||
        origin === "http://localhost:5175" ||
        origin === "http://localhost:5176" ||
        /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin) ||
        /^https:\/\/[a-z0-9-]+\.piubellaesteticapilates\.com\.ar$/.test(origin)
      ) {
        return origin;
      }
      return null;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "x-api-key"],
    maxAge: 86400,
  }),
);

app.onError((err, c) => {
  console.error("[error]", err);
  if ("status" in err && typeof err.status === "number") {
    return c.json(
      { error: err.message },
      err.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502,
    );
  }
  return c.json({ error: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found", path: c.req.path }, 404));

app.get("/", (c) =>
  c.json({
    name: "piubella-worker",
    version: "0.1.0",
    status: "running",
  }),
);

app.route("/api", api);

// Fuera de `api`: lo llama Meta, no un usuario logueado. El middleware `auth`
// de `/api/*` sigue corriendo acá (porque el path calza con ese prefijo),
// pero es no-bloqueante (solo decora userId/userRole si hay un token, nunca
// rechaza) — lo que sí garantizamos es que este router no tiene
// requireAuth/requirePermission, así que no hace falta estar logueado.
app.route("/api/webhooks/whatsapp", whatsappWebhookRouter);

// A diferencia de /api/webhooks/whatsapp (que Meta llama sin login), este
// endpoint no tiene ningún caller externo legítimo sin autenticar — dejarlo
// público permitiría a cualquiera disparar llamadas al proveedor de embeddings
// (con costo real) usando la credencial guardada. Se exige login + el mismo
// permiso que ya protege /api/ai-config (gestión de credenciales de IA).
app.post(
  "/api/webhooks/recalculate-embeddings",
  requireAuth,
  requirePermission("crm", "manage"),
  recalculateEmbeddingsWorker,
);

export default {
  fetch: app.fetch,
  // Cloudflare invoca `scheduled()` una vez por cada patrón cron definido en
  // wrangler.toml ([triggers] crons); `event.cron` trae el patrón exacto que
  // disparó esta corrida, así que hay que ramificar por él para saber cuál
  // handler ejecutar — ver wrangler.toml para los patrones vigentes.
  async scheduled(event, env, ctx) {
    // `env` acá viene tipado como `Env` (generado por `wrangler types`);
    // `AppBindings` es ese mismo shape con ARCA_MODE acotado a un literal
    // union — mismo objeto en runtime, solo más estrecho en compile-time,
    // igual que `c.env` en cualquier route handler.
    const db = createDb(env as unknown as AppBindings);

    if (event.cron === MESSAGE_QUEUE_CRON) {
      ctx.waitUntil(
        processMessageQueue(db, env as unknown as AppBindings).then((result) => {
          console.log("[queue-processor] cron run:", result);
        }),
      );
      // Task 4 — confiabilidad WhatsApp: limpia buckets de rate limit de más
      // de 1 hora. Reutiliza este mismo cron (cada 1 min) en vez de agregar
      // uno propio — es una `DELETE` barata (índice por `created_at`) y no
      // depende de si el queue-processor de arriba falla o no, por eso va en
      // su propio `waitUntil` en vez de encadenarse al `.then()` de arriba.
      ctx.waitUntil(
        cleanupOldBuckets(db).catch((err) => {
          console.error("[rate-limiter] cleanup falló:", err);
        }),
      );
      return;
    }

    // Comparación explícita, no un `else`: antes cualquier cron que no fuera
    // el de la cola caía acá, así que agregar un tercer cron habría disparado
    // recálculos que nadie pidió.
    if (event.cron === EMBEDDINGS_CRON) {
      ctx.waitUntil(
        drenarPendientes(db, env as unknown as AppBindings).then((r) => {
          console.log("[embedding-calculator] cron:", r);
        }),
      );
      return;
    }

    console.warn(`[scheduled] cron sin handler: ${event.cron}`);
  },
} satisfies ExportedHandler<Env>;
