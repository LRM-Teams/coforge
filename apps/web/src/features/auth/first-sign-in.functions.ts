import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { authMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { completeFirstSignIn, readNameStep } from "#src/server/auth/first-sign-in.server";
import { requireDatabaseClient } from "#src/server/db/client.server";

/** Whether the signed-in person still has to be asked for a full name, and what to start the field
 * with. */
export const getNameStep = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    declareNoStore();
    return readNameStep({ db: requireDatabaseClient(), user: context.user });
  });

/** Saves the full name and makes the personal Workspace; `{ ok: false }` names why a name was not
 * accepted. */
export const submitFullName = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ fullName: z.string() }))
  .handler(async ({ data, context }) =>
    completeFirstSignIn({
      db: requireDatabaseClient(),
      user: context.user,
      fullName: data.fullName,
      acceptLanguage: getRequest().headers.get("accept-language") ?? "",
    }),
  );
