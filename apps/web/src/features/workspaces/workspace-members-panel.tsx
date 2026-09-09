import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { Avatar } from "@/components/base/avatar/avatar";
import { Button } from "@/components/base/buttons/button";
import { Select } from "@/components/base/select/select";
import { useAppToast } from "@/components/ui/toast";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { m } from "@/paraglide/messages";
import {
  acceptWorkspaceInvitation,
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
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const invite = useServerFn(inviteWorkspaceMember);
  const accept = useServerFn(acceptWorkspaceInvitation);
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
    <div className="mx-auto w-full max-w-6xl space-y-8 p-4 sm:p-6 lg:p-8">
      {props.incomingInvitations.length > 0 ? (
        <section className="space-y-3">
          <h3 className="text-lg font-semibold">{m.workspace_invitations_incoming()}</h3>
          <ul className="divide-y divide-secondary overflow-hidden rounded-xl border border-secondary bg-primary shadow-xs">
            {props.incomingInvitations.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6"
              >
                <p className="min-w-0 text-sm break-words">
                  {m.workspace_invitation_from({
                    inviter: invitation.inviterUsername,
                    workspace: invitation.workspace.name,
                    role: invitation.role,
                  })}
                </p>
                <Button
                  size="sm"
                  onPress={() => run(() => accept({ data: { invitationId: invitation.id } }))}
                >
                  {m.workspace_invitation_accept()}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canManage ? (
        <section className="grid gap-4 border-b border-secondary pb-6 lg:grid-cols-[240px_1fr] lg:gap-8">
          <h3 className="text-lg font-semibold">{m.workspace_invite_title()}</h3>
          <form
            className="flex min-w-0 flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await invite({ data: { username, role } });
                setUsername("");
              });
            }}
          >
            <label className="min-w-0 flex-1 basis-48 space-y-1.5 text-sm">
              <span className="font-medium">{m.workspace_invite_username()}</span>
              <input
                className="block h-10 w-full rounded-lg border border-secondary bg-primary px-3 py-2 shadow-xs outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="@username"
              />
            </label>
            <div className="space-y-1.5 text-sm">
              <span className="font-medium">{m.workspace_invite_role()}</span>
              <Select
                aria-label={m.workspace_invite_role()}
                size="sm"
                className="w-36"
                selectedKey={role}
                onSelectionChange={(key) => {
                  const value = String(key);
                  if (value === "admin" || value === "member") setRole(value);
                }}
              >
                <Select.Item id="member" label={m.workspace_role_member()} />
                <Select.Item id="admin" label={m.workspace_role_admin()} />
              </Select>
            </div>
            <Button type="submit">{m.workspace_invite_submit()}</Button>
          </form>
        </section>
      ) : null}

      <section className="space-y-3">
        <h3 className="text-lg font-semibold">{m.workspace_members_title()}</h3>
        <ul className="divide-y divide-secondary overflow-hidden rounded-xl border border-secondary bg-primary shadow-xs">
          {props.members.map((member) => {
            const isSelf = member.userId === props.actorUserId;
            const canEditRole = canManage && member.role !== "owner";
            const displayName = member.displayName || member.username;
            return (
              <li
                key={member.userId}
                className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar
                    size="md"
                    alt={displayName}
                    initials={avatarInitial(displayName)}
                    contentClassName={avatarToneClassName(displayName)}
                    className="shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold break-words">
                      @{member.username}
                      {isSelf ? ` (${m.workspace_members_you()})` : ""}
                    </p>
                    <p className="mt-0.5 text-sm text-tertiary">{roleLabel(member.role)}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {canEditRole ? (
                    <Select
                      aria-label={m.workspace_invite_role()}
                      size="sm"
                      className="w-36"
                      selectedKey={member.role}
                      onSelectionChange={(key) => {
                        const value = String(key);
                        if (value !== "admin" && value !== "member") return;
                        void run(() =>
                          updateRole({
                            data: { userId: member.userId, role: value },
                          }),
                        );
                      }}
                    >
                      <Select.Item id="member" label={m.workspace_role_member()} />
                      <Select.Item id="admin" label={m.workspace_role_admin()} />
                    </Select>
                  ) : null}
                  {canManage && member.role !== "owner" && !isSelf ? (
                    <Button
                      size="sm"
                      color="tertiary-destructive"
                      onPress={() => run(() => remove({ data: { userId: member.userId } }))}
                    >
                      {m.workspace_members_remove()}
                    </Button>
                  ) : null}
                  {isSelf && member.role !== "owner" ? (
                    <Button
                      size="sm"
                      color="tertiary-destructive"
                      onPress={() => run(() => leave())}
                    >
                      {m.workspace_members_leave()}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {canManage && props.pendingInvitations.length > 0 ? (
        <section className="space-y-3">
          <h3 className="text-lg font-semibold">{m.workspace_invitations_pending()}</h3>
          <ul className="divide-y divide-secondary overflow-hidden rounded-xl border border-secondary bg-primary shadow-xs">
            {props.pendingInvitations.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6"
              >
                <p className="min-w-0 text-sm break-words">
                  @{invitation.inviteeUsername} · {roleLabel(invitation.role)}
                </p>
                <Button
                  size="sm"
                  color="tertiary-destructive"
                  onPress={() => run(() => revoke({ data: { invitationId: invitation.id } }))}
                >
                  {m.workspace_invitation_revoke()}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
