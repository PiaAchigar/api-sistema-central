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

Hyperdrive no funciona en `wrangler dev` sin una base local o remota a la cual apuntar. Hay dos modos:

### Opción A — Postgres local con Docker (recomendado para desarrollar)

```bash
npm install
npm run db:up    # levanta postgres:16 en el puerto 5499 (docker-compose.yml)
npm run dev      # el worker queda en http://localhost:8787
```

En el **primer arranque** el contenedor aplica solo, en orden: `1.0.0/init.sql` → `1.1.0/sync.sql` → `seed.dev.sql` (servicios, proveedoras, horarios y un cliente de prueba). `wrangler.toml` ya trae `localConnectionString` apuntando a esta base, no hay nada que configurar.

Comandos útiles:

| Script         | Descripcion                                                  |
| -------------- | ------------------------------------------------------------ |
| `npm run db:up`    | Levanta la base local (espera a que esté healthy)        |
| `npm run db:down`  | La detiene (los datos persisten en el volumen)            |
| `npm run db:reset` | Borra el volumen y rearma todo desde migraciones + seed   |
| `npm run db:psql`  | Abre un psql adentro del contenedor                       |

### Opción B — Contra Supabase real (sin Docker)

No editar `wrangler.toml`: exportar la variable de entorno, que **pisa** el `localConnectionString` y no queda commiteada:

```bash
export WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres"
npm run dev
```

Usar la connection string **directa** de Supabase (Project Settings > Database > Connection string). Ojo: estás tocando datos reales.

### Variables para drizzle-kit (opcional)

