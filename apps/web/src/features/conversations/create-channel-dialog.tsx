import { useId, useRef, useState, type FormEvent } from "react";
import { XClose } from "@untitledui/icons";
import { Heading, Text } from "react-aria-components";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { isAppError } from "@/lib/app-error";
import { m } from "@/paraglide/messages";

export function CreateChannelDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError("");
    try {
      await onCreate(name.trim());
      setName("");
      onOpenChange(false);
    } catch (cause) {
      setError(
        isAppError(cause) && cause.code === "CONFLICT" ? m.channel_conflict() : m.channel_error(),
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(value) => {
        if (!busy.current) onOpenChange(value);
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="p-6">
          {({ close }) => (
            <>
              <ButtonUtility
                aria-label={m.controls_close()}
                icon={XClose}
                size="sm"
                color="tertiary"
                className="absolute top-4 right-4"
                onClick={close}
              />
              <Heading slot="title" className="pr-8 text-lg font-semibold text-primary">
                {m.channel_create()}
              </Heading>
              <Text slot="description" className="mt-2 text-sm text-tertiary">
                {m.channel_public_description()}
              </Text>
              <form onSubmit={(event) => void submit(event)} className="mt-5 flex flex-col gap-2">
                <label htmlFor={id} className="text-sm font-medium">
                  {m.channel_name()}
                </label>
                <input
                  id={id}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={32}
                  pattern="[a-z0-9][a-z0-9_\-]{0,31}"
                  placeholder="engineering"
                  disabled={saving}
                  aria-describedby={`${id}-hint`}
                  className="h-10 rounded-lg border border-secondary bg-primary px-3 text-sm shadow-xs outline-none placeholder:text-tertiary focus:border-brand focus:ring-1 focus:ring-brand disabled:opacity-50"
                />
                <p id={`${id}-hint`} className="text-xs text-tertiary">
                  {m.channel_name_hint()}
                </p>
                {error && (
                  <p role="alert" className="text-sm text-error-primary">
                    {error}
                  </p>
                )}
                <Button
                  type="submit"
                  isDisabled={saving || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name.trim())}
                  className="mt-4 w-full"
                >
                  {m.channel_create()}
                </Button>
              </form>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
