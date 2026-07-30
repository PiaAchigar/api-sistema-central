import { z } from "zod";

export const faqBody = z.object({
  question: z.string().max(255).nullish(),
  answer: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
  isActive: z.boolean().optional(),
});
