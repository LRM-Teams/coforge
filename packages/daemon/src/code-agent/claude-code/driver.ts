import {
  AGENT_RUNTIME_EVENT_TYPE,
  type UsageSnapshot,
  type AgentRuntimeEvent,
  type AgentDriver,
} from "../contract";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { agentEnvironment } from "../environment";
import { JsonlProcess } from "../jsonl-process";
import { createAgentActivity } from "../../agent-runtime/agent-activity";
import { toolActivity } from "../tool-activity";
import { RUNTIME_PROVIDER } from "@coforge/protocol";
import { readClaudeCodeUsage } from "./usage";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class ClaudeCodeDriver implements AgentDriver {
  readonly provider = RUNTIME_PROVIDER.CLAUDE_CODE;
  readonly #command: readonly string[];

  constructor(options: { command?: readonly string[] } = {}) {
    this.#command = options.command ?? [
      "claude",
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];
  }

  async readUsage(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<UsageSnapshot | null> {
    return readClaudeCodeUsage(options.workingDirectory, {
      command: this.#command.slice(0, 1),
      timeoutMs: options.timeoutMs,
    });
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    const promptDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-prompt-"));
    let process: JsonlProcess | undefined;
    try {
      const promptPath = join(promptDirectory, "system-prompt.md");
      await writeFile(promptPath, options.instructions, { mode: 0o600 });
      const command = (sessionId?: string) => [
        ...this.#command,
        "--dangerously-skip-permissions",
        "--permission-mode",
        "bypassPermissions",
        ...(sessionId ? ["--resume", sessionId] : []),
        "--append-system-prompt-file",
        promptPath,
        ...(options.runtime?.model ? ["--model", options.runtime.model] : []),
        ...(options.runtime?.reasoning ? ["--effort", options.runtime.reasoning] : []),
      ];
      const spawn = (sessionId?: string) =>
        new JsonlProcess(
          command(sessionId),
          options.agentWorkspaceDirectory,
          agentEnvironment(options.environment),
        );
      process = spawn(options.sessionId);
      const session = new ClaudeCodeAgentSession(
        process,
        () => rm(promptDirectory, { recursive: true, force: true }),
        options.onSessionId,
        options.sessionId,
        () => spawn(),
      );
      await session.ready();
      return session;
    } catch (error) {
      await process?.dispose().catch(() => undefined);
      await rm(promptDirectory, { recursive: true, force: true });
      throw error;
    }
  }
}

