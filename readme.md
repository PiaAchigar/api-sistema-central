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
- **`/api/crm`** — `contacts`, `deals`, `customers/:id/purchases` + `purchases` (catálogo de venta, cotizar, vender, cancelar, devolver — ver más abajo), `credits`, `channels`, `conversations`, `automations`, `automation-faqs`.

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

### CRM — Compras (venta de packs, combos, servicios y paquetes de promo)

Todo lo que se puede vender pasa por `/api/crm/purchases`. El permiso es el de
quien vende (`crm.view` para leer/cotizar, `crm.edit` para vender/cancelar),
no el de catálogo.

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| `GET` | `/api/crm/customers/:id/purchases` | crm.view | Compras de la clienta: qué llevó, cuánto pagó/debe, estado de cada sesión |
| `GET` | `/api/crm/purchases/catalog` | crm.view | Todo lo vendible (combos, packs de depilación, servicios, capacitaciones) + promos vigentes, en una sola llamada |
| `POST` | `/api/crm/purchases/quote` | crm.view | Cotiza sin vender (ver abajo) |
| `POST` | `/api/crm/purchases` | crm.edit | Vende (ver abajo) |
| `POST` | `/api/crm/purchases/:id/cancel` | crm.edit | Cancela (no borra) |
| `GET` | `/api/crm/purchases/:id/delete-impact` | crm.view | Qué cuelga de la compra, antes de ofrecer borrarla |
| `DELETE` | `/api/crm/purchases/:id` | crm.edit | Borra para siempre (solo si no cuelga nada) |
| `GET` | `/api/crm/purchases/:id/refund-check` | crm.view | Si se le puede devolver la plata, y cuánta |
| `POST` | `/api/crm/purchases/:id/refund` | admin | Devuelve la plata en mano |

#### `POST /api/crm/purchases/quote` — paquete de promo

Desde la 1.55.0, además de cotizar un combo/servicio/pack/capacitación suelto
(`{ origen, id, sessions, promotionId? }`), esta misma ruta cotiza una
**promo de tipo paquete**: se manda la promo sola, sin origen — lo que lleva
sale de sus `promotion_target`.

```json
// Request
{ "origen": "paquete", "promotionId": "b6b6b6b6-...-promo-novia" }
```

```json
// Response
{
  "description": "Promo Novia",
  "sessionsTotal": 1,
  "promotionId": "b6b6b6b6-...-promo-novia",
  "expiresAt": null,
  "baseAmount": 335000,
  "discountedAmount": 250000,
  "finalAmount": 250000,
  "esPaquete": true,
  "comboId": null,
  "depilationComboId": null,
  "serviceId": null,
  "trainingId": null
}
```

`baseAmount` es la suma de los precios de lista de todo lo que lleva el
paquete (para poder mostrar "valen $335.000 — te los llevás por $250.000").
`discountedAmount` y `finalAmount` son el `precio_del_paquete` cargado en la
promo. La respuesta ya viene lista para mandarse tal cual a
`POST /api/crm/purchases`, igual que la cotización de una venta suelta.

Si algún destino de la promo no tiene precio resoluble —un pack de depilación
`kind: "guardado"` (zonas a elección, sin `fixed_price`), un combo o servicio
sin precio cargado, o una promo sin `precio_del_paquete`— la ruta responde
`400` nombrando qué falta, en vez de cotizar con un número inventado.

#### `POST /api/crm/purchases` — vender el paquete entero

```json
// Request
{
  "customerId": "3f3f3f3f-...-cliente",
  "esPaquete": true,
  "promotionId": "b6b6b6b6-...-promo-novia",
  "description": "Promo Novia",
  "sessionsTotal": 1,
  "baseAmount": 335000,
  "discountedAmount": 250000,
  "finalAmount": 250000,
  "expiresAt": null
}
```

