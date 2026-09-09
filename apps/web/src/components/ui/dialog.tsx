// Adapted from Untitled UI React's application/modals/modal.tsx (MIT).
import {
  Activity,
  createContext,
  useContext,
  useId,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Button,
  Dialog as AriaDialog,
  Heading,
  Modal,
  ModalOverlay,
  Text,
} from "react-aria-components";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";

const DialogContext = createContext({
  open: false,
  onOpenChange: (_open: boolean) => {},
  descriptionId: "",
});

function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const descriptionId = useId();
  return <DialogContext value={{ open, onOpenChange, descriptionId }}>{children}</DialogContext>;
}

function DialogPortal({
  children,
  keepMounted = false,
}: {
  children: ReactNode;
  keepMounted?: boolean;
}) {
  const { open, onOpenChange } = useContext(DialogContext);
  const overlay = (
    <ModalOverlay
      isOpen={keepMounted ? true : open}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed inset-0 z-50 flex min-h-dvh w-full items-end justify-center px-4 py-4 outline-none sm:items-center sm:px-8 sm:py-8"
    >
      {children}
    </ModalOverlay>
  );
  return keepMounted ? <Activity mode={open ? "visible" : "hidden"}>{overlay}</Activity> : overlay;
}

function DialogBackdrop({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      {...props}
      className={cn(
        "pointer-events-none fixed inset-0 bg-foreground/45 backdrop-blur-[6px]",
        className,
      )}
    />
  );
}

function DialogPopup({ className, ...props }: ComponentProps<typeof AriaDialog>) {
  const { descriptionId } = useContext(DialogContext);
  return (
    <Modal className="relative max-h-[calc(var(--visual-viewport-height)-2rem)] w-full max-w-[680px] outline-none">
      <AriaDialog
        aria-describedby={descriptionId}
        {...props}
        className={cn(
          "relative flex max-h-[inherit] w-full flex-col overflow-y-auto rounded-xl bg-background text-foreground shadow-xl outline-none sm:rounded-2xl",
          className,
        )}
      />
    </Modal>
  );
}

function DialogTitle({ className, ...props }: ComponentProps<typeof Heading>) {
  return <Heading slot="title" {...props} className={cn("text-xl font-semibold", className)} />;
}

function DialogDescription({ className, ...props }: ComponentProps<typeof Text>) {
  const { descriptionId } = useContext(DialogContext);
  return (
    <Text
      id={descriptionId}
      slot="description"
      {...props}
      className={cn("text-sm text-muted-foreground", className)}
    />
  );
}

function DialogClose({
  render,
  ...props
}: Omit<ComponentProps<typeof Button>, "render"> & { render?: ReactElement }) {
  const { onOpenChange } = useContext(DialogContext);
  return (
    <Button
      {...props}
      onPress={() => onOpenChange(false)}
      render={render ? (domProps) => <Slot {...domProps}>{render}</Slot> : undefined}
    />
  );
}

export {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogDescription,
  DialogPopup,
  DialogPortal,
  DialogTitle,
};
