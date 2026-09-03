import { MonitorX } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { m } from "@/paraglide/messages";
import { BackToComputers } from "./computer-layout";

/**
 * The detail panel when the URL names a Computer this Workspace does not have.
 * It keeps the panel's own header band, so the way back to the list survives
 * the miss on small screens.
 */
export function ComputerNotFound() {
  return (
    <>
      <PageHeader leading={<BackToComputers />} heading={m.computer_not_found()} />
      <div className="grid flex-1 place-content-center px-6 text-center">
        <MonitorX aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
        <p className="mt-3 max-w-sm text-sm text-muted-foreground">
          {m.computer_not_found_description()}
        </p>
      </div>
    </>
  );
}
