import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  DotsVertical,
  LogOut01,
  Mail01,
  Shield01,
  UserMinus01,
  UsersPlus,
} from "@untitledui/icons";

import { Avatar } from "@/components/base/avatar/avatar";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { useAppToast } from "@/components/ui/toast";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { m } from "@/paraglide/messages";
import { InviteMemberDialog } from "./invite-member-dialog";
import {
  acceptWorkspaceInvitation,
  declineWorkspaceInvitation,
  inviteWorkspaceMember,
  leaveWorkspace,
  removeWorkspaceMember,
  revokeWorkspaceInvitation,
  updateWorkspaceMemberRole,
} from "./members.functions";

type MemberRow = {
  userId: string;
  role: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
};

type InvitationRow = {
  id: string;
  role: string;
  inviteeUsername: string;
};

type IncomingInvitation = {
  id: string;
  role: string;
  workspace: { name: string; slug: string };
  inviterUsername: string;
};

function roleLabel(role: string) {
  if (role === "owner") return m.workspace_role_owner();
  if (role === "admin") return m.workspace_role_admin();
  return m.workspace_role_member();
}

export function WorkspaceMembersPanel(props: {
  actorUserId: string;
  actorRole: string;
  members: MemberRow[];
  pendingInvitations: InvitationRow[];
  incomingInvitations: IncomingInvitation[];
}) {
  const canManage = props.actorRole === "owner" || props.actorRole === "admin";
  const [inviteOpen, setInviteOpen] = useState(false);
  const invite = useServerFn(inviteWorkspaceMember);
  const accept = useServerFn(acceptWorkspaceInvitation);
  const decline = useServerFn(declineWorkspaceInvitation);
  const revoke = useServerFn(revokeWorkspaceInvitation);
  const updateRole = useServerFn(updateWorkspaceMemberRole);
  const remove = useServerFn(removeWorkspaceMember);
  const leave = useServerFn(leaveWorkspace);
  const router = useRouter();
  const toast = useAppToast();

  async function refresh() {
    await router.invalidate({ sync: true });
  }

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await refresh();
    } catch (error) {
      toast.error(m.workspace_members_action_failed(), error);
    }
  }

  return (
    <div className="w-full px-4 pb-8 sm:px-6">
      {props.incomingInvitations.length > 0 && (
        <div className="mt-6 flex items-start gap-3 rounded-lg border border-secondary bg-secondary px-4 py-4">
          <Mail01 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-brand-secondary" />
          <div className="min-w-0 flex-1 space-y-3">
            <h2 className="text-sm font-semibold text-primary">
              {m.workspace_invitations_incoming()}
            </h2>
            {props.incomingInvitations.map((invitation) => (
              <div
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <p className="min-w-0 text-sm text-secondary">
                  {m.workspace_invitation_from({
                    inviter: invitation.inviterUsername,
                    workspace: invitation.workspace.name,
                    role: roleLabel(invitation.role),
                  })}
                </p>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    color="secondary"
                    onPress={() => run(() => accept({ data: { invitationId: invitation.id } }))}
                  >
                    {m.workspace_invitation_accept()}
                  </Button>
                  <Button
                    size="sm"
                    color="secondary"
                    onPress={() => run(() => decline({ data: { invitationId: invitation.id } }))}
                  >
                    {m.workspace_invitation_decline()}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="divide-y divide-secondary border-b border-secondary">
        <section className="py-6">
          <ul aria-label={m.workspace_members_title()} className="divide-y divide-secondary">
            {props.members.map((member) => {
              const isSelf = member.userId === props.actorUserId;
              const displayName = member.displayName || member.username;
              const sameAsHandle = displayName === member.username;
              const canEditRole = canManage && member.role !== "owner";
              const canRemove = canManage && member.role !== "owner" && !isSelf;
              const canLeave = isSelf && member.role !== "owner";
              const hasActions = canEditRole || canRemove || canLeave;

              return (
                <li key={member.userId} className="flex h-12 items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar
                      size="sm"
                      alt={displayName}
                      src={member.avatarUrl ?? undefined}
                      initials={avatarInitial(displayName)}
                      contentClassName={avatarToneClassName(displayName)}
                      className="shrink-0"
                    />
                    <div className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate text-sm font-medium text-primary">
                        {displayName}
                      </span>
                      {!sameAsHandle && (
                        <span className="truncate text-sm text-tertiary">@{member.username}</span>
                      )}
                      {isSelf && (
                        <span className="shrink-0 text-sm text-tertiary">
                          · {m.workspace_members_you()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <Badge size="sm" color="gray">
                      {roleLabel(member.role)}
                    </Badge>
                    {hasActions && (
                      <Dropdown.Root>
                        <ButtonUtility
                          icon={DotsVertical}
                          size="sm"
                          color="tertiary"
                          tooltip={m.workspace_member_actions()}
                        />
                        <Dropdown.Popover placement="bottom end" className="w-52">
                          <Dropdown.Menu
                            aria-label={m.workspace_member_actions()}
                            onAction={(key) => {
                              if (key === "change-role") {
                                const nextRole = member.role === "admin" ? "member" : "admin";
                                void run(() =>
                                  updateRole({
                                    data: { userId: member.userId, role: nextRole },
                                  }),
                                );
                              } else if (key === "remove") {
                                void run(() => remove({ data: { userId: member.userId } }));
                              } else if (key === "leave") {
                                void run(() => leave());
                              }
                            }}
                          >
                            {canEditRole && (
                              <Dropdown.Item
                                id="change-role"
                                icon={Shield01}
                                label={
                                  member.role === "admin"
                                    ? m.workspace_member_make_member()
                                    : m.workspace_member_make_admin()
                                }
                              />
                            )}
                            {canRemove && (
                              <Dropdown.Item
                                id="remove"
                                icon={UserMinus01}
                                label={m.workspace_members_remove()}
                              />
                            )}
                            {canLeave && (
                              <Dropdown.Item
                                id="leave"
                                icon={LogOut01}
                                label={m.workspace_members_leave()}
                              />
                            )}
                          </Dropdown.Menu>
                        </Dropdown.Popover>
                      </Dropdown.Root>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        {canManage && (
          <section className="py-6">
            <header className="flex items-center justify-between gap-4 pb-4">
              <h2 className="text-lg font-semibold">{m.workspace_invitations_pending()}</h2>
              <Button
                type="button"
                color="secondary"
                size="sm"
                iconLeading={UsersPlus}
                onPress={() => setInviteOpen(true)}
              >
                {m.workspace_invite_button()}
              </Button>
            </header>
            {props.pendingInvitations.length > 0 ? (
              <ul className="divide-y divide-secondary">
                {props.pendingInvitations.map((invitation) => (
                  <li key={invitation.id} className="flex h-12 items-center justify-between gap-3">
                    <p className="min-w-0 truncate text-sm">
                      <span className="font-medium text-primary">
                        @{invitation.inviteeUsername}
                      </span>
                      <span className="text-tertiary"> · {roleLabel(invitation.role)}</span>
                    </p>
                    <Button
                      size="sm"
                      color="secondary"
                      onPress={() => run(() => revoke({ data: { invitationId: invitation.id } }))}
                    >
                      {m.workspace_invitation_revoke()}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{m.workspace_invitations_pending_empty_title()}</EmptyTitle>
                  <EmptyDescription>
                    {m.workspace_invitations_pending_empty_description()}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </section>
        )}
      </div>

      <InviteMemberDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvite={async (input) => {
          await invite({ data: input });
          await refresh();
        }}
      />
    </div>
  );
}
