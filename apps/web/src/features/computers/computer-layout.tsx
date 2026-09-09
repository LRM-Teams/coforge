import { createContext, useContext, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  Dataflow03 as Cable,
  ChevronLeft,
  Laptop01 as LaptopMinimal,
  Plus,
} from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
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
      <main className="flex h-svh min-w-0">
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-primary">
          <PageHeader heading={m.computer_page_title()} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <NoComputers onAdd={onAdd} />
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="flex h-svh min-w-0">
      <nav
        aria-label={m.computer_connected_list()}
        className={cn(
          "min-w-0 flex-col overflow-hidden bg-primary md:flex md:w-80 md:shrink-0 md:border-r md:border-secondary",
          listHidden ? "hidden" : "flex w-full",
        )}
      >
        <PageHeader heading={m.computer_page_title()} actions={<AddComputer onAdd={onAdd} />} />

        <ul className="flex-1 space-y-1 overflow-y-auto p-3">
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
                    "group flex min-h-18 min-w-0 items-center gap-3 rounded-lg px-3 py-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset",
                    selected
                      ? "bg-secondary text-brand-secondary hover:bg-secondary_hover"
                      : "hover:bg-primary_hover",
                  )}
                >
                  <ComputerTile computer={computer} online={computer.online} />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-sm font-semibold">
                      {computerLabel(computer)}
                    </span>
                    {computer.computerVersion && (
                      <span
                        className="truncate text-xs text-tertiary"
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
          "min-w-0 flex-1 flex-col overflow-hidden bg-primary md:flex",
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
    <Button size="sm" color="secondary" iconLeading={Plus} onPress={onAdd}>
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
    <ButtonUtility
      color="tertiary"
      size="sm"
      onClick={back}
      aria-label={m.computer_back_to_list()}
      className="-ml-2 size-11 shrink-0 md:hidden"
      icon={ChevronLeft}
    />
  );
}

function NoComputers({ onAdd }: { onAdd: () => void }) {
  return (
    <Empty className="gap-6 px-6 pt-[clamp(3rem,12svh,7rem)] pb-10">
      <EmptyHeader className="max-w-xs gap-3">
        <EmptyMedia aria-hidden="true" className="relative mb-3 h-28 w-44">
          <span className="absolute inset-x-2 top-0 h-24 rounded-full bg-secondary/70" />
          <LaptopMinimal className="relative size-28 text-tertiary" strokeWidth={1} />
          <span className="absolute right-2 bottom-0 flex size-10 items-center justify-center rounded-xl border border-secondary bg-primary text-tertiary shadow-sm">
            <Cable className="size-5" strokeWidth={1.5} />
          </span>
        </EmptyMedia>
        <EmptyTitle role="heading" aria-level={2} className="text-lg font-semibold">
          {m.computer_empty_title()}
        </EmptyTitle>
        <EmptyDescription>{m.computer_empty_description()}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="md" className="h-11 px-5" iconLeading={Plus} onPress={onAdd}>
          {m.computer_add_title()}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
