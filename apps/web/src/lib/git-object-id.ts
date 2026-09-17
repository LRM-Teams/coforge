import { z } from "zod";

/** A Git object name: SHA-1 today, SHA-256 once GitHub serves it. */
export const gitObjectIdSchema = z.string().regex(/^[a-f0-9]{40,64}$/i);