class ClaudeCodeAgentSession implements AgentSession {
  #process: JsonlProcess;
  readonly #exitListeners = new Set<() => void>();
  #closed = false;
  #firstInput: string | undefined;
  #progressObserved = false;
  #replacedSessionId: string | undefined;
  readonly #removePrompt: () => Promise<void>;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  #state: "idle" | "running" | "interrupting" | "disposed" = "idle";
  #initialized = false;
  #initialization: { process: JsonlProcess; promise: Promise<void> } | undefined;
  #sessionId: string | undefined;
  #sessionReports = Promise.resolve();
  // A fresh Claude session becomes ready at its first result, as in Raft 1.0.17.
  #sessionReadyForNotices = false;
  #compacting = false;
  #inputFailure: Error | undefined;
  #recoveryFailed = false;
  readonly #outstandingTools = new Set<string>();
  readonly #waitingNotices: Array<{
    text: string;
    resolve(): void;
    reject(error: Error): void;
  }> = [];
  #usageSnapshot: UsageSnapshot = { provider: RUNTIME_PROVIDER.CLAUDE_CODE };
  #pendingInterrupt:
    | { promise: Promise<void>; resolve(): void; reject(error: Error): void }
    | undefined;

  constructor(
    process: JsonlProcess,
    removePrompt: () => Promise<void>,
    private readonly reportSessionId?: (
      sessionId: string,
      replacedSessionId?: string,
    ) => Promise<void>,
    private expectedSessionId?: string,
    private readonly spawnFresh?: () => JsonlProcess,
  ) {
    this.#process = process;
    this.#removePrompt = removePrompt;
    this.#bindProcess(process);
  }

  #bindProcess(process: JsonlProcess): void {
    let missing = false;
    let otherDiagnostic = false;
    let failure: Error | undefined;
    process.onStderr((line) => {
      // Raft uses this native diagnostic, not an SDK existence query. Match
      // the entire selected-ID line, never arbitrary provider/model output.
      if (
        this.expectedSessionId &&
        line.trim() === `No conversation found with session ID: ${this.expectedSessionId}`
      )
        missing = true;
      else if (line.trim()) otherDiagnostic = true;
    });
    process.onRecord((record) => {
      if (this.#process !== process) return;
      if (
        this.expectedSessionId &&
        !this.#progressObserved &&
        !this.#recoveryFailed &&
        record.type === "result" &&
        record.subtype === "error_during_execution" &&
        record.is_error === true &&
        Array.isArray(record.errors) &&
        record.errors.length === 1 &&
        record.errors[0] === `No conversation found with session ID: ${this.expectedSessionId}`
      ) {
        missing = true;
        return;
      }
      this.#accept(record);
    });
    process.onFailure((error) => {
      failure = error;
      if (error.message !== "code agent process exited unexpectedly") {
        this.#rejectPendingInterrupt(error);
        this.#rejectWaitingNotices(error);
        this.#emit({
          type: "activity",
          activity: createAgentActivity("runtime_error", "error", error.message),
        });
      }
    });
    process.onClose(() => {
      if (this.#process !== process) return;
      if (
        missing &&
        !otherDiagnostic &&
        failure?.message === "code agent process exited unexpectedly" &&
        this.expectedSessionId &&
        !this.#replacedSessionId &&
        !this.#progressObserved &&
        !this.#recoveryFailed &&
        (this.#state === "running" || this.#state === "idle") &&
        this.spawnFresh
      ) {
        this.#replacedSessionId = this.expectedSessionId;
        this.expectedSessionId = undefined;
        this.#initialized = false;
        void this.#startFresh().catch((error: unknown) => {
          this.#rejectWaitingNotices(error instanceof Error ? error : new Error(String(error)));
          this.#emit({
            type: "activity",
            activity: createAgentActivity(
              "runtime_error",
              "error",
              "Claude fresh session launch failed",
            ),
          });
          void this.dispose().catch(() => undefined);
        });
        return;
      }
      if (failure && this.#state !== "disposed") {
        this.#emit({
          type: "activity",
          activity: createAgentActivity("runtime_error", "error", failure.message),
        });
      }
      this.#rejectPendingInterrupt(
        failure ?? new Error("code agent process closed during interrupt"),
      );
      this.#rejectWaitingNotices(new Error("code agent process closed before writing input"));
      void this.#removePrompt();
      this.#finishClose();
    });
  }

  async #startFresh(): Promise<void> {
    const firstInput = this.#firstInput;
    this.#process = this.spawnFresh!();
    this.#bindProcess(this.#process);
    await this.ready();
    if (this.#isDisposed()) return;
    if (firstInput !== undefined) await this.#sendInput(firstInput);
  }

  async ready(): Promise<void> {
    if (this.#initialized) return;
    const process = this.#process;
    if (this.#initialization?.process === process) return this.#initialization.promise;
    const promise = this.#initialize(process);
    this.#initialization = { process, promise };
    return promise;
  }

  async #initialize(process: JsonlProcess): Promise<void> {
    const requestId = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      let unsubscribeRecord: () => void = () => undefined;
      let unsubscribeFailure: () => void = () => undefined;
      let unsubscribeClose: () => void = () => undefined;
      let failure = new Error("Claude Code initialization process closed");
      const cleanup = () => {
        unsubscribeRecord();
        unsubscribeFailure();
        unsubscribeClose();
      };
      unsubscribeRecord = process.onRecord((record) => {
        const response = asRecord(record.response);
        if (record.type !== "control_response" || response?.request_id !== requestId) return;
        cleanup();
        if (response.subtype === "success") {
          this.#initialized = true;
          resolve();
        } else {
          reject(new Error("Claude Code initialization was rejected"));
        }
      });
      unsubscribeFailure = process.onFailure((error) => {
        failure = error;
        if (error.message !== "code agent process exited unexpectedly") {
          cleanup();
          reject(error);
        }
      });
      unsubscribeClose = process.onClose(() => {
        cleanup();
        if (this.#process !== process && !this.#isDisposed())
          void this.ready().then(resolve, reject);
        else reject(failure);
      });
      void process
        .send({
          type: "control_request",
          request_id: requestId,
          request: { subtype: "initialize" },
        })
        .catch((error: unknown) => {
          cleanup();
          reject(error);
        });
    });
  }

  async sendMessage(text: string): Promise<void> {
    if (this.#state !== "idle") throw new Error("code agent is already running");
    await this.#sendInput(text);
  }

  async #sendInput(text: string): Promise<void> {
    if (this.#inputFailure) throw this.#inputFailure;
    this.#firstInput ??= text;
    // Reserve the turn before writing; a native result can arrive during flush.
    if (this.#state === "idle") this.#state = "running";
    await this.#process.send({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.#sessionId,
    });
  }

  async notify(notice: string): Promise<void> {
    if (this.#inputFailure) throw this.#inputFailure;
    if (this.#state === "disposed" || this.#state === "interrupting") {
      throw new Error("code agent cannot accept a notification");
    }
    if (this.#state === "idle") {
      await this.#sendInput(notice);
      return;
    }
    // Do not inject into an arbitrary thinking/tool execution instant. Only a
    // native tool-batch, compact, or result boundary drains these pending calls.
    await new Promise<void>((resolve, reject) => {
      this.#waitingNotices.push({ text: notice, resolve, reject });
    });
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async interrupt(): Promise<void> {
    if (this.#state === "idle" || this.#state === "disposed") return;
    if (this.#pendingInterrupt) return this.#pendingInterrupt.promise;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.#pendingInterrupt = { promise, resolve, reject };
    this.#state = "interrupting";
    try {
      this.#process.interrupt();
    } catch (error) {
      this.#pendingInterrupt = undefined;
      if (!this.#isDisposed()) this.#state = "running";
      reject(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  onExit(listener: () => void): () => void {
    if (this.#closed) {
      queueMicrotask(listener);
      return () => undefined;
    }
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    this.#rejectWaitingNotices(new Error("code agent process closed before writing input"));
    this.#pendingInterrupt?.reject(new Error("code agent process closed"));
    this.#pendingInterrupt = undefined;
    try {
      await this.#process.dispose();
      this.#finishClose();
    } finally {
      await this.#removePrompt();
    }
  }

  #accept(record: Readonly<Record<string, unknown>>): void {
    if (this.#recoveryFailed || this.#state === "disposed") return;
    if (
      ["stream_event", "assistant", "user", "result"].includes(String(record.type)) ||
      (record.type === "system" && record.subtype === "init")
    ) {
      this.#progressObserved = true;
      this.#firstInput = undefined;
    }
    if (record.type === "system" && record.parent_tool_use_id == null) {
      if (record.subtype === "status" && record.status === "compacting") this.#compacting = true;
      if (record.subtype === "compact_boundary") {
        this.#compacting = false;
        this.#flushNotices();
      }
    }
    if (record.type === "system" && record.subtype === "init") {
      if (
        typeof record.session_id !== "string" ||
        !record.session_id.trim() ||
        record.session_id === this.#replacedSessionId ||
        (this.expectedSessionId && record.session_id !== this.expectedSessionId)
      ) {
        this.#failRecovery();
        return;
      }
      if (typeof record.session_id === "string" && record.session_id !== this.#sessionId) {
        this.#sessionId = record.session_id;
        this.#sessionReadyForNotices = record.session_id === this.expectedSessionId;
      }
      this.#reportIdentity();
      return;
    }
    if (record.type === "rate_limit_event") {
      const info = asRecord(record.rate_limit_info);
      const usageWindow = claudeRateLimitWindow(info);
      if (!usageWindow) return;
      this.#usageSnapshot = {
        ...this.#usageSnapshot,
        [usageWindow.key]: usageWindow.window,
      };
      this.#emit({ type: AGENT_RUNTIME_EVENT_TYPE.USAGE, snapshot: this.#usageSnapshot });
      return;
    }
    if (record.type === "stream_event") {
      const event = asRecord(record.event);
      if (
        record.parent_tool_use_id == null &&
        event?.type === "message_start" &&
        this.#state === "idle"
      ) {
        this.#state = "running";
      }
      const delta = asRecord(event?.delta);
      const subagent =
        typeof record.parent_tool_use_id === "string"
          ? { parentToolUseId: record.parent_tool_use_id }
          : undefined;
      if (
        event?.type === "content_block_delta" &&
        delta?.type === "text_delta" &&
        typeof delta.text === "string"
      ) {
        this.#emit({ type: "text-delta", text: delta.text, ...(subagent ? { subagent } : {}) });
      }
      if (
        event?.type === "content_block_delta" &&
        delta?.type === "thinking_delta" &&
        typeof delta.thinking === "string"
      )
        this.#emit({
          type: "thinking-delta",
          text: delta.thinking,
          ...(subagent ? { subagent } : {}),
        });
      return;
    }
    if (record.type === "assistant") {
      if (record.parent_tool_use_id == null) {
        if (this.#state === "idle") this.#state = "running";
        for (const block of messageContent(record)) {
          if (block?.type === "tool_use" && typeof block.id === "string") {
            this.#outstandingTools.add(block.id);
          }
        }
      }
      for (const block of messageContent(record)) {
        if (
          block?.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          this.#emit({ type: "tool-start", id: block.id, name: block.name });
          const activity = toolActivity(block.name, block.input, eventTime(record));
          if (typeof record.parent_tool_use_id === "string")
            activity.entries = activity.entries.map((entry) => ({
              ...entry,
              subagent: { parentToolUseId: record.parent_tool_use_id as string },
            }));
          this.#emit({
            type: "activity",
            activity,
          });
        }
      }
      return;
    }
    if (record.type === "user") {
      let toolFinished = false;
      for (const block of messageContent(record)) {
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        if (record.parent_tool_use_id == null && this.#outstandingTools.delete(block.tool_use_id)) {
          toolFinished = true;
        }
        const text = textContent(block.content);
        if (text) this.#emit({ type: "tool-output", id: block.tool_use_id, text });
        this.#emit({ type: "tool-end", id: block.tool_use_id, isError: block.is_error === true });
      }
      if (toolFinished) this.#flushNotices();
      return;
    }
    if (record.type === "result") {
      if (record.parent_tool_use_id != null) return;
      if (
        !this.#sessionId ||
        (this.expectedSessionId && this.#sessionId !== this.expectedSessionId)
      ) {
        this.#failRecovery();
        return;
      }
      this.#reportIdentity();
      this.#sessionReadyForNotices = true;
      this.#compacting = false;
      this.#outstandingTools.clear();
      const pending = this.#pendingInterrupt;
      if (pending) {
        this.#pendingInterrupt = undefined;
        pending.resolve();
      }
      if (this.#state !== "running" && this.#state !== "interrupting") return;
      const interrupted = this.#state === "interrupting";
      this.#state = "idle";
      this.#emit({
        type: "completed",
        status: interrupted ? "interrupted" : record.subtype === "success" ? "completed" : "failed",
      });
      this.#flushNotices();
    }
  }

  #reportIdentity(): void {
    const sessionId = this.#sessionId;
    if (!sessionId || !this.reportSessionId) return;
    // Serialize observations, not the event reader. A repeated turn-end report
    // confirms the reference, not that the provider flushed its transcript.
    this.#sessionReports = this.#sessionReports
      .then(async () => {
        await this.reportSessionId!(sessionId, this.#replacedSessionId);
      })
      .catch((error) => {
        this.#emit({
          type: "activity",
          activity: createAgentActivity(
            "runtime_error",
            "error",
            error instanceof Error ? error.message : "Claude session identity report failed",
          ),
        });
      });
  }

  #flushNotices(): void {
    if (this.#inputFailure || this.#state === "disposed" || this.#state === "interrupting") return;
    if (!this.#sessionReadyForNotices || this.#compacting || this.#outstandingTools.size > 0)
      return;
    // Raft-compatible written acceptance, not confirmation of model processing.
    for (const notice of this.#waitingNotices.splice(0)) {
      void this.#sendInput(notice.text).then(notice.resolve, notice.reject);
    }
  }

  #emit(event: AgentRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #finishClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#exitListeners) listener();
    this.#exitListeners.clear();
  }

  #isDisposed(): boolean {
    return this.#state === "disposed";
  }

  #failRecovery(): void {
    const error = new Error(
      this.expectedSessionId
        ? "Claude did not resume the requested session"
        : "Claude did not establish a valid session identity",
    );
    this.#recoveryFailed = true;
    this.#rejectWaitingNotices(error);
    this.#emit({
      type: "activity",
      activity: createAgentActivity("runtime_error", "error", error.message),
    });
    // Never block the event reader on process-tree cleanup.
    void this.dispose().catch(() => undefined);
  }

  #rejectWaitingNotices(error: Error): void {
    this.#inputFailure ??= error;
    for (const notice of this.#waitingNotices.splice(0)) notice.reject(error);
  }

  #rejectPendingInterrupt(error: Error): void {
    const pending = this.#pendingInterrupt;
    if (!pending) return;
    this.#pendingInterrupt = undefined;
    pending.reject(error);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageContent(
  record: Readonly<Record<string, unknown>>,
): Array<Record<string, unknown> | undefined> {
  const content = asRecord(record.message)?.content;
  return Array.isArray(content) ? content.map(asRecord) : [];
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map(asRecord)
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block!.text as string)
    .join("");
}

function eventTime(record: Readonly<Record<string, unknown>>): string {
  return typeof record.timestamp === "string" && !Number.isNaN(Date.parse(record.timestamp))
    ? record.timestamp
    : new Date().toISOString();
}

function claudeRateLimitWindow(
  info: Record<string, unknown> | undefined,
): { key: "primary" | "secondary"; window: NonNullable<UsageSnapshot["primary"]> } | undefined {
  if (info?.status !== "allowed" && info?.status !== "rejected") return undefined;
  const key =
    info.rateLimitType === "five_hour"
      ? "primary"
      : info.rateLimitType === "seven_day"
        ? "secondary"
        : undefined;
  if (!key || typeof info.resetsAt !== "number" || !Number.isFinite(info.resetsAt))
    return undefined;
  const reset = new Date(info.resetsAt >= 1e12 ? info.resetsAt : info.resetsAt * 1_000);
  if (Number.isNaN(reset.getTime())) return undefined;
  return {
    key,
    window: {
      status: info.status === "rejected" ? "rate-limited" : "available",
      windowDurationMinutes: key === "primary" ? 300 : 10_080,
      resetsAt: reset.toISOString(),
    },
  };
}
