import { Hono } from "hono";
import { agenda } from "./agenda";
import { aiConfigRouter } from "./ai-config";
import { billing } from "./billing";
import { crm } from "./crm";
import { health } from "./health";
import { usersRouter } from "./users";
import { treatments } from "./treatments";
import { auth } from "../middleware/auth";
import type { AppBindings, Variables } from "../env";

const api = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

api.use("*", auth);

api.route("/health", health);
api.route("/agenda", agenda);
api.route("/billing", billing);
api.route("/crm", crm);
api.route("/users", usersRouter);
api.route("/ai-config", aiConfigRouter);
api.route("/treatments", treatments);

export { api };
export type ApiType = typeof api;
