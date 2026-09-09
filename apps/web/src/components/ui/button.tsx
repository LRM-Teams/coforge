// Adapted from Untitled UI React's base/buttons/button.tsx (MIT).
import type { AriaAttributes, AriaRole, ComponentProps, ReactElement, ReactNode } from "react";
import { Button as AriaButton, Link as AriaLink } from "react-aria-components";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "group relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-lg text-sm font-semibold outline-ring transition duration-100 ease-linear focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-xs ring-1 ring-transparent ring-inset hover:bg-primary/90 before:pointer-events-none before:absolute before:inset-px before:rounded-[7px] before:border before:border-primary-foreground/12",
        outline:
          "bg-background text-foreground shadow-xs ring-1 ring-border ring-inset hover:bg-muted",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs ring-1 ring-border ring-inset hover:bg-secondary-hover",
        ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
        destructive:
          "bg-background text-destructive-text shadow-xs ring-1 ring-destructive/30 ring-inset outline-destructive hover:bg-destructive/10",
        link: "text-brand underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-9 gap-1 px-3 py-2",
        xs: "min-h-7 gap-1 px-2.5 py-1 text-xs",
        sm: "min-h-8 gap-1 px-2.5 py-1.5",
        lg: "min-h-11 gap-1.5 px-4 py-2.5 text-base",
        icon: "size-9 p-2",
        "icon-xs": "size-6 p-1",
        "icon-sm": "size-8 p-1.5",
        "icon-lg": "size-11 p-3",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ButtonProps = Omit<ComponentProps<typeof AriaButton>, "className" | "render" | "children"> &
  VariantProps<typeof buttonVariants> & {
    children?: ReactNode;
    role?: AriaRole;
    "aria-checked"?: AriaAttributes["aria-checked"];
    className?: string;
    disabled?: boolean;
    render?: ReactElement;
  };

function Button({
  className,
  variant,
  size,
  disabled,
  isDisabled,
  render,
  role,
  slot,
  style,
  "aria-checked": ariaChecked,
  ...props
}: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (render) {
    return (
      <AriaLink
        isDisabled={disabled ?? isDisabled}
        className={classes}
        style={typeof style === "function" ? undefined : style}
        render={(domProps) => (
          <Slot {...props} slot={slot ?? undefined}>
            <Slot {...domProps}>{render}</Slot>
          </Slot>
        )}
      />
    );
  }
  return (
    <AriaButton
      data-slot="button"
      {...props}
      slot={slot}
      style={style}
      render={
        role
          ? (domProps) => <button {...domProps} role={role} aria-checked={ariaChecked} />
          : undefined
      }
      type={props.type ?? "button"}
      isDisabled={disabled ?? isDisabled}
      className={classes}
    />
  );
}

export { Button, buttonVariants };
