import { useState, type FormEvent } from "react";

import { Button } from "@/components/base/buttons/button";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { DialogHeader } from "@/components/application/modals/dialog-header";
import { m } from "@/paraglide/messages";
import {
  AgentRuntimeFields,
  type RuntimeOptions,
  type RuntimeSelection,
} from "./agent-runtime-fields";

/**
 * The RUNTIME CONFIG pencil's form body: the same `AgentRuntimeFields` as the full page's edit
 * dialog, plus Save/Cancel and an inline error line. Kept as its own plain component (no
 * `Modal`/`Dialog`) so it renders outside a browser DOM — `Modal` needs a portal target
 * `renderToStaticMarkup` cannot provide (verified: it renders empty, no thrown error), so
 * `agent-runtime-config-dialog.test.tsx` renders this piece directly instead of the dialog shell.
 * Save stays disabled until `AgentRuntimeFields` reports an actual change via `onDirtyChange`.
 */
export function AgentRuntimeConfigForm({
  computerId,
  credentialConfigured = false,
  initial,
  onLoad,
  saving,
  error,
  onClose,
  onSave,
}: {
  computerId: string;
  credentialConfigured?: boolean;
  initial: RuntimeSelection;
  onLoad: (computerId: string) => Promise<RuntimeOptions>;
  saving: boolean;
  error: string;
  onClose?: () => void;
  onSave: (form: FormData) => void;
}) {
  const [dirty, setDirty] = useState(false);
  return (
    <form
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSave(new FormData(event.currentTarget));
      }}
    >
      <DialogHeader title={m.agent_profile_edit_runtime_config()} onClose={onClose} />
      <div className="grid gap-4 px-6 py-6 sm:grid-cols-2">
        <AgentRuntimeFields
          open
          computerId={computerId}
          credentialConfigured={credentialConfigured}
          initial={initial}
          onLoad={onLoad}
          onDirtyChange={setDirty}
        />
        {error && (
          <p role="alert" className="text-sm text-error-primary sm:col-span-2">
            {error}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-3 border-t border-secondary px-6 py-4">
        <Button type="button" size="md" color="secondary" isDisabled={saving} onPress={onClose}>
          {m.controls_cancel()}
        </Button>
        <Button type="submit" size="md" isDisabled={saving || !dirty}>
          {saving ? m.agent_profile_saving() : m.agent_profile_save_runtime_config()}
        </Button>
      </div>
    </form>
  );
}

/**
 * The Agent profile panel's Runtime config pencil target — a modal dialog, mirroring
 * `AgentRuntimeCredentialDialog` and the full page's edit dialog, rather than editing the
 * RUNTIME CONFIG section in place: the Runtime/Model/Reasoning badges never change; only the
 * pencil opens this. Closing (Esc, overlay click, Cancel, the header's X) is blocked while
 * `saving`, same as the credential dialog.
 */
export function AgentRuntimeConfigDialog({
  open,
  onClose,
  computerId,
  credentialConfigured,
  initial,
  onLoad,
  saving,
  error,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  computerId: string;
  credentialConfigured?: boolean;
  initial: RuntimeSelection;
  onLoad: (computerId: string) => Promise<RuntimeOptions>;
  saving: boolean;
  error: string;
  onSave: (form: FormData) => void;
}) {
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(next: boolean) => {
        if (saving) return;
        if (!next) onClose();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog>
          {({ close }) => (
            <AgentRuntimeConfigForm
              computerId={computerId}
              credentialConfigured={credentialConfigured}
              initial={initial}
              onLoad={onLoad}
              saving={saving}
              error={error}
              onClose={close}
              onSave={onSave}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
