import {
  APP_INBOX_PREVIEW_MAX_CHARS,
  appInboxDefinition,
  type AppInboxAction,
  type AppSourceRef,
} from "./registry";
import { AgentAppInboxPersistence } from "../persistence/agent-app-inbox-store";

export type AgentAppItem = Readonly<{
  itemId: string;
  appId: string;
  notificationClass: string;
  sourceRef: AppSourceRef;
  title?: string;
  summary?: string;
  retention: "until_explicit_ack";
  action: AppInboxAction;
  createdAt: string;
}>;

export type MintAppItem = Readonly<{
  appId: string;
  notificationClass: string;
  sourceRef: unknown;
  title?: string;
  summary?: string;
}>;

/** Agent-scoped typed App Inbox. Chat fields and executable actions are not part of its interface. */
export class AgentAppInbox {
  readonly #items = new Map<string, AgentAppItem>();

  private constructor(private readonly persistence: AgentAppInboxPersistence) {}

  static async open(stateDirectory: string, workspaceId: string, agentId: string) {
    const inbox = new AgentAppInbox(
      new AgentAppInboxPersistence(stateDirectory, workspaceId, agentId),
    );
    for (const raw of (await inbox.persistence.read()) ?? []) {
      const item = restoreItem(raw);
      if (inbox.#items.has(item.itemId))
        throw new Error("App Inbox persisted identity is duplicated");
      inbox.#items.set(item.itemId, item);
    }
    return inbox;
  }

  list(): AgentAppItem[] {
    return [...this.#items.values()].sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.itemId.localeCompare(right.itemId),
    );
  }

  async upsert(input: MintAppItem): Promise<AgentAppItem> {
    const definition = appInboxDefinition(input.appId, input.notificationClass);
    const sourceRef = definition.normalizeSourceRef(input.sourceRef);
    const itemId = definition.itemId(sourceRef);
    const previous = this.#items.get(itemId);
    const title = boundedSingleLine(input.title, "title");
    const summary = boundedSingleLine(input.summary, "summary");
    const item: AgentAppItem = Object.freeze({
      itemId,
      appId: input.appId,
      notificationClass: input.notificationClass,
      sourceRef,
      ...(title === undefined ? {} : { title }),
      ...(summary === undefined ? {} : { summary }),
      retention: definition.retention,
      action: definition.action,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
    });
    this.#items.set(itemId, item);
    try {
      await this.persistence.write(this.list());
    } catch (error) {
      if (previous) this.#items.set(itemId, previous);
      else this.#items.delete(itemId);
      throw error;
    }
    return item;
  }
}

function boundedSingleLine(value: unknown, field: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    typeof value !== "string" ||
    value.length > APP_INBOX_PREVIEW_MAX_CHARS ||
    [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  )
    throw new Error(`App Inbox ${field} must be bounded single-line text`);
  return value;
}

function restoreItem(raw: unknown): AgentAppItem {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("App Inbox persisted item is corrupt");
  const value = raw as Record<string, unknown>;
  const allowed = new Set([
    "itemId",
    "appId",
    "notificationClass",
    "sourceRef",
    "title",
    "summary",
    "retention",
    "action",
    "createdAt",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("App Inbox persisted item is corrupt");
  if (typeof value.appId !== "string" || typeof value.notificationClass !== "string")
    throw new Error("App Inbox persisted item is corrupt");
  const definition = appInboxDefinition(value.appId, value.notificationClass);
  const sourceRef = definition.normalizeSourceRef(value.sourceRef);
  if (
    value.itemId !== definition.itemId(sourceRef) ||
    value.retention !== definition.retention ||
    !value.action ||
    typeof value.action !== "object" ||
    Array.isArray(value.action) ||
    Object.keys(value.action).some((key) => !["kind", "commandId"].includes(key)) ||
    JSON.stringify(value.action) !== JSON.stringify(definition.action) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    throw new Error("App Inbox persisted item is corrupt");
  const title = boundedSingleLine(value.title, "title");
  const summary = boundedSingleLine(value.summary, "summary");
  return Object.freeze({
    itemId: value.itemId,
    appId: value.appId,
    notificationClass: value.notificationClass,
    sourceRef,
    ...(title === undefined ? {} : { title }),
    ...(summary === undefined ? {} : { summary }),
    retention: definition.retention,
    action: definition.action,
    createdAt: value.createdAt,
  });
}
