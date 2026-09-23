import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "@/features/auth/function-auth";
import {
  PrismaWorkspaceMemberPreferencesRepository,
  WorkspaceMemberPreferences,
} from "@/server/db/repositories/workspace-member-preferences.repositories.server";
import { TAB_ORDER_PANELS } from "./panel-tab-order";

/** The signed-in member's tab orders in their selected Workspace. */
export const getPanelTabOrders = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(({ context: { user, db, workspaceId } }) =>
    new WorkspaceMemberPreferences(new PrismaWorkspaceMemberPreferencesRepository(db)).getTabOrders(
      workspaceId,
      user.id,
    ),
  );

export const savePanelTabOrder = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ panel: z.enum(TAB_ORDER_PANELS), order: z.array(z.string()).max(16) }))
  .handler(({ data, context: { user, db, workspaceId } }) =>
    new WorkspaceMemberPreferences(new PrismaWorkspaceMemberPreferencesRepository(db)).setTabOrder(
      workspaceId,
      user.id,
      data.panel,
      data.order,
    ),
  );
