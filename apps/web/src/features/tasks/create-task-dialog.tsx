import { useId, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogDescription,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
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
    <Dialog open={open} onOpenChange={(value) => !busy.current && onOpenChange(value)}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className="w-[calc(100vw-2rem)] max-w-md rounded-2xl border bg-card p-6 shadow-xl">
          <DialogClose
            aria-label={m.controls_close()}
            className="absolute top-4 right-4 rounded-md p-1 hover:bg-muted"
          >
            <X className="size-4" />
          </DialogClose>
          <DialogTitle className="text-base font-semibold">{m.tasks_create()}</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-muted-foreground">
            {m.tasks_create_description()}
          </DialogDescription>
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
              className="h-10 rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            {error && (
              <p role="alert" className="text-sm text-destructive-text">
                {error}
              </p>
            )}
            <Button type="submit" disabled={saving || !title.trim()} className="mt-2 self-end">
              {m.tasks_create()}
            </Button>
          </form>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
