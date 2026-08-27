import { Monitor, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

export function ComputerContent({ onAdd }: { onAdd: () => void }) {
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
    </main>
  );
}
