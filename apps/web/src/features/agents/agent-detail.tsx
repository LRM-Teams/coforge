import { AlertCircle, Bot, Monitor } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { buttonVariants } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

type Detail = Awaited<ReturnType<typeof import("./agents.functions").getAgentDetail>>;

export function AgentDetail({ detail, tab }: { detail: Detail; tab: "profile" | "activity" }) {
  return (
    <main className="flex-1 p-4 sm:p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">@{detail.name}</p>
          <h1 className="text-2xl font-semibold tracking-tight">{detail.displayName}</h1>
        </div>
        <Link
          to="/messages/$agentId"
          params={{ agentId: detail.id }}
          className={buttonVariants({ variant: "outline" })}
        >
          {m.agent_private_chat()}
        </Link>
      </div>
      <nav className="mt-6 flex gap-1 border-b" aria-label={m.agent_detail_tabs()}>
        {(["profile", "activity"] as const).map((value) => (
          <Link
            key={value}
            to="/agents/$agentId"
            params={{ agentId: detail.id }}
            search={{ tab: value }}
            className={`border-b-2 px-4 py-2 text-sm font-medium ${tab === value ? "border-primary text-foreground" : "border-transparent text-muted-foreground"}`}
          >
            {value === "profile" ? m.agent_profile_tab() : m.agent_activity_tab()}
          </Link>
        ))}
      </nav>
      {tab === "profile" && detail.latestError && (
        <div
          role="alert"
          className="mt-6 flex items-start gap-3 rounded-xl border border-destructive/50 bg-destructive/5 p-4 text-sm"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium text-destructive">{m.agent_latest_error()}</p>
            <p className="mt-1 text-muted-foreground">{detail.latestError.message}</p>
          </div>
        </div>
      )}
      {tab === "profile" ? <Profile detail={detail} /> : <Activity detail={detail} />}
    </main>
  );
}

function Profile({ detail }: { detail: Detail }) {
  const fields = [
    [m.agent_profile_id(), detail.id],
    [m.agent_profile_name(), detail.name],
    [m.agent_profile_display_name(), detail.displayName],
    [m.agent_profile_owner(), `@${detail.owner.username}`],
    [m.agent_profile_created(), new Date(detail.createdAt).toLocaleString()],
  ];
  return (
    <div className="mt-6 grid gap-5 lg:grid-cols-2">
      <section className="rounded-xl border bg-card p-5">
        <h2 className="flex items-center gap-2 font-semibold">
          <Bot className="size-4" />
          {m.agent_profile_basic()}
        </h2>
        <dl className="mt-4 grid gap-4">
          {fields.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1 text-sm">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="rounded-xl border bg-card p-5">
        <h2 className="flex items-center gap-2 font-semibold">
          <Monitor className="size-4" />
          {m.agent_profile_computer()}
        </h2>
        <p className="mt-4 text-sm">{detail.computer?.label ?? m.agent_computer_unnamed()}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {detail.computer ? m.agent_computer_observed() : m.agent_computer_not_observed()}
        </p>
      </section>
      <section className="rounded-xl border bg-card p-5 lg:col-span-2">
        <h2 className="font-semibold">{m.agent_runtime_config()}</h2>
        <pre className="mt-4 overflow-x-auto rounded-lg bg-muted p-4 text-sm leading-6">
          <code>{JSON.stringify(detail.runtimeConfig, null, 2)}</code>
        </pre>
      </section>
    </div>
  );
}

function Activity({ detail }: { detail: Detail }) {
  if (!detail.activity.length)
    return (
      <div className="mt-6 rounded-xl border border-dashed p-10 text-center">
        <p className="font-medium">{m.agent_activity_empty()}</p>
        <p className="mt-1 text-sm text-muted-foreground">{m.agent_activity_empty_description()}</p>
      </div>
    );
  return (
    <ol className="mt-6 list-none divide-y">
      {detail.activity.map((entry) => (
        <li
          key={entry.id}
          className="grid gap-1 py-2 sm:grid-cols-[max-content_max-content_minmax(0,1fr)] sm:items-start sm:gap-3"
        >
          <time
            className="whitespace-nowrap text-xs tabular-nums text-muted-foreground sm:pt-0.5"
            dateTime={new Date(entry.occurredAt).toISOString()}
          >
            {new Date(entry.occurredAt).toLocaleString()}
          </time>
          <span className="flex items-center gap-2 font-medium">
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-full ${activityDotClass(entry.activity, entry.level)}`}
            />
            <span className={entry.level === "error" ? "text-destructive" : undefined}>
              {activityLabel(entry.activity, entry.level)}
            </span>
          </span>
          {showsActivityMessage(entry.activity) && (
            <p
              className={`whitespace-pre-wrap break-words text-sm ${entry.level === "error" ? "text-destructive" : "text-muted-foreground"}`}
            >
              {entry.message}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

function showsActivityMessage(activity: string) {
  return activity !== "starting" && activity !== "stopped" && activity !== "turn_completed";
}

function activityDotClass(activity: string, level: string) {
  if (level === "error") return "bg-destructive";
  if (activity === "starting") return "bg-amber-500";
  if (activity === "stopped") return "bg-muted-foreground";
  if (activity === "turn_completed") return "bg-emerald-500";
  return "bg-blue-500";
}

function activityLabel(activity: string, level: string) {
  if (level === "error") return m.agent_activity_failed();
  if (activity === "starting") return m.agent_activity_starting();
  if (activity === "stopped") return m.agent_activity_stopped();
  if (activity === "turn_completed") return m.agent_activity_completed();
  if (activity === "running_command") return m.agent_activity_running_command();
  if (activity === "reading_file") return m.agent_activity_reading_file();
  if (activity === "writing_file") return m.agent_activity_writing_file();
  if (activity === "editing_file") return m.agent_activity_editing_file();
  if (activity === "using_tool") return m.agent_activity_using_tool();
  return `${m.agent_activity_other()}: ${activity}`;
}
