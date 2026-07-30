# Facturadores ARCA (multi-emisor)

Cómo dar de alta **varias identidades fiscales** para que cada una facture con su
propio CUIT, certificado y numeración, y se elija cuál usar en cada cobranza.

> Ejemplo: Gastón factura con su monotributo, Pepe con el suyo. En Cobranza aparece
> un selector **"Facturar como"** y cada factura queda ligada al facturador elegido.

**Los trámites en ARCA (sacar el certificado) están en [`ARCA_SETUP.md`](./ARCA_SETUP.md)**
— hay que hacerlos **una vez por cada CUIT** que vaya a facturar. Este documento
cubre qué hacer *después*: cargar esas credenciales en el sistema.

---

## Cómo funciona (resumen)

| | Antes | Ahora |
|---|---|---|
| Dónde viven las credenciales | Variables del Worker (`AFIP_CERT`, `AFIP_KEY`…) | Tabla `arca_issuers`, **cifradas** |
| Cuántos emisores | Uno solo | Los que quieras |
| Quién los administra | Deploy / `wrangler secret put` | Dashboard → **Configuración → Facturadores** |
| Cómo se elige | No se elegía | Selector en **Cobranza** |

Cada factura guarda con qué facturador se creó (`invoices.issuer_id`). Eso manda
en todo lo que viene después: la emisión usa **sus** credenciales, la nota de
crédito la emite el mismo CUIT, el PDF arma el QR con sus datos, y la numeración
es independiente por facturador (cada CUIT + punto de venta lleva su propia serie).

### Seguridad

El token de Afip SDK, el certificado y la clave privada se guardan **cifrados con
AES-GCM**. La llave maestra es el secreto `ARCA_SECRETS_KEY` del Worker y **nunca
se guarda en la base**: con un dump de Postgres solo no se puede facturar a nombre
de nadie. La API nunca devuelve las credenciales — solo permite reemplazarlas.

---

# PARTE 1 — Preparar el entorno (una sola vez)

## 1.1 — Generar la llave maestra

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Guardala en el gestor de contraseñas. **Si se pierde, hay que volver a cargar
todos los certificados** (las credenciales guardadas quedan ilegibles).

### En local

Agregala a `facturador/.dev.vars` (no se commitea):

```
ARCA_SECRETS_KEY=<lo que devolvió el comando>
```

### En producción

```bash
cd facturador
npx wrangler secret put ARCA_SECRETS_KEY
# pegá el valor cuando lo pida
```

> Sin este secreto, los endpoints de facturadores responden **503** con el mensaje
> "Falta el secreto ARCA_SECRETS_KEY del Worker".

## 1.2 — Aplicar la migración `1.9.0`

Crea la tabla `arca_issuers` y la columna `invoices.issuer_id`.

**Base local nueva** (se aplica sola, está en el `docker-compose.yml`):

```bash
cd facturador
npm run db:reset   # ⚠️ borra todos los datos locales
```

**Base local que ya existe** (los scripts de `docker-entrypoint-initdb.d` solo
corren en el primer arranque, así que hay que aplicarla a mano):

```bash
cd facturador
docker compose exec -T db psql -U piubella -d piubella -v ON_ERROR_STOP=1 \
  < src/db/migrations/1.9.0/arca-issuers.sql
```

**Producción (Supabase):** correr el mismo archivo en el SQL Editor. Es idempotente
(se puede correr más de una vez sin romper).

Verificar:

```bash
npm run db:psql -- -c "\d arca_issuers"
```

## 1.3 — Levantar todo en local

```bash
cd facturador       && npm run db:up && npm run dev   # API   → :8787
cd front-biller     && npm run dev                    # biller   → :5174
cd front-agenda     && npm run dev                    # agenda   → :5173
cd front-dashboard  && npm run dev                    # dashboard→ :5175
```

Se entra siempre por el **dashboard** (`http://localhost:5175`): agenda y
facturación van embebidas ahí adentro.

## 1.4 — Migrar el facturador que ya estaba configurado

Si el Worker ya tenía `AFIP_CUIT` / `AFIP_SDK_TOKEN` / `AFIP_CERT` / `AFIP_KEY`,
este endpoint los pasa a la base sin copiar el certificado a mano. Queda como
**predeterminado**:

