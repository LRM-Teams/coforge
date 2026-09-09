import { createContext, useContext, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Cable, ChevronLeft, LaptopMinimal, Plus } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { computerLabel, type ComputerIdentity } from "./computer-identity";
import { ComputerTile } from "./computer-tile";

export type ComputerListItem = ComputerIdentity & {
  id: string;
  online: boolean;
  computerVersion?: string | null;
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
      <main className="flex h-svh min-w-0 md:p-2">
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-card md:rounded-xl md:border">
          <PageHeader heading={m.computer_page_title()} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <NoComputers onAdd={onAdd} />
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="flex h-svh min-w-0 md:gap-2 md:p-2">
      <nav
        aria-label={m.computer_connected_list()}
        className={cn(
          "min-w-0 flex-col overflow-hidden bg-card md:flex md:w-72 md:shrink-0 md:rounded-xl md:border",
          listHidden ? "hidden" : "flex w-full",
        )}
      >
        <PageHeader heading={m.computer_page_title()} actions={<AddComputer onAdd={onAdd} />} />

        <ul className="flex-1 space-y-1 overflow-y-auto p-2">
          {computers.map((computer) => {
            const selected = computer.id === selectedComputerId;
            return (
              <li key={computer.id}>
                <Link
                  to="/computers/$computerId"
                  params={{ computerId: computer.id }}
                  aria-current={selected ? "page" : undefined}
                  resetScroll={false}
                  onClick={() => setShowMobileList(false)}
                  className={cn(
                    "flex min-h-14 min-w-0 items-center gap-3 rounded-lg px-3 py-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    selected
                      ? "bg-accent/50 text-accent-foreground hover:bg-accent/70"
                      : "hover:bg-muted",
                  )}
                >
                  <ComputerTile computer={computer} online={computer.online} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">{computerLabel(computer)}</span>
                    {computer.computerVersion && (
                      <span
                        className="truncate text-xs text-muted-foreground"
                        aria-label={m.computer_version()}
                      >
                        v{computer.computerVersion}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <section
        className={cn(
          "min-w-0 flex-1 flex-col overflow-hidden bg-card md:flex md:rounded-xl md:border",
          listHidden ? "flex" : "hidden",
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
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={back}
      aria-label={m.computer_back_to_list()}
      className="-ml-2 size-11 shrink-0 md:hidden"
    >
      <ChevronLeft aria-hidden="true" className="size-5" />
    </Button>
  );
}

function NoComputers({ onAdd }: { onAdd: () => void }) {
  return (
    <Empty className="gap-6 px-6 pt-[clamp(3rem,12svh,7rem)] pb-10">
      <EmptyHeader className="max-w-xs gap-3">
        <EmptyMedia aria-hidden="true" className="relative mb-3 h-28 w-44">
          <span className="absolute inset-x-2 top-0 h-24 rounded-full bg-muted/70" />
          <LaptopMinimal className="relative size-28 text-muted-foreground" strokeWidth={1} />
          <span className="absolute right-2 bottom-0 flex size-10 items-center justify-center rounded-xl border bg-card text-muted-foreground shadow-sm">
            <Cable className="size-5" strokeWidth={1.5} />
          </span>
        </EmptyMedia>
        <EmptyTitle role="heading" aria-level={2} className="text-lg font-semibold">
          {m.computer_empty_title()}
        </EmptyTitle>
        <EmptyDescription>{m.computer_empty_description()}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button className="h-11 px-5" onClick={onAdd}>
          <Plus aria-hidden="true" data-icon="inline-start" />
          {m.computer_add_title()}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
