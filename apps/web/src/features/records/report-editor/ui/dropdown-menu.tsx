"use client";

import {
  cloneElement,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ComponentProps,
  type MouseEvent,
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
import { Check, ChevronRight } from "@untitledui/icons";
import { cx } from "@/utils/cx";

type Side = "top" | "right" | "bottom" | "left";
type Align = "start" | "center" | "end";

type DropdownMenuContextValue = {
  open: boolean;
  isControlled: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: RefObject<HTMLElement | null>;
};

const DropdownMenuContext = createContext<DropdownMenuContextValue | null>(null);

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

function DropdownMenu({
  open,
  onOpenChange,
  children,
  modal: _modal,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
  modal?: boolean;
}) {
  const isControlled = open !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const resolvedOpen = isControlled ? (open as boolean) : internalOpen;

  const setOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };

  return (
    <DropdownMenuContext.Provider value={{ open: resolvedOpen, isControlled, setOpen, triggerRef }}>
      {children}
    </DropdownMenuContext.Provider>
  );
}

function DropdownMenuPortal({
  children,
  container,
}: {
  children?: ReactNode;
  container?: Element | null;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(<>{children}</>, container ?? document.body);
}

function DropdownMenuTrigger({
  render,
  children,
  className,
  onClick,
  ...props
}: {
  render?: ReactElement;
  children?: ReactNode;
  className?: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  [key: string]: unknown;
}) {
  const ctx = useContext(DropdownMenuContext);

  const setRef = (node: HTMLElement | null) => {
    if (ctx) ctx.triggerRef.current = node;
  };

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    // Only auto-toggle when the menu's open state isn't externally driven —
    // callers that pass `open` to `DropdownMenu` manage opening themselves
    // (e.g. table-controls.tsx's drag/pointer-driven column & row menus).
    if (ctx && !ctx.isControlled) ctx.setOpen(!ctx.open);
  };

  if (render) {
    return renderMerge(
      render,
      { onClick: handleClick, className, ref: setRef, ...props },
      children,
    );
  }

  return (
    <button
      type="button"
      ref={setRef}
      data-slot="dropdown-menu-trigger"
      className={className}
      onClick={handleClick}
      {...props}
    >
      {children}
    </button>
  );
}

function DropdownMenuContent({
  align = "start",
  alignOffset: _alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  onClick,
  container,
  finalFocus: _finalFocus,
  children,
  ...props
}: ComponentProps<"div"> & {
  align?: Align;
  alignOffset?: number;
  side?: Side;
  sideOffset?: number;
  container?: Element | null;
  // Base UI's "return focus to trigger on close" toggle. This lightweight
  // reimplementation doesn't manage focus return, so the flag is accepted
  // (for API parity with existing call sites) and otherwise unused.
  finalFocus?: boolean;
}) {
  const ctx = useContext(DropdownMenuContext);
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
    function onPointerDownOutside(event: Event) {
      const target = event.target as Node;
      if (contentRef.current?.contains(target)) return;
      if (ctx?.triggerRef.current?.contains(target)) return;
      ctx?.setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") ctx?.setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDownOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDownOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, ctx]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={contentRef}
      data-slot="dropdown-menu-content"
      role="menu"
      style={style}
      onClick={(event) => {
        // Stop clicks from bubbling out of the menu into a row the trigger
        // might be nested in (e.g. an `<a>` wrapping the whole row).
        event.stopPropagation();
        onClick?.(event);
      }}
      className={cx(
        "z-50 max-h-[min(24rem,70vh)] min-w-32 overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none",
        className,
      )}
      {...props}
    >
      {children}
    </div>,
    container ?? document.body,
  );
}

function DropdownMenuGroup({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="dropdown-menu-group" role="group" className={className} {...props} />;
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: ComponentProps<"div"> & { inset?: boolean }) {
  return (
    <div
      data-slot="dropdown-menu-label"
      data-inset={inset || undefined}
      className={cx(
        "px-1.5 py-1 text-xs font-medium text-muted-foreground data-inset:pl-7",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  disabled,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  const ctx = useContext(DropdownMenuContext);

  return (
    <button
      type="button"
      role="menuitem"
      data-slot="dropdown-menu-item"
      data-inset={inset || undefined}
      data-variant={variant}
      data-disabled={disabled || undefined}
      disabled={disabled}
      className={cx(
        "group/dropdown-menu-item relative flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:hover:bg-destructive/10 data-[variant=destructive]:hover:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:hover:bg-destructive/20 dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        // Selecting an item closes the menu — table-controls.tsx items use
        // `onPointerDown` and close themselves explicitly, so this is a
        // harmless no-op for them; code-block-view.tsx items use `onClick`
        // and rely on this to close after selection.
        ctx?.setOpen(false);
      }}
      {...props}
    />
  );
}

function DropdownMenuSub({ children }: { children?: ReactNode }) {
  return <DropdownMenu>{children}</DropdownMenu>;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: ComponentProps<"button"> & { inset?: boolean }) {
  return (
    <DropdownMenuTrigger
      data-inset={inset || undefined}
      className={cx(
        "flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground data-inset:pl-7 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto" />
    </DropdownMenuTrigger>
  );
}

function DropdownMenuSubContent({
  align = "start",
  alignOffset = -3,
  side = "right",
  sideOffset = 0,
  className,
  ...props
}: ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      className={cx(
        "w-auto min-w-[96px] rounded-lg bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-100",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { checked?: boolean; inset?: boolean }) {
  return (
    <DropdownMenuItem
      inset={inset}
      className={cx("relative py-1 pr-8 pl-1.5", className)}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        {checked ? <Check className="size-4" /> : null}
      </span>
      {children}
    </DropdownMenuItem>
  );
}

function DropdownMenuRadioGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="dropdown-menu-radio-group" role="radiogroup" className={className} {...props} />
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  checked,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { inset?: boolean; checked?: boolean }) {
  return (
    <DropdownMenuItem
      inset={inset}
      className={cx("relative py-1 pr-8 pl-1.5", className)}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        {checked ? <Check className="size-4" /> : null}
      </span>
      {children}
    </DropdownMenuItem>
  );
}

function DropdownMenuSeparator({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      role="separator"
      data-slot="dropdown-menu-separator"
      className={cx("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cx(
        "ml-auto text-xs tracking-widest text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