```bash
curl -X POST "http://localhost:8787/api/billing/issuers/import-from-env" \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Gastón"}'
```

Es idempotente: si ya existe uno con ese nombre, no hace nada (`"imported": false`).

> En producción, mismo request contra la URL del Worker, con un token de admin
> (`Authorization: Bearer <access_token>`) o la API key.

---

# PARTE 2 — Dar de alta un facturador nuevo

Ejemplo: sumar a **Pepe**, que tiene su propio CUIT.

## 2.1 — Trámites en ARCA (con la Clave Fiscal de Pepe)

Seguir [`ARCA_SETUP.md`](./ARCA_SETUP.md) **completo con el CUIT de Pepe**. Resumen:

1. **Clave Fiscal nivel 3** del CUIT que va a facturar.
2. Generar clave privada + CSR (en una carpeta segura, **fuera del repo**):
   ```bash
   openssl genrsa -traditional -out pepe-prod.key 2048
   openssl req -new -key pepe-prod.key \
     -subj "/C=AR/O=PiuBella/CN=pepe/serialNumber=CUIT 20111111112" \
     -out pepe-prod.csr
   ```
3. Subir el `.csr` en ARCA → descargar el `.crt`.
4. Autorizar el web service **`wsfe`** para ese certificado.
5. Crear un **Punto de Venta tipo "Web Services"** → ese número es el punto de venta
   del facturador. (El de "Comprobantes en línea" **no** sirve.)
6. Access Token de **app.afipsdk.com** (puede ser el mismo de la cuenta, o uno propio).

> **Empezar siempre por homologación.** Es el ambiente de prueba de ARCA: emite CAE
> sin valor fiscal. Recién cuando sale un CAE OK, se repite con los servicios de
> producción y se cambia el facturador a `prod`.

## 2.2 — Cargarlo en el sistema

### Opción A — Desde el dashboard (recomendado)

1. **Configuración → Facturadores → Agregar**.
2. Completar:

   | Campo | Qué poner |
   |---|---|
   | **Nombre** | Lo que se ve en el selector de Cobranza (ej: `Pepe`) |
   | **CUIT** | 11 dígitos, sin guiones |
   | **Ambiente** | `Homologación` para probar, `Producción` para facturar de verdad |
   | **Punto de venta** | El PV de tipo Web Services creado en 2.1 |
   | **Comprobante** | `C` para monotributo |
   | **Token de Afip SDK** | El Access Token de app.afipsdk.com |
   | **Certificado .crt** | Pegar el contenido completo del archivo (con `-----BEGIN…`) |
   | **Clave privada .key** | Ídem |

3. Tildar **"Usar como facturador predeterminado"** solo si tiene que venir
   preseleccionado en Cobranza.

### Opción B — Por API

El PEM es multilínea y hay que escaparlo para JSON. Este comando arma el payload
desde los archivos:

```bash
python3 -c "
import json,sys
print(json.dumps({
  'name': sys.argv[1], 'cuit': sys.argv[2], 'sdkToken': sys.argv[3],
  'cert': open(sys.argv[4]).read(), 'key': open(sys.argv[5]).read(),
  'environment': sys.argv[6], 'pointOfSale': int(sys.argv[7]), 'invoiceType': 'C',
}))" "Pepe" "20111111112" "$SDK_TOKEN" pepe-prod.crt pepe-prod.key homo 3 > /tmp/pepe.json

curl -X POST "http://localhost:8787/api/billing/issuers" \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d @/tmp/pepe.json

rm /tmp/pepe.json   # no dejar la clave privada dando vueltas
```

## 2.3 — Probar que factura

1. **Cobranza** → elegir cliente y servicio → tildar **"Lleva factura"**.
2. En **"Facturar como"** elegir `Pepe`. Debajo se ve su CUIT, punto de venta y,
   si está en homologación, un aviso en ámbar.
3. **Cobrar** → queda una factura en borrador.
4. **Facturas** → abrirla → **Emitir**.

✅ Si vuelve con **CAE**, funcionó.
❌ Si falla, el detalle de ARCA queda en los `arca_logs` de esa factura
(`GET /api/billing/invoices/<id>`).

