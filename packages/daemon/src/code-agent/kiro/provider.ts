import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  AgentSession,
  AgentSessionOptions,
  AgentRuntimeEvent,
  AgentSessionIdentity,
} from "@coforge/agent";
import type { CodeAgentProvider } from "../contract";
import type {
  SessionNotification,
  SessionConfigOption,
  NewSessionRequest,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { agentEnvironment } from "../environment";
import { AgentSessionRecoveryError } from "../contract";
import { scrubRuntimeErrorText } from "../../agent-runtime/runtime-error-activity";
import { bounded, KIRO_ACP_ARGS, KiroConnection, record } from "./connection";
import { readKiroUsage } from "./usage";
import { discoverKiroCatalog } from "./catalog";
import { discoverExternalCodeAgents } from "../runtime-inventory";
import { assertKiroVersionSupported } from "./version";
import type { ProviderDiscoveryOptions } from "../contract";

// Kiro's tool_call frames never carry a programmatic name (only a
// human-readable title, e.g. "Run Command", "Read File"), so the ACP `kind`
// field is the only stable source for the canonical tool name. Kinds with no
// canonical CoForge tool fall back to the title.
const TOOL_KIND_NAMES: Readonly<Partial<Record<ToolKind, string>>> = {
  execute: "bash",
  read: "read_file",
  edit: "edit_file",
  search: "grep",
  fetch: "web_fetch",
};

// A stop reason outside the standard ACP `end_turn`/`cancelled` pair (Kiro's private "error"
// value included) always ends the turn as a failure; these are the fixed, CoForge-worded
// fallbacks used only when the turn carried no more specific reason of its own.
const STOP_REASON_FAILURE_MESSAGES: Readonly<Partial<Record<string, string>>> = {
  error: "Kiro ended the turn with an error",
  max_tokens: "Kiro reached its token limit before finishing the turn",
  max_turn_requests: "Kiro reached its turn request limit before finishing the turn",
  refusal: "Kiro refused to continue the turn",
};

export class KiroProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.KIRO;
  constructor(
    private readonly options: { command?: readonly string[]; configTimeoutMs?: number } = {},
  ) {}

  async discoverRuntime(options: ProviderDiscoveryOptions = {}) {
    return (
      await discoverExternalCodeAgents(
        options.probe,
        options.environment,
        options.platform,
        RUNTIME_PROVIDER.KIRO,
      )
    )[0];
  }

  discoverModelCatalog(options: ProviderDiscoveryOptions = {}) {
    return discoverKiroCatalog(
      options.command ?? ["kiro-cli", ...KIRO_ACP_ARGS],
      options.cwd ?? process.cwd(),
      options.environment ?? Bun.env,
    );
  }

  readUsage(options: { workingDirectory: string; timeoutMs?: number }) {
    return readKiroUsage({ timeoutMs: options.timeoutMs });
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid Kiro session ID");
    // Runtime discovery already gates the Daemon's reported inventory; this re-check covers an
    // existing Agent whose CLI has since fallen below the baseline (or predates the gate).
    await assertKiroVersionSupported(this.options.command ?? ["kiro-cli"]);
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
  // The most recent scrubbed error text Kiro has volunteered for the turn in progress (via
  // `session_info_update`), already reported as its own `error` event the moment it arrived.
  // The turn's outcome reuses only the FACT that a reason was already shown, never the text
  // itself a second time, so a failed/cancelled turn never doubles up its one visible reason.
  #turnErrorMessage: string | undefined;

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
    // A reason volunteered mid-turn belongs to this turn only; a fresh prompt starts clean.
    this.#turnErrorMessage = undefined;
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
          // ACP's standard `StopReason` union has no "error" member, but Kiro sends it; widen
          // to `string` so every value the CLI can actually send is handled explicitly below.
          const stopReason: string = response.stopReason;
          const shownAlready = this.#turnErrorMessage !== undefined;
          this.#turnErrorMessage = undefined;
          if (stopReason === "end_turn") {
            this.#emit({ type: "completed", status: "completed" });
            return;
          }
          if (stopReason === "cancelled" && this.#interrupting) {
            // A stop/restart we asked for; unchanged from today.
            this.#emit({ type: "completed", status: "interrupted" });
            return;
          }
          // Every other stop reason ends the turn as a failure. `session_info_update` already
          // reported the real reason the moment it arrived (`shownAlready`); only a turn that
          // never volunteered one gets this fixed, CoForge-worded fallback, so the Agent never
          // shows two activities for the one failed turn.
          if (!shownAlready)
            this.#emit({
              type: "error",
              message:
                stopReason === "cancelled"
                  ? "Kiro cancelled the turn"
                  : (STOP_REASON_FAILURE_MESSAGES[stopReason] ??
                    `Kiro stopped the turn (${stopReason})`),
            });
          this.#emit({ type: "completed", status: "failed" });
        },
        (error: unknown) => {
          if (this.#pending === admitted) admitted.reject(new Error("Kiro rejected input"));
          if (generation === this.#generation && !this.#disposed) {
            // The JSON-RPC error's own message is a real, specific fact ("Instructions not
            // selected", an upstream auth failure, …); scrub it the same way every other
            // runtime error is before it ever becomes visible, instead of discarding it for a
            // fixed summary.
            const message =
              error instanceof Error && error.message.trim()
                ? scrubRuntimeErrorText(error.message)
                : "Kiro request failed";
            const jsonRpcCode =
              error &&
              typeof error === "object" &&
              "code" in error &&
              typeof error.code === "number"
                ? String(error.code)
                : undefined;
            this.#emit({
              type: "error",
              message,
              ...(jsonRpcCode !== undefined ? { providerErrorCode: jsonRpcCode } : {}),
            });
            this.#emit({ type: "completed", status: "failed" });
          }
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
      const name = (update.kind && TOOL_KIND_NAMES[update.kind]) || update.title;
      this.#emit({ type: "tool-start", id: update.toolCallId, name, input: update.rawInput });
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
    if (update.sessionUpdate === "compaction_update") {
      // Report the raw CompactionUpdate.status transition every time; the daemon core de-dupes
      // repeated "in_progress" updates into a single reported episode
      // (agent-runtime/compaction-tracker.ts). "failed"/"cancelled" are a provider-observed
      // interruption, distinct from a normal "completed" finish.
      if (update.status === "in_progress") this.#emit({ type: "compaction-started" });
      else if (update.status === "completed") this.#emit({ type: "compaction-finished" });
      else if (update.status === "failed" || update.status === "cancelled")
        this.#emit({ type: "compaction-interrupted" });
    }
    if (
      update.sessionUpdate === "tool_call_update" &&
      update.status === "in_progress" &&
      !update.content?.length
    ) {
      // A still-running tool with no new content this notification: content-free liveness.
      this.#emit({ type: "progress", source: "kiro_tool_call_update" });
    }
    if (update.sessionUpdate === "plan" || update.sessionUpdate === "plan_update") {
      // Task-plan bookkeeping carries no message content; still shows the turn is live.
      this.#emit({ type: "progress", source: "kiro_plan_update" });
    }
    if (update.sessionUpdate === "usage_update") {
      this.#emit({ type: "progress", source: "kiro_usage_update" });
    }
    if (
      update.sessionUpdate === "session_info_update" &&
      meta?.kind === "error" &&
      typeof meta.message === "string" &&
      meta.message.trim()
    ) {
      // meta.message is Kiro's own diagnostic (e.g. a raw TLS failure) and may carry private
      // provider data; scrub it through the same redaction every other runtime error goes
      // through, bound its length, and forward the real fact instead of a fixed placeholder.
      // meta.errorType is a stable native error code (e.g.
      // "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC") when Kiro reports one; it never carries
      // free text, so it is forwarded unscrubbed as the classification hint.
      const scrubbed = scrubRuntimeErrorText(meta.message);
      this.#turnErrorMessage = scrubbed;
      this.#emit({
        type: "error",
        message: scrubbed,
        ...(typeof meta.errorType === "string" && meta.errorType.trim()
          ? { providerErrorCode: meta.errorType }
          : {}),
      });
    }
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
