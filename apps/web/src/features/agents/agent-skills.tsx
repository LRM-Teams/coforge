import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { AgentSkillsListResult, AgentSkillsScope } from "@coforge/protocol";

import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

export type AgentSkillsLoadResult =
  | { status: "ready"; result: AgentSkillsListResult }
  | { status: "offline" | "timeout" | "unavailable" };

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "offline" | "timeout" | "unavailable" }
  | { status: "ready"; result: AgentSkillsListResult };

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

  return (
    <section className="min-w-0 rounded-xl border bg-card p-5 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{m.agent_skills_title()}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{m.agent_skills_caveat()}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void load()}
          disabled={state.status === "loading"}
        >
          <RefreshCw aria-hidden="true" />
          {m.agent_skills_refresh()}
        </Button>
      </div>
      {state.status === "loading" ? (
        <p role="status" className="mt-5 text-sm text-muted-foreground">
          {m.agent_skills_loading()}
        </p>
      ) : state.status === "ready" ? (
        <div className="mt-5 grid gap-7">
          <SkillScope heading={m.agent_skills_global()} scope={state.result.global} />
          <SkillScope heading={m.agent_skills_workspace()} scope={state.result.workspace} />
        </div>
      ) : (
        <p role="status" className="mt-5 text-sm text-destructive-text">
          {state.status === "offline"
            ? m.agent_skills_offline()
            : state.status === "timeout"
              ? m.agent_skills_timeout()
              : state.status === "unavailable"
                ? m.agent_skills_unavailable()
                : m.agent_skills_error()}
        </p>
      )}
    </section>
  );
}

function SkillScope({ heading, scope }: { heading: string; scope: AgentSkillsScope }) {
  return (
    <section className="min-w-0" aria-labelledby={`skills-${heading.replaceAll(" ", "-")}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 id={`skills-${heading.replaceAll(" ", "-")}`} className="text-sm font-semibold">
          {heading}
        </h3>
        {scope.status !== "ok" && (
          <p className="text-xs text-muted-foreground">
            {scope.status === "partial"
              ? m.agent_skills_partial()
              : scope.status === "unsupported"
                ? m.agent_skills_unsupported()
                : m.agent_skills_scope_error()}
          </p>
        )}
      </div>
      {scope.entries.length ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-xl text-left text-sm">
            <thead className="border-b text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {m.agent_skills_name()}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {m.agent_skills_description()}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {m.agent_skills_source()}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {scope.entries.map((entry) => (
                <tr key={`${entry.sourcePath}:${entry.name}`}>
                  <td className="py-2 pr-4 font-medium">{entry.name}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{entry.description || "—"}</td>
                  <td className="break-all py-2 font-mono text-xs text-muted-foreground">
                    {entry.sourcePath}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : scope.status === "ok" ? (
        <p className="mt-3 text-sm text-muted-foreground">{m.agent_skills_empty()}</p>
      ) : null}
      {scope.directories.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-medium">{m.agent_skills_directories()}</summary>
          <ul className="mt-2 grid gap-1.5">
            {scope.directories.map((directory) => (
              <li key={directory.path} className="flex flex-wrap justify-between gap-2 text-xs">
                <code className="break-all text-muted-foreground">{directory.path}</code>
                <span>{directoryStatus(directory.status)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function directoryStatus(status: AgentSkillsScope["directories"][number]["status"]) {
  if (status === "scanned") return m.agent_skills_directory_scanned();
  if (status === "missing") return m.agent_skills_directory_missing();
  if (status === "unreadable") return m.agent_skills_directory_unreadable();
  return m.agent_skills_directory_unsupported();
}
