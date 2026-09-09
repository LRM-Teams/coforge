import { useEffect, useState, type CSSProperties } from "react";
import { AlertCircle, CheckCircle } from "@untitledui/icons";
import { Toaster, toast } from "sonner";

import { isAppError } from "@/lib/app-error";
import { m } from "@/paraglide/messages";

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
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return (
    <>
      {children}
      <Toaster
        position={mobile ? "top-center" : "bottom-right"}
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
    success(title: string) {
      toast.success(title, { id: `success:${title}` });
    },
    error(title: string, cause?: unknown) {
      toast.error(title, {
        id: `error:${title}`,
        description:
          isAppError(cause) && cause.errorId
            ? m.error_reference({ errorId: cause.errorId })
            : undefined,
      });
    },
  };
}
