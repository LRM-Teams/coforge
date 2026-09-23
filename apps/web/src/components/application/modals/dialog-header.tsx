import type { ReactNode } from "react";
import { Heading, Text } from "react-aria-components";
import { XClose as X } from "@untitledui/icons";

import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

/** Title row of a form dialog: heading, optional description, optional close control. */
export function DialogHeader({
  title,
  description,
  onClose,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose?: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-6 px-6 pt-6", className)}>
      <div>
        <Heading slot="title" className="text-lg font-semibold text-primary">
          {title}
        </Heading>
        {description && (
          <Text slot="description" className="mt-2 block text-sm text-tertiary">
            {description}
          </Text>
        )}
      </div>
      {onClose && (
        <ButtonUtility
          type="button"
          aria-label={m.controls_close()}
          icon={X}
          size="sm"
          color="tertiary"
          onClick={onClose}
        />
      )}
    </div>
  );
}
