"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  autoUpdate,
  computePosition,
  flip,
  offset as offsetMiddleware,
  shift,
  type Placement,
} from "@floating-ui/dom";
import { cx } from "@/utils/cx";

type Side = "top" | "right" | "bottom" | "left";
type Align = "start" | "center" | "end";

type PopoverContextValue = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLElement | null>;
};

const PopoverContext = createContext<PopoverContextValue | null>(null);

function Popover({
  open,
  onOpenChange,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  children?: ReactNode;
}) {
  const triggerRef = useRef<HTMLElement | null>(null);
  return (
    <PopoverContext.Provider
      value={{ open: open ?? false, onOpenChange: onOpenChange ?? (() => {}), triggerRef }}
    >
      {children}
    </PopoverContext.Provider>
  );
}

function PopoverTrigger({ className, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const ctx = useContext(PopoverContext);
  return (
    <button
      type="button"
      ref={(node) => {
        if (ctx) ctx.triggerRef.current = node;
      }}
      data-slot="popover-trigger"
      className={className}
      onClick={(event) => {
        onClick?.(event);
        ctx?.onOpenChange(!ctx.open);
      }}
      {...props}
    />
  );
}

function PopoverContent({
  className,
  align = "center",
  alignOffset: _alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  keepMounted,
  children,
  ...props
}: ComponentProps<"div"> & {
  align?: Align;
  alignOffset?: number;
  side?: Side;
  sideOffset?: number;
  // Kept in the DOM while closed. Needed when the content hosts a modal
  // (confirm dialog / transcript) that opens on click: without it the popup
  // unmounts the moment focus leaves for the dialog, tearing the dialog down
  // with it.
  keepMounted?: boolean;
}) {
  const ctx = useContext(PopoverContext);
  const open = ctx?.open ?? false;
  const contentRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({
    position: "fixed",
    top: 0,
    left: 0,
    visibility: "hidden",
  });

  useEffect(() => {
    if (!open) return;
    const trigger = ctx?.triggerRef.current;
    const content = contentRef.current;
    if (!trigger || !content) return;
    const placement: Placement = align === "center" ? side : (`${side}-${align}` as Placement);

    function update() {
      void computePosition(trigger!, content!, {
        placement,
        strategy: "fixed",
        middleware: [offsetMiddleware(sideOffset), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        setStyle({ position: "fixed", top: y, left: x, visibility: "visible" });
      });
    }

    update();
    return autoUpdate(trigger, content, update);
  }, [open, side, sideOffset, align, ctx]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (contentRef.current?.contains(target)) return;
      if (ctx?.triggerRef.current?.contains(target)) return;
      ctx?.onOpenChange(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") ctx?.onOpenChange(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, ctx]);

  if (!open && !keepMounted) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={contentRef}
      data-slot="popover-content"
      style={open ? style : { ...style, visibility: "hidden", pointerEvents: "none" }}
      className={cx(
        "z-50 flex w-72 flex-col gap-2.5 rounded-lg bg-popover p-2.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100",
        className,
      )}
      {...props}
    >
      {children}
    </div>,
    document.body,
  );
}

function PopoverHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cx("flex flex-col gap-0.5 text-sm", className)}
      {...props}
    />
  );
}

function PopoverTitle({ className, ...props }: ComponentProps<"h3">) {
  return (
    <h3
      data-slot="popover-title"
      className={cx("font-heading font-medium", className)}
      {...props}
    />
  );
}

function PopoverDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cx("text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger };
