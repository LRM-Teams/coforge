import { ProgressBar } from "react-aria-components";
import { AlertCircle, Loading02 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { ThreadPaneHeader } from "./thread-pane-header";

/**
 * Where a thread that was opened by link stands while its first message is not loaded: the thread
 * slot shows it in place of the thread (docs/design/toast-vs-inline.md — what the viewer must see
 * stays in the affected area). `loading` while its window is read; `missing` when the channel has
 * no such first message (deleted, or a link to a message that never started a thread); `failed`
 * when the read itself failed.
 */
export type ThreadRootLoad =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "failed"; errorId?: string };

export function ThreadRootState({
  load,
  context,
  onClose,
  onRetry,
}: {
  load: ThreadRootLoad;
  context?: string;
  onClose: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ThreadPaneHeader context={context} onClose={onClose} />
      {load.status === "loading" ? (
        <div role="status" className="flex items-center justify-center px-4 py-8 text-tertiary">
          <ProgressBar
            isIndeterminate
            aria-label={m.conversation_loading()}
            className="inline-flex size-4 shrink-0"
          >
            <Loading02 aria-hidden className="size-full motion-safe:animate-spin" />
          </ProgressBar>
        </div>
      ) : (
        <div className="grid justify-items-center gap-4 px-4 py-8 text-center md:px-6">
          <AlertCircle aria-hidden="true" className="size-5 text-error-primary" />
          <p role="alert" className="text-sm">
            {load.status === "missing"
              ? m.conversation_thread_unavailable()
              : m.conversation_thread_load_error()}
          </p>
          {load.status === "failed" && load.errorId && (
            <p className="text-xs text-tertiary">{m.error_reference({ errorId: load.errorId })}</p>
          )}
          {load.status === "failed" ? (
            <Button color="secondary" onPress={onRetry}>
              {m.controls_retry()}
            </Button>
          ) : (
            <Button color="secondary" onPress={onClose}>
              {m.conversation_thread_close()}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
