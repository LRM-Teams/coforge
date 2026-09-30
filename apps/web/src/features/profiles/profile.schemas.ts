import { z } from "zod";

import { checkPersonName, normalizePersonName } from "#src/features/profiles/person-name";

/**
 * A person's name by the one rule (`person-name.ts`), shared with the full name asked at first
 * sign-in. The problem is the issue's own message (`empty`, `too_long`, `refused`), for a page to
 * word.
 */
function personName(value: string, context: z.RefinementCtx) {
  const checked = checkPersonName(value);
  if (checked.ok) return checked.name;
  context.issues.push({ code: "custom", message: checked.problem, input: value });
  return z.NEVER;
}

/** The full name, required. */
export const fullNameSchema = z.string().transform(personName);

/** The optional nickname: the same rule, and blank or absent means none (`null`), in which case
 * the full name is what people are shown. */
export const displayNameSchema = z
  .string()
  .optional()
  .transform((value, context) =>
    normalizePersonName(value ?? "") === "" ? null : personName(value!, context),
  );

export const saveUserProfileInputSchema = z.object({
  fullName: fullNameSchema,
  displayName: displayNameSchema,
  description: z.string().trim().max(280),
});