```json
// Response (201) — la cabecera de la compra (customerPurchase)
{
  "id": "c1c1c1c1-...-compra",
  "customerId": "3f3f3f3f-...-cliente",
  "comboId": null,
  "serviceId": null,
  "depilationComboId": null,
  "trainingId": null,
  "esPaqueteDePromo": true,
  "promotionId": "b6b6b6b6-...-promo-novia",
  "promotionName": "Promo Novia",
  "description": "Promo Novia",
  "sessionsTotal": 1,
  "baseAmount": "335000.00",
  "discountedAmount": "250000.00",
  "finalAmount": "250000.00",
  "purchasedAt": "2026-09-22T15:00:00.000Z",
  "expiresAt": null,
  "cancelledAt": null,
  "notes": null,
  "pagadoConSaldo": 0
}
```

`esPaquete: true` no lleva `comboId`/`serviceId`/`depilationComboId`/
`trainingId` (el `refine` de `compraBody` lo exige así), pero sí
`promotionId`: de ahí sale, del lado del servidor, qué lleva el paquete y
cómo se reparte el precio entre sus líneas. Cada línea se inserta en
`customer_purchase_service` con su propia identidad (`service_id`,
`depilation_combo_id` o `training_id`) y su propio `orden` — la respuesta de
este POST es solo la cabecera; las líneas se ven después con
`GET /api/crm/customers/:id/purchases`, que es de donde la ficha de la
clienta saca el nombre de cada una.

### Sitio Web — lectura pública (lo que consume `piubella_web`)

Estas son **todas** las rutas que el sitio público le pide al Worker. La lista
sale de `piubella_web/src/lib/worker-api.ts`, que es el único lugar del sitio
que habla con la API: si una ruta no está acá, la web no la usa.

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/agenda/categories` | Árbol de categorías. La web descarta las de `kind='area'`: cada servicio ya cuelga de su técnica, así que mostrarlas duplicaría el árbol |
| `GET` | `/api/agenda/services?categoryId=&q=&featured=` | Servicios, filtrables por categoría, texto o destacados |
| `GET` | `/api/agenda/availability/:serviceId?date=YYYY-MM-DD` | Slots disponibles |
| `GET` | `/api/agenda/company-config` | Textos, contacto y horarios |
| `GET` | `/api/agenda/promotions?featured=true` | Promos vigentes y con `is_visible_web`, con sus `targets` (1.53.0) |
| `GET` | `/api/agenda/combos` | Combos y packs con `is_visible_web` |
| `GET` | `/api/agenda/depilacion/packs-publicos` | Packs de depilación con `is_published_web` |
| `GET` | `/api/agenda/trainings?featured=true` | Capacitaciones visibles |
| `GET` | `/api/agenda/activities` | Actividades (Pilates, Thermobike) |

> **Sin `auth`.** Es catálogo: lo lee cualquiera que abra la página. Verificado
> en vivo para `/combos` y `/depilacion/packs-publicos`; el resto sigue el mismo
> criterio desde antes.

#### `GET /api/agenda/combos`

Devuelve el combo con sus renglones y **sus dos precios**:

- `servicesSubtotal` — la suma de los precios de lista de los servicios que
  incluye. Es el número que la web **tacha**.
- `finalAmount` — lo que sale el combo.

Y, desde el rediseño de `/servicios` (2026-09-18), **dos formas de agrupar que
no son lo mismo**:

- `areaCategoryId` / `areaName` — el **área** del combo (son 6: Estética,
  Depilación Definitiva, Medicina y Dermatología, Masajes y Bienestar,
  Actividades, Capacitaciones). Es el título cuando se toca el botón "Combos".
- `clasificaciones: [{ id, name }]` — las **clasificaciones** donde el combo
  aparece dentro del árbol del menú (son 8: las categorías raíz que no son
  áreas). Un combo sale en **cada** clasificación que tenga alguno de sus
  servicios, así que la lista puede traer más de una y eso es querido:
  `Combo1-prueba` es del área Estética pero sus servicios caen en Belleza y en
  Tratamientos Médicos, así que aparece en las dos.

Un **pack** (`kind='pack'`) no tiene renglones propios: repite otro combo. Sus
clasificaciones se resuelven por `COALESCE(pack_of_combo_id, id)`, o saldría sin
ninguna y desaparecería del árbol.

#### `GET /api/agenda/depilacion/packs-publicos`

Los packs de depilación que se muestran en la web. Filtra `kind='pack_fijo'`,
`is_active` y **`is_published_web`**.

```json
[{ "id": "…", "name": "Cuerpo Full", "description": null,
   "fixedPrice": 65000, "fixedDurationMinutes": 90,
   "choiceZoneCount": 0, "zonas": ["Axilas", "Piernas completas"] }]
