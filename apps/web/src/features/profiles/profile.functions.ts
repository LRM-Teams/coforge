import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/features/auth/function-auth";
import { requireDatabaseClient } from "@/server/db/client.server";
import { PrismaUserProfileRepository } from "@/server/db/repositories/user-profile.repositories.server";
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
      name: profile.displayName ?? user.name,
      email: user.email,
      username: profile.username,
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
