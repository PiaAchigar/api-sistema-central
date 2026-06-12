import { Hono } from "hono";
import { agenda } from "./agenda";
import { billing } from "./billing";
import { health } from "./health";
import { auth } from "../middleware/auth";
import type { AppBindings, Variables } from "../env";

const api = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

api.use("*", auth);

api.route("/health", health);
api.route("/agenda", agenda);
api.route("/billing", billing);

export { api };
export type ApiType = typeof api;
