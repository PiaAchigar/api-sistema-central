/**
 * Parámetros que nunca van a llegar vivos a Postgres.
 *
 * **El problema, en concreto.** Este proyecto arma el cliente con
 * `drizzle-orm/postgres-js` y le pasa los parámetros ya separados del texto.
 * Cuando un valor entra por un operador de Drizzle —`eq`, `gte`, `lt`— la
 * columna sabe de qué tipo es y lo convierte: un `Date` sale como el string
 * `"2026-09-16T01:00:00.000Z"`. Cuando entra por un fragmento `sql` crudo no
 * hay columna que lo convierta, así que el `Date` viaja tal cual y el driver
 * muere al bindearlo:
 *
 *   TypeError: The "string" argument must be of type string… Received an
 *   instance of Date
 *
 * **Por qué hace falta buscarlo a propósito.** La consulta es válida: compila,
 * el SQL que imprime está bien escrito y falla recién contra la base. Acá
 * ningún test toca una base, así que una consulta así pasa verde y rompe en
 * producción. Pasó de verdad: `/api/agenda/appointments/consumible` tiró 500
 * desde V3a (2026-08) hasta que se encontró el 2026-09-16, y como el front
 * no muestra nada cuando esa consulta falla, nadie lo vio en un mes.
 *
 * **Por qué "ningún Date" alcanza como regla.** Todo mapper de columna
 * convierte el `Date` a string antes de que salga. Entonces un `Date` que
 * sobrevive hasta los parámetros significa una sola cosa: ese valor esquivó
 * un mapper, o sea vino de un `sql` crudo. No es una ley universal de Drizzle
 * —depende de cómo este proyecto arma el cliente— pero si algún día eso
 * cambia, esto falla en vez de callarse, que es el lado correcto para fallar.
 */

/** Un parámetro que quedó como `Date`. `posicion` es el `$n` de Postgres. */
export type FechaCruda = { posicion: number; valor: Date };

/**
 * Los parámetros que siguen siendo `Date` en una consulta ya armada.
 *
 * Recibe lo que devuelve `.toSQL()` de Drizzle, que arma el texto y la lista
 * de parámetros sin abrir conexión. Vacío = la consulta se puede ejecutar.
 */
export function fechasCrudas(consulta: { params: readonly unknown[] }): FechaCruda[] {
  return consulta.params.flatMap((valor, i) =>
    valor instanceof Date ? [{ posicion: i + 1, valor }] : [],
  );
}
