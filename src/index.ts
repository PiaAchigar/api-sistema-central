import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestLogger } from "./middleware/logger";
import { api } from "./routes";
import type { AppBindings, Variables } from "./env";

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

export default app satisfies ExportedHandler<Env>;
