import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "#src/features/auth/function-auth";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { PrismaUserProfileRepository } from "#src/server/db/repositories/user-profile.repositories.server";
import { saveUserProfileInputSchema } from "./profile.schemas";

function profiles() {
  const db = requireDatabaseClient();
  return new PrismaUserProfileRepository(db);
}

export const getUserProfile = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const user = context.user;
    const profile = await profiles().get(user.id);
    return {
      id: user.id,
      name: profile.name,
      username: profile.username,
      named: profile.named,
      fullName: profile.fullName,
      displayName: profile.displayName,
      email: user.email,
      description: profile.description,
      avatarUrl: profile.avatarUrl,
    };
  });

export const saveUserProfile = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(saveUserProfileInputSchema)
  .handler(async ({ data, context }) => {
    const user = context.user;
    return profiles().set(user.id, data);
  });
