import { useState } from "react";
import { Monitor, X } from "lucide-react";

import { CloudComputerOption } from "@/components/computer/cloud-computer";
import { YourComputerInstall } from "@/components/computer/your-computer";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogDescription,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { m } from "@/paraglide/messages";

type ComputerType = "local" | "cloud";
export function AddComputerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [computerType, setComputerType] = useState<ComputerType>("local");
  const [step, setStep] = useState<"choose" | "install">("choose");

  function close() {
    onOpenChange(false);
    window.setTimeout(() => {
      setStep("choose");
    }, 150);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup aria-describedby="add-computer-description">
          <div className="flex items-start justify-between gap-6 px-6 pt-6 sm:px-8 sm:pt-8">
            <div>
              <DialogTitle>{m.computer_add_title()}</DialogTitle>
              <DialogDescription id="add-computer-description" className="mt-2 max-w-xl text-base">
                {step === "choose"
                  ? m.computer_add_description()
                  : m.computer_install_description()}
              </DialogDescription>
            </div>
            <DialogClose
              render={
                <Button variant="ghost" size="icon" aria-label={m.controls_close()} onClick={close}>
                  <X aria-hidden="true" />
                </Button>
              }
            />
          </div>

          {step === "choose" ? (
            <div className="grid gap-4 px-6 py-8 sm:grid-cols-2 sm:px-8">
              <button
                type="button"
                aria-pressed={computerType === "local"}
                className={`rounded-2xl border p-5 text-left transition-colors ${computerType === "local" ? "border-brand bg-brand/5 ring-1 ring-brand" : "hover:bg-muted"}`}
                onClick={() => setComputerType("local")}
              >
                <span className="mb-5 flex size-14 items-center justify-center rounded-xl bg-muted">
                  <Monitor aria-hidden="true" className="size-7" />
                </span>
                <span className="block text-lg font-medium">{m.computer_your_computer()}</span>
                <span className="mt-2 block text-sm leading-6 text-muted-foreground">
                  {m.computer_your_computer_description()}
                </span>
              </button>
              <CloudComputerOption
                selected={computerType === "cloud"}
                onSelect={() => setComputerType("cloud")}
              />
            </div>
          ) : (
            <YourComputerInstall />
          )}

          <div className="flex items-center justify-end gap-3 border-t px-6 py-4 sm:px-8">
            <Button variant="outline" onClick={step === "choose" ? close : () => setStep("choose")}>
              {step === "choose" ? m.controls_cancel() : m.controls_back()}
            </Button>
            {step === "choose" && (
              <Button
                onClick={() => computerType === "local" && setStep("install")}
                disabled={computerType === "cloud"}
              >
                {computerType === "cloud" ? m.computer_coming_soon() : m.controls_next()}
              </Button>
            )}
          </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
