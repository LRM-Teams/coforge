import { DEV_BROWSER_USER } from "../src/server/auth/dev-skip-auth.server";
import { getDatabaseClient } from "../src/server/db/client.server";
import { workspaceIdForUser } from "../src/server/workspaces/enrollment.server";

const db = getDatabaseClient();
if (!db) throw new Error("DATABASE_URL is required to seed development data");

await db.user.upsert({
  where: { id: DEV_BROWSER_USER.id },
  create: { id: DEV_BROWSER_USER.id, username: DEV_BROWSER_USER.username },
  update: { username: DEV_BROWSER_USER.username },
});
await workspaceIdForUser(db, DEV_BROWSER_USER, "en");
await db.$disconnect();