```bash
cp .env.example .env
# DATABASE_URL: para la base docker es postgresql://piubella:piubella@localhost:5499/piubella
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

## API (v1)

Rutas montadas en `src/routes/index.ts`:

- **`/api/agenda`** — `services`, `services/:id`, `categories` (árbol), `availability/:serviceId?date=`, `appointments` (GET por día / POST con validaciones / PATCH estado con snapshot de comisión), `providers`, `company-config`, `trainings`, `machines`, `web` (galería + testimonios), `faq`.
- **`/api/billing`** — `customers` (búsqueda + alta rápida), `customers/:id/invoices`, `checkout` (cobranza orquestada), `invoices` (+ `:id/emit`, `emit-batch`, `:id/cancel`), `payments`, `cash-register` (+ `daily-report`), `commissions`.

Capas: `routes` (Hono + zod) → `services` (lógica de negocio) → `repositories` (Drizzle). El adapter ARCA está en `src/arca/` (interfaz `ArcaClient`, mock por default).

### Catálogo — CRUD admin

Administración de **Servicios**, **Categorías** y **Proveedoras**. El permiso se lee del
JWT de Supabase (`app_metadata.role`) — o de la `API_KEY` estática, que cuenta como
`admin`. Roles válidos: `admin | manager | operator` (matriz en `reglas_negocio.md`).
**"Eliminar" = archivar** (soft-delete, regla 1.3): nunca hace `DELETE` físico.

- **Crear / archivar / restaurar** → solo `admin` (`requireAdmin`).
- **Editar** → `admin`, `manager` u `operator` (`requireRole`).
- **Listar archivados** (`?includeInactive=true`) → solo staff; se ignora para anónimos.

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| `POST` | `/api/agenda/categories` | admin | Crear categoría |
| `PATCH` | `/api/agenda/categories/:id` | staff | Editar (`name`, `description`, `parentCategoryId`, `displayOrder`) |
| `DELETE` | `/api/agenda/categories/:id` | admin | Archivar (`is_active=false`) |
| `POST` | `/api/agenda/categories/:id/restore` | admin | Restaurar |
| `GET` | `/api/agenda/categories?includeInactive=true` | staff | Árbol incluyendo archivadas |
| `POST` | `/api/agenda/services` | admin | Crear servicio |
| `PATCH` | `/api/agenda/services/:id` | staff | Editar core + web (`unitPriceList/Cash`, `taxCategory`, `isVisible`, `isFeatured`, `webSortOrder`, …) |
| `DELETE` | `/api/agenda/services/:id` | admin | Archivar (`is_active=false`) |
| `POST` | `/api/agenda/services/:id/restore` | admin | Restaurar |
| `GET` | `/api/agenda/services?includeInactive=true` | staff | Lista incluyendo archivados |
| `GET` | `/api/agenda/providers/all?includeInactive=true` | staff | Lista admin (incluye datos de contacto / PII) |
| `POST` | `/api/agenda/providers` | admin | Crear proveedora |
| `PATCH` | `/api/agenda/providers/:id` | staff | Editar (`fullName`, `email`, `phone`, `dni`, `cuit`, `specialties`, `notes`, `address`, …) |
| `DELETE` | `/api/agenda/providers/:id` | admin | Archivar (`status='inactive'`) |
| `POST` | `/api/agenda/providers/:id/restore` | admin | Restaurar (`status='active'`) |

> El `GET /api/agenda/providers` público (booking) **no cambió**: devuelve solo campos
> mínimos sin PII. La data sensible va por `GET /api/agenda/providers/all` (staff).

#### Máquinas (Pieza 3B)

CRUD de **Máquinas** + log de **mantenimientos** (`machines`, `machine_maintenance_logs`).
Mismo modelo de permisos. Archivar = `status='inactive'`. Crear un log recalcula
`maintenance_count` / `last_maintenance_at`.

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| `GET` | `/api/agenda/machines?includeInactive=true` | staff | Lista (oculta `inactive` sin el flag) |
| `POST` | `/api/agenda/machines` | admin | Crear máquina |
| `PATCH` | `/api/agenda/machines/:id` | staff | Editar |
| `DELETE` | `/api/agenda/machines/:id` | admin | Archivar (`status='inactive'`) |
| `POST` | `/api/agenda/machines/:id/restore` | admin | Restaurar |
| `GET` | `/api/agenda/machines/:id/logs` | staff | Historial de mantenimientos |
| `POST` | `/api/agenda/machines/:id/logs` | staff | Registrar mantenimiento |
| `PATCH` | `/api/agenda/machines/log/:logId` | staff | Editar mantenimiento |
| `DELETE` | `/api/agenda/machines/log/:logId` | admin | Eliminar mantenimiento (físico) |

> El servicio se vincula a su máquina principal vía `service_machine`: el `PATCH/POST`
> de `services` acepta `machineId` (reemplaza el vínculo) y el `GET` devuelve `primaryMachine`.

### Sitio Web — CRUD admin (Pieza 4)

Contenido de la web pública: visibilidad, destacados, textos, galería, testimonios y FAQ.
Mismo modelo de permisos (editar = staff; crear/archivar/eliminar = admin).

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| `GET` | `/api/agenda/trainings/admin` | staff | Capacitaciones (todas las activas, visibles o no) |
| `PATCH` | `/api/agenda/trainings/:id` | staff | `isVisible`, `isFeatured`, `webSortOrder` |
| `GET` | `/api/agenda/company-config` | público | Textos + datos de empresa + `openHours` |
| `PATCH` | `/api/agenda/company-config` | staff | Editar textos/datos (`heroTitle`, `aboutUs`, contacto, redes, …) |
| `GET` | `/api/agenda/web/gallery` | staff | Items de galería |
| `POST` | `/api/agenda/web/gallery` | admin | Alta de imagen (por `publicUrl`) |
| `PATCH` | `/api/agenda/web/gallery/:id` | staff | Editar / toggle `isVisible` |
| `DELETE` | `/api/agenda/web/gallery/:id` | admin | Eliminar (físico) |
| `GET` | `/api/agenda/web/testimonials` | staff | Testimonios |
| `POST` | `/api/agenda/web/testimonials` | admin | Alta |
| `PATCH` | `/api/agenda/web/testimonials/:id` | staff | Editar / toggle `isVisible` |
| `DELETE` | `/api/agenda/web/testimonials/:id` | admin | Eliminar (físico) |
| `GET` | `/api/agenda/faq?includeInactive=true` | staff | FAQ (oculta `is_active=false` sin el flag) |
| `POST` | `/api/agenda/faq` | admin | Crear FAQ |
| `PATCH` | `/api/agenda/faq/:id` | staff | Editar (`question`, `answer`, `category`, `keywords`, …) |
| `DELETE` | `/api/agenda/faq/:id` | admin | Archivar (`is_active=false`) |
| `POST` | `/api/agenda/faq/:id/restore` | admin | Restaurar |

> **Sin migración nueva:** todas las tablas/columnas ya existen en `init.sql` /
> `1.2.0/reconcile.sql` (`faq`, `web_gallery`, `web_testimonials`, `company_config.hero_*`,
> `about_us`, campos web de `training`). Pieza 4 solo agregó el mapeo Drizzle de `faq`.
> La galería v1 usa `public_url` (URL externa); la subida a Cloudflare R2 queda como sub-tema.

### Configuración (Pieza 5)

Datos de empresa + horarios + gestión de usuarios. **Toda la sección es admin-only.**

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| `PATCH` | `/api/agenda/company-config/open-hours` | staff | Upsert de horarios por día (`{ days: [{ dayOfWeek, openingTime, closingTime, isOpen }] }`) |
| `GET` | `/api/users` | admin | Lista de usuarios (Supabase Auth) |
| `POST` | `/api/users` | admin | Crear usuario (`email`, `password`, `role`) |
| `PATCH` | `/api/users/:id` | admin | Cambiar rol (`admin`\|`manager`\|`operator`) |
| `DELETE` | `/api/users/:id` | admin | Eliminar usuario |

> **Gestión de usuarios — requiere `service_role` de Supabase.** Los endpoints `/api/users`
> usan la Auth Admin API (GoTrue) con el `service_role` (god-mode, **server-side only**).
> Configurar con `wrangler secret put SUPABASE_SERVICE_ROLE_KEY` (y en local, agregarlo a
> `.dev.vars`). Si falta, responden **503** con mensaje claro; el resto de Configuración
> (datos de empresa, horarios) funciona igual. Un admin no puede cambiarse el rol ni borrarse
> a sí mismo (evita lockout).

> **Pendiente (Pieza 2):** acuerdos proveedora↔servicio (`service_provider_service`,
> regla "cerrar viejo + crear nuevo").
>
> **Pendiente (Pieza 5, futuro):** parámetros de reserva (expiración por defecto — necesita
> columna nueva), ARCA solo-lectura y vista de matriz de roles.

## ARCA

`wrangler.toml` define `ARCA_MODE` (`mock` | `afip`), `ARCA_POS` (punto de venta) y `ARCA_INVOICE_TYPE` (`C` para monotributo). El modo `mock` genera CAE falsos y persiste todo en `ARCA_LOGS`, así el flujo completo funciona sin credenciales. Para pasar a real: cuenta en [afipsdk.com](https://docs.afipsdk.com), `wrangler secret put AFIP_CUIT` y `wrangler secret put AFIP_SDK_TOKEN`, y `ARCA_MODE = "afip"` (ver TODOs en `src/arca/afip-client.ts`).

## Migración pendiente en Supabase

`src/db/migrations/1.1.0/sync.sql` es **idempotente** y debe correrse una vez contra Supabase: agrega `payments.received_by_provider_id` (pago transferido directo a la profesional) e índices de soporte, y garantiza que estén los cambios documentados en `DOCUMENTACION_BD.md` v2.1/v2.2 (precios lista/efectivo, `service_provider_service`, snapshots de comisión, etc.) por si alguno faltara.

```bash
psql "$DATABASE_URL" -f src/db/migrations/1.1.0/sync.sql
```

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
