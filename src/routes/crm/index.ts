// api-sistema-central/src/routes/crm/index.ts
import { Hono } from "hono";
import { automationFaqsRouter } from "./automation-faqs";
import { automationsRouter } from "./automations";
import { channelsRouter } from "./channels";
import { contactsRouter } from "./contacts";
import { contactLinksRouter } from "./contact-links";
import { conversationsRouter } from "./conversations";
import { comprasRouter } from "./compras";
import { saldosRouter } from "./saldos";
import { dealsRouter } from "./deals";
import type { AppBindings, Variables } from "../../env";

const crm = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

crm.route("/contacts", contactsRouter);
crm.route("/contacts", contactLinksRouter);
crm.route("/deals", dealsRouter);
// Compras: vender packs/combos/servicios que quedan pendientes (1.45.0).
// Sus rutas ya traen el prefijo completo (/customers/:id/purchases, /purchases).
crm.route("/", comprasRouter);
// Saldo a favor vencido: a quién y cuánto, y pasarlo a caja (1.47.0).
crm.route("/credits", saldosRouter);
crm.route("/channels", channelsRouter);
crm.route("/conversations", conversationsRouter);
crm.route("/automations", automationsRouter);
crm.route("/automation-faqs", automationFaqsRouter);

export { crm };
