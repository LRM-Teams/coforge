import { useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { DotsVertical, Shield01, UserMinus01, UsersPlus } from "@untitledui/icons";

import { Avatar } from "#src/components/base/avatar/avatar";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { useAppToast } from "#src/components/ui/toast";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { humanLabel } from "#src/lib/human-label";
import { m } from "#src/paraglide/messages";
import { InviteMemberDialog } from "./invite-member-dialog";
import { canManageMembers } from "./workspace-roles";
import { removeWorkspaceMember, updateWorkspaceMemberRole } from "./members.functions";

type MemberRow = {
  userId: string;
  role: string;
  username: string;
  displayName: string | null;
  fullName: string | null;
  avatarUrl: string | null;
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
  /** Workspace-wide channel settings, for an owner or admin; placed after the members. */
  systemChannels?: ReactNode;
}) {
  const canManage = canManageMembers(props.actorRole);
  const [inviteOpen, setInviteOpen] = useState(false);
  const updateRole = useServerFn(updateWorkspaceMemberRole);
  const remove = useServerFn(removeWorkspaceMember);
  const router = useRouter();
  const toast = useAppToast();

  async function refresh() {
    await router.invalidate({ sync: true });
  }

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await refresh();
    } catch {
      toast.error(m.workspace_members_action_failed());
    }
  }

  return (
    <div className="w-full px-4 pb-8 sm:px-6">
      <div className="divide-y divide-secondary border-b border-secondary">
        <section className="py-6">
          <header className="flex items-center justify-between gap-4 pb-4">
            <h2 className="text-lg font-semibold">{m.workspace_members_title()}</h2>
            {canManage && (
              <Button
                type="button"
                color="secondary"
                size="sm"
                iconLeading={UsersPlus}
                onPress={() => setInviteOpen(true)}
              >
                {m.workspace_invite_button()}
              </Button>
            )}
          </header>
          <ul aria-label={m.workspace_members_title()} className="divide-y divide-secondary">
            {props.members.map((member) => {
              const isSelf = member.userId === props.actorUserId;
              const displayName = humanLabel(member);
              const canEditRole = canManage && member.role !== "owner";
              const canRemove = canManage && member.role !== "owner" && !isSelf;
              const hasActions = canEditRole || canRemove;

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

        {props.systemChannels}
      </div>

      <InviteMemberDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
}
