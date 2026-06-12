// Intervalos semiabiertos [start, end) en minutos desde medianoche local.
export type Interval = { start: number; end: number };

export function isEmpty(i: Interval): boolean {
  return i.end <= i.start;
}

/** Intersección de cada ventana con un intervalo límite. */
export function intersect(windows: Interval[], bound: Interval): Interval[] {
  return windows
    .map((w) => ({ start: Math.max(w.start, bound.start), end: Math.min(w.end, bound.end) }))
    .filter((w) => !isEmpty(w));
}

/** Resta un intervalo de cada ventana (puede partirlas en dos). */
export function subtract(windows: Interval[], busy: Interval): Interval[] {
  const result: Interval[] = [];
  for (const w of windows) {
    if (busy.end <= w.start || busy.start >= w.end) {
      result.push(w);
      continue;
    }
    if (busy.start > w.start) result.push({ start: w.start, end: busy.start });
    if (busy.end < w.end) result.push({ start: busy.end, end: w.end });
  }
  return result.filter((w) => !isEmpty(w));
}

/** Resta varios intervalos ocupados. */
export function subtractAll(windows: Interval[], busies: Interval[]): Interval[] {
  return busies.reduce((acc, b) => subtract(acc, b), windows);
}

/** Une ventanas solapadas o contiguas. */
export function merge(windows: Interval[]): Interval[] {
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const result: Interval[] = [];
  for (const w of sorted) {
    const last = result[result.length - 1];
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
    } else {
      result.push({ ...w });
    }
  }
  return result;
}

/**
 * Genera inicios de slot sobre una grilla de paso fijo: un slot es válido si
 * [t, t+duration] cabe entero dentro de alguna ventana.
 */
export function generateSlots(
  windows: Interval[],
  durationMinutes: number,
  stepMinutes = 15,
): number[] {
  const starts = new Set<number>();
  for (const w of windows) {
    // Alinear el primer slot a la grilla global (no al inicio de la ventana)
    const first = Math.ceil(w.start / stepMinutes) * stepMinutes;
    for (let t = first; t + durationMinutes <= w.end; t += stepMinutes) {
      starts.add(t);
    }
  }
  return [...starts].sort((a, b) => a - b);
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}
