import { z } from "zod";

import { TIME_FORMATS } from "#src/lib/time-format";

export const saveDateTimePreferencesInputSchema = z.object({
  timeZone: z.string().nullable(),
  timeFormat: z.enum(TIME_FORMATS).nullable(),
});
