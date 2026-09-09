import { Activity, Bell, Bot, Monitor, UserRound } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { m } from "@/paraglide/messages";

export function AgentDetailPending({ tab }: { tab: "profile" | "activity" | "reminders" }) {
  const tabs = [
    { value: "profile", label: m.agent_profile_tab(), icon: UserRound },
    { value: "activity", label: m.agent_activity_tab(), icon: Activity },
    { value: "reminders", label: m.agent_reminders_tab(), icon: Bell },
  ];
  const label = tabs.find((item) => item.value === tab)?.label;
  return (
    <main
      aria-busy="true"
      className="flex h-svh max-h-svh min-h-0 flex-1 flex-col overflow-hidden p-4 sm:p-5 md:p-6"
    >
      <p role="status" className="sr-only">
        {m.agent_detail_loading()}
      </p>
      <div aria-hidden="true" className="flex shrink-0 items-start justify-between gap-4">
        <div className="flex items-center gap-3 motion-safe:animate-pulse">
          <Skeleton className="size-12 shrink-0 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
        <Skeleton className="h-9 w-24 motion-safe:animate-pulse" />
      </div>
      <nav aria-hidden="true" className="mt-6 flex shrink-0 gap-1 border-b">
        {tabs.map(({ value, label, icon: Icon }) => (
          <span
            key={value}
            className={`inline-flex items-center gap-1 border-b-2 px-2 py-2 text-sm font-medium sm:gap-2 sm:px-4 ${tab === value ? "border-primary" : "border-transparent"}`}
          >
            <Icon className="size-4 shrink-0" />
            {label}
          </span>
        ))}
      </nav>
      <section aria-label={label} className="min-h-0 flex-1 overflow-hidden">
        {tab === "profile" ? (
          <ProfilePending />
        ) : tab === "activity" ? (
          <ActivityPending />
        ) : (
          <div aria-hidden="true" className="mt-6 space-y-3 motion-safe:animate-pulse">
            {["w-52", "w-64"].map((width) => (
              <div
                key={width}
                className="flex items-center justify-between gap-6 rounded-xl border bg-card p-4"
              >
                <Skeleton className={`h-4 max-w-2/3 ${width}`} />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function ProfilePending() {
  return (
    <div aria-hidden="true" className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
      {[Bot, Monitor].map((Icon, index) => (
        <section key={index} className="rounded-xl border bg-card p-5">
          <div className="flex items-center gap-2">
            <Icon className="size-4 text-muted-foreground" />
            <Skeleton className="h-4 w-32" />
          </div>
          <div className="mt-5 space-y-4 motion-safe:animate-pulse">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-4 w-2/5" />
          </div>
        </section>
      ))}
      <section className="rounded-xl border bg-card p-5 lg:col-span-2">
        <Skeleton className="h-4 w-40" />
        <div className="mt-5 grid gap-4 sm:grid-cols-2 motion-safe:animate-pulse">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      </section>
    </div>
  );
}

function ActivityPending() {
  return (
    <div aria-hidden="true" className="mt-6 divide-y motion-safe:animate-pulse">
      {["w-3/4", "w-2/3", "w-4/5", "w-1/2", "w-3/5"].map((width, index) => (
        <div key={index} className="grid gap-3 py-3 sm:grid-cols-[6rem_8rem_minmax(0,1fr)]">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className={`h-4 ${width}`} />
        </div>
      ))}
    </div>
  );
}
