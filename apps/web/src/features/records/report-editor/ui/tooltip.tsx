"use client";

import {
  cloneElement,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactElement,
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

type TooltipContextValue = {
  open: boolean;
  show: () => void;
  hide: () => void;
  triggerRef: RefObject<HTMLElement | null>;
};

const TooltipContext = createContext<TooltipContextValue | null>(null);

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

function TooltipProvider({ children }: { delay?: number; children?: ReactNode }) {
  return <>{children}</>;
}

function Tooltip({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(
    () => () => {
      if (showTimer.current) clearTimeout(showTimer.current);
    },
    [],
  );

  const value = useMemo<TooltipContextValue>(
    () => ({
      open,
      show: () => {
        if (showTimer.current) clearTimeout(showTimer.current);
        showTimer.current = setTimeout(() => setOpen(true), 300);
      },
      hide: () => {
        if (showTimer.current) clearTimeout(showTimer.current);
        setOpen(false);
      },
      triggerRef,
    }),
    [open],
  );

  return <TooltipContext.Provider value={value}>{children}</TooltipContext.Provider>;
}

function TooltipTrigger({
  render,
  children,
  className,
  ...props
}: {
  render?: ReactElement;
  children?: ReactNode;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className">) {
  const ctx = useContext(TooltipContext);

  const triggerHandlers = {
    onMouseEnter: () => ctx?.show(),
    onMouseLeave: () => ctx?.hide(),
    onFocus: () => ctx?.show(),
    onBlur: () => ctx?.hide(),
  };

  const setRef = (node: HTMLElement | null) => {
    if (ctx) ctx.triggerRef.current = node;
  };

  if (render) {
    return renderMerge(render, { ...triggerHandlers, className, ref: setRef, ...props }, children);
  }

  return (
    <button
      type="button"
      ref={setRef}
      data-slot="tooltip-trigger"
      className={cx("h-max w-max outline-hidden", className)}
      {...triggerHandlers}
      {...props}
    >
      {children}
    </button>
  );
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  children,
  ...props
}: {
  className?: string;
  side?: Side;
  sideOffset?: number;
  align?: Align;
  alignOffset?: number;
  children?: ReactNode;
  [key: string]: unknown;
}) {
  const ctx = useContext(TooltipContext);
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

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={contentRef}
      data-slot="tooltip-content"
      role="tooltip"
      style={style}
      className={cx(
        "z-50 inline-flex w-fit max-w-xs items-center gap-1.5 rounded-lg border border-border bg-popover px-2.5 py-1 text-xs text-popover-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>,
    document.body,
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
