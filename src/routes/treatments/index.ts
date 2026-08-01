import { Hono } from "hono";
import { treatmentSearchRouter } from "./search";
import type { AppBindings } from "../../env";

const treatments = new Hono<{ Bindings: AppBindings }>();

treatments.route("/search", treatmentSearchRouter);

export { treatments };
