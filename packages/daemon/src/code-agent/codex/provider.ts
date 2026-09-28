import type {
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionIdentity,
  AgentSessionOptions,
  UsageSnapshot,
} from "@coforge/agent";
import type { CodeAgentProvider } from "#src/code-agent/contract";
import { readCodexUsage } from "./usage";
import { agentEnvironment } from "#src/code-agent/environment";
import { JsonlProcess, JsonlRequestError } from "#src/code-agent/jsonl-process";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import {
  discoverCodexCatalog,
  discoverExternalCodeAgents,
} from "#src/code-agent/runtime-inventory";
import type { ProviderDiscoveryOptions } from "#src/code-agent/contract";
import { asRecord, eventTime } from "#src/code-agent/json-record";

const logger = getLogger(["coforge", "daemon", "code-agent", "codex"]);

export class CodexProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.CODEX;
  readonly #command: readonly string[];

  constructor(options: { command?: readonly string[] } = {}) {
    this.#command = options.command ?? ["codex", "app-server"];
  }

  async discoverRuntime(options: ProviderDiscoveryOptions = {}) {
    return (
      await discoverExternalCodeAgents(
        options.probe,
        options.environment,
        options.platform,
        RUNTIME_PROVIDER.CODEX,
      )
    )[0];
  }

  discoverModelCatalog(options: ProviderDiscoveryOptions = {}) {
    return discoverCodexCatalog(
      options.command ?? this.#command,
      options.cwd ?? process.cwd(),
      options.environment ?? Bun.env,
    );
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

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    const process = new JsonlProcess(
      this.#command,
      options.agentWorkspaceDirectory,
      agentEnvironment(options.environment, Bun.env, undefined, {
        envVars: options.runtime?.envVars,
        extraEnv: { NO_COLOR: "1" },
        gitHooks: options.gitHooks,
      }),
    );
    try {
      await process.request({
        method: "initialize",
        params: {
          clientInfo: {
            name: "coforge_daemon",
            title: "CoForge Daemon",
            version: COFORGE_DAEMON_VERSION,
          },
          capabilities: { experimentalApi: false },
        },
      });
      await process.send({ method: "initialized", params: {} });
      const skillsResponse = await process.request({
        method: "skills/list",
        params: { cwds: [options.agentWorkspaceDirectory], forceReload: true },
      });
      assertSkillsLoaded(skillsResponse, options.agentWorkspaceDirectory);
      const openThread = (sessionId?: string) =>
        process.request({
          method: sessionId ? "thread/resume" : "thread/start",
          params: {
            ...(sessionId ? { threadId: sessionId } : { ephemeral: false }),
            cwd: options.agentWorkspaceDirectory,
            developerInstructions: options.instructions,
            ...(options.runtime?.model ? { model: options.runtime.model } : {}),
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            config: {
              ...(options.runtime?.reasoning
                ? { model_reasoning_effort: options.runtime.reasoning }
                : {}),
              // Retain the existing global-config override surface; the approved
              // danger-full-access policy does not use workspace-write restrictions.
              "sandbox_workspace_write.network_access": true,
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
            ...(!sessionId ? { serviceName: "coforge_daemon" } : {}),
          },
        });
      let replacedSessionId: string | undefined;
      const response = await openThread(options.sessionId).catch(async (error: unknown) => {
        const native =
          error instanceof JsonlRequestError ? asRecord(error.responseError) : undefined;
        if (
          !options.sessionId ||
          native?.code !== -32600 ||
          native.message !== `no rollout found for thread id ${options.sessionId}`
        )
          throw error;
        // Exact official ThreadNotFound response only, never auth/I/O or generic errors.
        replacedSessionId = options.sessionId;
        return openThread();
      });
      const thread = asRecord(asRecord(response.result)?.thread);
      if (typeof thread?.id !== "string") throw new Error("Codex did not create a thread");
      if (options.sessionId && !replacedSessionId && thread.id !== options.sessionId)
        throw new Error("Codex did not resume the requested thread");
      await options.onSessionId?.(thread.id, replacedSessionId);
      logger.info("Codex thread received standing instructions", {
        event: "codex.instructions.injected",
        agent_id: options.agentId,
        runtime_id: options.runtimeId,
        instruction_bytes: new TextEncoder().encode(options.instructions).byteLength,
        outcome: "ok",
      });
      return new CodexAgentSession(
        process,
        thread.id,
        options.sessionId !== undefined && replacedSessionId === undefined,
        options.agentId,
        options.runtimeId,
      );
    } catch (error) {
      await process.dispose();
      throw error;
    }
  }
}

