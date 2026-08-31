import type {
  CodeAgentAdapter,
  AgentRuntimeEvent,
  CodeAgentSession,
  CodeAgentStartOptions,
} from "../contract";
import type { UsageSnapshot } from "../contract";
import { readCodexUsage } from "./usage";
import { agentEnvironment } from "../environment";
import { JsonlProcess } from "../jsonl-process";
import { createAgentActivity } from "../../agent-runtime/agent-activity";
import { RUNTIME_PROVIDER } from "@coforge/protocol";

export class CodexAgentAdapter implements CodeAgentAdapter {
  readonly provider = RUNTIME_PROVIDER.CODEX;
  readonly #command: readonly string[];

  constructor(options: { command?: readonly string[] } = {}) {
    this.#command = options.command ?? ["codex", "app-server"];
  }

  async readUsage(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<UsageSnapshot | null> {
    return readCodexUsage(options.workingDirectory, {
      command: this.#command,
      timeoutMs: options.timeoutMs,
    });
  }

  async start(options: CodeAgentStartOptions): Promise<CodeAgentSession> {
    const process = new JsonlProcess(
      this.#command,
      options.agentWorkspaceDirectory,
      agentEnvironment(options.environment),
    );
    try {
      await process.request({
        method: "initialize",
        params: {
          clientInfo: { name: "coforge_daemon", title: "CoForge Daemon", version: "0.1.0" },
          capabilities: { experimentalApi: false },
        },
      });
      await process.send({ method: "initialized", params: {} });
      const skillsResponse = await process.request({
        method: "skills/list",
        params: { cwds: [options.agentWorkspaceDirectory], forceReload: true },
      });
      assertSkillsLoaded(skillsResponse, options.agentWorkspaceDirectory);
      const response = await process.request({
        method: "thread/start",
        params: {
          cwd: options.agentWorkspaceDirectory,
          ...(options.runtime?.model ? { model: options.runtime.model } : {}),
          approvalPolicy: "never",
          sandbox: "workspace-write",
          config: {
            ...(options.runtime?.reasoning
              ? { model_reasoning_effort: options.runtime.reasoning }
              : {}),
            allow_login_shell: false,
            shell_environment_policy: {
              inherit: "all",
              ignore_default_excludes: false,
              filters: {
                "COFORGE_*": "include",
                HOME: "include",
                PATH: "include",
                XDG_CONFIG_HOME: "include",
                XDG_DATA_HOME: "include",
                XDG_CACHE_HOME: "include",
                TMPDIR: "include",
                TEMP: "include",
                TMP: "include",
                LANG: "include",
                LC_ALL: "include",
              },
            },
          },
          ephemeral: true,
          serviceName: "coforge_daemon",
        },
      });
      const thread = asRecord(asRecord(response.result)?.thread);
      if (typeof thread?.id !== "string") throw new Error("Codex did not create a thread");
      return new CodexAgentSession(process, thread.id);
    } catch (error) {
      await process.dispose();
      throw error;
    }
  }
}

class CodexAgentSession implements CodeAgentSession {
  readonly #process: JsonlProcess;
  readonly #threadId: string;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  #state: CodexSessionState = { type: "idle" };

  constructor(process: JsonlProcess, threadId: string) {
    this.#process = process;
    this.#threadId = threadId;
    process.onRecord((record) => this.#accept(record));
    process.onFailure((error) =>
      this.#emit({
        type: "activity",
        activity: createAgentActivity("error", "error", error.message),
      }),
    );
  }

