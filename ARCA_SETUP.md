# Puesta en marcha de ARCA (facturación electrónica)

Guía de cero para conectar el facturador con ARCA (ex-AFIP) usando **Afip SDK**.
Pensada para **monotributo → Factura C**.

> **Regla de oro:** primero hacés que funcione todo en **homologación** (ambiente de
> prueba, no emite facturas reales). Recién cuando emitís un CAE de prueba OK,
> repetís los mismos pasos para **producción**. Son dos certificados distintos.

---

## Glosario rápido (qué es cada cosa)

| Término | Qué es |
|---------|--------|
| **Clave Fiscal** | Tu usuario/contraseña para entrar a ARCA. Necesitás **nivel 3**. |
| **Certificado digital (.crt)** | El "DNI" de tu sistema ante ARCA. Lo genera ARCA a partir de un pedido (CSR). |
| **Clave privada (.key)** | El archivo secreto que va de la mano del certificado. La generás vos. |
| **CSR** | "Pedido de certificado". Un archivo que generás con OpenSSL y subís a ARCA. |
| **wsfe** | El web service de Facturación Electrónica de ARCA. Es el que hay que autorizar. |
| **Punto de Venta (PV)** | Número que identifica desde dónde emitís (ej: `2` → `0002`). Hay que crearlo para "Web Services". |
| **CAE** | El código que devuelve ARCA cuando aprueba una factura. Sin CAE, la factura no es válida. |
| **Homologación** | Ambiente de prueba de ARCA. CAE de mentira, sin valor fiscal. |
| **Afip SDK** | Servicio intermediario (app.afipsdk.com) que nos evita lidiar con SOAP/certificados a mano. |

---

## Requisitos previos

- [ ] Tener **Clave Fiscal nivel 3** del CUIT que va a facturar.
  (Si es nivel 2, se sube en el cajero del banco o con la app "Mi ARCA".)
- [ ] Tener **OpenSSL** instalado (en Mac/Linux ya viene). Verificá con `openssl version`.
- [ ] Crear una cuenta gratuita en **https://app.afipsdk.com**.

---

# PARTE 1 — Homologación (ambiente de prueba)

## 1.1 — Habilitar el "Administrador de Certificados de Testing" en ARCA

1. Entrá a ARCA con tu Clave Fiscal → escritorio de servicios.
2. Buscá y agregá el servicio **"WSASS - Autogestión Certificados Homologación"**
   (Administrador → "Adherir servicio").

## 1.2 — Generar tu clave privada y el CSR (en tu compu)

En una terminal, parado en una carpeta segura (NO dentro del repo):

```bash
# 1. Generar la clave privada (NO compartir nunca este archivo)
openssl genrsa -traditional -out piubella-homo.key 2048

# 2. Generar el CSR (reemplazá el CUIT por el tuyo, sin guiones)
openssl req -new -key piubella-homo.key \
  -subj "/C=AR/O=PiuBella/CN=piubella/serialNumber=CUIT 20349878829" \
  -out piubella-homo.csr
```

Te quedan dos archivos: `piubella-homo.key` (secreto) y `piubella-homo.csr` (el pedido).

## 1.3 — Subir el CSR a ARCA y descargar el certificado

1. En ARCA, entrá a **"WSASS - Autogestión Certificados Homologación"**.
2. Opción **"Crear DN y obtener certificado"** → pegá/subí el contenido del `.csr`.
3. ARCA te devuelve el certificado → guardalo como `piubella-homo.crt`.

## 1.4 — Autorizar el web service `wsfe`

1. En el mismo WSASS de testing, opción **"Agregar adhesión a WSN"** (o "Autorizar web service").
2. Elegí el servicio **`wsfe`** (Facturación Electrónica) y asocialo a tu certificado.

## 1.5 — Obtener el Access Token de Afip SDK

> **Importante:** en Afip SDK **no se sube** el certificado a ningún dashboard.
> El certificado y la clave viajan en cada request (los manda nuestro Worker).
> De afipsdk.com solo necesitás el **Access Token**.

1. Entrá a **https://app.afipsdk.com** → tu cuenta.
2. Copiá tu **Access Token** → ese es el `AFIP_SDK_TOKEN`.

## 1.6 — Configurar el Worker para homologación

El cert y la key son PEM **multilínea**, que no entran cómodos en `.dev.vars`.
Por eso los pasamos en **base64 (una sola línea)**. Generalos así:

```bash
# Devuelven el contenido en base64, una línea (copiá el output de cada uno)
base64 -i piubella-homo.crt | tr -d '\n'   # → AFIP_CERT
base64 -i piubella-homo.key | tr -d '\n'   # → AFIP_KEY
```

Creá/editá **`.dev.vars`** en la raíz de `facturador/` (NO se commitea):

```
ARCA_MODE=afip
ARCA_ENV=homo
AFIP_CUIT=20XXXXXXXXX
AFIP_SDK_TOKEN=el-token-de-afipsdk
AFIP_CERT=<el base64 del .crt>
AFIP_KEY=<el base64 del .key>
```

> El código acepta tanto base64 como PEM crudo: si pegás el PEM con `-----BEGIN`
> lo usa tal cual; si no, lo decodifica de base64. Con `ARCA_ENV=homo` pega
> contra el ambiente de prueba de ARCA.

