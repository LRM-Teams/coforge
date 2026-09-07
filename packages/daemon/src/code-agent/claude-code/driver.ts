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
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
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
      const command = [
        ...this.#command,
        "--append-system-prompt-file",
        promptPath,
        ...(options.runtime?.model ? ["--model", options.runtime.model] : []),
        ...(options.runtime?.reasoning ? ["--effort", options.runtime.reasoning] : []),
      ];
      process = new JsonlProcess(
        command,
        options.agentWorkspaceDirectory,
        agentEnvironment(options.environment),
      );
      const session = new ClaudeCodeAgentSession(process, () =>
        rm(promptDirectory, { recursive: true, force: true }),
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
  readonly #process: JsonlProcess;
  readonly #removePrompt: () => Promise<void>;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  #state: "idle" | "running" | "interrupting" | "disposed" = "idle";
  #initialized = false;
  #sessionId: string | undefined;
  // A fresh Claude session becomes ready at its first result, as in Raft 1.0.17.
  #sessionReadyForNotices = false;
  #compacting = false;
  #inputFailure: Error | undefined;
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

  constructor(process: JsonlProcess, removePrompt: () => Promise<void>) {
    this.#process = process;
    this.#removePrompt = removePrompt;
    process.onRecord((record) => this.#accept(record));
    process.onFailure((error) => {
      this.#rejectPendingInterrupt(error);
      this.#rejectWaitingNotices(error);
      this.#emit({
        type: "activity",
        activity: createAgentActivity("error", "error", error.message),
      });
    });
    process.onClose(() => {
      this.#rejectPendingInterrupt(new Error("code agent process closed during interrupt"));
      this.#rejectWaitingNotices(new Error("code agent process closed before writing input"));
      void this.#removePrompt();
    });
  }

  async ready(): Promise<void> {
    if (this.#initialized) return;
    const requestId = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      let unsubscribeRecord: () => void = () => undefined;
      let unsubscribeFailure: () => void = () => undefined;
      const cleanup = () => {
        unsubscribeRecord();
        unsubscribeFailure();
      };
      unsubscribeRecord = this.#process.onRecord((record) => {
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
      unsubscribeFailure = this.#process.onFailure((error) => {
        cleanup();
        reject(error);
      });
      void this.#process
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
    return this.#process.onClose(listener);
  }

  async dispose(): Promise<void> {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    this.#rejectWaitingNotices(new Error("code agent process closed before writing input"));
    this.#pendingInterrupt?.reject(new Error("code agent process closed"));
    this.#pendingInterrupt = undefined;
    try {
      await this.#process.dispose();
    } finally {
      await this.#removePrompt();
    }
  }

  #accept(record: Readonly<Record<string, unknown>>): void {
    if (record.type === "system" && record.parent_tool_use_id == null) {
      if (record.subtype === "status" && record.status === "compacting") this.#compacting = true;
      if (record.subtype === "compact_boundary") {
        this.#compacting = false;
        this.#flushNotices();
      }
    }
    if (record.type === "system" && record.subtype === "init") {
      if (typeof record.session_id === "string" && record.session_id !== this.#sessionId) {
        this.#sessionId = record.session_id;
        this.#sessionReadyForNotices = false;
      }
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
      if (
        event?.type === "content_block_delta" &&
        delta?.type === "text_delta" &&
        typeof delta.text === "string"
      ) {
        this.#emit({ type: "text-delta", text: delta.text });
      }
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
          const input = asRecord(block.input);
          const details =
            block.name === "Bash" && typeof input?.command === "string"
              ? input.command
              : typeof input?.file_path === "string"
                ? input.file_path
                : block.name;
          const activity =
            block.name === "Bash"
              ? "running_command"
              : block.name === "Read"
                ? "reading_file"
                : block.name === "Write"
                  ? "writing_file"
                  : block.name === "Edit"
                    ? "editing_file"
                    : "using_tool";
          this.#emit({
            type: "activity",
            activity: createAgentActivity(activity, "info", details, eventTime(record)),
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

  #isDisposed(): boolean {
    return this.#state === "disposed";
  }

  #rejectWaitingNotices(error: Error): void {
    this.#inputFailure = error;
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
