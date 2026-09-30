import { z } from "zod";

import { checkPersonName } from "#src/features/profiles/person-name";

export const saveUserProfileInputSchema = z.object({
  // The one rule for a person's name (`person-name.ts`), shared with the full name asked at first
  // sign-in. The problem is its own name (`empty`, `too_long`, `refused`) for a page to word.
  name: z.string().transform((value, context) => {
    const checked = checkPersonName(value);
    if (checked.ok) return checked.name;
    context.issues.push({ code: "custom", message: checked.problem, input: value });
    return z.NEVER;
  }),
  description: z.string().trim().max(280),
});
