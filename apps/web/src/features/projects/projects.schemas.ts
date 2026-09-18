import { z } from "zod";

export const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PROJECT_SLUG_MAX_LENGTH = 100;

export function isValidProjectSlug(slug: string): boolean {
  return PROJECT_SLUG_PATTERN.test(slug) && slug.length <= PROJECT_SLUG_MAX_LENGTH;
}

const projectSlug = z.string().trim().refine(isValidProjectSlug);

const githubFullName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .max(300);

export const createProjectInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: projectSlug,
    installationId: z.number().int().positive().safe().optional(),
    repositoryId: z.number().int().positive().safe().optional(),
    fullName: githubFullName.optional(),
  })
  .refine((data) => {
    const hasInstallation = data.installationId !== undefined;
    const hasRepository = data.repositoryId !== undefined;
    const hasName = data.fullName !== undefined;
    if (!hasInstallation && !hasRepository && !hasName) return true;
    if (hasInstallation && hasRepository && hasName) return true;
    return !hasInstallation && !hasRepository && hasName;
  });

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
  commitCoAuthor: z.boolean(),
});
