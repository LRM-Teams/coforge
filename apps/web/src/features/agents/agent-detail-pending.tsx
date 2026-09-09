import {
  Activity,
  Bell01 as Bell,
  CpuChip01 as Bot,
  Monitor01 as Monitor,
  UserCircle as UserRound,
} from "@untitledui/icons";

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
      className="flex h-svh max-h-svh min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background px-4 pt-5 md:px-8 md:pt-8"
    >
      <p role="status" className="sr-only">
        {m.agent_detail_loading()}
      </p>
      <div aria-hidden="true" className="flex shrink-0 items-center justify-between gap-4 pb-6">
        <div className="flex items-center gap-3 motion-safe:animate-pulse">
          <Skeleton className="size-12 shrink-0 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
        <Skeleton className="h-9 w-24 motion-safe:animate-pulse" />
      </div>
      <nav aria-hidden="true" className="flex shrink-0 gap-5 overflow-x-auto border-b md:gap-6">
        {tabs.map(({ value, label, icon: Icon }) => (
          <span
            key={value}
            className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-0.5 pb-3 text-sm font-semibold ${tab === value ? "border-brand text-brand" : "border-transparent text-muted-foreground"}`}
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
    <div aria-hidden="true" className="divide-y">
      {[Bot, Monitor].map((Icon, index) => (
        <section
          key={index}
          className="grid gap-5 py-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8"
        >
          <div className="flex items-start gap-2">
            <Icon className="size-4 text-muted-foreground" />
            <Skeleton className="h-4 w-32" />
          </div>
          <div className="space-y-5 motion-safe:animate-pulse">
            {Array.from({ length: index === 0 ? 6 : 1 }, (_, row) => (
              <div key={row} className="grid gap-1.5 md:grid-cols-[10rem_minmax(0,1fr)] md:gap-6">
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-6 w-3/5" />
              </div>
            ))}
          </div>
        </section>
      ))}
      <section className="grid gap-5 py-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8">
        <Skeleton className="h-4 w-40" />
        <div className="grid gap-5 md:grid-cols-2 motion-safe:animate-pulse">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      </section>
    </div>
  );
}

function ActivityPending() {
  return (
    <div
      aria-hidden="true"
      className="mt-6 divide-y rounded-xl border px-4 md:px-6 motion-safe:animate-pulse"
    >
      {["w-3/4", "w-2/3", "w-4/5", "w-1/2", "w-3/5"].map((width, index) => (
        <div
          key={index}
          className="grid gap-2 py-4 md:grid-cols-[7rem_10rem_minmax(0,1fr)] md:gap-5"
        >
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className={`h-4 ${width}`} />
        </div>
      ))}
    </div>
  );
}
