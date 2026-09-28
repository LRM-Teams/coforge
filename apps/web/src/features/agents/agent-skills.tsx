import { useCallback, useEffect, useRef, useState } from "react";
import { Folder, Globe01 } from "@untitledui/icons";
import type { AgentSkillsListResult, AgentSkillsScope } from "@lrm/coforge-sdk/internal";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";

export type AgentSkillsLoadResult =
  | { status: "ready"; result: AgentSkillsListResult }
  | { status: "offline" | "timeout" | "unavailable" };

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "offline" | "timeout" | "unavailable" }
  | { status: "ready"; result: AgentSkillsListResult };

/**
 * The Profile tab's Skills section: a `Skills (N)` heading, a
 * single loading line, a reason line plus Retry on any non-ready state, and two source-grouped
 * card lists (Global/Workspace) with no directory list, no per-entry source column, and no
 * "loaded" claim. Owner-only, same gate as before (`agent-profile-tab.tsx`).
 */
export function AgentSkills({
  resetKey,
  onLoad,
}: {
  resetKey: string;
  onLoad: () => Promise<AgentSkillsLoadResult>;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const request = useRef(0);
  const load = useCallback(async () => {
    const current = ++request.current;
    setState({ status: "loading" });
    try {
      const result = await onLoad();
      if (request.current !== current) return;
      setState(result);
    } catch {
      if (request.current === current) setState({ status: "error" });
    }
  }, [onLoad]);

  useEffect(() => {
    void load();
    return () => {
      request.current += 1;
    };
  }, [load, resetKey]);

  const count =
    state.status === "ready"
      ? state.result.global.entries.length + state.result.workspace.entries.length
      : 0;

  return (
    <section className="min-w-0 py-6">
      <h2 className="font-semibold">{m.agent_skills_title({ count })}</h2>
      {state.status === "loading" ? (
        <p role="status" className="mt-4 text-sm text-tertiary">
          {m.agent_skills_loading()}
        </p>
      ) : state.status === "ready" ? (
        <div className="mt-4 grid gap-6">
          <SkillGroup
            icon={Globe01}
            heading={m.agent_skills_global()}
            emptyCopy={m.agent_skills_global_empty()}
            scope={state.result.global}
          />
          <SkillGroup
            icon={Folder}
            heading={m.agent_skills_workspace()}
            emptyCopy={m.agent_skills_workspace_empty()}
            scope={state.result.workspace}
          />
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p role="status" className="text-sm text-error-primary">
            {state.status === "offline"
              ? m.agent_skills_offline()
              : state.status === "timeout"
                ? m.agent_skills_timeout()
                : state.status === "unavailable"
                  ? m.agent_skills_unavailable()
                  : m.agent_skills_error()}
          </p>
          <Button size="sm" color="secondary" onPress={() => void load()}>
            {m.controls_retry()}
          </Button>
        </div>
      )}
    </section>
  );
}

function SkillGroup({
  icon: Icon,
  heading,
  emptyCopy,
  scope,
}: {
  icon: typeof Globe01;
  heading: string;
  emptyCopy: string;
  scope: AgentSkillsScope;
}) {
  const groups = groupBySourcePath(scope.entries);
  return (
    <section className="min-w-0" aria-labelledby={`skills-${heading}`}>
      <div className="flex items-center gap-1.5">
        <Icon aria-hidden="true" className="size-4 text-tertiary" />
        <h3 id={`skills-${heading}`} className="text-sm font-semibold">
          {heading}
        </h3>
        <span className="text-sm text-tertiary">({scope.entries.length})</span>
      </div>
      {scope.entries.length === 0 ? (
        <p className="mt-2 text-sm text-tertiary">{emptyCopy}</p>
      ) : (
        <div className="mt-3 grid gap-4">
          {groups.map(([sourcePath, entries]) => (
            <div key={sourcePath} className="min-w-0">
              <p className="flex items-baseline gap-1.5 text-xs text-tertiary">
                <code className="truncate">{sourcePath}</code>
                <span>({entries.length})</span>
              </p>
              <div className="mt-2 grid gap-2">
                {entries.map((entry) => (
                  <div
                    key={`${sourcePath}:${entry.name}`}
                    className="min-w-0 rounded-lg border border-secondary px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="truncate font-medium text-primary">{entry.displayName}</p>
                      {entry.userInvocable && (
                        <Badge color="gray" size="sm" className="font-mono">
                          /{entry.name}
                        </Badge>
                      )}
                    </div>
                    {entry.description && (
                      <p className="mt-0.5 line-clamp-2 text-sm text-tertiary">
                        {entry.description}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function groupBySourcePath(entries: AgentSkillsScope["entries"]) {
  const groups = new Map<string, AgentSkillsScope["entries"]>();
  for (const entry of entries) {
    const existing = groups.get(entry.sourcePath);
    if (existing) existing.push(entry);
    else groups.set(entry.sourcePath, [entry]);
  }
  return [...groups.entries()];
}
