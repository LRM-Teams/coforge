import { z } from "zod";

export const saveUserTimeZoneInputSchema = z.object({ timeZone: z.string().nullable() });
