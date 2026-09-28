import { Plus, XClose } from "@untitledui/icons";
import { useRef, useState, type FormEvent } from "react";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { m } from "#src/paraglide/messages";
import { DialogHeader } from "#src/components/application/modals/dialog-header";

/**
 * New Tasks in the conversation: one title per row, "Add another" for more, all created together
 * in one request (so all of them or none).
 */
export function CreateTaskDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (titles: string[], requestId: string) => Promise<void>;
}) {
  const [rows, setRows] = useState(newRows);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  // A retry of the same titles reuses its request id, so a create that did land is not repeated.
  const submission = useRef<{ key: string; requestId: string } | undefined>(undefined);
  const count = rows.length;

  function setRow(id: string, title: string) {
    setError("");
    setRows((current) => current.map((row) => (row.id === id ? { id, title } : row)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    const titles = rows.map((row) => row.title.trim()).filter(Boolean);
    if (titles.length === 0) {
      setError(m.tasks_create_title_required());
      return;
    }
    const key = JSON.stringify(titles);
    const request =
      submission.current?.key === key
        ? submission.current
        : { key, requestId: crypto.randomUUID() };
    submission.current = request;
    busy.current = true;
    setSaving(true);
    setError("");
    try {
      await onCreate(titles, request.requestId);
      submission.current = undefined;
      setRows(newRows());
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
                title={m.tasks_create_heading({ count })}
                onClose={close}
                className="px-0 pt-0"
              />
              <form onSubmit={(event) => void submit(event)} className="mt-5 flex flex-col gap-3">
                <div className="flex flex-col gap-2">
                  {rows.map((row, index) => (
                    <div key={row.id} className="flex items-center gap-1">
                      <Input
                        aria-label={m.tasks_create_row_label({ number: index + 1 })}
                        placeholder={m.tasks_create_row_label({ number: index + 1 })}
                        value={row.title}
                        onChange={(value) => setRow(row.id, value)}
                        maxLength={500}
                        isDisabled={saving}
                        autoFocus={index === count - 1}
                        wrapperClassName="flex-1"
                      />
                      {count > 1 && (
                        <ButtonUtility
                          size="xs"
                          color="tertiary"
                          icon={XClose}
                          aria-label={m.tasks_create_remove_row({ number: index + 1 })}
                          isDisabled={saving}
                          onClick={() =>
                            setRows((current) => current.filter(({ id }) => id !== row.id))
                          }
                        />
                      )}
                    </div>
                  ))}
                </div>
                <Button
                  type="button"
                  size="sm"
                  color="secondary"
                  iconLeading={Plus}
                  isDisabled={saving}
                  className="self-start"
                  onPress={() => setRows((current) => [...current, newRow()])}
                >
                  {m.tasks_create_add_another()}
                </Button>
                {error && (
                  <p role="alert" className="text-sm text-error-primary">
                    {error}
                  </p>
                )}
                <div className="mt-2 flex justify-end gap-3">
                  <Button type="button" color="secondary" isDisabled={saving} onPress={close}>
                    {m.tasks_create_cancel()}
                  </Button>
                  <Button type="submit" isLoading={saving}>
                    {m.tasks_create_submit({ count })}
                  </Button>
                </div>
              </form>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** A title row; its id keeps each input's state with it when an earlier row is removed. */
const newRow = () => ({ id: crypto.randomUUID(), title: "" });
const newRows = () => [newRow()];
