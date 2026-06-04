import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import type { AppBindings } from "../env";

export type Db = PostgresJsDatabase<typeof schema>;
export type Schema = typeof schema;

export function createDb(env: AppBindings): Db {
  const client = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return drizzle(client, { schema });
}
