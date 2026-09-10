// Copied from the official app-navigation/base-components/mobile-header.tsx template
// (see docs/ui-guidelines.md §2), adapted so the drawer opens from each page's own
// header instead of a separate app header: one 48px band per page on mobile.
import { createContext, useContext, useState, type PropsWithChildren } from "react";
import { X as CloseIcon, Menu02 } from "@untitledui/icons";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  Modal as AriaModal,
  ModalOverlay as AriaModalOverlay,
} from "react-aria-components";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { m } from "@/paraglide/messages";
import { cx } from "@/utils/cx";

const MobileDrawerContext = createContext<{
  isOpen: boolean;
  setOpen: (open: boolean) => void;
} | null>(null);

/** Wraps the whole shell so any page header can open the drawer. */
export const MobileDrawerProvider = ({ children }: PropsWithChildren) => {
  const [isOpen, setOpen] = useState(false);
  return <MobileDrawerContext value={{ isOpen, setOpen }}>{children}</MobileDrawerContext>;
};

export const MobileNavigationHeader = ({ children }: PropsWithChildren) => {
  const drawer = useContext(MobileDrawerContext);
  const isOpen = drawer?.isOpen ?? false;
  const setOpen = drawer?.setOpen ?? (() => {});
  return (
    <>
      <AriaModalOverlay
        isDismissable
        isOpen={isOpen}
        onOpenChange={setOpen}
        className={({ isEntering, isExiting }) =>
          cx(
            "fixed inset-0 z-50 cursor-pointer bg-overlay/70 pr-16 backdrop-blur-md lg:hidden",
            isEntering && "duration-300 ease-in-out animate-in fade-in",
            isExiting && "duration-200 ease-in-out animate-out fade-out",
          )
        }
      >
        {({ state }) => (
          <>
            <AriaButton
              aria-label={m.navigation_close_menu()}
              onPress={() => state.close()}
              className="fixed top-2.5 right-3 flex cursor-pointer items-center justify-center rounded-lg p-2 text-fg-white/70 outline-focus-ring hover:bg-white/10 hover:text-fg-white focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <CloseIcon className="size-6" />
            </AriaButton>

            <AriaModal className="w-full max-w-74 cursor-auto will-change-transform">
              <AriaDialog className="h-dvh outline-hidden focus:outline-hidden">
                {children}
              </AriaDialog>
            </AriaModal>
          </>
        )}
      </AriaModalOverlay>
    </>
  );
};

/** Opens the mobile drawer; renders nothing on lg+ and outside the drawer host. */
export function MobileNavigationButton({ className }: { className?: string }) {
  const drawer = useContext(MobileDrawerContext);
  if (!drawer) return null;
  return (
    <ButtonUtility
      icon={Menu02}
      size="sm"
      color="tertiary"
      aria-label={m.navigation_open_menu()}
      onClick={() => drawer.setOpen(true)}
      className={cx("-ml-2 shrink-0 lg:hidden", className)}
    />
  );
}
