import { useId, useRef, useState, type FormEvent } from "react";
import { XClose as X } from "@untitledui/icons";
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
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy.current) onOpenChange(value);
      }}
    >
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className="w-[calc(100vw-2rem)] max-w-md rounded-xl border bg-card p-6 shadow-xl">
          <DialogClose
            aria-label={m.controls_close()}
            className="absolute top-4 right-4 rounded-lg p-2 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <X className="size-4" />
          </DialogClose>
          <DialogTitle className="pr-8 text-lg font-semibold">{m.channel_create()}</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-muted-foreground">
            {m.channel_public_description()}
          </DialogDescription>
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
              className="h-10 rounded-lg border bg-background px-3 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring disabled:opacity-50"
            />
            <p id={`${id}-hint`} className="text-xs text-muted-foreground">
              {m.channel_name_hint()}
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive-text">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={saving || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name.trim())}
              className="mt-4 w-full"
            >
              {m.channel_create()}
            </Button>
          </form>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
