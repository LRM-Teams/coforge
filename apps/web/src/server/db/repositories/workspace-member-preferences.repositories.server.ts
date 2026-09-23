import type { PrismaClient } from "@/generated/prisma/client";

import { AppError } from "@/lib/app-error";
import {
  isTabOrder,
  knownTabs,
  type TabOrderPanel,
  type TabOrders,
} from "@/features/panel-tabs/panel-tab-order";

export type WorkspaceMemberPreferencesRepository = {
  /** Each panel's saved tab ids; an empty list when the member never saved one. */
  getTabOrders(workspaceId: string, userId: string): Promise<Record<TabOrderPanel, string[]>>;
  setTabOrder(
    workspaceId: string,
    userId: string,
    panel: TabOrderPanel,
    order: string[],
  ): Promise<void>;
};

const TAB_ORDER_COLUMNS = {
  conversation: "conversationTabOrder",
  agentProfile: "agentProfileTabOrder",
} as const satisfies Record<TabOrderPanel, string>;

export class PrismaWorkspaceMemberPreferencesRepository implements WorkspaceMemberPreferencesRepository {
  constructor(private readonly db: PrismaClient) {}

  async getTabOrders(workspaceId: string, userId: string) {
    // A member without a row has never saved a preference in this Workspace.
    const saved = await this.db.workspaceMemberPreference.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    return {
      conversation: saved?.conversationTabOrder ?? [],
      agentProfile: saved?.agentProfileTabOrder ?? [],
    };
  }

  async setTabOrder(workspaceId: string, userId: string, panel: TabOrderPanel, order: string[]) {
    const data = { [TAB_ORDER_COLUMNS[panel]]: order };
    await this.db.workspaceMemberPreference.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { workspaceId, userId, ...data },
      update: data,
    });
  }
}

/** A Workspace member's own settings in that Workspace: today, the panels' tab orders. */
export class WorkspaceMemberPreferences {
  constructor(private readonly repository: WorkspaceMemberPreferencesRepository) {}

  /** Saved orders, keeping only ids that are still tabs of their panel. */
  async getTabOrders(workspaceId: string, userId: string): Promise<TabOrders> {
    const saved = await this.repository.getTabOrders(workspaceId, userId);
    return {
      conversation: knownTabs("conversation", saved.conversation),
      agentProfile: knownTabs("agentProfile", saved.agentProfile),
    };
  }

  async setTabOrder(workspaceId: string, userId: string, panel: TabOrderPanel, order: string[]) {
    if (!isTabOrder(panel, order)) throw new AppError("INVALID_INPUT");
    await this.repository.setTabOrder(workspaceId, userId, panel, order);
  }
}