## 1.7 — Probar

Levantá el worker (`npm run dev`) y emití una factura de prueba:

```bash
# 1. Crear un draft (ajustá los UUID a datos reales de tu DB)
curl -X POST "http://localhost:8787/api/billing/invoices" \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"customerId":"<uuid>","items":[{"serviceId":"<uuid>","quantity":1}]}'

# 2. Emitir ese draft (pide CAE a ARCA homologación)
curl -X POST "http://localhost:8787/api/billing/invoices/<id>/emit" \
  -H "x-api-key: $API_KEY"
```

✅ Si la respuesta trae un `CAE`, **funcionó**.
❌ Si trae error, el detalle de ARCA queda guardado en los `arca_logs` de la factura
(`GET /api/billing/invoices/<id>` lo muestra). Mandámelo y ajustamos el campo que observe.

---

# PARTE 2 — Producción (facturas reales)

Mismos pasos que la Parte 1, pero en los servicios de **producción** de ARCA:

| Homologación | Producción |
|--------------|------------|
| WSASS - Certificados **Homologación** | **"Administración de Certificados Digitales"** (producción) |
| `wsfe` de testing | `wsfe` de producción, vía **"Administrador de Relaciones de Clave Fiscal"** |

## 2.1 — Generar otro certificado (de producción)

```bash
openssl genrsa -traditional -out piubella-prod.key 2048
openssl req -new -key piubella-prod.key \
  -subj "/C=AR/O=PiuBella/CN=piubella/serialNumber=CUIT 20XXXXXXXXX" \
  -out piubella-prod.csr
```

## 2.2 — Subir el CSR en ARCA producción

ARCA → **"Administración de Certificados Digitales"** → "Agregar alias" → subir el `.csr`
→ "ver" → descargar el `.crt`.

## 2.3 — Autorizar `wsfe` en producción

ARCA → **"Administrador de Relaciones de Clave Fiscal"** → **"Nueva Relación"**
→ Representado: tu CUIT → "Buscar" → **ARCA > Web Services > Facturación Electrónica (wsfe)**
→ segundo "Buscar" → elegí tu certificado → **Confirmar**.

## 2.4 — Crear el Punto de Venta para Web Services

ARCA → **"Administración de puntos de venta y domicilios"** (ABM Puntos de Venta)
→ crear un PV de tipo **"Factura Electrónica - Monotributo - Web Services"**.
El número que te asigne es tu **`ARCA_POS`** (ej: `2`).

> Importante: el PV de "Comprobantes en línea" (web manual) **no** sirve para web service.
> Tiene que ser uno de tipo Web Services, distinto número.

## 2.5 — Configurar los secretos de producción y activar prod

En producción el cert/key van como **secretos del Worker** (NO en `.dev.vars`).
`wrangler secret put` acepta el PEM multilínea directo desde el archivo:

```bash
wrangler secret put AFIP_CUIT                       # tu CUIT
wrangler secret put AFIP_SDK_TOKEN                  # token de afipsdk
wrangler secret put AFIP_CERT < piubella-prod.crt   # certificado (PEM directo)
wrangler secret put AFIP_KEY  < piubella-prod.key   # clave privada (PEM directo)
```

En `wrangler.toml` ajustá las vars no secretas:

```toml
ARCA_MODE = "afip"
ARCA_ENV  = "prod"          # ← activa el ambiente de producción de ARCA
ARCA_POS  = "<nº del PV de producción>"
```

Con `ARCA_ENV=prod` el cliente apunta a los endpoints reales de ARCA. (El switch
ya está cableado en el código vía esa variable; no hay nada hardcodeado.)

---

## Checklist resumida

**Homologación**
- [ ] Clave Fiscal nivel 3
- [ ] Servicio WSASS testing habilitado
- [ ] Certificado `.crt` + `.key` de testing
- [ ] `wsfe` autorizado (testing)
- [ ] Access Token de Afip SDK copiado
- [ ] `.dev.vars` con `ARCA_MODE=afip`, `ARCA_ENV=homo`, CUIT, token, cert/key (base64)
- [ ] Factura de prueba con CAE OK

**Producción**
- [ ] Administración de Certificados Digitales habilitada
- [ ] Certificado `.crt` + `.key` de producción
- [ ] `wsfe` autorizado en Administrador de Relaciones
- [ ] Punto de Venta tipo Web Services creado → `ARCA_POS`
- [ ] Secretos `AFIP_CUIT`, `AFIP_SDK_TOKEN`, `AFIP_CERT`, `AFIP_KEY` en el Worker
- [ ] `ARCA_ENV = "prod"` en `wrangler.toml`
- [ ] Primera factura real con CAE OK

---

## Notas de seguridad

- Los archivos `.key` **nunca** se commitean ni se comparten. Son la llave de tu facturación.
- El `AFIP_SDK_TOKEN` y el `AFIP_CUIT` van como **secretos** en producción
  (`wrangler secret put`), nunca en `wrangler.toml`.
- Guardá los `.crt`/`.key` en un lugar seguro (gestor de contraseñas / bóveda).


OK. Autorización fue creada (CUITCOMPUTADOR=20349878829, ALIASCOMPUTADOR=piubella, CUITREPRESENTADO=20349878829, SERVICIO=ws://wsfe, CUITAUTORIZANTE=20349878829).