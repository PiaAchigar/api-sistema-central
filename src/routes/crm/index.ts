// api-sistema-central/src/routes/crm/index.ts
import { Hono } from "hono";
import { contactsRouter } from "./contacts";
import { dealsRouter } from "./deals";
import type { AppBindings, Variables } from "../../env";

const crm = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

crm.route("/contacts", contactsRouter);
crm.route("/deals", dealsRouter);

export { crm };
