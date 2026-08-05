import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestLogger } from "./middleware/logger";
import { api } from "./routes";
import { whatsappWebhookRouter } from "./routes/webhooks/whatsapp";
import { requireAuth, requirePermission } from "./middleware/auth";
import { createDb } from "./db/client";
import { recalculateEmbeddings, recalculateEmbeddingsWorker } from "./workers/embedding-calculator";
import { processMessageQueue } from "./workers/queue-processor";
import type { AppBindings, Variables } from "./env";

// Patrón cron de queue-processor.ts (Task 2 — procesa message_queue). Vive acá
// como constante porque `scheduled()` necesita comparar `event.cron` contra
// este mismo string para decidir qué handler correr — ver wrangler.toml
// ([triggers] crons) donde se registra el trigger real.
const MESSAGE_QUEUE_CRON = "* * * * *";

const app = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

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
// público permitiría a cualquiera disparar llamadas a la API de Anthropic
// (con costo real) usando la credencial guardada. Se exige login + el mismo
// permiso que ya protege /api/ai-config (gestión de credenciales de IA).
// Ver src/workers/embedding-calculator.ts para la lógica y la advertencia
// sobre qué tan "reales" son estos embeddings.
app.post(
  "/api/webhooks/recalculate-embeddings",
  requireAuth,
  requirePermission("crm", "manage"),
  recalculateEmbeddingsWorker,
);

export default {
  fetch: app.fetch,
  // Cloudflare invoca `scheduled()` para cada cron trigger definido en
  // wrangler.toml ([triggers] crons); `event.cron` trae el patrón que disparó
  // esta corrida puntual, así que hay que ramificar por él — si no,
  // cualquier cron activo dispararía TODOS los jobs de acá abajo, incluido
  // recalculateEmbeddings (que gasta la credencial de Anthropic activa y
  // está deliberadamente deshabilitado — ver wrangler.toml).
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
      return;
    }

    // Cron trigger opcional para recalcular embeddings pendientes (ver
    // wrangler.toml — comentado por default: cada corrida gasta la
    // credencial de Anthropic y, tal como está hoy, "embedding" no es
    // semánticamente real — ver embedding.ts). Si se habilita ese cron en
    // wrangler.toml, cae acá.
    ctx.waitUntil(
      recalculateEmbeddings(db, env as unknown as AppBindings).then((result) => {
        console.log("[embedding-calculator] cron run:", result);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
