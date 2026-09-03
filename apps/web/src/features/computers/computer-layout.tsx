import { createContext, useContext, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Monitor, Plus } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { computerLabel, type ComputerIdentity } from "./computer-identity";
import { ComputerTile } from "./computer-tile";

export type ComputerListItem = ComputerIdentity & {
  id: string;
  online: boolean;
};

/**
 * Lets the selected Computer put the "back to the list" control in its own
 * header band, the way the conversation panels do. Below `md` only one panel
 * fits, so the layout owns which one is showing and shares the way back.
 */
const BackToComputersContext = createContext<(() => void) | undefined>(undefined);

/**
 * Two panels on the app's ground: the Computer list and the selected
 * Computer's detail. Below `md` they take turns, since only one fits. With no
 * Computers there is nothing to list or detail, so one panel carries the way
 * to add the first one.
 */
export function ComputerLayout({
  computers,
  selectedComputerId,
  onAdd,
  children,
}: {
  computers: ComputerListItem[];
  selectedComputerId?: string;
  onAdd: () => void;
  children: ReactNode;
}) {
  const [showMobileList, setShowMobileList] = useState(!selectedComputerId);
  const listHidden = Boolean(selectedComputerId) && !showMobileList;

  if (!computers.length) {
    return (
      <main className="flex h-svh min-w-0 p-2">
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
          <PageHeader heading={m.computer_page_title()} actions={<AddComputer onAdd={onAdd} />} />
          <NoComputers onAdd={onAdd} />
        </section>
      </main>
    );
  }

  return (
    <main className="flex h-svh min-w-0 gap-2 p-2">
      <nav
        aria-label={m.computer_connected_list()}
        className={cn(
          "min-w-0 flex-col overflow-hidden rounded-xl border bg-card md:flex md:w-72 md:shrink-0",
          listHidden ? "hidden" : "flex w-full",
        )}
      >
        <PageHeader heading={m.computer_page_title()} actions={<AddComputer onAdd={onAdd} />} />

        <ul className="flex-1 overflow-y-auto p-2">
          {computers.map((computer) => {
            const selected = computer.id === selectedComputerId;
            return (
              <li key={computer.id}>
                <Link
                  to="/computers/$computerId"
                  params={{ computerId: computer.id }}
                  aria-current={selected ? "page" : undefined}
                  onClick={() => setShowMobileList(false)}
                  className={cn(
                    "flex min-w-0 items-center gap-3 rounded-lg px-2.5 py-2.5 hover:bg-muted",
                    selected && "bg-muted",
                  )}
                >
                  <ComputerTile computer={computer} online={computer.online} />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-xs font-medium">{computerLabel(computer)}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {computer.machineId}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <section
        className={cn(
          "min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card md:flex",
          showMobileList ? "hidden" : "flex",
        )}
      >
        <BackToComputersContext value={() => setShowMobileList(true)}>
          {children}
        </BackToComputersContext>
      </section>
    </main>
  );
}

function AddComputer({ onAdd }: { onAdd: () => void }) {
  return (
    <Button size="sm" onClick={onAdd}>
      <Plus aria-hidden="true" data-icon="inline-start" />
      {m.computer_add_title()}
    </Button>
  );
}

/** Returns to the Computer list on small screens, where only one panel fits. */
export function BackToComputers() {
  const back = useContext(BackToComputersContext);
  if (!back) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={back}
      aria-label={m.computer_back_to_list()}
      className="-ml-1 flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-muted md:hidden"
    >
      <Monitor aria-hidden="true" className="size-4" />
    </button>
  );
}

function NoComputers({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="grid h-full place-content-center px-6 text-center">
      <Monitor aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
      <p className="mt-3 font-medium">{m.computer_empty_title()}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {m.computer_empty_description()}
      </p>
      <Button className="mx-auto mt-5" variant="outline" onClick={onAdd}>
        {m.computer_add_title()}
      </Button>
    </div>
  );
}
