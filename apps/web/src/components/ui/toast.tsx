import { type CSSProperties } from "react";
import { AlertCircle, CheckCircle } from "@untitledui/icons";
import { Toaster, toast } from "sonner";

import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { m } from "#src/paraglide/messages";

const toastStyle: CSSProperties & Record<`--${string}`, string> = {
  "--normal-bg": "var(--color-bg-primary)",
  "--normal-text": "var(--color-text-primary)",
  "--normal-border": "var(--color-border-secondary)",
};

const offset = {
  top: "max(1rem, env(safe-area-inset-top))",
  bottom: "max(1rem, env(safe-area-inset-bottom))",
  right: "max(1rem, env(safe-area-inset-right))",
  left: "max(1rem, env(safe-area-inset-left))",
};

export function AppToastProvider({ children }: { children: React.ReactNode }) {
  const desktop = useBreakpoint("md");

  return (
    <>
      {children}
      <Toaster
        position={desktop ? "bottom-right" : "top-center"}
        visibleToasts={3}
        hotkey={["F6"]}
        customAriaLabel={m.navigation_notifications()}
        offset={offset}
        mobileOffset={offset}
        style={toastStyle}
        icons={{
          success: <CheckCircle aria-hidden="true" className="size-4 text-success-primary" />,
          error: <AlertCircle aria-hidden="true" className="size-4 text-error-primary" />,
        }}
        toastOptions={{
          classNames: {
            toast: "rounded-xl!",
            title: "text-sm! font-medium!",
            description: "text-xs! text-tertiary!",
          },
        }}
      />
    </>
  );
}

export function useAppToast() {
  return {
    success(title: string, options?: { durationMs?: number }) {
      toast.success(title, {
        id: `success:${title}`,
        duration: options?.durationMs,
      });
    },
    // A toast only confirms that an action failed; an error reference belongs under an inline
    // failure, never in a toast.
    error(title: string) {
      toast.error(title, { id: `error:${title}` });
    },
  };
}
