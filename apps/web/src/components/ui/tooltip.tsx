// Adapted from Untitled UI React's base/tooltip/tooltip.tsx (MIT).
import {
  createContext,
  useContext,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Button,
  Tooltip as AriaTooltip,
  TooltipTrigger as AriaTooltipTrigger,
} from "react-aria-components";
import { cn } from "@/lib/utils";

const DelayContext = createContext(0);
function TooltipProvider({ delay = 0, children }: { delay?: number; children: ReactNode }) {
  return <DelayContext value={delay}>{children}</DelayContext>;
}
function Tooltip(props: ComponentProps<typeof AriaTooltipTrigger>) {
  const delay = useContext(DelayContext);
  return <AriaTooltipTrigger delay={delay} closeDelay={0} {...props} />;
}
function TooltipTrigger({
  render,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "render"> & { render?: ReactElement }) {
  // React Aria triggers provide their interaction props through context. Its
  // own components consume that context directly; wrapping them in Focusable
  // via Slot hides the interactive leaf and causes the missing-role warning.
  if (render) return render;
  return (
    <Button type="button" {...props}>
      {children}
    </Button>
  );
}
function TooltipContent({
  className,
  side = "top",
  sideOffset = 6,
  align = "center",
  alignOffset = 0,
  ...props
}: Omit<ComponentProps<typeof AriaTooltip>, "className"> & {
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
  align?: "start" | "center" | "end";
  alignOffset?: number;
}) {
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
    <AriaTooltip
      {...props}
      placement={placement}
      offset={sideOffset}
      crossOffset={alignOffset}
      className={cn(
        "z-50 flex max-w-xs items-center gap-1.5 rounded-lg bg-foreground px-3 py-2 text-xs font-semibold text-background shadow-lg outline-none",
        className,
      )}
    />
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
