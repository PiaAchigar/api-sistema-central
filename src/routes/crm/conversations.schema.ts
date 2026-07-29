import { z } from "zod";

export const CHANNELS = ["whatsapp", "instagram", "facebook", "email"] as const;
export const STATUSES = ["open", "closed"] as const;

export const createConversationBody = z.object({
  contactId: z.string().uuid(),
  channel: z.enum(CHANNELS),
});

export const sendMessageBody = z.object({
  content: z.string().min(1),
});

export const patchConversationBody = z
  .object({
    status: z.enum(STATUSES).optional(),
    assignedAgentId: z.string().uuid().nullable().optional(),
  })
  .refine((d) => d.status !== undefined || d.assignedAgentId !== undefined, {
    message: "Nada para actualizar",
  });

export const listConversationsQuery = z.object({
  channel: z.enum(CHANNELS).optional(),
  status: z.enum(STATUSES).optional(),
  assignedAgentId: z.string().optional(), // uuid | "unassigned"
  q: z.string().optional(),
});
