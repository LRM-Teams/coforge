import { useState, type FormEvent } from "react";

import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { DialogHeader } from "@/components/application/modals/dialog-header";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { useSubmitGuard } from "@/hooks/use-submit-guard";
import { m } from "@/paraglide/messages";

/** The shared invite-a-member dialog used by the Members directory and the Settings Members section. */
export function InviteMemberDialog({
  open,
  onOpenChange,
  onInvite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvite: (input: { username: string; role: "admin" | "member" }) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [error, setError] = useState("");
  const [submitting, guard] = useSubmitGuard();

  function close() {
    setUsername("");
    setRole("member");
    setError("");
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

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <Modal className="w-[min(420px,calc(100vw-2rem))]">
        <Dialog>
          <form onSubmit={submit}>
            <DialogHeader title={m.workspace_invite_title()} onClose={close} />
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
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
