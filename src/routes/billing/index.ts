import { Hono } from "hono";
import { cashRouter } from "./cash-register";
import { checkoutRouter } from "./checkout";
import { commissionsRouter } from "./commissions";
import { customersRouter } from "./customers";
import { invoicesRouter } from "./invoices";
import { paymentsRouter } from "./payments";
import type { AppBindings } from "../../env";

const billing = new Hono<{ Bindings: AppBindings }>();

billing.route("/customers", customersRouter);
billing.route("/checkout", checkoutRouter);
billing.route("/invoices", invoicesRouter);
billing.route("/payments", paymentsRouter);
billing.route("/cash-register", cashRouter);
billing.route("/commissions", commissionsRouter);

export { billing };
