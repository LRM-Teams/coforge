import { getLogger } from "@logtape/logtape";
import type {
  ReminderFireRequest,
  ReminderFireResponse,
  ReminderJob,
  ReminderSync,
} from "@coforge/protocol";
import { APP_INBOX_PREVIEW_MAX_CHARS } from "../agent-app-inbox/registry";

const logger = getLogger(["coforge", "daemon", "reminder"]);
const MAX_TIMER_MS = 24 * 60 * 60_000;
const RETRY_BUDGET_MS = 15 * 60_000;
const MAX_ATTEMPTS = 8;

/** Projects canonical reminder text into the strict, bounded App Inbox preview. */
export function reminderAppInboxPreview(title: string): string {
  const withoutControls = [...title]
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
    })
    .join("");
  const singleLine = withoutControls.replace(/\s+/g, " ").trim();
  let preview = singleLine.slice(0, APP_INBOX_PREVIEW_MAX_CHARS);
  const lastCodeUnit = preview.charCodeAt(preview.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) preview = preview.slice(0, -1);
  return preview;
}

export type ReminderReceipt = {
  workspaceId: string;
  computerId: string;
  agentId: string;
  reminderId: string;
  version: number;
  job: ReminderJob;
  requestId: string;
  firedAtClient: string;
  attempt: number;
  deadline: number;
  nextAt: number;
  serverResult?: ReminderFireResponse["result"];
  serverFired?: boolean;
  serverCatchup?: boolean;
  wakeAccepted: boolean;
  consumed: boolean;
  terminal: boolean;
};

export interface ReminderReceiptStore {
  read(agentId: string): Promise<ReminderReceipt[]>;
  write(agentId: string, receipts: readonly ReminderReceipt[]): Promise<void>;
}

export interface ReminderClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
}

