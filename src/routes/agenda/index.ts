import { Hono } from "hono";
import { activitiesPublicRouter } from "./activities-public";
import { appointmentsRouter } from "./appointments";
import { availability } from "./availability";
import { categoriesRouter } from "./categories";
import { classesRouter } from "./classes";
import { companyConfigRouter } from "./company-config";
import { faqRouter } from "./faq";
import { machinesRouter } from "./machines";
import { promotionsRouter } from "./promotions";
import { providersRouter, services } from "./services";
import { trainings } from "./trainings";
import { webRouter } from "./web";
import type { AppBindings } from "../../env";

const agenda = new Hono<{ Bindings: AppBindings }>();

agenda.route("/services", services);
agenda.route("/categories", categoriesRouter);
agenda.route("/activities", activitiesPublicRouter);
agenda.route("/availability", availability);
agenda.route("/appointments", appointmentsRouter);
agenda.route("/classes", classesRouter);
agenda.route("/providers", providersRouter);
agenda.route("/company-config", companyConfigRouter);
agenda.route("/promotions", promotionsRouter);
agenda.route("/trainings", trainings);
agenda.route("/machines", machinesRouter);
agenda.route("/web", webRouter);
agenda.route("/faq", faqRouter);

export { agenda };
