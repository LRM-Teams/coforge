import { AppError } from "#src/lib/app-error";
import {
  announceMemberChanged,
  type ConversationRealtime,
} from "#src/server/conversations/conversation-realtime.server";
import { assertCanManageMembers, type WorkspaceMemberRole } from "./member-role.server";

/** A reusable link anyone signed in can open to join the Workspace as an ordinary member. */
export type WorkspaceJoinLinkRecord = {
  id: string;
  workspaceId: string;
  /** The secret in the link's URL; shown again to the Workspace's owners and admins. */
  token: string;
  /** How many people may join by it; null is no limit. */
  maxUses: number | null;
  useCount: number;
  /** null never expires. */
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

/** The Workspace as a link's visitor sees it before joining. */
export type JoinLinkWorkspace = { id: string; slug: string; name: string; iconUrl: string | null };

export type WorkspaceJoinLinkPreview = {
  /** No Workspace id: a visitor needs only what the page shows and the slug to go in. */
  workspace: Omit<JoinLinkWorkspace, "id">;
  /** People in the Workspace. */
  memberCount: number;
  /** Public, live Agents: a private Agent is never counted for someone outside. */
  agentCount: number;
  viewerIsMember: boolean;
};

export type NewWorkspaceJoinLink = {
  workspaceId: string;
  createdByUserId: string;
  token: string;
  maxUses: number | null;
  expiresAt: Date | null;
};

export type JoinLinkAdmission =
  | { status: "admitted"; joinedChannelIds: string[] }
  /** The link stopped admitting (revoked, expired or used up) before this join counted. */
  | { status: "inactive" }
  /** The person became a member meanwhile; no use was counted. */
  | { status: "already-member" };

export type WorkspaceJoinLinkStore = {
  findMemberRole(workspaceId: string, userId: string): Promise<WorkspaceMemberRole | null>;
  /** The Workspace's newest link that is active at `now`. */
  findLatestActive(workspaceId: string, now: Date): Promise<WorkspaceJoinLinkRecord | null>;
  /** Revokes the Workspace's unrevoked links and creates this one, atomically: a Workspace has one
   * working link, so none keeps admitting people unseen. */
  create(input: NewWorkspaceJoinLink & { now: Date }): Promise<WorkspaceJoinLinkRecord>;
  /** Revokes the Workspace's unrevoked link `linkId` and creates the new one, atomically; null
   * (and nothing written) when `linkId` is no unrevoked link of this Workspace. */
  replace(
    input: NewWorkspaceJoinLink & { linkId: string; now: Date },
  ): Promise<WorkspaceJoinLinkRecord | null>;
  /** false when `linkId` is no unrevoked link of this Workspace. */
  revoke(input: { workspaceId: string; linkId: string; now: Date }): Promise<boolean>;
  findByToken(
    token: string,
  ): Promise<{ link: WorkspaceJoinLinkRecord; workspace: JoinLinkWorkspace } | null>;
  countMembers(workspaceId: string): Promise<{ memberCount: number; agentCount: number }>;
  /** In one transaction: counts one use while the link is still active at `now` (never past its
   * limit, however many people join at once) and admits the person as a member. */
  admit(input: { linkId: string; userId: string; now: Date }): Promise<JoinLinkAdmission>;
};

/** The largest use limit the column stores (PostgreSQL `integer`). */
const MAX_USES_LIMIT = 2_147_483_647;

/** A link admits people until it is revoked, expires, or reaches its use limit. The Prisma store
 * states the same rule in SQL for the use it counts. */
export function isJoinLinkActive(
  link: Pick<WorkspaceJoinLinkRecord, "maxUses" | "useCount" | "expiresAt" | "revokedAt">,
  now: Date,
): boolean {
  if (link.revokedAt) return false;
  if (link.expiresAt && link.expiresAt <= now) return false;
  return link.maxUses === null || link.useCount < link.maxUses;
}

/** 32 random bytes, base64url: the only thing a visitor needs to join. */
export function generateJoinLinkToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

type LinkOptions = { maxUses: number | null; expiresAt: Date | null };

/**
 * Workspace join links, as Raft's: owners and admins create, update (replace) and revoke them;
 * anyone signed in who has one joins as an ordinary member. To a visitor, an unknown, revoked,
 * expired or used-up link are all the same NOT_FOUND.
 */
export class WorkspaceJoinLinks {
  constructor(
    private readonly store: WorkspaceJoinLinkStore,
    private readonly now: () => Date = () => new Date(),
    private readonly realtime?: Pick<ConversationRealtime, "memberChanged">,
  ) {}

  async current(input: { workspaceId: string; actorUserId: string }) {
    await this.requireManager(input.workspaceId, input.actorUserId);
    return this.store.findLatestActive(input.workspaceId, this.now());
  }

  async create(input: { workspaceId: string; actorUserId: string } & LinkOptions) {
    await this.requireManager(input.workspaceId, input.actorUserId);
    return this.store.create({ ...this.newLink(input), now: this.now() });
  }

  /** "Update link": the old URL stops working at once and a new one takes its place. */
  async replace(input: { workspaceId: string; actorUserId: string; linkId: string } & LinkOptions) {
    await this.requireManager(input.workspaceId, input.actorUserId);
    const replacement = await this.store.replace({
      ...this.newLink(input),
      linkId: input.linkId,
      now: this.now(),
    });
    if (!replacement) throw new AppError("NOT_FOUND");
    return replacement;
  }

  async revoke(input: { workspaceId: string; actorUserId: string; linkId: string }) {
    await this.requireManager(input.workspaceId, input.actorUserId);
    const revoked = await this.store.revoke({
      workspaceId: input.workspaceId,
      linkId: input.linkId,
      now: this.now(),
    });
    if (!revoked) throw new AppError("NOT_FOUND");
  }

  /** What a link's page shows before joining; works signed out (no `viewerUserId`). */
  async inspect(input: {
    token: string;
    viewerUserId?: string;
  }): Promise<WorkspaceJoinLinkPreview> {
    const { workspace } = await this.requireActive(input.token);
    const counts = await this.store.countMembers(workspace.id);
    const viewerIsMember = input.viewerUserId
      ? (await this.store.findMemberRole(workspace.id, input.viewerUserId)) !== null
      : false;
    const { slug, name, iconUrl } = workspace;
    return { workspace: { slug, name, iconUrl }, ...counts, viewerIsMember };
  }

  /** Joins the link's Workspace as a member; while the link works, someone already in it just gets
   * the Workspace back. */
  async join(input: { token: string; userId: string }) {
    const { link, workspace } = await this.requireActive(input.token);
    const landing = { workspaceId: workspace.id, slug: workspace.slug };
    if (await this.store.findMemberRole(workspace.id, input.userId)) return landing;
    const admission = await this.store.admit({
      linkId: link.id,
      userId: input.userId,
      now: this.now(),
    });
    if (admission.status === "inactive") throw new AppError("NOT_FOUND");
    if (admission.status === "admitted") {
      await announceMemberChanged(this.realtime, {
        workspaceId: workspace.id,
        conversationIds: admission.joinedChannelIds,
      });
    }
    return landing;
  }

  private async requireActive(token: string) {
    const found = await this.store.findByToken(token);
    if (!found || !isJoinLinkActive(found.link, this.now())) throw new AppError("NOT_FOUND");
    return found;
  }

  private newLink(input: { workspaceId: string; actorUserId: string } & LinkOptions) {
    const { maxUses, expiresAt } = input;
    if (
      maxUses !== null &&
      !(Number.isInteger(maxUses) && maxUses > 0 && maxUses <= MAX_USES_LIMIT)
    )
      throw new AppError("INVALID_INPUT");
    if (expiresAt !== null && !(expiresAt.getTime() > this.now().getTime()))
      throw new AppError("INVALID_INPUT");
    return {
      workspaceId: input.workspaceId,
      createdByUserId: input.actorUserId,
      token: generateJoinLinkToken(),
      maxUses,
      expiresAt,
    };
  }

  private async requireManager(workspaceId: string, userId: string) {
    const role = await this.store.findMemberRole(workspaceId, userId);
    if (!role) throw new AppError("ACCESS_DENIED");
    assertCanManageMembers(role);
  }
}
