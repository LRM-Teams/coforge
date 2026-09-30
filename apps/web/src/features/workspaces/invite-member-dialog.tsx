import { useEffect } from "react";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { m } from "#src/paraglide/messages";
import { InviteLinkPanel, useInviteLink } from "./invite-link-panel";

/** The invite-people dialog shared by the Members directory and the Settings Members section: the
 * Workspace's join link, to copy, limit or revoke. Only owners and admins open it. */
export function InviteMemberDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const inviteLink = useInviteLink();

  // The link is made the first time the dialog opens, so there is always one to copy.
  useEffect(() => {
    if (open) inviteLink.show();
  }, [open]);

  function close() {
    inviteLink.reset();
    onOpenChange(false);
  }

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
          <InviteLinkPanel inviteLink={inviteLink} onDone={close} />
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
