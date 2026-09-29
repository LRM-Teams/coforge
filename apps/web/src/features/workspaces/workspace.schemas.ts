import { z } from "zod";
import { isValidWorkspaceSlug } from "./workspace-slug";

const workspaceSlug = z.string().refine(isValidWorkspaceSlug);

/** The longest Workspace name the profile accepts, counted after trimming. */
export const WORKSPACE_NAME_MAX_LENGTH = 100;

export const createWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1),
  slug: workspaceSlug,
});

export const renameWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX_LENGTH),
});

export const workspaceIconUploadInput = z
  .instanceof(FormData)
  .transform((form) => ({ file: form.get("file") }))
  .pipe(z.object({ file: z.instanceof(File) }));
