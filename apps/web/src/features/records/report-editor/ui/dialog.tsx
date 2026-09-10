"use client";

import {
  cloneElement,
  createContext,
  useContext,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type MouseEventHandler,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "@untitledui/icons";

import { cx } from "@/utils/cx";
import { Button } from "./button";

type DialogContextValue = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const DialogContext = createContext<DialogContextValue | null>(null);

// Merges extra props (className concatenated, matching `on*` handlers
// chained) onto a caller-supplied element — a light stand-in for Base UI's
// `render` prop so callers can keep passing `render={<button .../>}`.
function renderMerge(
  render: ReactElement,
  extra: Record<string, unknown>,
  children?: ReactNode,
): ReactElement {
  const renderProps = render.props as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...renderProps };
  for (const key of Object.keys(extra)) {
    const value = extra[key];
    if (key === "className") {
      merged.className = cx(renderProps.className as string | undefined, value as string);
    } else if (
      key.startsWith("on") &&
      typeof value === "function" &&
      typeof renderProps[key] === "function"
    ) {
      const existing = renderProps[key] as (...args: unknown[]) => void;
      const incoming = value as (...args: unknown[]) => void;
      merged[key] = (...args: unknown[]) => {
        existing(...args);
        incoming(...args);
      };
    } else {
      merged[key] = value;
    }
  }
  if (children !== undefined) merged.children = children;
  return cloneElement(render, merged);
}

function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <DialogContext.Provider
      value={{ open: open ?? false, onOpenChange: onOpenChange ?? (() => {}) }}
    >
      {children}
    </DialogContext.Provider>
  );
}

function DialogTrigger({ onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const ctx = useContext(DialogContext);
  return (
    <button
      type="button"
      data-slot="dialog-trigger"
      onClick={(event) => {
        onClick?.(event);
        ctx?.onOpenChange(true);
      }}
      {...props}
    />
  );
}

function DialogPortal({ children }: { children?: ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(<>{children}</>, document.body);
}

function DialogClose({
  render,
  onClick,
  children,
  ...props
}: {
  render?: ReactElement;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  children?: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick">) {
  const ctx = useContext(DialogContext);
  const handleClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    onClick?.(event);
    ctx?.onOpenChange(false);
  };

  if (render) {
    return renderMerge(render, { onClick: handleClick, ...props }, children);
  }

  return (
    <button type="button" data-slot="dialog-close" onClick={handleClick} {...props}>
      {children}
    </button>
  );
}

function DialogOverlay({ className, style, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-overlay"
      // Inline unlock (not a Tailwind class): modal Drawers (Vaul) lock
      // background via `body.style.pointerEvents = "none"` and only re-enable
      // it on their own content node. Dialog portals to `document.body` (a
      // sibling of that content), so without an explicit unlock the overlay/
      // popup inherit the lock — LRM-1195 Add people search on mobile, same
      // root as LRM-265 AlertDialog. Matches AlertDialogOverlay.
      style={{ ...style, pointerEvents: "auto" }}
      className={cx(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  style,
  ...props
}: ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  const ctx = useContext(DialogContext);
  const open = ctx?.open ?? false;
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") ctx?.onOpenChange(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, ctx]);

  if (!open) return null;

  return (
    <DialogPortal>
      <DialogOverlay onClick={() => ctx?.onOpenChange(false)} />
      <div
        ref={contentRef}
        data-slot="dialog-content"
        role="dialog"
        aria-modal="true"
        style={{ ...style, pointerEvents: "auto" }}
        className={cx(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogClose
            render={<Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" />}
          >
            <X />
            <span className="sr-only">Close</span>
          </DialogClose>
        )}
      </div>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="dialog-header" className={cx("flex flex-col gap-2", className)} {...props} />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cx(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && <DialogClose render={<Button variant="outline" />}>Close</DialogClose>}
    </div>
  );
}

function DialogTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      data-slot="dialog-title"
      className={cx("font-heading text-base leading-none font-medium", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="dialog-description"
      className={cx(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
