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
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  }),
);

app.onError((err, c) => {
  console.error("[error]", err);
  if ("status" in err && typeof err.status === "number") {
    return c.json({ error: err.message }, err.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500);
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
