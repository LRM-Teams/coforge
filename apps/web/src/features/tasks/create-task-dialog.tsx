import { useRef, useState, type FormEvent } from "react";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { m } from "#src/paraglide/messages";
import { DialogHeader } from "#src/components/application/modals/dialog-header";

export function CreateTaskDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (title: string, requestId: string) => Promise<void>;
}) {
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
              <DialogHeader
                title={m.tasks_create()}
                description={m.tasks_create_description()}
                onClose={close}
                className="px-0 pt-0"
              />
              <form onSubmit={(event) => void submit(event)} className="mt-5 flex flex-col gap-3">
                <Input
                  label={m.tasks_title()}
                  value={title}
                  onChange={setTitle}
                  isRequired
                  maxLength={500}
                  isDisabled={saving}
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
