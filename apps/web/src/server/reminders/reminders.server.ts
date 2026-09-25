import {
  parseReminderRecurrence,
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
} from "@lrm/coforge-sdk/internal";

export const MAX_ACTIVE_REMINDERS = 50;
export const MAX_REMINDER_LOG_EVENTS = 100;
export const DEFAULT_REMINDER_TIMEZONE = "Asia/Shanghai";

/** Why the reminder domain refused a command, named once so both callers can report it. */
export type ReminderRefusalCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "ACCESS_DENIED"
  | "CONFLICT"
  | "TEMPORARILY_UNAVAILABLE";

/**
 * A refusal the domain can name. The WebSocket path has always put the message in `reason`; the
 * HTTP route flattened every refusal into one `400 invalid reminder request`, so a caller could not
 * tell "not authorized" from "the connected Daemon is not capable" — and neither could the Daemon's
 * own error log, which records the API's `code` field and nothing else. One named refusal, which
 * both paths carry: the HTTP route answers with the `code`, the RPC path keeps the message.
 */
export class ReminderRefusal extends Error {
  constructor(
    readonly code: ReminderRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "ReminderRefusal";
  }
}

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

/** The local fields a recurrence match reads. The minute-by-minute scan reads them thousands of
 * times per call, so they are collected in one pass over `formatToParts` with no intermediate parts
 * array, filtered array, mapped array or lookup object per iteration. */
type LocalMinute = {
  weekday: string;
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
};

const localMinute = (formatter: Intl.DateTimeFormat, instant: Date): LocalMinute => {
  const local: LocalMinute = { weekday: "", year: "", month: "", day: "", hour: "", minute: "" };
  for (const part of formatter.formatToParts(instant)) {
    const value = part.value.toLowerCase();
    if (part.type === "weekday") local.weekday = value;
    else if (part.type === "year") local.year = value;
    else if (part.type === "month") local.month = value;
    else if (part.type === "day") local.day = value;
    else if (part.type === "hour") local.hour = value;
    else if (part.type === "minute") local.minute = value;
  }
  return local;
};

const localMinuteKey = (value: LocalMinute) =>
  `${value.year}-${value.month}-${value.day}-${value.hour}-${value.minute}`;

/** The scan's per-minute test: does this instant's local wall clock match the recurrence's fixed
 * hour, minute and (for a weekly recurrence) weekday? `probe` asks `formatToParts` for only those
 * fields — the date fields the key needs are read with the full formatter on the rare minute that
 * matches — so each of the horizon's thousands of probes formats fewer parts. */
const matchesLocalMinute = (
  probe: Intl.DateTimeFormat,
  instant: Date,
  hour: string | undefined,
  minute: string | undefined,
  weekdays: readonly string[] | undefined,
): boolean => {
  let hourMatches = false;
  let minuteMatches = false;
  let weekdayMatches = weekdays === undefined;
  for (const part of probe.formatToParts(instant)) {
    if (part.type === "hour") hourMatches = hour !== undefined && part.value === hour;
    else if (part.type === "minute") minuteMatches = minute !== undefined && part.value === minute;
    else if (part.type === "weekday" && weekdays)
      weekdayMatches = weekdays.includes(part.value.toLowerCase());
  }
  return hourMatches && minuteMatches && weekdayMatches;
};

/** First matching real instant means overlap chooses the first occurrence; gaps have no match. */
export function nextOccurrence(repeat: string, timezone: string, due: Date, now: Date): Date {
  const recurrence = parseReminderRecurrence(repeat);
  if (recurrence?.kind === "every") {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[recurrence.unit];
    const period = recurrence.count * unit;
    return new Date(
      due.getTime() +
        Math.max(1, Math.floor((now.getTime() - due.getTime()) / period) + 1) * period,
    );
  }
  const hour =
    recurrence?.kind === "daily" || recurrence?.kind === "weekly"
      ? String(recurrence.hour).padStart(2, "0")
      : undefined;
  const minute =
    recurrence?.kind === "daily" || recurrence?.kind === "weekly"
      ? String(recurrence.minute).padStart(2, "0")
      : undefined;
  const weekdays = recurrence?.kind === "weekly" ? recurrence.weekdays : undefined;
  // The scan walks a multi-day horizon a minute at a time, so its probe asks for the three fields
  // the test reads and nothing else; the full formatter runs on a matching minute only.
  const probe = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    ...(weekdays ? { weekday: "short" as const } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
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
    time <= now.getTime() + (recurrence?.kind === "weekly" ? 15 : 9) * 86_400_000;
    time += 60_000
  ) {
    if (!matchesLocalMinute(probe, new Date(time), hour, minute, weekdays)) continue;
    const local = localMinute(formatter, new Date(time));
    const key = localMinuteKey(local);
    let duplicate = false;
    for (let earlier = time - 60_000; earlier >= time - 3 * 3_600_000; earlier -= 60_000)
      if (localMinuteKey(localMinute(formatter, new Date(earlier))) === key) {
        duplicate = true;
        break;
      }
    if (duplicate) continue;
    return new Date(time);
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
      throw new ReminderRefusal("ACCESS_DENIED", "reminder operation is not authorized");
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
        throw new ReminderRefusal(
          "TEMPORARILY_UNAVAILABLE",
          "connected Daemon does not support reminders",
        );
      const anchor = await this.repository.resolveAnchor(
        scope,
        request.target!,
        request.messageId!,
      );
      const zone = request.repeat ? (request.timezone ?? DEFAULT_REMINDER_TIMEZONE) : undefined;
      if (zone && !validTimezone(zone))
        throw new ReminderRefusal("INVALID_INPUT", "invalid IANA timezone");
      const now = this.now();
      const first = request.fireAt
        ? new Date(request.fireAt)
        : request.delaySeconds
          ? new Date(now.getTime() + request.delaySeconds * 1000)
          : nextOccurrence(request.repeat!, zone!, now, now);
      if (first.getTime() <= now.getTime())
        throw new ReminderRefusal("INVALID_INPUT", "reminder time must be in the future");
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
      if (!current) throw new ReminderRefusal("NOT_FOUND", "reminder not found");
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
        if (zone && !validTimezone(zone))
          throw new ReminderRefusal("INVALID_INPUT", "invalid IANA timezone");
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
      throw new ReminderRefusal("ACCESS_DENIED", "reminder snapshot is not authorized");
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
    if (!agent) throw new ReminderRefusal("ACCESS_DENIED", "reminder snapshot is not authorized");
    return this.snapshot({ ...scope, userId: agent.userId });
  }

  async fire(request: ReminderFireRequest, userId: string): Promise<Uint8Array> {
    const scope = { ...request, userId };
    if (!(await this.repository.authorize(scope)))
      throw new ReminderRefusal("ACCESS_DENIED", "reminder fire is not authorized");
    const response = await this.repository.fire(scope, request, this.now());
    if (response.nextReminder) await this.bestEffort(upsertSync(request, response.nextReminder));
    return encodeReminderFireResponse(response.result);
  }

  async fireFromDaemon(request: ReminderFireRequest): Promise<Uint8Array> {
    const agent = await this.repository.authorizeDaemon(request);
    if (!agent) throw new ReminderRefusal("ACCESS_DENIED", "reminder fire is not authorized");
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
