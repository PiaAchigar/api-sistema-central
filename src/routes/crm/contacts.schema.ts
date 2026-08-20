import { z } from "zod";
import { todayLocal } from "../../lib/time";

export const CONTACT_STATUS = ["prospect", "customer", "inactive"] as const;

export const contactInput = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  status: z.enum(CONTACT_STATUS).default("prospect"),
  notes: z.string().optional(),
  whatsappId: z.string().optional(),
  instagramId: z.string().optional(),
  facebookId: z.string().optional(),
  birthdate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "La fecha tiene que ser AAAA-MM-DD" })
    // Una fecha de nacimiento en el futuro nunca es válida, y no es hipotético:
    // la importación original dejó 1403 contactos —el 25% de los que tenían
    // fecha— nacidos entre 2029 y 2075, porque leyó los años en dos dígitos.
    // Se reparó en la migración 1.33.0; esto evita que vuelvan a entrar.
    // El límite es el DÍA del negocio (ART), no UTC: entre las 21 y las 24
    // `new Date()` ya está en el día siguiente y dejaría pasar un día de más.
    .refine((v) => v <= todayLocal(), {
      message: "La fecha de nacimiento no puede ser futura",
    })
    .optional(),
  tags: z.array(z.string()).optional(),
  preferredService: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  isArchived: z.boolean().optional(),
});

export const listQuery = z.object({
  q: z.string().optional(),
  // Query params son strings: coacción explícita "true"→true, todo lo demás→false.
  // NO usar z.coerce.boolean() (haría "false"→true).
  includeArchived: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  // "recent" es el orden histórico de la pantalla (alta más nueva primero) y
  // sigue siendo el default para no cambiarle la vista a nadie sin pedirlo.
  sort: z.enum(["recent", "nameAsc", "nameDesc"]).default("recent"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
