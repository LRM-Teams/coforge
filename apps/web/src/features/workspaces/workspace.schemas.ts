import { z } from "zod";
import { isValidWorkspaceSlug } from "./workspace-slug";

const workspaceSlug = z.string().refine(isValidWorkspaceSlug);

export const createWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1),
  slug: workspaceSlug,
});