```

`choiceZoneCount > 0` significa que la clienta elige esa cantidad de zonas
**además** de las de `zonas`.

> **No confundir con `listarPacksFijos`**, que alimenta `/cotizar`: ésa trae
> todos los activos —publicados o no— y devuelve **ids** de zona, no nombres.
> Son dos lecturas distintas de la misma tabla y tienen que seguir siéndolo.

> **Sin precio tachado, a propósito.** `depilation_combo` guarda `fixed_price` y
> no hay contra qué compararlo, así que la card no muestra tachado. Inventar uno
> sería mentirle a la clienta.

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

Guías paso a paso:

- **[`FACTURADORES.md`](./FACTURADORES.md)** — multi-facturador: dar de alta varias identidades fiscales (cada una con su CUIT, certificado y numeración) y elegir cuál factura en cada cobranza. **Empezá por acá.**
- **[`ARCA_SETUP.md`](./ARCA_SETUP.md)** — los trámites en ARCA para conseguir el certificado, autorizar `wsfe` y crear el punto de venta. Se hacen una vez por cada CUIT.

`wrangler.toml` define `ARCA_MODE` (`mock` | `afip`), `ARCA_POS` (punto de venta) y `ARCA_INVOICE_TYPE` (`C` para monotributo). El modo `mock` genera CAE falsos y persiste todo en `ARCA_LOGS`, así el flujo completo funciona sin credenciales.

Las credenciales de cada facturador viven **cifradas en la tabla `arca_issuers`** y se administran desde el dashboard (Configuración → Facturadores). El único secreto que hace falta en el Worker es `ARCA_SECRETS_KEY`, la llave maestra que las cifra:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npx wrangler secret put ARCA_SECRETS_KEY
```

Las variables `AFIP_CUIT` / `AFIP_SDK_TOKEN` / `AFIP_CERT` / `AFIP_KEY` quedan como respaldo para instalaciones sin facturadores cargados, y son las que lee `POST /api/billing/issuers/import-from-env` para migrar el emisor original a la base.

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
- **`fetch_types: false` tiene una consecuencia que muerde: no se pueden pasar arrays como parametro.**
  Sin poder averiguar el OID del array, `postgres.js` lo aplasta a un escalar y Postgres contesta
  `malformed array literal`. En un fragmento `sql` crudo, entonces, nunca `= ANY(${ids})`: los ids
  van expandidos a un parametro cada uno — `IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})` —
  o directamente con el helper `inArray()` de Drizzle, que hace lo mismo. Esto dejo
  `GET /api/agenda/combos` en 500 el 2026-09-22, y **no lo agarra un test cuyo cliente use las
  opciones por defecto**: el cliente de prueba tiene que repetir las de produccion.

## Recursos

- [Documentacion de Hyperdrive](https://developers.cloudflare.com/hyperdrive/)
- [Hyperdrive + Drizzle](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/)
- [Hyperdrive + Supabase](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/)
- [Hono](https://hono.dev/)
- [Drizzle ORM](https://orm.drizzle.team/)
