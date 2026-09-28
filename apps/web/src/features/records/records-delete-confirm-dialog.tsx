import { AlertCircle, XClose as X } from "@untitledui/icons";
import { Heading, Text } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { FeaturedIcon } from "#src/components/foundations/featured-icon/featured-icon";
import { m } from "#src/paraglide/messages";

/**
 * Confirms an irreversible delete in Records settings (a weekly template, or one key-point prompt
 * history entry). Same shape as `WeeklySendConfirmDialog`; the confirm is the surface's one solid
 * red button.
 */
export function RecordsDeleteConfirmDialog({
  open,
  title,
  description,
  busy,
  error,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  busy?: boolean;
  /** Why the last delete attempt failed; shown inline under the description. */
  error?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(value) => {
        if (busy) return;
        onOpenChange(value);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="p-6">
          {({ close }) => (
            <>
              <ButtonUtility
                aria-label={m.controls_close()}
                icon={X}
                size="sm"
                color="tertiary"
                isDisabled={busy}
                className="absolute top-4 right-4"
                onClick={close}
              />
              <div className="flex items-start gap-3 pr-8">
                <FeaturedIcon color="error" theme="light" size="sm" icon={AlertCircle} />
                <div className="min-w-0 space-y-2">
                  <Heading
                    slot="title"
                    className="text-base font-semibold text-primary wrap-anywhere"
                  >
                    {title}
                  </Heading>
                  <Text slot="description" className="text-sm text-secondary">
                    {description}
                  </Text>
                  {error && (
                    <p role="alert" className="text-sm text-error-primary">
                      {error}
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-6 flex justify-end gap-3">
                <Button type="button" color="secondary" size="sm" isDisabled={busy} onPress={close}>
                  {m.records_delete_cancel()}
                </Button>
                <Button
                  type="button"
                  color="primary-destructive"
                  size="sm"
                  isDisabled={busy}
                  isLoading={busy}
                  showTextWhileLoading
                  onPress={() => void onConfirm()}
                >
                  {busy ? m.records_delete_pending() : m.records_delete_confirm()}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
