import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { XClose as X } from "@untitledui/icons";
import { Heading } from "react-aria-components";

import { Button } from "@/components/base/buttons/button";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { m } from "@/paraglide/messages";

export function CreateMemberReportDialog({
  open,
  onOpenChange,
  defaultTitle,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTitle: string;
  onCreate: (title: string) => Promise<void>;
}) {
  const id = useId();
  const [title, setTitle] = useState(defaultTitle);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    if (open) {
      setTitle(defaultTitle);
      setError("");
    }
  }, [open, defaultTitle]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = title.trim();
    if (!next || busy.current) return;
    busy.current = true;
    setSaving(true);
    setError("");
    try {
      await onCreate(next);
      onOpenChange(false);
    } catch {
      setError(m.records_create_report_error());
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
      <Modal className="w-[calc(100vw-2rem)] max-w-md rounded-xl border bg-card p-6 shadow-xl">
        <Dialog>
          {({ close }) => (
            <>
              <button
                type="button"
                aria-label={m.controls_close()}
                className="absolute top-4 right-4 rounded-lg p-2 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                onClick={close}
              >
                <X className="size-4" />
              </button>
              <Heading slot="title" className="pr-8 text-lg font-semibold">
                {m.records_create_report_title()}
              </Heading>
              <p className="mt-2 text-sm text-muted-foreground">
                {m.records_create_report_description()}
              </p>
              <form onSubmit={(event) => void submit(event)} className="mt-5 flex flex-col gap-2">
                <label htmlFor={id} className="text-sm font-medium">
                  {m.records_create_report_name()}
                </label>
                <input
                  id={id}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  maxLength={120}
                  placeholder={m.records_create_report_name_placeholder()}
                  className="h-10 rounded-lg border bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                  autoFocus
                />
                {error ? <p className="text-sm text-destructive">{error}</p> : null}
                <div className="mt-3 flex justify-end gap-2">
                  <Button
                    type="button"
                    color="tertiary"
                    isDisabled={saving}
                    onPress={() => onOpenChange(false)}
                  >
                    {m.records_create_report_cancel()}
                  </Button>
                  <Button type="submit" isDisabled={saving || !title.trim()}>
                    {m.records_create_report_save()}
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
