import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { requireBrowserUser } from "../../server/auth/require-user.server";
import { getDatabaseClient } from "../../server/db/client.server";
import { PrismaUserProfileRepository } from "../../server/db/repositories/user-profile.repositories.server";
import { saveUserProfileInputSchema } from "./profile.schemas";

function currentUser() {
  return requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
}

function profiles() {
  const db = getDatabaseClient();
  if (!db) throw new Error("User profile persistence is unavailable");
  return new PrismaUserProfileRepository(db);
}

export const getUserProfile = createServerFn({ method: "GET" }).handler(async () => {
  const user = currentUser();
  const profile = await profiles().get(user.id);
  return {
    name: profile.displayName ?? user.name,
    email: user.email,
    username: profile.username,
    description: profile.description,
    avatarUrl: profile.avatarUrl,
  };
});

export const saveUserProfile = createServerFn({ method: "POST" })
  .validator(saveUserProfileInputSchema)
  .handler(async ({ data }) => {
    const user = currentUser();
    return profiles().set(user.id, data);
  });
