import {
  AGENT_RUNTIME_EVENT_TYPE,
  type UsageSnapshot,
  type AgentRuntimeEvent,
  type CodeAgentAdapter,
  type CodeAgentSession,
  type CodeAgentStartOptions,
} from "../contract";
import { agentEnvironment } from "../environment";
import { JsonlProcess } from "../jsonl-process";
import { createAgentActivity } from "../../agent-runtime/agent-activity";
import { RUNTIME_PROVIDER } from "@coforge/protocol";
import { readClaudeCodeUsage } from "./usage";
import { COFORGE_AGENT_INSTRUCTIONS } from "../communication-instructions";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class ClaudeCodeAgentAdapter implements CodeAgentAdapter {
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

  async start(options: CodeAgentStartOptions): Promise<CodeAgentSession> {
    const promptDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-prompt-"));
    let process: JsonlProcess | undefined;
    try {
      const promptPath = join(promptDirectory, "system-prompt.md");
      await writeFile(promptPath, COFORGE_AGENT_INSTRUCTIONS, { mode: 0o600 });
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

class ClaudeCodeAgentSession implements CodeAgentSession {
  readonly #process: JsonlProcess;
  readonly #removePrompt: () => Promise<void>;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  #state: "idle" | "running" | "interrupting" | "disposed" = "idle";
  #initialized = false;
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
      this.#emit({
        type: "activity",
        activity: createAgentActivity("error", "error", error.message),
      });
    });
    process.onClose(() => {
      this.#rejectPendingInterrupt(new Error("code agent process closed during interrupt"));
      void this.#removePrompt();
    });
  }

  async ready(): Promise<void> {
    if (this.#initialized) return;
    await new Promise<void>((resolve, reject) => {
      let unsubscribeRecord: () => void = () => undefined;
      let unsubscribeFailure: () => void = () => undefined;
      const cleanup = () => {
        unsubscribeRecord();
        unsubscribeFailure();
      };
      unsubscribeRecord = this.#process.onRecord((record) => {
        if (record.type === "system" && record.subtype === "init") {
          cleanup();
          resolve();
        }
      });
      unsubscribeFailure = this.#process.onFailure((error) => {
        cleanup();
        reject(error);
      });
    });
  }

  async sendMessage(text: string): Promise<void> {
    if (this.#state !== "idle") throw new Error("code agent is already running");
    this.#state = "running";
    try {
      await this.#process.send({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        session_id: "default",
      });
    } catch (error) {
      if (!this.#isDisposed()) this.#state = "idle";
      throw error;
    }
  }

  async notify(notice: string): Promise<void> {
    await this.sendMessage(notice);
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
    this.#pendingInterrupt?.reject(new Error("code agent process closed"));
    this.#pendingInterrupt = undefined;
    try {
      await this.#process.dispose();
    } finally {
      await this.#removePrompt();
    }
  }

  #accept(record: Readonly<Record<string, unknown>>): void {
    if (record.type === "system" && record.subtype === "init") {
      this.#initialized = true;
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
      for (const block of messageContent(record)) {
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const text = textContent(block.content);
        if (text) this.#emit({ type: "tool-output", id: block.tool_use_id, text });
        this.#emit({ type: "tool-end", id: block.tool_use_id, isError: block.is_error === true });
      }
      return;
    }
    if (record.type === "result") {
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
    }
  }

  #emit(event: AgentRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #isDisposed(): boolean {
    return this.#state === "disposed";
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
