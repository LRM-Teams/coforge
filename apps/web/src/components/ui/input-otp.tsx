import * as React from "react";
import { cn } from "@/lib/utils";
import { OTPInput, OTPInputContext } from "input-otp";

function InputOTP({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string;
}) {
  return (
    <OTPInput
      data-slot="input-otp"
      containerClassName={cn(
        "cn-input-otp flex items-center has-disabled:opacity-50",
        containerClassName,
      )}
      spellCheck={false}
      className={cn("disabled:cursor-not-allowed", className)}
      {...props}
    />
  );
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-group"
      className={cn("flex items-center gap-1.5", className)}
      {...props}
    />
  );
}

function InputOTPSlot({
  index,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  index: number;
}) {
  const inputOTPContext = React.useContext(OTPInputContext);
  const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {};

  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive}
      aria-invalid={props["aria-invalid"]}
      className={cn(
        "relative flex size-9 items-center justify-center rounded-lg bg-primary text-sm font-medium text-tertiary shadow-xs ring-1 ring-secondary transition-[box-shadow,background-color] ring-inset aria-invalid:text-error-primary aria-invalid:ring-error data-[active=true]:ring-2 data-[active=true]:ring-brand data-[active=true]:outline-2 data-[active=true]:outline-offset-2 data-[active=true]:outline-brand",
        char && "text-primary ring-2 ring-brand",
        className,
      )}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-4 w-px animate-caret-blink bg-primary duration-1000" />
        </div>
      )}
    </div>
  );
}

function InputOTPSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-separator"
      className={cn("text-center text-xl font-medium text-tertiary", className)}
      role="separator"
      {...props}
    >
      -
    </div>
  );
}

export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator };
