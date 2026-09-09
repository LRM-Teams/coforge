import { useRef, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { Heading, Text } from "react-aria-components";
import {
  MessageCircle01 as MessageCircle,
  Monitor01 as Monitor,
  Plus,
  SearchLg as Search,
  Users01 as UsersRound,
  XClose as X,
} from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { Avatar } from "@/components/base/avatar/avatar";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { localizeHref } from "@/paraglide/runtime";
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
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { Select } from "@/components/base/select/select";
import { m } from "@/paraglide/messages";
import type { AgentStatusView } from "./agent-status-realtime";
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
    if (!name || !description) {
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
    <main className="flex h-svh min-w-0">
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-primary">
        <PageHeader
          heading={m.navigation_agents()}
          actions={
            <Button className="h-11 md:h-10" onPress={() => setOpen(true)}>
              <Plus aria-hidden="true" data-icon="inline-start" />
              {m.header_new_agent()}
            </Button>
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6">
          {deferredStart && (
            <p
              role="status"
              className="mt-5 rounded-lg border border-secondary bg-secondary px-4 py-3 text-sm text-tertiary"
            >
              {m.agent_deferred_start_notice()}
            </p>
          )}
          {memberCount > 0 && (
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <div
                role="group"
                aria-label={m.member_type_filter()}
                className="flex max-w-full gap-0.5 rounded-lg bg-secondary p-1 ring-1 ring-secondary ring-inset"
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
                    color={memberType === type ? "secondary" : "tertiary"}
                    className="h-11 gap-2 px-3 font-semibold md:h-9 aria-pressed:text-primary"
                    aria-pressed={memberType === type}
                    onPress={() => onMemberTypeChange(type)}
                  >
                    {type === "all"
                      ? m.filters_all()
                      : type === "human"
                        ? m.member_person()
                        : m.member_agent()}
                    <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium tabular-nums text-tertiary ring-1 ring-secondary ring-inset">
                      {type === "all"
                        ? memberCount
                        : type === "human"
                          ? directory.people.length
                          : directory.agents.length}
                    </span>
                  </Button>
                ))}
              </div>
              <label className="flex h-11 w-full items-center gap-2 rounded-lg bg-primary px-3 text-sm shadow-xs ring-1 ring-secondary transition-shadow focus-within:ring-2 focus-within:ring-brand ring-inset sm:ml-auto sm:w-72">
                <Search aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
                <input
                  type="search"
                  aria-label={m.filters_search()}
                  placeholder={`${m.filters_search()}...`}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-tertiary"
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
                    <Search aria-hidden="true" className="size-8 text-tertiary" strokeWidth={1.5} />
                  </EmptyMedia>
                ) : (
                  <EmptyMedia aria-hidden="true" className="relative mb-3 h-28 w-44">
                    <span className="absolute inset-x-2 top-0 h-24 rounded-full bg-secondary" />
                    <UsersRound className="relative size-20 text-tertiary" strokeWidth={1} />
                    <span className="absolute right-2 bottom-0 flex size-10 items-center justify-center rounded-xl border border-secondary bg-primary text-tertiary shadow-sm">
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
                    color="secondary"
                    className="h-11 px-5"
                    onPress={() => (query ? setSearch("") : onMemberTypeChange("all"))}
                  >
                    {query ? m.agent_clear_search() : m.member_show_all()}
                  </Button>
                ) : null}
              </EmptyContent>
            </Empty>
          )}
        </div>
      </section>

      <ModalOverlay
        isOpen={open}
        onOpenChange={(nextOpen) => {
          if (!submittingRef.current) setOpen(nextOpen);
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-lg rounded-2xl">
          <Dialog>
            {({ close }) =>
              computers.length ? (
                <form onSubmit={submit}>
                  <div className="flex items-start justify-between gap-6 px-6 pt-6">
                    <div>
                      <Heading slot="title" className="text-lg font-semibold text-primary">
                        {m.agent_form_title()}
                      </Heading>
                      <Text slot="description" className="mt-2 text-sm text-tertiary">
                        {m.agent_form_description()}
                      </Text>
                    </div>
                    <ButtonUtility
                      type="button"
                      aria-label={m.controls_close()}
                      icon={X}
                      size="sm"
                      color="tertiary"
                      onClick={close}
                    />
                  </div>
                  <div className="grid gap-5 px-6 py-6 sm:grid-cols-2">
                    <div className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">
                      <span>{m.agent_form_computer()}</span>
                      <Select
                        name="computerId"
                        isRequired
                        size="lg"
                        className="min-w-0 rounded-lg shadow-xs"
                        aria-label={m.agent_form_computer()}
                        selectedKey={computerId}
                        onSelectionChange={(key) => {
                          if (key !== null) setComputerId(String(key));
                        }}
                      >
                        {computers.map((computer) => (
                          <Select.Item
                            key={computer.id}
                            id={computer.id}
                            label={computer.displayName}
                            supportingText={
                              computer.online
                                ? m.computer_status_online()
                                : m.computer_status_offline()
                            }
                          />
                        ))}
                      </Select>
                    </div>
                    <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">
                      {m.agent_form_name()}
                      <input
                        name="name"
                        required
                        pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                        placeholder="release-fix"
                        className="h-11 min-w-0 rounded-lg bg-primary px-3 shadow-xs ring-1 ring-secondary outline-none transition-shadow ring-inset focus:ring-2 focus:ring-brand"
                      />
                    </label>
                    <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">
                      {m.agent_form_description()}
                      <textarea
                        name="description"
                        required
                        rows={3}
                        placeholder={m.agent_form_description_placeholder()}
                        className="min-w-0 resize-y rounded-lg bg-primary px-3 py-2.5 shadow-xs ring-1 ring-secondary outline-none transition-shadow ring-inset focus:ring-2 focus:ring-brand"
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
                      <p role="alert" className="text-sm text-error-primary sm:col-span-2">
                        {error}
                      </p>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3 border-t border-secondary px-6 py-4 sm:flex sm:justify-end">
                    <Button
                      type="button"
                      color="secondary"
                      className="h-11"
                      isDisabled={submitting}
                      onPress={() => setOpen(false)}
                    >
                      {m.controls_cancel()}
                    </Button>
                    <Button type="submit" className="h-11" isDisabled={submitting}>
                      {submitting ? m.agent_form_submitting() : m.agent_form_submit()}
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="p-6">
                  <div
                    aria-hidden="true"
                    className="mb-5 flex size-12 items-center justify-center rounded-xl bg-primary text-tertiary shadow-xs ring-1 ring-secondary ring-inset"
                  >
                    <Monitor className="size-6" />
                  </div>
                  <Heading slot="title" className="text-lg font-semibold text-primary">
                    {m.agent_form_title()}
                  </Heading>
                  <Text slot="description" className="mt-3 text-sm text-tertiary">
                    {m.agent_empty_computer_description()}
                  </Text>
                  <div className="mt-6 flex flex-wrap justify-end gap-3">
                    <Button color="secondary" onPress={() => setOpen(false)}>
                      {m.controls_cancel()}
                    </Button>
                    <Button
                      href={localizeHref("/computers")}
                      className="h-11"
                      onPress={() => setOpen(false)}
                    >
                      {m.agent_connect_computer()}
                    </Button>
                  </div>
                </div>
              )
            }
          </Dialog>
        </Modal>
      </ModalOverlay>
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
    <li className="grid min-h-56 min-w-0 grid-cols-[3rem_minmax(0,1fr)_auto] grid-rows-[auto_1fr_auto] items-start gap-x-3 gap-y-5 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
      <Avatar
        size="xl"
        alt={member.displayName}
        initials={avatarInitial(member.displayName)}
        contentClassName={avatarToneClassName(member.displayName)}
        status={
          ownedAgent ? (ownedAgent.status.value === "active" ? "online" : "offline") : undefined
        }
      />
      {ownedAgent && (
        <span className="sr-only">
          {ownedAgent.status.value === "active"
            ? m.agent_status_online()
            : m.agent_status_offline()}
        </span>
      )}
      <div className="min-w-0">
        <h2 className="line-clamp-2 break-words text-base font-semibold">
          {ownedAgent ? (
            <Link
              to="/agents/$agentId"
              params={{ agentId: member.id }}
              search={{ tab: "profile" }}
              className="inline-flex min-h-11 items-center rounded-sm outline-focus-ring outline-offset-4 hover:underline focus-visible:outline-2 sm:min-h-0"
            >
              {member.displayName}
            </Link>
          ) : (
            member.displayName
          )}
        </h2>
        <p className="mt-0.5 truncate text-sm text-tertiary">@{member.name}</p>
      </div>
      <div className="col-span-3 row-start-2 min-w-0">
        {member.description && (
          <p className="line-clamp-2 break-words text-sm leading-6 text-tertiary">
            {member.description}
          </p>
        )}
      </div>
      <div className="col-span-3 row-start-3 flex min-w-0 items-center gap-3 self-end">
        <span className="shrink-0 rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-primary ring-1 ring-secondary ring-inset">
          {label}
        </span>
        {computerName !== undefined && (
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-tertiary">
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
        <ButtonUtility
          icon={MessageCircle}
          size="sm"
          color="secondary"
          tooltip={m.agent_private_chat()}
          className="col-start-3 row-start-1"
          href={localizeHref(`/messages/${member.id}`)}
        />
      )}
    </li>
  );
}

function runtimeProvider(value: FormDataEntryValue | null): CreateAgentInput["provider"] {
  if (value === "pi" || value === "codex" || value === "claude-code") return value;
  return "coforge";
}
