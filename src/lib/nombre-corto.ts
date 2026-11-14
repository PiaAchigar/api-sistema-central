const mayuscula = (s: string) => (s ? s.charAt(0).toLocaleUpperCase("es") + s.slice(1) : s);

/** Etiqueta corta para dropdowns: "Lucía Celano" → "Lucía Ce."; toma el PRIMER apellido
 *  (la segunda palabra): "Laura Da Ruda" → "Laura Da.". Una sola palabra
 *  queda igual; sin nombre cae al email y, sin email, a "Sin nombre". */
export function nombreCorto(fullName: string | null, email: string | null): string {
  const palabras = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return email || "Sin nombre";
  const primera = mayuscula(palabras[0] ?? "");
  if (palabras.length === 1) return primera;
  const apellido = palabras[1] ?? "";
  return `${primera} ${mayuscula(Array.from(apellido).slice(0, 2).join(""))}.`;
}
