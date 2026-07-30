import { Hono } from "hono";
import { cashRouter } from "./cash-register";
import { checkoutRouter } from "./checkout";
import { commissionsRouter } from "./commissions";
import { customersRouter } from "./customers";
import { invoicesRouter } from "./invoices";
import { issuersRouter } from "./issuers";
import { paymentsRouter } from "./payments";
import { requireAuth } from "../../middleware/auth";
import type { AppBindings, Variables } from "../../env";

const billing = new Hono<{ Bindings: AppBindings; Variables: Variables }>();

billing.use("*", requireAuth);

billing.route("/customers", customersRouter);
billing.route("/checkout", checkoutRouter);
billing.route("/invoices", invoicesRouter);
billing.route("/payments", paymentsRouter);
billing.route("/cash-register", cashRouter);
billing.route("/commissions", commissionsRouter);
billing.route("/issuers", issuersRouter);

export { billing };
