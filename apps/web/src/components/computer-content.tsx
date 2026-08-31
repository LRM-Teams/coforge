import { Monitor, Plus } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

export type ComputerView = {
  id: string;
  machineId: string;
  runtimes: { provider: string; version: string; observedAt: Date | string }[];
};

const providerLabel = (provider: string) =>
  provider === "codex" ? "Codex" : provider === "claude-code" ? "Claude Code" : provider;

export function ComputerContent({
  computers,
  onAdd,
}: {
  computers: ComputerView[];
  onAdd: () => void;
}) {
  return (
    <main className="flex-1 p-2">
      <div className="min-h-[calc(100svh_-_1rem)] overflow-hidden rounded-xl border bg-card">
        <PageHeader
          heading={m.computer_page_title()}
          actions={
            <Button onClick={onAdd}>
              <Plus aria-hidden="true" data-icon="inline-start" />
              {m.computer_add_title()}
            </Button>
          }
        />
        <div className="p-4 sm:p-5 md:p-6">
          <p className="max-w-xl text-sm text-muted-foreground">{m.computer_page_description()}</p>
          {computers.length ? (
            <section className="mt-7 divide-y border-y" aria-label={m.computer_connected_list()}>
              {computers.map((computer) => (
                <div
                  key={computer.id}
                  className="flex flex-col gap-2 py-4 sm:flex-row sm:items-start"
                >
                  <div className="min-w-0 sm:w-64">
                    <p className="font-medium">{m.computer_your_computer()}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {computer.machineId}
                    </p>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-wrap gap-x-5 gap-y-1 text-sm">
                    {computer.runtimes.length ? (
                      computer.runtimes.map((runtime) => (
                        <span key={runtime.provider}>
                          {providerLabel(runtime.provider)}{" "}
                          <span className="text-muted-foreground">{runtime.version}</span>
                        </span>
                      ))
                    ) : (
                      <span className="text-muted-foreground">{m.computer_no_code_agents()}</span>
                    )}
                  </div>
                </div>
              ))}
            </section>
          ) : (
            <section className="mt-8 flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed bg-card px-6 py-12 text-center">
              <span className="flex size-14 items-center justify-center rounded-xl bg-muted">
                <Monitor aria-hidden="true" className="size-7 text-muted-foreground" />
              </span>
              <h2 className="mt-4 text-base font-medium">{m.computer_empty_title()}</h2>
              <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                {m.computer_empty_description()}
              </p>
              <Button className="mt-5" variant="outline" onClick={onAdd}>
                {m.computer_add_title()}
              </Button>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
