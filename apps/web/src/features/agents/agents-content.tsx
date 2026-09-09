import { useRef, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import {
  MessageCircle01 as MessageCircle,
  Monitor01 as Monitor,
  Plus,
  SearchLg as Search,
  Users01 as UsersRound,
  XClose as X,
} from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { Avatar } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogDescription,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { m } from "@/paraglide/messages";
import type { AgentStatusView } from "./agent-status-realtime";
import type { AgentDisplaySnapshot } from "@coforge/protocol/agent-display";
import { AgentDisplayAvatar } from "./agent-activity-avatar";
import { AgentRuntimeFields, type RuntimeCatalog } from "./agent-runtime-fields";
import type { CreateAgentInput } from "./agent.schemas";
import type { WorkspaceMemberDirectory } from "@/features/workspaces/workspaces.functions";

type ComputerOption = {
  id: string;
  name: string;
  displayName: string;
  online?: boolean;
  runtimes: { provider: string }[];
};

export type AgentView = {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  status: AgentStatusView;
  display?: AgentDisplaySnapshot;
};

export function AgentsContent({
  directory,
  memberType,
  onMemberTypeChange,
  agents,
  computers,
  onCreate,
  onLoadRuntimeCatalog,
  defaultCreateDialogOpen = false,
}: {
  directory: WorkspaceMemberDirectory;
  memberType: "all" | "human" | "agent";
  onMemberTypeChange: (value: "all" | "human" | "agent") => void;
  agents: AgentView[];
  computers: ComputerOption[];
  onCreate: (input: CreateAgentInput) => Promise<{ startPublished: boolean }>;
  onLoadRuntimeCatalog: (computerId: string) => Promise<RuntimeCatalog[]>;
  defaultCreateDialogOpen?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(defaultCreateDialogOpen);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState("");
  const [deferredStart, setDeferredStart] = useState(false);
  const [computerId, setComputerId] = useState(computers[0]?.id ?? "");
  const selectedComputer = computers.find((computer) => computer.id === computerId);
  const memberCount = directory.people.length + directory.agents.length;
  const query = search.trim().toLowerCase();
  const filteredPeople = directory.people.filter(
    (person) =>
      memberType !== "agent" &&
      `${person.displayName} ${person.name}`.toLowerCase().includes(query),
  );
  const filteredAgents = directory.agents.filter(
    (agent) =>
      memberType !== "human" &&
      `${agent.displayName} ${agent.name} ${agent.computerName ?? ""}`
        .toLowerCase()
        .includes(query),
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    setError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("name") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();
    if (!name) {
      setError(m.agent_form_required_error());
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const result = await onCreate({
        name,
        description,
        provider: runtimeProvider(form.get("provider")),
        model: String(form.get("model") ?? "").trim() || undefined,
        modelProvider: String(form.get("modelProvider") ?? "").trim() || undefined,
        reasoning: String(form.get("reasoning") ?? "").trim(),
        computerId: String(form.get("computerId") ?? ""),
      });
      formElement.reset();
      setOpen(false);
      setDeferredStart(!result.startPublished);
    } catch {
      setError(m.agent_form_server_error());
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <main className="flex h-svh min-w-0 md:p-2">
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-card md:rounded-xl md:border">
        <PageHeader
          heading={m.navigation_agents()}
          actions={
            <Button className="h-11 md:h-10" onClick={() => setOpen(true)}>
              <Plus aria-hidden="true" data-icon="inline-start" />
              {m.header_new_agent()}
            </Button>
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6">
          {deferredStart && (
            <p
              role="status"
              className="mt-5 rounded-lg border bg-muted px-4 py-3 text-sm text-muted-foreground"
            >
              {m.agent_deferred_start_notice()}
            </p>
          )}
          {memberCount > 0 && (
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <div
                role="group"
                aria-label={m.member_type_filter()}
                className="flex max-w-full gap-0.5 rounded-lg bg-muted p-1 ring-1 ring-border ring-inset"
              >
                {(["all", "human", "agent"] as const).map((type) => (
                  <Button
                    key={type}
                    aria-label={
                      type === "all"
                        ? m.filters_all()
                        : type === "human"
                          ? m.member_person()
                          : m.member_agent()
                    }
                    variant={memberType === type ? "outline" : "ghost"}
                    className="h-11 gap-2 px-3 font-semibold md:h-9 aria-pressed:text-foreground"
                    aria-pressed={memberType === type}
                    onClick={() => onMemberTypeChange(type)}
                  >
                    {type === "all"
                      ? m.filters_all()
                      : type === "human"
                        ? m.member_person()
                        : m.member_agent()}
                    <span className="rounded-full bg-card px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground ring-1 ring-border ring-inset">
                      {type === "all"
                        ? memberCount
                        : type === "human"
                          ? directory.people.length
                          : directory.agents.length}
                    </span>
                  </Button>
                ))}
              </div>
              <label className="flex h-11 w-full items-center gap-2 rounded-lg bg-background px-3 text-sm shadow-xs ring-1 ring-border ring-inset transition-shadow focus-within:ring-2 focus-within:ring-ring sm:ml-auto sm:w-72">
                <Search aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
                <input
                  type="search"
                  aria-label={m.filters_search()}
                  placeholder={`${m.filters_search()}...`}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
                />
              </label>
            </div>
          )}
          {filteredPeople.length + filteredAgents.length ? (
            <ul
              aria-label={m.navigation_agents()}
              className="mt-6 grid gap-5 md:grid-cols-[repeat(auto-fill,minmax(17rem,1fr))]"
            >
              {filteredPeople.map((person) => (
                <MemberCard key={`person:${person.id}`} member={person} label={m.member_person()} />
              ))}
              {filteredAgents.map((member) => {
                const ownedAgent = agents.find((agent) => agent.id === member.id);
                return (
                  <MemberCard
                    key={`agent:${member.id}`}
                    member={member}
                    label={m.member_agent()}
                    computerName={member.computerName}
                    ownedAgent={ownedAgent}
                  />
                );
              })}
            </ul>
          ) : (
            <Empty
              className={
                memberCount ? "gap-5 px-0 py-12" : "gap-6 px-0 pt-[clamp(3rem,12svh,7rem)] pb-10"
              }
            >
              <EmptyHeader className="max-w-xs gap-3">
                {memberCount ? (
                  <EmptyMedia>
                    <Search
                      aria-hidden="true"
                      className="size-8 text-muted-foreground"
                      strokeWidth={1.5}
                    />
                  </EmptyMedia>
                ) : (
                  <EmptyMedia aria-hidden="true" className="relative mb-3 h-28 w-44">
                    <span className="absolute inset-x-2 top-0 h-24 rounded-full bg-muted/70" />
                    <UsersRound
                      className="relative size-20 text-muted-foreground"
                      strokeWidth={1}
                    />
                    <span className="absolute right-2 bottom-0 flex size-10 items-center justify-center rounded-xl border bg-card text-muted-foreground shadow-sm">
                      <Plus className="size-5" />
                    </span>
                  </EmptyMedia>
                )}
                <EmptyTitle role="heading" aria-level={2} className="text-lg font-semibold">
                  {memberCount
                    ? query
                      ? m.agent_no_search_results()
                      : memberType === "agent"
                        ? m.agent_empty_title()
                        : m.member_no_humans()
                    : m.agent_empty_title()}
                </EmptyTitle>
                <EmptyDescription>
                  {memberCount
                    ? query
                      ? m.agent_search_description()
                      : m.member_type_empty_description()
                    : m.agent_empty_description()}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                {memberCount ? (
                  <Button
                    variant="outline"
                    className="h-11 px-5"
                    onClick={() => (query ? setSearch("") : onMemberTypeChange("all"))}
                  >
                    {query ? m.agent_clear_search() : m.member_show_all()}
                  </Button>
                ) : null}
              </EmptyContent>
            </Empty>
          )}
        </div>
      </section>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!submittingRef.current) setOpen(nextOpen);
        }}
      >
        <DialogPortal keepMounted>
          <DialogBackdrop />
          <DialogPopup className="rounded-2xl">
            {computers.length ? (
              <form onSubmit={submit}>
                <div className="flex items-start justify-between gap-6 px-6 pt-6">
                  <div>
                    <DialogTitle>{m.agent_form_title()}</DialogTitle>
                    <DialogDescription className="mt-2">
                      {m.agent_form_description()}
                    </DialogDescription>
                  </div>
                  <DialogClose
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={m.controls_close()}
                      >
                        <X aria-hidden="true" />
                      </Button>
                    }
                  />
                </div>
                <div className="grid gap-5 px-6 py-6 sm:grid-cols-2">
                  <div className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">
                    <span>{m.agent_form_computer()}</span>
                    <Select
                      name="computerId"
                      required
                      value={computerId}
                      onValueChange={(value) => {
                        if (value !== null) {
                          setComputerId(value);
                        }
                      }}
                    >
                      <SelectTrigger
                        aria-label={m.agent_form_computer()}
                        className="h-11 min-w-0 rounded-lg shadow-xs"
                      >
                        <SelectValue>{() => selectedComputer?.displayName}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {computers.map((computer) => (
                          <SelectItem key={computer.id} value={computer.id}>
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate">{computer.displayName}</span>
                              <span className="shrink-0 text-muted-foreground">
                                ·{" "}
                                {computer.online
                                  ? m.computer_status_online()
                                  : m.computer_status_offline()}
                              </span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">
                    {m.agent_form_name()}
                    <input
                      name="name"
                      required
                      pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                      placeholder="release-fix"
                      className="h-11 min-w-0 rounded-lg bg-background px-3 shadow-xs ring-1 ring-border ring-inset outline-none transition-shadow focus:ring-2 focus:ring-ring"
                    />
                  </label>
                  <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">
                    {m.agent_form_description()}
                    <textarea
                      name="description"
                      rows={3}
                      placeholder={m.agent_form_description_placeholder()}
                      className="min-w-0 resize-y rounded-lg bg-background px-3 py-2.5 shadow-xs ring-1 ring-border ring-inset outline-none transition-shadow focus:ring-2 focus:ring-ring"
                    />
                  </label>
                  <AgentRuntimeFields
                    key={computerId}
                    open={open}
                    computerId={computerId}
                    onLoad={async (id) => ({
                      providers:
                        computers
                          .find((computer) => computer.id === id)
                          ?.runtimes.map((runtime) => runtime.provider) ?? [],
                      catalogs: await onLoadRuntimeCatalog(id),
                    })}
                  />
                  {error && (
                    <p role="alert" className="text-sm text-destructive-text sm:col-span-2">
                      {error}
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3 border-t px-6 py-4 sm:flex sm:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    disabled={submitting}
                    onClick={() => setOpen(false)}
                  >
                    {m.controls_cancel()}
                  </Button>
                  <Button type="submit" className="h-11" disabled={submitting}>
                    {submitting ? m.agent_form_submitting() : m.agent_form_submit()}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="p-6">
                <div
                  aria-hidden="true"
                  className="mb-5 flex size-12 items-center justify-center rounded-xl bg-card text-muted-foreground shadow-xs ring-1 ring-border ring-inset"
                >
                  <Monitor className="size-6" />
                </div>
                <DialogTitle>{m.agent_form_title()}</DialogTitle>
                <DialogDescription className="mt-3">
                  {m.agent_empty_computer_description()}
                </DialogDescription>
                <div className="mt-6 flex flex-wrap justify-end gap-3">
                  <Button variant="outline" onClick={() => setOpen(false)}>
                    {m.controls_cancel()}
                  </Button>
                  <Link
                    to="/computers"
                    onClick={() => setOpen(false)}
                    className={buttonVariants({ className: "h-11" })}
                  >
                    {m.agent_connect_computer()}
                  </Link>
                </div>
              </div>
            )}
          </DialogPopup>
        </DialogPortal>
      </Dialog>
    </main>
  );
}

function MemberCard({
  member,
  label,
  computerName,
  ownedAgent,
}: {
  member: WorkspaceMemberDirectory["people"][number];
  label: string;
  computerName?: string | null;
  ownedAgent?: AgentView;
}) {
  return (
    <li className="grid min-h-56 min-w-0 grid-cols-[3rem_minmax(0,1fr)_auto] grid-rows-[auto_1fr_auto] items-start gap-x-3 gap-y-5 rounded-xl bg-card p-5 shadow-xs ring-1 ring-border ring-inset">
      {ownedAgent ? (
        <AgentDisplayAvatar name={member.displayName} display={ownedAgent.display} size="xl" />
      ) : (
        <Avatar people={[{ name: member.displayName }]} size="xl" />
      )}
      <div className="min-w-0">
        <h2 className="line-clamp-2 break-words text-base font-semibold">
          {ownedAgent ? (
            <Link
              to="/agents/$agentId"
              params={{ agentId: member.id }}
              search={{ tab: "profile" }}
              className="inline-flex min-h-11 items-center rounded-sm outline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring sm:min-h-0"
            >
              {member.displayName}
            </Link>
          ) : (
            member.displayName
          )}
        </h2>
        <p className="mt-0.5 truncate text-sm text-muted-foreground">@{member.name}</p>
      </div>
      <div className="col-span-3 row-start-2 min-w-0">
        {member.description && (
          <p className="line-clamp-2 break-words text-sm leading-6 text-muted-foreground">
            {member.description}
          </p>
        )}
      </div>
      <div className="col-span-3 row-start-3 flex min-w-0 items-center gap-3 self-end">
        <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-foreground ring-1 ring-border ring-inset">
          {label}
        </span>
        {computerName !== undefined && (
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Monitor aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 line-clamp-2 break-words">
              {computerName === null
                ? m.member_no_computer()
                : computerName || m.agent_computer_unnamed()}
            </span>
          </p>
        )}
      </div>
      {ownedAgent && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon"
                className="col-start-3 row-start-1 size-11 rounded-lg sm:size-9"
                aria-label={m.agent_private_chat()}
                render={
                  <Link to="/messages/$agentId" params={{ agentId: member.id }}>
                    <MessageCircle aria-hidden="true" />
                  </Link>
                }
              />
            }
          />
          <TooltipContent>{m.agent_private_chat()}</TooltipContent>
        </Tooltip>
      )}
    </li>
  );
}

function runtimeProvider(value: FormDataEntryValue | null): CreateAgentInput["provider"] {
  if (value === "pi" || value === "codex" || value === "claude-code") return value;
  return "coforge";
}
