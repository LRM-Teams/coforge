import { Monitor, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RuntimePopover, type UsageView } from "@/components/runtime-usage";
import type { RuntimeProvider } from "@coforge/protocol";
import { m } from "@/paraglide/messages";

type Model = { displayName: string; id: string };

export type ComputerView = {
  id: string;
  machineId: string;
  runtimes: { provider: string; version: string; displayName: string; observedAt: Date | string }[];
  modelCatalogs?: { provider: string; models: Model[] }[];
  usage?: Record<string, UsageView>;
  online: boolean;
};

export function ComputerContent({
  computers,
  onAdd,
  onScanUsage = async () => undefined,
}: {
  computers: ComputerView[];
  onAdd: () => void;
  onScanUsage?: (computerId: string, provider: RuntimeProvider) => Promise<void>;
}) {
  return (
    <main className="flex-1 p-4 sm:p-5 md:p-6">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{m.computer_page_title()}</h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            {m.computer_page_description()}
          </p>
        </div>
        <Button onClick={onAdd}>
          <Plus aria-hidden="true" data-icon="inline-start" />
          {m.computer_add_title()}
        </Button>
      </div>
      {computers.length ? (
        <section className="mt-7 divide-y border-y" aria-label={m.computer_connected_list()}>
          {computers.map((computer) => (
            <div key={computer.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start">
              <div className="min-w-0 sm:w-64">
                <p className="flex items-center gap-2 font-medium">
                  <span
                    aria-label={computer.online ? "Online" : "Offline"}
                    className={`size-2 rounded-full ${computer.online ? "bg-green-500" : "bg-muted-foreground"}`}
                  />
                  {m.computer_your_computer()}
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {computer.machineId}
                </p>
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-3 text-sm">
                {computer.runtimes.length ? (
                  computer.runtimes.map((runtime) => {
                    const provider = runtimeProvider(runtime.provider);
                    return (
                      <div key={provider} className="min-w-0">
                        <RuntimePopover
                          runtime={{
                            provider,
                            version: runtime.version,
                            displayName: runtime.displayName,
                          }}
                          usage={computer.usage?.[provider]}
                          onScan={() => onScanUsage(computer.id, provider)}
                        />
                      </div>
                    );
                  })
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
    </main>
  );
}

function runtimeProvider(value: string): RuntimeProvider {
  if (value === "codex" || value === "claude-code" || value === "pi") return value;
  throw new Error("Computer reported an unknown runtime provider");
}