  async sendMessage(text: string): Promise<void> {
    if (this.#state.type !== "idle") throw new Error("code agent is already running");
    this.#state = { type: "starting", completedTurnIds: new Set() };
    let response: Readonly<Record<string, unknown>>;
    try {
      response = await this.#process.request({
        method: "turn/start",
        params: {
          threadId: this.#threadId,
          input: [{ type: "text", text }],
        },
      });
    } catch (error) {
      if (!this.#isDisposed()) this.#state = { type: "idle" };
      throw error;
    }
    const turn = asRecord(asRecord(response.result)?.turn);
    if (typeof turn?.id !== "string") {
      if (!this.#isDisposed()) this.#state = { type: "idle" };
      throw new Error("Codex did not create a turn");
    }
    if (this.#state.type !== "starting") return;
    this.#state = this.#state.completedTurnIds.has(turn.id)
      ? { type: "idle" }
      : { type: "running", turnId: turn.id };
  }

  async notify(notice: string): Promise<void> {
    await this.sendMessage(notice);
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async interrupt(): Promise<void> {
    if (this.#state.type !== "running") return;
    const turnId = this.#state.turnId;
    this.#state = { type: "interrupting", turnId };
    try {
      await this.#process.request({
        method: "turn/interrupt",
        params: { threadId: this.#threadId, turnId },
      });
    } catch (error) {
      if (!this.#isDisposed()) this.#state = { type: "running", turnId };
      throw error;
    }
  }

  onExit(listener: () => void): () => void {
    return this.#process.onClose(listener);
  }

  async dispose(): Promise<void> {
    if (this.#state.type === "disposed") return;
    this.#state = { type: "disposed" };
    await this.#process.dispose();
  }

  #accept(record: Record<string, unknown>): void {
    const params = asRecord(record.params);
    if (record.method === "item/agentMessage/delta" && typeof params?.delta === "string") {
      this.#emit({ type: "text-delta", text: params.delta });
      return;
    }
    if (record.method === "item/started") {
      const item = asRecord(params?.item);
      if (item?.type === "commandExecution" && typeof item.id === "string") {
        this.#emit({ type: "tool-start", id: item.id, name: "command" });
        const command = typeof item.command === "string" ? item.command : "command";
        this.#emit({
          type: "activity",
          activity: createAgentActivity("running_command", "info", command, eventTime(record)),
        });
      } else if (item?.type === "fileChange") {
        for (const change of fileChanges(item)) {
          const activity = change.kind === "add" ? "writing_file" : "editing_file";
          this.#emit({
            type: "activity",
            activity: createAgentActivity(activity, "info", change.path, eventTime(record)),
          });
        }
      }
      return;
    }
    if (
      record.method === "item/commandExecution/outputDelta" &&
      typeof params?.itemId === "string" &&
      typeof params.delta === "string"
    ) {
      this.#emit({ type: "tool-output", id: params.itemId, text: params.delta });
      return;
    }
    if (record.method === "item/completed") {
      const item = asRecord(params?.item);
      if (item?.type === "commandExecution" && typeof item.id === "string") {
        this.#emit({ type: "tool-end", id: item.id, isError: item.exitCode !== 0 });
      }
      return;
    }
    if (record.method === "turn/completed") {
      const turn = asRecord(params?.turn);
      if (typeof turn?.id !== "string") return;
      if (this.#state.type === "starting") this.#state.completedTurnIds.add(turn.id);
      else if (
        (this.#state.type === "running" || this.#state.type === "interrupting") &&
        this.#state.turnId === turn.id
      ) {
        this.#state = { type: "idle" };
      } else {
        return;
      }
      const status =
        turn.status === "interrupted"
          ? "interrupted"
          : turn.status === "completed"
            ? "completed"
            : "failed";
      this.#emit({ type: "completed", status });
    }
  }

  #emit(event: AgentRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #isDisposed(): boolean {
    return this.#state.type === "disposed";
  }
}

type CodexSessionState =
  | { type: "idle" }
  | { type: "starting"; completedTurnIds: Set<string> }
  | { type: "running"; turnId: string }
  | { type: "interrupting"; turnId: string }
  | { type: "disposed" };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertSkillsLoaded(response: Record<string, unknown>, cwd: string): void {
  const data = asRecord(response.result)?.data;
  if (!Array.isArray(data)) throw new Error("Codex did not report loaded skills");
  const workspace = data.map(asRecord).find((entry) => entry?.cwd === cwd);
  if (!workspace || !Array.isArray(workspace.errors) || workspace.errors.length > 0) {
    throw new Error("Codex failed to load workspace skills");
  }
}

function eventTime(record: Readonly<Record<string, unknown>>): string {
  return typeof record.timestamp === "string" && !Number.isNaN(Date.parse(record.timestamp))
    ? record.timestamp
    : new Date().toISOString();
}

function fileChanges(
  item: Readonly<Record<string, unknown>>,
): Array<{ kind: string; path: string }> {
  const changes = Array.isArray(item.changes) ? item.changes : [item];
  return changes.flatMap((value) => {
    const change = asRecord(value);
    if (!change || typeof change.path !== "string") return [];
    return [
      {
        kind: typeof change.kind === "string" ? change.kind : "edit",
        path: change.path,
      },
    ];
  });
}
