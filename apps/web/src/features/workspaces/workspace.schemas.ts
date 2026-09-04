import { z } from "zod";
import { isValidWorkspaceSlug } from "../../server/workspaces/workspace-slug";

const workspaceSlug = z.string().refine(isValidWorkspaceSlug);

export const selectWorkspaceInputSchema = z.object({ slug: workspaceSlug });
export const createWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1),
  slug: workspaceSlug,
});
