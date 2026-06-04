import { Hono } from "hono";
import { health } from "./health";
import type { AppBindings } from "../env";

const api = new Hono<{ Bindings: AppBindings }>();

api.route("/health", health);

export { api };
export type ApiType = typeof api;
