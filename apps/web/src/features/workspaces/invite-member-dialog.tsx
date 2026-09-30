import { useState, type FormEvent } from "react";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Tab, TabList, TabPanel, Tabs } from "#src/components/application/tabs/tabs";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { InviteLinkPanel, useInviteLink } from "./invite-link-panel";
import { canManageMembers } from "./workspace-roles";

type InviteTab = "username" | "link";

/** The shared invite-a-member dialog used by the Members directory and the Settings Members
 * section. Owners and admins also get the "By link" tab. */
export function InviteMemberDialog({
  open,
  onOpenChange,
  onInvite,
  actorRole,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvite: (input: { username: string; role: "admin" | "member" }) => Promise<void>;
  /** The viewer's Workspace role; the link tab shows only to those who manage members. */
  actorRole: string;
}) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [error, setError] = useState("");
  const [submitting, guard] = useSubmitGuard();
  const [tab, setTab] = useState<InviteTab>("username");
  const inviteLink = useInviteLink();
  const showLinkTab = canManageMembers(actorRole);

  function close() {
    setUsername("");
    setRole("member");
    setError("");
    setTab("username");
    inviteLink.reset();
    onOpenChange(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!username.trim()) return;
    await guard(async () => {
      setError("");
      try {
        await onInvite({ username: username.trim(), role });
        close();
      } catch {
        setError(m.workspace_members_action_failed());
      }
    });
  }

  const usernameForm = (
    <form onSubmit={submit}>
      <div className="grid gap-4 px-6 py-6">
        <Input
          label={m.workspace_invite_username()}
          placeholder="@username"
          value={username}
          isRequired
          onChange={setUsername}
        />
        <Select
          label={m.workspace_invite_role()}
          selectedKey={role}
          onSelectionChange={(key) => {
            const value = String(key);
            if (value === "admin" || value === "member") setRole(value);
          }}
        >
          <Select.Item id="member" label={m.workspace_role_member()} />
          <Select.Item id="admin" label={m.workspace_role_admin()} />
        </Select>
        {error && (
          <p role="alert" className="text-sm text-error-primary">
            {error}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-3 border-t border-secondary px-6 py-4">
        <Button type="button" color="secondary" onPress={close}>
          {m.controls_cancel()}
        </Button>
        <Button
          type="submit"
          isDisabled={!username.trim()}
          isLoading={submitting}
          showTextWhileLoading
        >
          {submitting ? m.workspace_invite_submitting() : m.workspace_invite_submit()}
        </Button>
      </div>
    </form>
  );

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <Modal className="w-[min(32rem,calc(100vw-2rem))]">
        <Dialog>
          <DialogHeader title={m.workspace_invite_title()} onClose={close} />
          {showLinkTab ? (
            <Tabs
              selectedKey={tab}
              onSelectionChange={(key) => {
                if (key !== "username" && key !== "link") return;
                setTab(key);
                if (key === "link") inviteLink.show();
              }}
            >
              <TabList
                aria-label={m.workspace_invite_tabs()}
                type="underline"
                className="mt-4 border-b border-secondary px-6"
              >
                <Tab id="username">{m.workspace_invite_tab_username()}</Tab>
                <Tab id="link">{m.workspace_invite_tab_link()}</Tab>
              </TabList>
              <TabPanel id="username">{usernameForm}</TabPanel>
              <TabPanel id="link">
                <InviteLinkPanel inviteLink={inviteLink} onDone={close} />
              </TabPanel>
            </Tabs>
          ) : (
            usernameForm
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