class CodexAgentSession implements AgentSession {
  readonly #process: JsonlProcess;
  readonly #threadId: string;
  readonly #agentId: string | undefined;
  readonly #runtimeId: string | undefined;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #commandOutputBytes = new Map<string, number>();
  #state: CodexSessionState = { type: "idle" };
  #starting: Promise<void> | undefined;
  #identity: AgentSessionIdentity;

  constructor(
    process: JsonlProcess,
    threadId: string,
    resumed: boolean,
    agentId?: string,
    runtimeId?: string,
  ) {
    this.#process = process;
    this.#threadId = threadId;
    this.#agentId = agentId;
    this.#runtimeId = runtimeId;
    this.#identity = {
      sessionId: threadId,
      state: resumed ? "resumable" : "empty",
    };
    process.onRecord((record) => this.#accept(record));
    process.onStderr((text) => {
      const match = /Reconnecting\.\.\.\s*(\d+)\s*\/\s*\d+/i.exec(text);
      if (!match) return;
      // Raw stderr line as the fact; the daemon core formats/redacts it into the
      // visible `runtime_reconnecting` Activity (agent-runtime/runtime-error-activity.ts).
      this.#emit({ type: "reconnecting", attempt: Number(match[1]), message: text });
    });
    // Whether an unexpected close reads as a crash is the daemon core's call, made
    // from this fact at the moment the process actually exits.
    process.onFailure((error) => this.#emit({ type: "error", message: error.message }));
  }

  async sendMessage(text: string): Promise<void> {
    if (this.#state.type !== "idle") throw new Error("code agent is already running");
    const starting = this.#startTurn(text);
    this.#starting = starting;
    try {
      await starting;
    } finally {
      if (this.#starting === starting) this.#starting = undefined;
    }
  }

  async #startTurn(text: string): Promise<void> {
    this.#setIdentity("unknown");
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
    this.#setIdentity("resumable");
    if (this.#state.type !== "starting") return;
    this.#state = this.#state.completedTurnIds.has(turn.id)
      ? { type: "idle" }
      : { type: "running", turnId: turn.id };
  }

  async notify(notice: string): Promise<void> {
    await this.#acceptNotice(notice);
    logger.info("Codex accepted inbox wakeup", {
      event: "codex.wakeup.accepted",
      agent_id: this.#agentId,
      runtime_id: this.#runtimeId,
      notice_bytes: new TextEncoder().encode(notice).byteLength,
      outcome: "ok",
    });
  }

  async #acceptNotice(notice: string): Promise<void> {
    // Only retry a rejected admission when the active turn ended. Other RPC
    // failures remain failures so the daemon retains the unacknowledged attention.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.#starting) await this.#starting;
      const state = this.#state;
      if (state.type === "idle") return this.sendMessage(notice);
      if (state.type !== "running") throw new Error("code agent cannot accept a notification");
      try {
        const response = await this.#process.request({
          method: "turn/steer",
          params: {
            threadId: this.#threadId,
            expectedTurnId: state.turnId,
            input: [{ type: "text", text: notice }],
          },
        });
        if (asRecord(response.result)?.turnId !== state.turnId) {
          throw new Error("Codex did not accept the notification for the active turn");
        }
        return;
      } catch (error) {
        const rpcError =
          error instanceof JsonlRequestError ? asRecord(error.responseError) : undefined;
        if (
          attempt > 0 ||
          rpcError?.code !== -32600 ||
          rpcError.message !== "no active turn to steer"
        ) {
          throw error;
        }
        if (this.#state === state) this.#state = { type: "idle" };
      }
    }
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async readSessionIdentity(): Promise<AgentSessionIdentity> {
    return this.#identity;
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
    if (record.method === "error") {
      const error = asRecord(params?.error);
      if (
        params?.threadId !== this.#threadId ||
        typeof params.turnId !== "string" ||
        typeof params.willRetry !== "boolean" ||
        typeof error?.message !== "string"
      )
        return;
      if (params.willRetry) {
        logger.debug("Codex is retrying a provider request", {
          event: "codex.request.retrying",
          agent_id: this.#agentId,
          runtime_id: this.#runtimeId,
        });
        return;
      }
      this.#emit({ type: "error", message: error.message, occurredAt: eventTime(record) });
      return;
    }
    if (record.method === "item/agentMessage/delta" && typeof params?.delta === "string") {
      this.#emit({ type: "text-delta", text: params.delta });
      return;
    }
    // Readable summaries only. Deliberately ignore the raw reasoning text itself,
    // but a busy Agent stays visibly busy: report it content-free as progress.
    if (record.method === "item/reasoning/summaryTextDelta" && typeof params?.delta === "string") {
      this.#emit({ type: "thinking-delta", text: params.delta });
      return;
    }
    if (record.method === "item/reasoning/textDelta" && typeof params?.delta === "string") {
      this.#emit({
        type: "progress",
        source: "codex_reasoning_text_delta",
        occurredAt: eventTime(record),
      });
      return;
    }
    if (record.method === "item/started") {
      const item = asRecord(params?.item);
      if (item?.type === "commandExecution" && typeof item.id === "string") {
        this.#commandOutputBytes.set(item.id, 0);
        const command = typeof item.command === "string" ? item.command : "command";
        // Reported as a raw "bash" tool-start, same as every other provider, so the
        // daemon core's `toolActivity` resolves a `coforge …` command to its hidden
        // tool (e.g. `send_message`) instead of showing it as a generic shell command.
        this.#emit({
          type: "tool-start",
          id: item.id,
          name: "bash",
          input: { command },
          occurredAt: eventTime(record),
        });
      } else if (item?.type === "fileChange") {
        const itemId = typeof item.id === "string" ? item.id : "file-change";
        fileChanges(item).forEach((change, index) => {
          this.#emit({
            type: "tool-start",
            id: `${itemId}:${index}`,
            name: change.kind === "add" ? "write_file" : "edit_file",
            input: { file_path: change.path },
            occurredAt: eventTime(record),
          });
        });
      }
      return;
    }
    if (
      record.method === "item/commandExecution/outputDelta" &&
      typeof params?.itemId === "string" &&
      typeof params.delta === "string"
    ) {
      this.#commandOutputBytes.set(
        params.itemId,
        (this.#commandOutputBytes.get(params.itemId) ?? 0) +
          new TextEncoder().encode(params.delta).byteLength,
      );
      this.#emit({
        type: "tool-output",
        id: params.itemId,
        text: params.delta,
      });
      return;
    }
    if (record.method === "item/completed") {
      const item = asRecord(params?.item);
      // A reasoning item's completion needs no provider-specific signal: the daemon
      // derives "thinking finished" for every provider from the normalized event
      // stream (ActivityTrajectory), so there is nothing to report here.
      if (item?.type === "reasoning") return;
      if (item?.type === "commandExecution" && typeof item.id === "string") {
        logger.info("Codex command completed", {
          event: "codex.command.completed",
          agent_id: this.#agentId,
          runtime_id: this.#runtimeId,
          exit_code: typeof item.exitCode === "number" ? item.exitCode : undefined,
          output_bytes: this.#commandOutputBytes.get(item.id) ?? 0,
          outcome: item.exitCode === 0 ? "ok" : "failed",
        });
        this.#commandOutputBytes.delete(item.id);
        this.#emit({
          type: "tool-end",
          id: item.id,
          isError: item.exitCode !== 0,
        });
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
      if (status === "failed") {
        const error = asRecord(turn.error);
        // Raw fact only (no scrub/cap here) — the daemon core owns redaction and
        // truncation for the visible Activity; this local scrub only bounds what
        // reaches the daemon's own structured log line below.
        const rawMessage =
          typeof error?.message === "string" ? error.message : "Codex turn failed.";
        logger.error("Codex turn failed", {
          event: "codex.turn.failed",
          agent_id: this.#agentId,
          runtime_id: this.#runtimeId,
          turn_status: turn.status,
          error_code: typeof error?.code === "string" ? error.code : undefined,
          error_message: scrubError(rawMessage),
          outcome: "error",
        });
        this.#emit({
          type: "error",
          message: rawMessage,
          occurredAt: eventTime(record),
          providerErrorClass: typeof error?.code === "string" ? error.code : "CodexTurnError",
          providerErrorReason: "turn_failed",
        });
      }
      this.#emit({ type: "completed", status });
    }
  }

  #emit(event: AgentRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #setIdentity(state: AgentSessionIdentity["state"]): void {
    if (this.#identity.state === state) return;
    this.#identity = { sessionId: this.#threadId, state };
    this.#emit({ type: "session", identity: this.#identity });
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

function assertSkillsLoaded(response: Record<string, unknown>, cwd: string): void {
  const data = asRecord(response.result)?.data;
  if (!Array.isArray(data)) throw new Error("Codex did not report loaded skills");
  const workspace = data.map(asRecord).find((entry) => entry?.cwd === cwd);
  if (!workspace || !Array.isArray(workspace.errors) || workspace.errors.length > 0) {
    throw new Error("Codex failed to load workspace skills");
  }
}

// Bounds only the daemon's own structured log line (`codex.turn.failed`), never the visible
// Activity: the daemon core owns redaction/truncation for anything shown to a user (see
// agent-runtime/runtime-error-activity.ts, the single place that happens for every provider).
function scrubError(message: string): string {
  return message
    .replace(/(?:sk|pk|api|token|key|secret)[_-]?[A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 500);
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
