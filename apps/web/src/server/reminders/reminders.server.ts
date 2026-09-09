import {
  REMINDER_SYNC_MESSAGE_TYPE,
  decodeAgentReminderOperationRequest,
  encodeAgentReminderOperationRequest,
  encodeReminderFireResponse,
  encodeReminderSync,
  type AgentReminderOperationRequest,
  type AgentReminderOperationResponse,
  type ReminderFireRequest,
  type ReminderFireResponse,
  type ReminderJob,
  type ReminderSummaryRecord,
  type ReminderSync,
} from "@coforge/protocol";

export const MAX_ACTIVE_REMINDERS = 50;
export const MAX_REMINDER_LOG_EVENTS = 100;
export const DEFAULT_REMINDER_TIMEZONE = "Asia/Shanghai";

type Scope = {
  protocolMajor?: number;
  workspaceId: string;
  computerId: string;
  agentId: string;
  userId: string;
};
type DaemonScope = Omit<Scope, "userId">;
export type StoredReminder = ReminderSummaryRecord & { computerId: string };

export interface ReminderRepository {
  authorize(scope: Scope): Promise<boolean>;
  authorizeDaemon(scope: DaemonScope): Promise<{ userId: string } | undefined>;
  replay?(
    scope: Scope,
    requestId: string,
    fingerprint: string,
    reminderId?: string,
  ): Promise<StoredReminder | undefined>;
  resolveAnchor(
    scope: Scope,
    target: string,
    messageId: string,
  ): Promise<{ messageId: string; target: string }>;
  create(
    scope: Scope,
    requestId: string,
    fingerprint: string,
    input: Omit<StoredReminder, "reminderId" | "createdAt">,
  ): Promise<StoredReminder>;
  list(scope: Scope, status?: string, all?: boolean): Promise<StoredReminder[]>;
  get(scope: Scope, id: string): Promise<StoredReminder | undefined>;
  update(
    scope: Scope,
    requestId: string,
    fingerprint: string,
    id: string,
    request: AgentReminderOperationRequest,
    now: Date,
    eventType: "updated" | "snoozed" | "canceled",
  ): Promise<StoredReminder>;
  events(
    scope: Scope,
    id: string,
    limit: number,
  ): Promise<{ eventId: string; type: string; time: string; nextFireAt?: string }[]>;
  fire(
    scope: Scope,
    request: ReminderFireRequest,
    now: Date,
  ): Promise<{ result: ReminderFireResponse; nextReminder?: StoredReminder }>;
}

export interface ReminderCapabilityLease {
  supports(workspaceId: string, computerId: string): Promise<boolean>;
}

export type ReminderPublisher = (sync: ReminderSync) => Promise<void>;

function validTimezone(zone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
    return true;
  } catch {
    return false;
  }
}

const parts = (formatter: Intl.DateTimeFormat, instant: Date) =>
  Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value.toLowerCase()]),
  );

const localMinuteKey = (value: Record<string, string>) =>
  `${value.year}-${value.month}-${value.day}-${value.hour}-${value.minute}`;

/** First matching real instant means overlap chooses the first occurrence; gaps have no match. */
export function nextOccurrence(repeat: string, timezone: string, due: Date, now: Date): Date {
  const interval = /^every:(\d+)([mhd])$/.exec(repeat);
  if (interval) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[interval[2]!]!;
    const period = Number(interval[1]) * unit;
    return new Date(
      due.getTime() +
        Math.max(1, Math.floor((now.getTime() - due.getTime()) / period) + 1) * period,
    );
  }
  const daily = /^daily@(\d\d):(\d\d)$/.exec(repeat);
  const weekly = /^weekly:([a-z,]+)@(\d\d):(\d\d)$/.exec(repeat);
  const weekdays = weekly?.[1]!.split(",");
  const hour = daily?.[1] ?? weekly?.[2];
  const minute = daily?.[2] ?? weekly?.[3];
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (
    let time = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
    time <= now.getTime() + (weekly ? 15 : 9) * 86_400_000;
    time += 60_000
  ) {
    const local = parts(formatter, new Date(time));
    if (
      local.hour === hour &&
      local.minute === minute &&
      (!weekdays || weekdays.includes(local.weekday!))
    ) {
      const key = localMinuteKey(local);
      let duplicate = false;
      for (let earlier = time - 60_000; earlier >= time - 3 * 3_600_000; earlier -= 60_000)
        if (localMinuteKey(parts(formatter, new Date(earlier))) === key) {
          duplicate = true;
          break;
        }
      if (duplicate) continue;
      return new Date(time);
    }
  }
  throw new Error("No valid recurring occurrence found");
}

const job = (r: StoredReminder): ReminderJob => ({
  reminderId: r.reminderId,
  ownerAgentId: r.ownerAgentId,
  version: r.version,
  title: r.title,
  target: r.target,
  messageId: r.messageId,
  fireAt: r.fireAt,
});

const upsertSync = (
  scope: Pick<
    ReminderSync,
    "protocolMajor" | "requestId" | "workspaceId" | "computerId" | "agentId"
  >,
  reminder: StoredReminder,
): ReminderSync => ({
  protocolMajor: scope.protocolMajor,
  requestId: scope.requestId,
  workspaceId: scope.workspaceId,
  computerId: scope.computerId,
  agentId: scope.agentId,
  operation: "upsert",
  jobs: [job(reminder)],
  messageType: REMINDER_SYNC_MESSAGE_TYPE,
});