const defaultClock: ReminderClock = {
  now: Date.now,
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  cancel(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

/** Authenticated authoritative reminder mirror and durable fire state machine. */
export class ReminderScheduler {
  readonly #jobs = new Map<string, Map<string, ReminderJob>>();
  readonly #scheduleTimers = new Map<string, unknown>();
  readonly #receiptTimers = new Map<string, unknown>();
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #receipts = new Map<string, ReminderReceipt>();
  readonly #inFlight = new Set<string>();
  readonly #effects = new Set<Promise<void>>();
  readonly #authorized = new Set<string>();
  readonly #versions = new Map<string, number>();
  readonly #tombstones = new Set<string>();
  readonly #changedAfterSnapshot = new Set<string>();
  readonly #persistenceFailures = new Map<string, number>();
  #generation = 0;
  #running = true;

  constructor(
    private readonly scope: { workspaceId: string; computerId: string },
    private readonly store: ReminderReceiptStore,
    private readonly fire: (request: ReminderFireRequest) => Promise<ReminderFireResponse>,
    private readonly wake: (job: ReminderJob) => Promise<boolean>,
    private readonly clock: ReminderClock = defaultClock,
  ) {}

  apply(sync: ReminderSync): Promise<void> {
    return this.#serial(sync.agentId, async () => {
      if (!this.#running) throw new Error("reminder scheduler is stopped");
      this.#assertScope(sync);
      if (sync.operation === "snapshot") {
        this.#authorized.add(sync.agentId);
        this.#clearScheduleTimers(sync.agentId);
        const previous = this.#jobs.get(sync.agentId) ?? new Map();
        const jobs = new Map<string, ReminderJob>();
        for (const job of sync.jobs) {
          const key = this.#versionKey(sync.agentId, job.reminderId);
          const fence = this.#versions.get(key) ?? -1;
          if (job.version >= fence && !(job.version === fence && this.#tombstones.has(key))) {
            this.#versions.set(key, job.version);
            this.#changedAfterSnapshot.delete(key);
            jobs.set(job.reminderId, job);
          }
        }
        for (const old of previous.values()) {
          const key = this.#versionKey(sync.agentId, old.reminderId);
          if (this.#changedAfterSnapshot.has(key) && !jobs.has(old.reminderId))
            jobs.set(old.reminderId, old);
        }
        this.#jobs.set(sync.agentId, jobs);
        this.#armSchedules(sync.agentId);
        await this.#restore(sync.agentId);
        return;
      }
      if (!this.#authorized.has(sync.agentId)) return;
      const jobs = this.#jobs.get(sync.agentId) ?? new Map();
      const reminderId = sync.operation === "upsert" ? sync.jobs[0]!.reminderId : sync.reminderId!;
      const version = sync.operation === "upsert" ? sync.jobs[0]!.version : sync.version!;
      const key = this.#versionKey(sync.agentId, reminderId);
      const fence = this.#versions.get(key) ?? -1;
      if (version < fence || (version === fence && this.#tombstones.has(key))) return;
      this.#versions.set(key, version);
      this.#changedAfterSnapshot.add(key);
      if (sync.operation === "cancel") this.#tombstones.add(key);
      else this.#tombstones.delete(key);
      this.#cancelSchedule(sync.agentId, reminderId);
      if (sync.operation === "upsert") jobs.set(reminderId, sync.jobs[0]!);
      else jobs.delete(reminderId);
      this.#jobs.set(sync.agentId, jobs);
      if (sync.operation === "upsert") this.#armSchedule(sync.jobs[0]!);
    });
  }

  acknowledge(agentId: string, reminderId: string, version: number): Promise<boolean> {
    return this.#serial(agentId, async () => {
      const receipts = await this.store.read(agentId);
      const receipt = receipts.find((r) => r.reminderId === reminderId && r.version === version);
      if (!receipt || receipt.serverResult !== "accepted" || !receipt.serverFired) return false;
      receipt.consumed = true;
      receipt.terminal = true;
      await this.store.write(agentId, receipts);
      this.#receipts.set(this.#receiptKey(agentId, reminderId, version), receipt);
      this.#cancelReceipt(agentId, reminderId, version);
      return true;
    });
  }

  /** Waits until all currently-started transitions and external effects have settled. */
  async awaitIdle(): Promise<void> {
    for (;;) {
      const work = [...this.#queues.values(), ...this.#effects];
      if (work.length === 0) return;
      await Promise.all(work.map((item) => item.catch(() => {})));
      if ([...this.#queues.values(), ...this.#effects].every((item) => work.includes(item))) return;
    }
  }

  stop(): void {
    this.#running = false;
    this.#generation++;
    for (const timer of [...this.#scheduleTimers.values(), ...this.#receiptTimers.values()])
      this.clock.cancel(timer);
    this.#scheduleTimers.clear();
    this.#receiptTimers.clear();
    this.#jobs.clear();
    this.#authorized.clear();
  }

  async #restore(agentId: string): Promise<void> {
    let receipts: ReminderReceipt[];
    try {
      receipts = await this.store.read(agentId);
    } catch (error) {
      logger.error("Reminder receipt restore failed", { error, agent_id: agentId });
      return;
    }
    for (const receipt of receipts) {
      if (
        receipt.workspaceId !== this.scope.workspaceId ||
        receipt.computerId !== this.scope.computerId ||
        receipt.agentId !== agentId
      ) {
        logger.error("Reminder receipt restore rejected for another daemon", { agent_id: agentId });
        continue;
      }
      const key = this.#receiptKey(agentId, receipt.reminderId, receipt.version);
      this.#receipts.set(key, receipt);
      if (!receipt.consumed && !receipt.terminal) this.#armReceipt(receipt, receipt.nextAt);
    }
  }

  #armSchedules(agentId: string): void {
    for (const job of this.#jobs.get(agentId)?.values() ?? []) this.#armSchedule(job);
  }

  #armSchedule(job: ReminderJob): void {
    if (!this.#running) return;
    const key = this.#scheduleKey(job.ownerAgentId, job.reminderId);
    const due = Date.parse(job.fireAt);
    const timer = this.clock.schedule(
      () => {
        if (this.#scheduleTimers.get(key) !== timer) return;
        this.#scheduleTimers.delete(key);
        if (!this.#running) return;
        const current = this.#jobs.get(job.ownerAgentId)?.get(job.reminderId);
        if (current?.version !== job.version) return;
        if (this.clock.now() < due) return this.#armSchedule(current);
        this.#track(this.#serial(job.ownerAgentId, () => this.#prepareDue(job)));
      },
      Math.min(Math.max(0, due - this.clock.now()), MAX_TIMER_MS),
    );
    this.#cancelTimer(this.#scheduleTimers, key);
    this.#scheduleTimers.set(key, timer);
  }

  async #prepareDue(job: ReminderJob): Promise<void> {
    if (
      !this.#running ||
      this.#jobs.get(job.ownerAgentId)?.get(job.reminderId)?.version !== job.version
    )
      return;
    const key = this.#receiptKey(job.ownerAgentId, job.reminderId, job.version);
    let receipt = this.#receipts.get(key);
    if (!receipt) {
      try {
        receipt = (await this.store.read(job.ownerAgentId)).find(
          (r) => r.reminderId === job.reminderId && r.version === job.version,
        );
      } catch (error) {
        logger.error("Reminder receipt read failed", { error, agent_id: job.ownerAgentId });
      }
    }
    if (!receipt) {
      const now = this.clock.now();
      receipt = {
        ...this.scope,
        agentId: job.ownerAgentId,
        reminderId: job.reminderId,
        version: job.version,
        job: structuredClone(job),
        requestId: crypto.randomUUID(),
        firedAtClient: new Date(now).toISOString(),
        attempt: 0,
        deadline: now + RETRY_BUDGET_MS,
        nextAt: now,
        wakeAccepted: false,
        consumed: false,
        terminal: false,
      };
    }
    this.#receipts.set(key, receipt);
    await this.#persistOrRetry(receipt, true);
  }

  async #persistOrRetry(
    receipt: ReminderReceipt,
    proceed: boolean | "retry",
    afterFailure: boolean | "retry" = proceed,
  ): Promise<boolean> {
    const key = this.#receiptKey(receipt.agentId, receipt.reminderId, receipt.version);
    try {
      const current = await this.#saveMerged(receipt);
      this.#receipts.set(key, current);
      this.#persistenceFailures.delete(key);
      if (proceed === true && !current.consumed && !current.terminal) this.#startEffect(current);
      else if (proceed === "retry" && !current.consumed && !current.terminal) this.#retry(current);
      return !current.consumed && !current.terminal;
    } catch (error) {
      const failures = (this.#persistenceFailures.get(key) ?? 0) + 1;
      this.#persistenceFailures.set(key, failures);
      logger.error("Reminder receipt persistence failed", { error, agent_id: receipt.agentId });
      if (!this.#running || failures >= MAX_ATTEMPTS || this.clock.now() >= receipt.deadline)
        return false;
      receipt.nextAt = Math.min(receipt.deadline, this.clock.now() + this.#backoff(failures));
      this.#armReceipt(receipt, receipt.nextAt, false, afterFailure);
      return false;
    }
  }

  #startEffect(receipt: ReminderReceipt): void {
    const key = this.#receiptKey(receipt.agentId, receipt.reminderId, receipt.version);
    if (!this.#running || this.#inFlight.has(key)) return;
    if (receipt.attempt >= MAX_ATTEMPTS || this.clock.now() >= receipt.deadline) {
      receipt.terminal = true;
      this.#track(this.#serial(receipt.agentId, () => this.#persistOrRetry(receipt, false)));
      return;
    }
    receipt.attempt++;
    this.#inFlight.add(key);
    const generation = this.#generation;
    let readyToWake = false;
    this.#track(
      this.#serial(receipt.agentId, async () => {
        const current = this.#receipts.get(key);
        return current ? this.#persistOrRetry(current, false, true) : false;
      })
        .then(async (persisted) => {
          if (!persisted) return;
          if (!this.#running || generation !== this.#generation) return;
          const current = this.#receipts.get(key);
          if (!current || current.consumed || current.terminal) return;
          if (current.serverResult === "accepted" && current.serverFired)
            await this.#runWake(key, current, generation);
          else readyToWake = await this.#runFire(key, current, generation);
        })
        .finally(() => {
          this.#inFlight.delete(key);
          const current = this.#receipts.get(key);
          if (
            readyToWake &&
            this.#running &&
            current?.serverResult === "accepted" &&
            current.serverFired &&
            !current.consumed &&
            !current.terminal
          )
            this.#startEffect(current);
        }),
    );
  }

  async #runFire(key: string, receipt: ReminderReceipt, generation: number): Promise<boolean> {
    let response: ReminderFireResponse | undefined;
    try {
      response = await this.fire({
        protocolMajor: 1,
        requestId: receipt.requestId,
        workspaceId: receipt.workspaceId,
        computerId: receipt.computerId,
        agentId: receipt.agentId,
        reminderId: receipt.reminderId,
        version: receipt.version,
        firedAtClient: receipt.firedAtClient,
      });
      this.#correlate(receipt, response);
    } catch (error) {
      logger.error("Reminder fire failed", { error, agent_id: receipt.agentId });
    }
    return this.#serial(receipt.agentId, async () => {
      if (!this.#running || generation !== this.#generation) return false;
      const current = await this.#fresh(key, receipt.agentId);
      if (!current || current.consumed || current.terminal) return false;
      if (!response) {
        this.#retry(current);
        return false;
      }
      current.serverResult = response.result;
      current.serverFired = response.fired;
      current.serverCatchup = response.catchup;
      if (response.result === "accepted" && response.fired)
        return this.#persistOrRetry(current, false, true);
      else if (response.result === "premature") {
        const retryAt = this.clock.now() + (response.retryAfterMs ?? 0);
        if (retryAt > current.deadline) {
          if (await this.#deleteReceipt(current)) this.#armServerRetry(current.job, retryAt);
        } else {
          current.nextAt = retryAt;
          await this.#persistOrRetry(current, false);
          this.#armReceipt(current, current.nextAt);
        }
      } else {
        current.terminal = true;
        await this.#persistOrRetry(current, false);
      }
      return false;
    });
  }

  async #runWake(key: string, receipt: ReminderReceipt, generation: number): Promise<void> {
    let accepted = false;
    try {
      accepted = await this.wake(receipt.job);
    } catch (error) {
      logger.error("Reminder wake failed", { error, agent_id: receipt.agentId });
    }
    await this.#serial(receipt.agentId, async () => {
      if (!this.#running || generation !== this.#generation) return;
      const current = await this.#fresh(key, receipt.agentId);
      if (!current || current.consumed || current.terminal) return;
      current.wakeAccepted = accepted;
      if (accepted) current.terminal = true;
      await this.#persistOrRetry(current, accepted ? false : "retry");
    });
  }

  #retry(receipt: ReminderReceipt): void {
    if (receipt.attempt >= MAX_ATTEMPTS || this.clock.now() >= receipt.deadline) {
      receipt.terminal = true;
      this.#track(this.#serial(receipt.agentId, () => this.#persistOrRetry(receipt, false)));
      return;
    }
    receipt.nextAt = Math.min(receipt.deadline, this.clock.now() + this.#backoff(receipt.attempt));
    this.#armReceipt(receipt, receipt.nextAt);
  }

  #armReceipt(
    receipt: ReminderReceipt,
    at = receipt.nextAt,
    proceed = true,
    afterPersistence: boolean | "retry" = true,
  ): void {
    if (!this.#running || receipt.consumed || receipt.terminal) return;
    const key = this.#receiptKey(receipt.agentId, receipt.reminderId, receipt.version);
    const nextAt = Math.min(receipt.deadline, at);
    receipt.nextAt = nextAt;
    const timer = this.clock.schedule(
      () => {
        if (this.#receiptTimers.get(key) !== timer) return;
        this.#receiptTimers.delete(key);
        if (!this.#running) return;
        if (this.clock.now() < receipt.nextAt)
          return this.#armReceipt(receipt, receipt.nextAt, proceed, afterPersistence);
        this.#track(
          this.#serial(receipt.agentId, async () => {
            const current = proceed
              ? await this.#fresh(key, receipt.agentId)
              : this.#receipts.get(key);
            if (!current || current.consumed || current.terminal) return;
            if (proceed) this.#startEffect(current);
            else await this.#persistOrRetry(current, afterPersistence);
          }),
        );
      },
      Math.min(Math.max(0, nextAt - this.clock.now()), MAX_TIMER_MS),
    );
    this.#cancelTimer(this.#receiptTimers, key);
    this.#receiptTimers.set(key, timer);
  }

  async #fresh(key: string, agentId: string): Promise<ReminderReceipt | undefined> {
    try {
      const disk = (await this.store.read(agentId)).find(
        (r) => this.#receiptKey(agentId, r.reminderId, r.version) === key,
      );
      if (disk) this.#receipts.set(key, disk);
    } catch (error) {
      logger.error("Reminder receipt read failed", { error, agent_id: agentId });
    }
    return this.#receipts.get(key);
  }

  async #saveMerged(receipt: ReminderReceipt): Promise<ReminderReceipt> {
    const receipts = await this.store.read(receipt.agentId);
    const index = receipts.findIndex(
      (r) => r.reminderId === receipt.reminderId && r.version === receipt.version,
    );
    const existing = index < 0 ? undefined : receipts[index];
    const merged = structuredClone(receipt);
    if (existing?.consumed) {
      merged.consumed = true;
      merged.terminal = true;
    }
    if (index < 0) receipts.push(merged);
    else receipts[index] = merged;
    await this.store.write(receipt.agentId, receipts);
    return merged;
  }

  async #deleteReceipt(receipt: ReminderReceipt): Promise<boolean> {
    const key = this.#receiptKey(receipt.agentId, receipt.reminderId, receipt.version);
    try {
      const receipts = (await this.store.read(receipt.agentId)).filter(
        (item) => item.reminderId !== receipt.reminderId || item.version !== receipt.version,
      );
      await this.store.write(receipt.agentId, receipts);
      this.#receipts.delete(key);
      return true;
    } catch (error) {
      logger.error("Premature reminder receipt deletion failed", {
        error,
        agent_id: receipt.agentId,
      });
      return false;
    }
  }

  #armServerRetry(job: ReminderJob, retryAt: number): void {
    const key = this.#scheduleKey(job.ownerAgentId, job.reminderId);
    const timer = this.clock.schedule(
      () => {
        if (this.#scheduleTimers.get(key) !== timer) return;
        this.#scheduleTimers.delete(key);
        if (!this.#running) return;
        const current = this.#jobs.get(job.ownerAgentId)?.get(job.reminderId);
        if (current?.version !== job.version) return;
        this.#track(this.#serial(job.ownerAgentId, () => this.#prepareDue(current)));
      },
      Math.min(Math.max(0, retryAt - this.clock.now()), MAX_TIMER_MS),
    );
    this.#cancelTimer(this.#scheduleTimers, key);
    this.#scheduleTimers.set(key, timer);
  }

  #backoff(attempt: number) {
    return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
  }
  #correlate(receipt: ReminderReceipt, response: ReminderFireResponse): void {
    for (const field of [
      "requestId",
      "workspaceId",
      "computerId",
      "agentId",
      "reminderId",
    ] as const)
      if (response[field] !== receipt[field])
        throw new Error("uncorrelated reminder fire response");
    if (response.protocolMajor !== 1 || response.version !== receipt.version)
      throw new Error("uncorrelated reminder fire response");
  }
  #assertScope(sync: ReminderSync): void {
    if (
      sync.protocolMajor !== 1 ||
      sync.workspaceId !== this.scope.workspaceId ||
      sync.computerId !== this.scope.computerId ||
      sync.jobs.some((j) => j.ownerAgentId !== sync.agentId)
    )
      throw new Error("reminder sync targets another daemon");
  }
  #clearScheduleTimers(agentId: string): void {
    for (const [key, timer] of this.#scheduleTimers)
      if (key.startsWith(`${agentId}:`)) {
        this.clock.cancel(timer);
        this.#scheduleTimers.delete(key);
      }
  }
  #cancelSchedule(agentId: string, reminderId: string) {
    this.#cancelTimer(this.#scheduleTimers, this.#scheduleKey(agentId, reminderId));
  }
  #cancelReceipt(agentId: string, reminderId: string, version: number) {
    this.#cancelTimer(this.#receiptTimers, this.#receiptKey(agentId, reminderId, version));
  }
  #cancelTimer(map: Map<string, unknown>, key: string): void {
    if (map.has(key)) this.clock.cancel(map.get(key));
    map.delete(key);
  }
  #scheduleKey(agentId: string, reminderId: string) {
    return `${agentId}:${reminderId}`;
  }
  #receiptKey(agentId: string, reminderId: string, version: number) {
    return `${agentId}:${reminderId}:${version}`;
  }
  #versionKey(agentId: string, reminderId: string) {
    return `${agentId}:${reminderId}`;
  }
  #serial<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.#queues.get(agentId) ?? Promise.resolve()).then(operation, operation);
    const settled = next.catch(() => {});
    this.#queues.set(agentId, settled);
    void settled.finally(() => {
      if (this.#queues.get(agentId) === settled) this.#queues.delete(agentId);
    });
    return next;
  }
  #track(effect: Promise<unknown>): void {
    const tracked = effect.then(
      () => {},
      (error) => {
        logger.error("Reminder async operation failed", { error });
      },
    );
    this.#effects.add(tracked);
    void tracked.finally(() => this.#effects.delete(tracked));
  }
}
