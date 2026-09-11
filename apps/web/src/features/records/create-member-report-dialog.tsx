import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { XClose as X } from "@untitledui/icons";
import { Heading } from "react-aria-components";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
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
      <Modal className="w-[calc(100vw-2rem)] max-w-md rounded-xl bg-primary p-6 shadow-xl ring-1 ring-secondary">
        <Dialog>
          {({ close }) => (
            <>
              <ButtonUtility
                size="sm"
                color="tertiary"
                icon={X}
                aria-label={m.controls_close()}
                className="absolute top-4 right-4"
                onClick={close}
              />
              <Heading slot="title" className="pr-8 text-lg font-semibold text-primary">
                {m.records_create_report_title()}
              </Heading>
              <form onSubmit={(event) => void submit(event)} className="mt-5 flex flex-col gap-2">
                <Input
                  id={id}
                  label={m.records_create_report_name()}
                  value={title}
                  onChange={setTitle}
                  isRequired
                  maxLength={120}
                  placeholder={m.records_create_report_name_placeholder()}
                  autoFocus
                />
                {error ? <p className="text-sm text-error-primary">{error}</p> : null}
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
