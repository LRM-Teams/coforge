// Adapted from Untitled UI React's base/dropdown/dropdown.tsx (MIT).
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Button,
  Header,
  Menu,
  MenuItem,
  MenuSection,
  MenuTrigger,
  Popover,
  Separator,
} from "react-aria-components";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";

function DropdownMenu({
  modal: _modal,
  open,
  onOpenChange,
  children,
}: {
  modal?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <MenuTrigger isOpen={open} onOpenChange={onOpenChange}>
      {children}
    </MenuTrigger>
  );
}

function DropdownMenuTrigger({
  render,
  ...props
}: Omit<ComponentProps<typeof Button>, "render"> & { render?: ReactElement }) {
  return (
    <Button
      data-slot="dropdown-menu-trigger"
      {...props}
      render={render ? (domProps) => <Slot {...domProps}>{render}</Slot> : undefined}
    />
  );
}

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Popover>, "children" | "className"> & {
  children: ReactNode;
  className?: string;
  align?: "start" | "center" | "end";
  alignOffset?: number;
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
}) {
  // Existing menus have a non-interactive account/loading header before their collection.
  const nodes = Children.toArray(children);
  const headers = nodes.filter((child) => isValidElement(child) && child.type === "div");
  const items = nodes.filter((child) => !headers.includes(child));
  const placement =
    align === "center"
      ? side
      : side === "left"
        ? align === "start"
          ? "left top"
          : "left bottom"
        : side === "right"
          ? align === "start"
            ? "right top"
            : "right bottom"
          : side === "top"
            ? align === "start"
              ? "top start"
              : "top end"
            : align === "start"
              ? "bottom start"
              : "bottom end";
  return (
    <Popover
      {...props}
      placement={placement}
      offset={sideOffset}
      crossOffset={alignOffset}
      className={cn(
        "z-50 max-h-[min(24rem,var(--available-height))] min-w-48 origin-(--trigger-anchor-point) overflow-auto rounded-lg bg-popover text-popover-foreground shadow-lg ring-1 ring-border [--anchor-width:var(--trigger-width)]",
        className,
      )}
    >
      {headers}
      <Menu className="h-min py-1 outline-none select-none">{items}</Menu>
    </Popover>
  );
}

const DropdownMenuGroup = MenuSection;
function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Header>) {
  return (
    <Header
      {...props}
      className={cn("px-3 py-2 text-xs font-semibold text-muted-foreground", className)}
    />
  );
}

function DropdownMenuItem({
  className,
  children,
  render,
  onClick,
  disabled,
  variant = "default",
  ...props
}: Omit<ComponentProps<typeof MenuItem>, "render" | "className" | "children"> & {
  className?: string;
  children?: ReactNode;
  render?: ReactElement;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <MenuItem
      {...props}
      isDisabled={disabled ?? props.isDisabled}
      onAction={onClick ?? props.onAction}
      data-slot="dropdown-menu-item"
      render={render ? (domProps) => <Slot {...domProps}>{render}</Slot> : undefined}
      className={cn(
        "group relative mx-1.5 flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm font-semibold outline-ring transition duration-100 ease-linear select-none data-focused:bg-muted data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 data-disabled:cursor-not-allowed data-disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
        variant === "destructive" && "text-destructive-text data-focused:bg-destructive/10",
        className,
      )}
    >
      {children}
    </MenuItem>
  );
}

function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof Separator>) {
  return <Separator {...props} className={cn("my-1 h-px w-full bg-border", className)} />;
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
};
