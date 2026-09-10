import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  AgentDriver,
  AgentSession,
  AgentSessionOptions,
  AgentRuntimeEvent,
  AgentSessionIdentity,
} from "@coforge/agent";
import type {
  SessionNotification,
  SessionConfigOption,
  NewSessionRequest,
} from "@agentclientprotocol/sdk";
import { RUNTIME_PROVIDER } from "@coforge/protocol";
import { agentEnvironment } from "../environment";
import { AgentSessionRecoveryError } from "../contract";
import { createAgentActivity } from "../../agent-runtime/agent-activity";
import { toolActivity } from "../tool-activity";
import { bounded, KIRO_ACP_ARGS, KiroConnection, record } from "./connection";
import { readKiroUsage } from "./usage";

export class KiroDriver implements AgentDriver {
  readonly provider = RUNTIME_PROVIDER.KIRO;
  constructor(
    private readonly options: { command?: readonly string[]; configTimeoutMs?: number } = {},
  ) {}

  readUsage(options: { workingDirectory: string; timeoutMs?: number }) {
    return readKiroUsage({ timeoutMs: options.timeoutMs });
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid Kiro session ID");
    const environment = agentEnvironment(options.environment, Bun.env, undefined, {
      envVars: options.runtime?.envVars,
    });
    const directory = resolve(options.agentWorkspaceDirectory, ".kiro/agents");
    await mkdir(directory, { recursive: true });
    if ((await realpath(directory)) !== directory)
      throw new Error("Kiro agent profile directory must not be a symlink");
    const name = `coforge-runtime-${crypto.randomUUID()}`;
    const path = join(directory, `${name}.json`);
    await writeFile(
      path,
      JSON.stringify({
        name,
        description: "CoForge managed runtime instructions",
        prompt: options.instructions,
        tools: ["*"],
        permissions: { rules: [{ capability: "all", effect: "allow" }] },
        includeMcpJson: true,
        resources: [
          "skill://.kiro/skills/**/SKILL.md",
          `skill://${environment.KIRO_HOME ?? join(environment.HOME ?? "~", ".kiro")}/skills/**/SKILL.md`,
        ],
      }),
      { flag: "wx", mode: 0o600 },
    );
    let session: KiroSession | undefined;
    try {
      session = new KiroSession(
        [...(this.options.command ?? ["kiro-cli"]), ...KIRO_ACP_ARGS],
        options,
        environment,
        name,
        () => rm(path, { force: true }),
        this.options.configTimeoutMs,
      );
      await session.open();
      return session;
    } catch (error) {
      if (session) await session.dispose();
      else await rm(path, { force: true });
      throw error;
    }
  }
}

class KiroSession implements AgentSession {
  readonly #transport: KiroConnection;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #seenMessageIds = new Set<string>();
  #identity: AgentSessionIdentity | undefined;
  #pending: { resolve(): void; reject(error: Error): void } | undefined;
  #admissions: Promise<void> = Promise.resolve();
  #turn: Promise<void> | undefined;
  #generation = 0;
  #disposed = false;
  #dispose: Promise<void> | undefined;
  #interrupting = false;

