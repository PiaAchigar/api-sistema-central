import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { contacts, customers } from "../db/schema";
import type { Sexo } from "../lib/depilation-pricing";

/**
 * El tramo de tarifa y tiempo de depilación de una clienta.
 *
 * Vive en el contacto y no se pregunta dos veces: la venta lo usa para
 * cotizar y la agenda para calcular el turno. Si se eligiera en cada pantalla,
 * tarde o temprano alguien cobra en mujer y agenda en hombre.
 *
 * **NULL devuelve `"mujer"`**, que es lo que el sistema hizo siempre
 * (`SEXO_DURACION_CATALOGO`). Miles de contactos no tienen esto cargado y
 * tienen que poder seguir comprando. Una clienta inexistente también: quien
 * llama decide si eso es un 404, acá no se rompe la cotización por un id malo.
 */
export async function sexoDeLaClienta(db: Db, customerId: string): Promise<Sexo> {
  const [fila] = await db
    .select({ sexo: contacts.sexo })
    .from(customers)
    .leftJoin(contacts, eq(contacts.id, customers.contactId))
    .where(eq(customers.id, customerId))
    .limit(1);

  return fila?.sexo === "hombre" ? "hombre" : "mujer";
}
