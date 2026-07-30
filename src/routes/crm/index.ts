// api-sistema-central/src/routes/crm/index.ts
import { Hono } from "hono";
import { automationFaqsRouter } from "./automation-faqs";
import { automationsRouter } from "./automations";
import { channelsRouter } from "./channels";
import { contactsRouter } from "./contacts";
import { conversationsRouter } from "./conversations";
import { dealsRouter } from "./deals";
import type { AppBindings, Variables } from "../../env";

const crm = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

crm.route("/contacts", contactsRouter);
crm.route("/deals", dealsRouter);
crm.route("/channels", channelsRouter);
crm.route("/conversations", conversationsRouter);
crm.route("/automations", automationsRouter);
crm.route("/automation-faqs", automationFaqsRouter);

export { crm };
