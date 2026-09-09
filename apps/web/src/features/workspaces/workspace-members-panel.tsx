import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppToast } from "@/components/ui/toast";
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
    <div className="space-y-8 p-4 md:p-6">
      {props.incomingInvitations.length > 0 ? (
        <section className="space-y-3">
          <h3 className="text-sm font-medium">{m.workspace_invitations_incoming()}</h3>
          <ul className="space-y-2">
            {props.incomingInvitations.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 py-2"
              >
                <p className="text-sm">
                  {m.workspace_invitation_from({
                    inviter: invitation.inviterUsername,
                    workspace: invitation.workspace.name,
                    role: invitation.role,
                  })}
                </p>
                <Button
                  size="sm"
                  onClick={() => run(() => accept({ data: { invitationId: invitation.id } }))}
                >
                  {m.workspace_invitation_accept()}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canManage ? (
        <section className="space-y-3">
          <h3 className="text-sm font-medium">{m.workspace_invite_title()}</h3>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await invite({ data: { username, role } });
                setUsername("");
              });
            }}
          >
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">{m.workspace_invite_username()}</span>
              <input
                className="block w-48 rounded-md border bg-background px-2 py-1.5"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="@username"
              />
            </label>
            <div className="space-y-1 text-sm">
              <span className="text-muted-foreground">{m.workspace_invite_role()}</span>
              <Select
                value={role}
                onValueChange={(value) => {
                  if (value === "admin" || value === "member") setRole(value);
                }}
              >
                <SelectTrigger aria-label={m.workspace_invite_role()} className="h-8 w-36">
                  <SelectValue>{() => roleLabel(role)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">{m.workspace_role_member()}</SelectItem>
                  <SelectItem value="admin">{m.workspace_role_admin()}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" size="sm">
              {m.workspace_invite_submit()}
            </Button>
          </form>
        </section>
      ) : null}

      <section className="space-y-3">
        <h3 className="text-sm font-medium">{m.workspace_members_title()}</h3>
        <ul className="space-y-2">
          {props.members.map((member) => {
            const isSelf = member.userId === props.actorUserId;
            const canEditRole = canManage && member.role !== "owner";
            return (
              <li
                key={member.userId}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    @{member.username}
                    {isSelf ? ` (${m.workspace_members_you()})` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">{roleLabel(member.role)}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {canEditRole ? (
                    <Select
                      value={member.role}
                      onValueChange={(value) => {
                        if (value !== "admin" && value !== "member") return;
                        void run(() =>
                          updateRole({
                            data: { userId: member.userId, role: value },
                          }),
                        );
                      }}
                    >
                      <SelectTrigger
                        aria-label={m.workspace_invite_role()}
                        className="h-8 w-36"
                      >
                        <SelectValue>{() => roleLabel(member.role)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">{m.workspace_role_member()}</SelectItem>
                        <SelectItem value="admin">{m.workspace_role_admin()}</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : null}
                  {canManage && member.role !== "owner" && !isSelf ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => run(() => remove({ data: { userId: member.userId } }))}
                    >
                      {m.workspace_members_remove()}
                    </Button>
                  ) : null}
                  {isSelf && member.role !== "owner" ? (
                    <Button size="sm" variant="ghost" onClick={() => run(() => leave())}>
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
          <h3 className="text-sm font-medium">{m.workspace_invitations_pending()}</h3>
          <ul className="space-y-2">
            {props.pendingInvitations.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 py-2"
              >
                <p className="text-sm">
                  @{invitation.inviteeUsername} · {roleLabel(invitation.role)}
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    run(() => revoke({ data: { invitationId: invitation.id } }))
                  }
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
