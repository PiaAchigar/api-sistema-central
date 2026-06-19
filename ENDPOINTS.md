# API Endpoints — piubella-worker

**Base URL (dev):** `https://piubella-worker-dev.piubella-account.workers.dev`

---

## Sin autenticación

| Método | Path | Descripción |
|--------|------|-------------|
| GET | `/` | Info del worker |
| GET | `/api/health` | Health check + ping a la DB |

---

## Agenda — públicos (widget de reservas)

No requieren `Authorization` header.

| Método | Path | Query params |
|--------|------|-------------|
| GET | `/api/agenda/categories` | — |
| GET | `/api/agenda/services` | `?categoryId` `?q` |
| GET | `/api/agenda/services/:id` | — |
| GET | `/api/agenda/providers` | `?serviceId` |
| GET | `/api/agenda/providers/schedule` | `?date` (YYYY-MM-DD) |
| GET | `/api/agenda/providers/:id/services` | — |
| GET | `/api/agenda/availability/:serviceId` | `?date` (YYYY-MM-DD) · `?providerId` |
| GET | `/api/agenda/company-config` | — |
| POST | `/api/agenda/appointments` | crear turno desde el widget |

### Body: `POST /api/agenda/appointments`
```json
{
  "customerId": "uuid",
  "serviceId": "uuid",
  "providerId": "uuid",
  "machineId": "uuid (opcional)",
  "start": "2026-06-18T10:00:00-03:00",
  "priceMode": "list | cash (opcional)",
  "notes": "opcional",
  "status": "scheduled | reserved (opcional)",
  "expiryMinutes": 30
}
```

---

## Agenda — requieren auth (panel admin)

Header requerido: `Authorization: Bearer <supabase_access_token>`

| Método | Path | Query params / Body |
|--------|------|---------------------|
| GET | `/api/agenda/appointments` | `?date` (YYYY-MM-DD) · `?providerId` · `?status` |
| PATCH | `/api/agenda/appointments/:id` | `{ status?, notes? }` |
| PATCH | `/api/agenda/appointments/:id/reschedule` | `{ newStart: ISO datetime }` |

### Status válidos
- `reserved` → `scheduled` → `completed`
- `cancelled`, `no_show`

---

## Billing — todos requieren auth

Header requerido: `Authorization: Bearer <supabase_access_token>`

### Clientes

| Método | Path | Query / Body |
|--------|------|-------------|
| GET | `/api/billing/customers` | `?q` (búsqueda por nombre/DNI) |
| POST | `/api/billing/customers` | `{ name, dni, phone?, email? }` |
| GET | `/api/billing/customers/:id/invoices` | — |

### Checkout

| Método | Path | |
|--------|------|---|
| POST | `/api/billing/checkout` | ver body abajo |

```json
{
  "customerId": "uuid",
  "appointmentId": "uuid (opcional)",
  "items": [
    { "serviceId": "uuid", "quantity": 1, "priceMode": "list | cash" }
  ],
  "payment": {
    "method": "cash | bank_transfer | mercadopago",
    "amount": 5000,
    "wantsInvoice": true,
    "paidToProviderId": "uuid (opcional)"
  },
  "notes": "opcional"
}
```

### Facturas

| Método | Path | Query / Body |
|--------|------|-------------|
| GET | `/api/billing/invoices` | `?status` · `?customerId` · `?from` · `?to` (YYYY-MM-DD) |
| POST | `/api/billing/invoices` | `{ customerId, items[], adjustmentAmount?, description? }` |
| GET | `/api/billing/invoices/:id` | — |
| POST | `/api/billing/invoices/:id/emit` | — |
| POST | `/api/billing/invoices/emit-batch` | `{ invoiceIds?: uuid[] }` (vacío = todos los drafts) |
| POST | `/api/billing/invoices/:id/cancel` | `{ reason?: string }` |

### Status de factura
`draft` → `emitted` → `paid` · `cancelled`

### Pagos

| Método | Path | Query |
|--------|------|-------|
| GET | `/api/billing/payments` | `?date` (YYYY-MM-DD) · `?method` (cash / bank_transfer / mercadopago) |

### Caja

| Método | Path | Query / Body |
|--------|------|-------------|
| GET | `/api/billing/cash-register` | `?date` (YYYY-MM-DD, default hoy) |
| POST | `/api/billing/cash-register` | `{ amount, source, description, isDeclared }` |
| GET | `/api/billing/cash-register/daily-report` | `?date` (YYYY-MM-DD, default hoy) |

### Source de movimiento manual
`deposit` · `refund` · `other`

### Comisiones

| Método | Path | Query |
|--------|------|-------|
| GET | `/api/billing/commissions` | `?from` · `?to` (YYYY-MM-DD, ambos requeridos) · `?providerId` |

---

## Autenticación

El token lo provee Supabase al hacer login en el frontend:

```
Authorization: Bearer <supabase_access_token>
```

Para que el Worker valide el token, el secret debe estar configurado:

```bash
wrangler secret put SUPABASE_JWT_SECRET
# → pegar el valor de: Supabase > Settings > API > JWT Secret
```

**Dev local** — crear `.dev.vars` en la raíz del proyecto (no commitear):
```
SUPABASE_JWT_SECRET=tu-jwt-secret
```

---

## CORS

Orígenes permitidos:
- `http://localhost:3000`
- `http://localhost:5173`
- `https://*.vercel.app`
