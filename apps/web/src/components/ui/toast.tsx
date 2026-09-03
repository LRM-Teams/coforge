import { Toast } from "@base-ui/react/toast";
import { X } from "lucide-react";

import { isAppError } from "@/lib/app-error";
import { m } from "@/paraglide/messages";

export function AppToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <Toast.Provider>
      {children}
      <Toast.Portal>
        <Toast.Viewport
          aria-label={m.navigation_notifications()}
          className="fixed right-4 bottom-4 z-50 flex w-[calc(100vw-2rem)] max-w-sm flex-col-reverse gap-2 outline-none"
        >
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

export function useAppToast() {
  const manager = Toast.useToastManager();
  return {
    error(title: string, cause?: unknown) {
      manager.add({
        title,
        description: errorReference(cause),
        type: "error",
        priority: "high",
      });
    },
  };
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      className="rounded-xl border border-destructive/30 bg-popover p-4 text-popover-foreground shadow-lg transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0"
    >
      <Toast.Content className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Toast.Title className="text-sm font-medium" />
          <Toast.Description className="mt-1 text-xs text-muted-foreground" />
        </div>
        <Toast.Close
          aria-label={m.toast_dismiss()}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X aria-hidden="true" className="size-4" />
        </Toast.Close>
      </Toast.Content>
    </Toast.Root>
  ));
}

function errorReference(cause: unknown): string | undefined {
  return isAppError(cause) && cause.errorId
    ? m.error_reference({ errorId: cause.errorId })
    : undefined;
}
