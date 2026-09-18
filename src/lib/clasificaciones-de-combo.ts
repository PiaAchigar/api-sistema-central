/**
 * Las clasificaciones de un combo: en qué partes del árbol del menú aparece.
 *
 * Una *clasificación* es una categoría raíz que NO es un área (vocabulario de
 * Pia: "categoría padre"). Un combo se muestra en CADA clasificación que tenga
 * alguno de sus servicios internos, así que un combo con servicios de Belleza y
 * de Tratamientos Médicos aparece en las dos.
 *
 * La consulta devuelve una fila por cada par (combo, clasificación) y repite
 * cuando dos servicios del mismo combo caen en la misma clasificación. Acá se
 * deduplica: dos servicios de una clasificación son UN combo ahí, no dos.
 */
export type Clasificacion = { id: string; name: string };

export type FilaDeClasificacion = {
  comboId: string;
  clasificacionId: string;
  clasificacionName: string | null;
};

export function agruparClasificaciones(
  filas: readonly FilaDeClasificacion[],
): Map<string, Clasificacion[]> {
  const porCombo = new Map<string, Map<string, Clasificacion>>();

  for (const f of filas) {
    // Una clasificación sin nombre no se puede dibujar. Dejarla entrar pondría
    // un título vacío en la pantalla, que se lee como un error de la página.
    if (f.clasificacionName == null) continue;
    const suyas = porCombo.get(f.comboId) ?? new Map<string, Clasificacion>();
    suyas.set(f.clasificacionId, { id: f.clasificacionId, name: f.clasificacionName });
    porCombo.set(f.comboId, suyas);
  }

  const salida = new Map<string, Clasificacion[]>();
  for (const [comboId, suyas] of porCombo) {
    salida.set(
      comboId,
      // El ORDER BY de una consulta con UNION recursivo no es estable, y el
      // orden es lo que ve la clienta. Se ordena acá.
      [...suyas.values()].sort((a, b) => a.name.localeCompare(b.name, "es")),
    );
  }
  return salida;
}
