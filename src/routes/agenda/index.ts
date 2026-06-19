import { Hono } from "hono";
import { appointmentsRouter } from "./appointments";
import { availability } from "./availability";
import { categoriesRouter } from "./categories";
import { companyConfigRouter } from "./company-config";
import { promotionsRouter } from "./promotions";
import { providersRouter, services } from "./services";
import type { AppBindings } from "../../env";

const agenda = new Hono<{ Bindings: AppBindings }>();

agenda.route("/services", services);
agenda.route("/categories", categoriesRouter);
agenda.route("/availability", availability);
agenda.route("/appointments", appointmentsRouter);
agenda.route("/providers", providersRouter);
agenda.route("/company-config", companyConfigRouter);
agenda.route("/promotions", promotionsRouter);

export { agenda };