Chequeo por consola de que quedó bien asociada:

```bash
cd facturador
npm run db:psql -- -c "
select i.name as facturador, i.cuit, i.point_of_sale, inv.invoice_number, inv.status
from invoices inv join arca_issuers i on i.id = inv.issuer_id
order by inv.created_at desc limit 5;"
```

## 2.4 — Pasar de homologación a producción

Cuando el CAE de prueba salió OK:

1. Repetir 2.1 en los servicios de **producción** de ARCA (es **otro** certificado).
2. **Configuración → Facturadores** → clic en el nombre → cambiar **Ambiente** a
   `Producción`, actualizar el **punto de venta** de producción y **pegar el
   certificado y la clave nuevos**.

> Los campos de credenciales vacíos **conservan** las guardadas. Solo se reemplaza
> lo que se pega. Por eso, al pasar a producción hay que pegar sí o sí el cert/key
> nuevos: si no, seguiría intentando con los de homologación (y ARCA los rechaza).

---

## Operaciones frecuentes

| Qué | Cómo |
|---|---|
| Cambiar el predeterminado | Facturadores → **"Hacer predeterminado"** en la fila |
| Dar de baja uno | Ícono de tacho. Es baja lógica: desaparece del selector pero las facturas emitidas con ese CUIT quedan intactas |
| Renovar un certificado vencido | Editar el facturador y pegar el `.crt`/`.key` nuevos |
| Ver con qué CUIT salió cada factura | Columna **Facturador** en la pantalla de Facturas |

No se puede desactivar ni dar de baja el facturador **predeterminado**: primero
hay que marcar otro como predeterminado.

---

## Problemas comunes

| Mensaje | Qué pasó |
|---|---|
| `Falta el secreto ARCA_SECRETS_KEY del Worker` (503) | No está la llave maestra. Ver 1.1 |
| `No se pudo descifrar la credencial de ARCA: ARCA_SECRETS_KEY no coincide` | La llave maestra actual no es la que cifró esos datos (se rotó o se pisó). Volver a cargar cert/key/token de cada facturador |
| `El token proporcionado es invalido` | El Access Token de Afip SDK está mal o no corresponde a ese ambiente |
| `column arca_issuers does not exist` | Falta correr la migración `1.9.0`. Ver 1.2 |
| `El facturador "X" está desactivado` | Se intentó facturar con uno dado de baja |
| ARCA rechaza con error de numeración | El punto de venta no es de tipo **Web Services**, o se está usando el PV de otro CUIT |

---

## Notas

- Los `.key` **nunca** se commitean ni se comparten: son la llave de la facturación
  de esa persona.
- En **desarrollo**, si `ARCA_MODE=mock` en `.dev.vars`/`wrangler.toml`, todo el
  circuito multi-facturador funciona igual pero con CAE simulados: se puede probar
  el selector sin certificados reales.
- La numeración es **por facturador**: cada CUIT + punto de venta lleva su propia
  serie. Ante ARCA manda siempre el último autorizado real
  (`FECompUltimoAutorizado`), no el número que propone la base.
- Las variables `AFIP_*` del Worker quedan solo como respaldo para instalaciones
  que todavía no cargaron ningún facturador (y para `import-from-env`). Una vez
  que hay facturadores en la base, mandan ellos.

## Checklist

**Preparación (una vez)**
- [ ] `ARCA_SECRETS_KEY` generada y cargada (`.dev.vars` en local, `wrangler secret put` en prod)
- [ ] Migración `1.9.0` aplicada
- [ ] Facturador existente importado con `import-from-env`

**Por cada facturador nuevo**
- [ ] Clave Fiscal nivel 3 del CUIT
- [ ] Certificado `.crt` + `.key` (homologación)
- [ ] `wsfe` autorizado
- [ ] Punto de Venta tipo Web Services creado
- [ ] Access Token de Afip SDK
- [ ] Cargado en **Configuración → Facturadores**
- [ ] Factura de prueba con CAE OK en homologación
- [ ] Certificado de producción cargado y ambiente cambiado a `Producción`
- [ ] Primera factura real con CAE OK
