import { z } from "zod";

// Piezas de validación de los encuentros de capacitación: mismas horas
// "HH:MM:SS" locales (ART), mismo orden y mismo cupo que los horarios de
// actividades (src/routes/activitySchedules.ts), con los mismos mensajes.
const horaRegex = /^\d{2}:\d{2}:\d{2}$/;
const mensajeOrdenHoras = "La hora de fin tiene que ser posterior a la de inicio";
// Cupo: entero >= 1, o null = sin límite declarado (columna capacity).
export const capacidadSchema = z.number().int().min(1).nullable();
export const horaSchema = z.string().regex(horaRegex, "Format must be HH:MM:SS");

export const finPosteriorAInicio = (h: { startTime: string; endTime: string }) => h.endTime > h.startTime;
export const finPosteriorAInicioOpcional = (h: { startTime?: string; endTime?: string }) =>
  h.startTime === undefined || h.endTime === undefined || h.endTime > h.startTime;
export const errorOrdenHoras = { message: mensajeOrdenHoras, path: ["endTime"] };