  constructor(
    command: readonly string[],
    private readonly options: AgentSessionOptions,
    environment: Readonly<Record<string, string>>,
    private readonly profileName: string,
    private readonly cleanupProfile: () => Promise<void>,
    private readonly configTimeoutMs = 30_000,
  ) {
    this.#transport = new KiroConnection(
      command,
      options.agentWorkspaceDirectory,
      environment,
      (notification) => this.#update(notification),
      (request) => {
        const allow =
          !this.#disposed && !this.#interrupting && request.sessionId === this.#identity?.sessionId
            ? (request.options.find((option) => option.kind === "allow_always") ??
              request.options.find((option) => option.kind === "allow_once"))
            : undefined;
        return {
          outcome: allow
            ? { outcome: "selected", optionId: allow.optionId }
            : { outcome: "cancelled" },
        };
      },
    );
  }

  async open() {
    await this.#transport.initialize();
    const agent = this.#transport.connection.agent;
    const params: NewSessionRequest = { cwd: this.options.agentWorkspaceDirectory, mcpServers: [] };
    let config: SessionConfigOption[];
    if (this.options.sessionId) {
      // v3 silently creates an empty session for unknown IDs. Never use load as an existence test.
      let cursor: string | undefined;
      let createdAt: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = await bounded(
          agent.request("session/list", { cwd: params.cwd, ...(cursor ? { cursor } : {}) }),
        );
        const selected = page.sessions.find((entry) => entry.sessionId === this.options.sessionId);
        if (selected) {
          const meta = record(selected._meta?.kiro);
          if (
            selected.cwd !== params.cwd ||
            meta?.source !== "local" ||
            typeof meta.createdAt !== "string"
          )
            throw new Error("Kiro session ownership metadata is unavailable");
          createdAt = meta.createdAt;
          break;
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor && (cursors.has(cursor) || cursors.size >= 100))
          throw new Error("Kiro session listing is incomplete");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (!createdAt) throw new AgentSessionRecoveryError("session_missing");
      const loaded = await bounded(
        agent.request("session/load", { ...params, sessionId: this.options.sessionId }),
      );
      if (loaded._meta?.id !== this.options.sessionId || loaded._meta?.createdAt !== createdAt)
        throw new AgentSessionRecoveryError("provider_replay_rejected");
      this.#identity = { sessionId: this.options.sessionId, state: "resumable" };
      config = loaded.configOptions ?? [];
    } else {
      const created = await bounded(agent.request("session/new", params));
      if (!created.sessionId.trim()) throw new Error("Kiro did not create a session");
      this.#identity = { sessionId: created.sessionId, state: "empty" };
      config = created.configOptions ?? [];
    }
    const sessionId = this.#identity.sessionId;
    const select = async (id: string, value: string) => {
      const option = config.find((option) => option.id === id);
      if (
        option?.type !== "select" ||
        !option.options.some((entry) =>
          "value" in entry
            ? entry.value === value
            : entry.options.some((child) => child.value === value),
        )
      )
        throw new Error(`Kiro ${id} selection is unavailable`);
      const configured = await bounded(
        agent.request("session/set_config_option", { sessionId, configId: id, value }),
      );
      config = configured.configOptions;
      if (!config.some((option) => option.id === id && option.currentValue === value))
        throw new Error(`Kiro did not apply ${id}`);
    };
    await select("mode", this.profileName);
    if (this.options.runtime?.model) {
      config = await this.#transport.waitForConfig(
        sessionId,
        config,
        "model",
        this.configTimeoutMs,
      );
      await select("model", this.options.runtime.model);
    }
    if (this.options.runtime?.reasoning) {
      config = await this.#transport.waitForConfig(
        sessionId,
        config,
        "thought_level",
        this.configTimeoutMs,
      );
      const effort = config.find((option) => option.category === "thought_level");
      if (!effort) throw new Error("Kiro reasoning selection is unavailable");
      await select(effort.id, this.options.runtime.reasoning);
    }
    await this.options.onSessionId?.(sessionId);
  }

  sendMessage(message: string) {
    return this.notify(message);
  }

  notify(message: string): Promise<void> {
    const accepted = this.#admissions.then(() => this.#prompt(message));
    this.#admissions = accepted.catch(() => {});
    return accepted;
  }

  async #prompt(message: string) {
    if (this.#disposed || this.#interrupting || !this.#identity)
      throw new Error("Kiro cannot accept input");
    const generation = ++this.#generation;
    const admitted = Promise.withResolvers<void>();
    this.#pending = admitted;
    const turn = this.#transport.connection.agent
      .request("session/prompt", {
        sessionId: this.#identity.sessionId,
        prompt: [{ type: "text", text: message }],
      })
      .then(
        (response) => {
          if (this.#pending === admitted)
            admitted.reject(new Error("Kiro ended a turn without accepting its input"));
          if (generation !== this.#generation || this.#disposed) return;
          this.#emit({
            type: "completed",
            status:
              response.stopReason === "cancelled"
                ? "interrupted"
                : response.stopReason === "end_turn"
                  ? "completed"
                  : "failed",
          });
        },
        (error: unknown) => {
          if (this.#pending === admitted) admitted.reject(new Error("Kiro rejected input"));
          if (generation === this.#generation && !this.#disposed) {
            this.#emit({
              type: "activity",
              activity: createAgentActivity("runtime_error", "error", "Kiro request failed"),
            });
            this.#emit({ type: "completed", status: "failed" });
          }
          // Native errors may contain private provider data; do not send them to logs.
          void error;
        },
      );
    this.#turn = turn;
    try {
      await bounded(admitted.promise);
    } catch (error) {
      await this.dispose();
      throw error;
    } finally {
      if (this.#pending === admitted) this.#pending = undefined;
      void turn.finally(() => {
        if (this.#turn === turn) this.#turn = undefined;
      });
    }
  }

  #update(notification: SessionNotification) {
    if (this.#disposed || notification.sessionId !== this.#identity?.sessionId) return;
    const update = notification.update;
    const meta = record(update._meta?.kiro);
    if (
      update.sessionUpdate === "session_info_update" &&
      meta?.kind === "user_message_id_assigned" &&
      typeof meta.userMessageId === "string" &&
      meta.userMessageId.trim() &&
      !this.#seenMessageIds.has(meta.userMessageId)
    ) {
      this.#seenMessageIds.add(meta.userMessageId);
      if (this.#pending) {
        this.#identity = { sessionId: notification.sessionId, state: "resumable" };
        this.#emit({ type: "session", identity: this.#identity });
        this.#pending.resolve();
      }
    }
    if (
      (update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk") &&
      update.content.type === "text"
    ) {
      this.#emit({
        type: update.sessionUpdate === "agent_message_chunk" ? "text-delta" : "thinking-delta",
        text: update.content.text,
      });
    }
    if (update.sessionUpdate === "tool_call") {
      const name = update.name ?? update.title;
      this.#emit({ type: "tool-start", id: update.toolCallId, name });
      this.#emit({ type: "activity", activity: toolActivity(name, update.rawInput) });
    }
    if (update.sessionUpdate === "tool_call_update") {
      for (const item of update.content ?? []) {
        if (item.type === "content" && item.content.type === "text" && item.content.text)
          this.#emit({ type: "tool-output", id: update.toolCallId, text: item.content.text });
      }
      if (update.status === "completed" || update.status === "failed")
        this.#emit({
          type: "tool-end",
          id: update.toolCallId,
          isError: update.status === "failed",
        });
    }
    if (
      update.sessionUpdate === "session_info_update" &&
      meta?.kind === "error" &&
      typeof meta.message === "string"
    )
      this.#emit({
        type: "activity",
        activity: createAgentActivity("runtime_error", "error", "Kiro reported a runtime error"),
      });
  }

  async interrupt() {
    if (this.#disposed || !this.#identity) return;
    this.#interrupting = true;
    try {
      await this.#transport.connection.agent.notify("session/cancel", {
        sessionId: this.#identity.sessionId,
      });
      if (this.#turn) await bounded(this.#turn);
    } catch (error) {
      await this.dispose();
      throw error;
    } finally {
      this.#interrupting = false;
    }
  }

  async readSessionIdentity() {
    return this.#identity;
  }
  subscribe(listener: (event: AgentRuntimeEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  onExit(listener: () => void) {
    return this.#transport.process.onClose(listener);
  }
  #emit(event: AgentRuntimeEvent) {
    for (const listener of this.#listeners) listener(event);
  }
  dispose(): Promise<void> {
    this.#disposed = true;
    this.#pending?.reject(new Error("Kiro session closed"));
    this.#dispose ??= this.#transport.dispose().finally(this.cleanupProfile);
    return this.#dispose;
  }
}
