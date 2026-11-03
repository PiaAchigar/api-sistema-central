import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { promotions } from "../db/schema";
import type { Db } from "../db/client";
import { sumaDeLasPartesDeCombo } from "./combos.repo";
import {
  createPromotion,
  deletePromotionPermanently,
  listActivePromotions,
  updatePromotion,
} from "./promotions.repo";
import { precioDeServicio, precioDeServicioEfectivo } from "../lib/combo-pricing";

const LOCAL_DB_URL = "postgresql://piubella:piubella@localhost:5499/piubella";
const pgClient = postgres(LOCAL_DB_URL, { max: 1, fetch_types: false, prepare: false });
const db = drizzle(pgClient, { schema }) as unknown as Db;

const QA = "ZZ_QA_SUMA_PARTES";
let servicioId = "";
let precio = 0;
let efectivo = 0;

async function limpiar() {
  const previas = await db.select({ id: promotions.id }).from(promotions).where(eq(promotions.name, QA));
  for (const p of previas) await deletePromotionPermanently(db, p.id);
}

beforeAll(async () => {
  await limpiar();
  const [s] = await db.execute<{ id: string; l: string | null; c: string | null }>(
    `select id, unit_price_list as l, unit_price_cash as c from service
      where is_active = true and name not like 'ZZ_QA%'
        and coalesce(unit_price_list, unit_price_cash) > 0
      order by (unit_price_cash is not null and unit_price_cash < unit_price_list) desc, id limit 1` as never,
  );
  servicioId = s!.id;
  precio = precioDeServicio(s!.l, s!.c);
  efectivo = precioDeServicioEfectivo(s!.l, s!.c);
});

afterAll(async () => {
  await limpiar();
  await pgClient.end();
});

describe("sumaDeLasPartesDeCombo", () => {
  it("combo público: pack de 4 × 22000 → sumaDeLasPartes 88000", () => {
    expect(
      sumaDeLasPartesDeCombo({
        kind: "pack",
        servicesSubtotal: 0,
        servicesSubtotalCash: 0,
        packUnitAmount: 22000,
        packUnitAmountCash: 20000,
        packEffectiveSessions: 4,
      }),
    ).toEqual({ sumaDeLasPartes: 88000, sumaDeLasPartesEfectivo: 80000 });
  });

  it("un combo suma su subtotal (lista y efectivo)", () => {
    expect(
      sumaDeLasPartesDeCombo({ kind: "combo", servicesSubtotal: 50000, servicesSubtotalCash: 45000 }),
    ).toEqual({ sumaDeLasPartes: 50000, sumaDeLasPartesEfectivo: 45000 });
  });
});

describe("promos públicas — suma y precio final", () => {
  const base = {
    name: QA,
    isVisibleWeb: true,
  };

  it("promo de 10% sobre un servicio → suma = precio en EFECTIVO, precioFinal con 10% menos", async () => {
    const creada = await createPromotion(
      db,
      { ...base, promotionType: "percentage", discountPercentage: 10 },
      [{ tipo: "servicio", id: servicioId }],
      [],
    );
    const publica = (await listActivePromotions(db)).find((p) => p.id === creada!.id);
    // Las promos se cobran sobre el efectivo: la web no puede mostrar la lista.
    expect(publica?.sumaDeLasPartes).toBe(efectivo);
    expect(publica?.precioFinal).toBe(Math.round((efectivo * 90) / 100));
  });

  it("promo de paquete pública trae suma y precio", async () => {
    const paquete = precio * 2 - 1;
    const creada = await createPromotion(
      db,
      { ...base, promotionType: "paquete", precioDelPaquete: paquete },
      [{ tipo: "servicio", id: servicioId, cantidad: 2 }],
      [],
    );
    const publica = (await listActivePromotions(db)).find((p) => p.id === creada!.id);
    expect(publica?.sumaDeLasPartes).toBe(efectivo * 2);
    expect(publica?.precioFinal).toBe(paquete);
  });

  it("rechaza guardar una promo de paquete igual a la suma", async () => {
    await expect(
      createPromotion(
        db,
        { ...base, promotionType: "paquete", precioDelPaquete: precio * 2 },
        [{ tipo: "servicio", id: servicioId, cantidad: 2 }],
        [],
      ),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("tiene que ser menor") });
  });

  it("al editar también rechaza un paquete más caro que sus partes", async () => {
    const creada = await createPromotion(
      db,
      { ...base, promotionType: "paquete", precioDelPaquete: precio * 2 - 1 },
      [{ tipo: "servicio", id: servicioId, cantidad: 2 }],
      [],
    );
    await expect(
      updatePromotion(
        db,
        creada!.id,
        { ...base, promotionType: "paquete", precioDelPaquete: precio * 3 },
        [{ tipo: "servicio", id: servicioId, cantidad: 2 }],
        [],
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
