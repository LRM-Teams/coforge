import { useId, useRef, useState, type FormEvent } from "react";
import { XClose as X } from "@untitledui/icons";
import { Heading, Text } from "react-aria-components";

import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Button } from "@/components/base/buttons/button";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { m } from "@/paraglide/messages";

export function CreateTaskDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (title: string, requestId: string) => Promise<void>;
}) {
  const id = useId();
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const submission = useRef<{ title: string; requestId: string } | undefined>(undefined);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || busy.current) return;
    const request =
      submission.current?.title === trimmed
        ? submission.current
        : { title: trimmed, requestId: crypto.randomUUID() };
    submission.current = request;
    busy.current = true;
    setSaving(true);
    setError("");
    try {
      await onCreate(request.title, request.requestId);
      submission.current = undefined;
      setTitle("");
      onOpenChange(false);
    } catch {
      setError(m.tasks_create_error());
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  return (
    <ModalOverlay isOpen={open} onOpenChange={(value) => !busy.current && onOpenChange(value)}>
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="p-6">
          {({ close }) => (
            <>
              <ButtonUtility
                aria-label={m.controls_close()}
                icon={X}
                size="sm"
                color="tertiary"
                className="absolute top-4 right-4"
                onClick={close}
              />
              <Heading slot="title" className="text-base font-semibold text-primary">
                {m.tasks_create()}
              </Heading>
              <Text slot="description" className="mt-2 text-sm text-tertiary">
                {m.tasks_create_description()}
              </Text>
              <form onSubmit={(event) => void submit(event)} className="mt-5 flex flex-col gap-3">
                <label htmlFor={id} className="text-sm font-medium">
                  {m.tasks_title()}
                </label>
                <input
                  id={id}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  maxLength={500}
                  disabled={saving}
                  className="h-10 rounded-lg border border-secondary bg-primary px-3 text-sm outline-none focus:ring-2 focus:ring-brand"
                />
                {error && (
                  <p role="alert" className="text-sm text-error-primary">
                    {error}
                  </p>
                )}
                <Button
                  type="submit"
                  isDisabled={saving || !title.trim()}
                  className="mt-2 self-end"
                >
                  {m.tasks_create()}
                </Button>
              </form>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