export class Reminders {
  constructor(
    private readonly repository: ReminderRepository,
    private readonly capabilities: ReminderCapabilityLease,
    private readonly publish: ReminderPublisher,
    private readonly now = () => new Date(),
  ) {}

  async execute(
    request: AgentReminderOperationRequest,
    userId: string,
  ): Promise<AgentReminderOperationResponse> {
    request = decodeAgentReminderOperationRequest(encodeAgentReminderOperationRequest(request));
    const scope = { ...request, userId };
    const fingerprint = JSON.stringify(request);
    if (!(await this.repository.authorize(scope)))
      throw new Error("reminder operation is not authorized");
    if (!["list", "log"].includes(request.operation)) {
      const replay = await this.repository.replay?.(
        scope,
        request.requestId,
        fingerprint,
        request.reminderId,
      );
      if (replay) return this.response(request, [replay]);
    }
    let reminders: StoredReminder[] = [];
    let events: AgentReminderOperationResponse["events"] = [];
    if (request.operation === "schedule") {
      if (!(await this.capabilities.supports(request.workspaceId, request.computerId)))
        throw new Error("connected Daemon does not support reminders");
      const anchor = await this.repository.resolveAnchor(
        scope,
        request.target!,
        request.messageId!,
      );
      const zone = request.repeat ? (request.timezone ?? DEFAULT_REMINDER_TIMEZONE) : undefined;
      if (zone && !validTimezone(zone)) throw new Error("invalid IANA timezone");
      const now = this.now();
      const first = request.fireAt
        ? new Date(request.fireAt)
        : request.delaySeconds
          ? new Date(now.getTime() + request.delaySeconds * 1000)
          : nextOccurrence(request.repeat!, zone!, now, now);
      if (first.getTime() <= now.getTime()) throw new Error("reminder time must be in the future");
      const created = await this.repository.create(scope, request.requestId, fingerprint, {
        ownerAgentId: request.agentId,
        computerId: request.computerId,
        version: 1,
        title: request.title!,
        ...anchor,
        fireAt: first.toISOString(),
        status: "scheduled",
        ...(request.repeat ? { repeat: request.repeat, timezone: zone } : {}),
      });
      reminders = [created];
      await this.bestEffort(upsertSync(request, created));
    } else if (request.operation === "list")
      reminders = await this.repository.list(scope, request.status, request.all);
    else if (request.operation === "log")
      events = await this.repository.events(scope, request.reminderId!, MAX_REMINDER_LOG_EVENTS);
    else {
      const current = await this.repository.get(scope, request.reminderId!);
      if (!current) throw new Error("reminder not found");
      if (request.operation === "cancel") {
        const changed = await this.repository.update(
          scope,
          request.requestId,
          fingerprint,
          current.reminderId,
          request,
          this.now(),
          "canceled",
        );
        reminders = [changed];
        await this.bestEffort({
          ...request,
          operation: "cancel",
          jobs: [],
          reminderId: changed.reminderId,
          version: changed.version,
          messageType: REMINDER_SYNC_MESSAGE_TYPE,
        });
      } else {
        const zone = request.timezone;
        if (zone && !validTimezone(zone)) throw new Error("invalid IANA timezone");
        const changed = await this.repository.update(
          scope,
          request.requestId,
          fingerprint,
          current.reminderId,
          request,
          this.now(),
          request.operation === "snooze" ? "snoozed" : "updated",
        );
        reminders = [changed];
        await this.bestEffort(upsertSync(request, changed));
      }
    }
    return {
      protocolMajor: 1,
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      computerId: request.computerId,
      agentId: request.agentId,
      accepted: true,
      reminders,
      events,
    };
  }

  private response(
    request: AgentReminderOperationRequest,
    reminders: StoredReminder[],
  ): AgentReminderOperationResponse {
    return {
      protocolMajor: 1,
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      computerId: request.computerId,
      agentId: request.agentId,
      accepted: true,
      reminders,
      events: [],
    };
  }

  async snapshot(scope: Scope & { requestId: string }): Promise<Uint8Array> {
    if (!(await this.repository.authorize(scope)))
      throw new Error("reminder snapshot is not authorized");
    const reminders = await this.repository.list(scope, "scheduled", true);
    return encodeReminderSync({
      protocolMajor: 1,
      ...scope,
      operation: "snapshot",
      jobs: reminders.slice(0, MAX_ACTIVE_REMINDERS).map(job),
      messageType: REMINDER_SYNC_MESSAGE_TYPE,
    });
  }

  async snapshotForDaemon(scope: DaemonScope & { requestId: string }): Promise<Uint8Array> {
    const agent = await this.repository.authorizeDaemon(scope);
    if (!agent) throw new Error("reminder snapshot is not authorized");
    return this.snapshot({ ...scope, userId: agent.userId });
  }

  async fire(request: ReminderFireRequest, userId: string): Promise<Uint8Array> {
    const scope = { ...request, userId };
    if (!(await this.repository.authorize(scope)))
      throw new Error("reminder fire is not authorized");
    const response = await this.repository.fire(scope, request, this.now());
    if (response.nextReminder) await this.bestEffort(upsertSync(request, response.nextReminder));
    return encodeReminderFireResponse(response.result);
  }

  async fireFromDaemon(request: ReminderFireRequest): Promise<Uint8Array> {
    const agent = await this.repository.authorizeDaemon(request);
    if (!agent) throw new Error("reminder fire is not authorized");
    return this.fire(request, agent.userId);
  }

  private async bestEffort(sync: ReminderSync) {
    try {
      await this.publish(sync);
    } catch {
      /* persisted state is recovered by snapshot */
    }
  }
}
