import { z } from "zod";

export const projectIconUploadInput = z
  .instanceof(FormData)
  .transform((form) => ({ id: form.get("id"), file: form.get("file") }))
  .pipe(z.object({ id: z.uuid(), file: z.instanceof(File) }));

export const updateProjectInput = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000),
  // Omitted means retain the existing link, null explicitly disconnects it.
  repository: z
    .object({
      installationId: z.number().int().positive().safe(),
      id: z.number().int().positive().safe(),
      fullName: z
        .string()
        .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
        .max(300),
    })
    .nullable()
    .optional(),
});
