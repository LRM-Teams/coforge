import { z } from "zod";

/** A user code as typed: the page accepts it with or without the dash it is displayed with, in
 * any case, so normalization - not rejection - is what the server does with the raw value. The
 * length bound is generous on purpose; the exact shape is checked after normalizing. */
export const userCodeInputSchema = z.object({
  userCode: z.string().min(1).max(32),
});
