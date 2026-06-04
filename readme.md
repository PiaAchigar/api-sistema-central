# piubella-worker

Backend del facturador Piubella corriendo sobre **Cloudflare Workers** con acceso a **Supabase Postgres** a traves de **Hyperdrive**, tipado con **TypeScript** y modelado con **Drizzle ORM**.

## Stack

- **Cloudflare Workers** (runtime edge)
- **Hyperdrive** (pool de conexiones a Postgres con cache)
- **Hono** (framework HTTP, ~14KB, tipado fuerte)
- **Drizzle ORM** + **postgres.js** (driver)
- **Zod** + **@hono/zod-validator** (validacion de payloads)
- **Drizzle Kit** (migraciones SQL)

## Estructura

```
.
├── wrangler.toml              # Config del Worker + binding Hyperdrive
├── drizzle.config.ts          # Config de Drizzle Kit
├── src/
│   ├── index.ts               # Entry point (Hono app)
│   ├── env.ts                 # Tipos de bindings (HYPERDRIVE, etc.)
│   ├── db/
│   │   ├── client.ts          # Factory del cliente Drizzle
│   │   └── schema.ts          # Esquemas de tablas (definir aca)
│   ├── lib/
│   │   └── errors.ts          # AppError + helpers (notFound, badRequest, ...)
│   ├── middleware/
│   │   └── logger.ts          # Logger de requests
│   └── routes/
│       ├── index.ts           # Router raiz (/api)
│       ├── health.ts          # GET /api/health (verifica DB)
│       └── _example.ts        # Plantilla para nuevos routers
└── README.md
```

## Setup local

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar la connection string local

Editar `wrangler.toml` y descompletar la linea `localConnectionString` con la connection string **directa** de Supabase (la que entrega Supabase en Project Settings > Database > Connection string, puerto `5432` o `6543` segun corresponda):

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "7e802994d43e47b0b038a50423291f8f"
localConnectionString = "postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres"
```

### 3. Copiar variables de entorno

```bash
cp .env.example .env
# Editar .env con la connection string directa de Supabase (usada solo para drizzle-kit)
```

### 4. Generar tipos de Wrangler

```bash
npm run types
```

### 5. Levantar el dev server

```bash
npm run dev
```

El Worker estara disponible en `http://localhost:8787`. Endpoints utiles:

- `GET /` -> info basica
- `GET /api/health` -> verifica que la conexion a Supabase via Hyperdrive funciona

## Comandos

| Script              | Descripcion                                                 |
| ------------------- | ----------------------------------------------------------- |
| `npm run dev`       | Levanta Wrangler en modo local                              |
| `npm run deploy`    | Despliega el Worker a Cloudflare                            |
| `npm run types`     | Regenera `worker-configuration.d.ts` con los tipos de env  |
| `npm run db:generate` | Genera una migracion SQL a partir de `src/db/schema.ts`   |
| `npm run db:migrate`  | Aplica migraciones pendientes a Supabase                  |
| `npm run db:push`     | Sincroniza el schema directamente (solo dev)              |
| `npm run db:studio`   | Abre Drizzle Studio en el navegador                       |

## Como agregar un nuevo router

1. Crear `src/routes/<recurso>.ts` con un `Hono<{ Bindings: Env }>()`.
2. Exportar el router y montarlo en `src/routes/index.ts`:

```ts
// src/routes/invoices.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDb } from "../db/client";
import type { Env } from "../env";

const invoices = new Hono<{ Bindings: Env }>();

invoices.get(
  "/",
  zValidator("query", z.object({ status: z.enum(["draft", "issued"]).optional() })),
  async (c) => {
    const db = createDb(c.env);
    const { status } = c.req.valid("query");
    // ...usar db.select() etc.
    return c.json({ items: [] });
  },
);

export { invoices };
```

```ts
// src/routes/index.ts
import { invoices } from "./invoices";
api.route("/invoices", invoices);
```

## Como definir el schema de Drizzle

Editar `src/db/schema.ts` y exportar las tablas con `pgTable` de `drizzle-orm/pg-core`. Ejemplo:

```ts
import { pgTable, serial, varchar, timestamp, numeric } from "drizzle-orm/pg-core";

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  number: varchar("number", { length: 20 }).notNull().unique(),
  customerName: varchar("customer_name", { length: 255 }).notNull(),
  total: numeric("total", { precision: 12, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

Despues correr `npm run db:generate` y `npm run db:migrate`.

## Hyperdrive: notas importantes

- El binding `HYPERDRIVE` es la unica forma de hablar con la DB desde el Worker en produccion.
- En dev (`wrangler dev`) se usa `localConnectionString` para hablar directo con Supabase.
- `postgres.js` se configura con `max: 5`, `fetch_types: false`, `prepare: false` para evitar errores intermitentes con prepared statements en Hyperdrive y reducir latencia de primer query.
- El cliente se crea **dentro de cada handler**, no a nivel modulo. Hyperdrive ya mantiene el pool subyacente.

## Recursos

- [Documentacion de Hyperdrive](https://developers.cloudflare.com/hyperdrive/)
- [Hyperdrive + Drizzle](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/)
- [Hyperdrive + Supabase](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/)
- [Hono](https://hono.dev/)
- [Drizzle ORM](https://orm.drizzle.team/)
