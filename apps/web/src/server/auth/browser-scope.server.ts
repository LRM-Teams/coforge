import { getRequest } from "@tanstack/react-start/server";
import { AppError } from "../../lib/app-error";
import { getDatabaseClient } from "../db/client.server";
import { requireWorkspaceIdForRequest } from "../workspaces/selection.server";
import { requireBrowserUser } from "./require-user.server";

const temporarilyUnavailable = () => new AppError("TEMPORARILY_UNAVAILABLE");

/**
 * The browser caller, the database and the Workspace the request is scoped to: the prelude
 * of nearly every server function. `unavailable` is thrown when persistence is not configured.
 */
export async function browserScope(unavailable: () => Error = temporarilyUnavailable) {
  const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
  const db = getDatabaseClient();
  if (!db) throw unavailable();
  const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
  return { user, db, workspaceId, scope: { workspaceId, userId: user.id } };
}
