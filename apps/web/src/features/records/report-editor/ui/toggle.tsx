"use client";

import type { ButtonHTMLAttributes } from "react";
import { cx } from "@/utils/cx";

type ToggleVariant = "default" | "outline";
type ToggleSize = "default" | "sm" | "lg";

const variantClassNames: Record<ToggleVariant, string> = {
  default: "bg-transparent",
  outline: "border border-input bg-transparent hover:bg-muted",
};

const sizeClassNames: Record<ToggleSize, string> = {
  default: "h-8 min-w-8 px-2",
  sm: "h-7 min-w-7 rounded-[min(var(--radius-md),12px)] px-1.5 text-[0.8rem]",
  lg: "h-9 min-w-9 px-2.5",
};

function toggleVariants({
  variant = "default",
  size = "default",
  className,
}: { variant?: ToggleVariant; size?: ToggleSize; className?: string } = {}) {
  return cx(
    "group/toggle inline-flex items-center justify-center gap-1 rounded-lg text-sm font-medium whitespace-nowrap transition-all outline-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-pressed:bg-muted dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    variantClassNames[variant],
    sizeClassNames[size],
    className,
  );
}

function Toggle({
  className,
  variant = "default",
  size = "default",
  pressed,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ToggleVariant;
  size?: ToggleSize;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      data-slot="toggle"
      aria-pressed={pressed}
      className={toggleVariants({ variant, size, className })}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
