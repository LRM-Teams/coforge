import { RFC_UUID_PATTERN } from "@lrm/coforge-sdk/internal";

export const APP_INBOX_PREVIEW_MAX_CHARS = 120;

export type AppSourceRef = Readonly<{ kind: string; id: string; revision: string }>;
export type AppInboxAction = Readonly<{ kind: "run_command"; commandId: string }>;

export type AppInboxDefinition = Readonly<{
  retention: "until_explicit_ack";
  action: AppInboxAction;
  normalizeSourceRef(value: unknown): AppSourceRef;
  itemId(sourceRef: AppSourceRef): string;
}>;

const reminderDue: AppInboxDefinition = {
  retention: "until_explicit_ack",
  action: { kind: "run_command", commandId: "reminder.ack" },
  normalizeSourceRef(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("reminder sourceRef must be {kind,id,revision}");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => !["kind", "id", "revision"].includes(key)))
      throw new Error("reminder sourceRef contains unknown fields");
    if (input.kind !== "reminder") throw new Error("reminder sourceRef.kind must be reminder");
    if (typeof input.id !== "string" || !RFC_UUID_PATTERN.test(input.id))
      throw new Error("reminder sourceRef.id must be a UUID");
    if (typeof input.revision !== "string" || !/^[1-9][0-9]*$/.test(input.revision))
      throw new Error("reminder sourceRef.revision must be a positive integer string");
    return { kind: "reminder", id: input.id, revision: input.revision };
  },
  itemId(sourceRef) {
    return `reminder:${sourceRef.id}:${sourceRef.revision}`;
  },
};

export const AGENT_APP_REGISTRY: Readonly<
  Record<string, Readonly<Record<string, AppInboxDefinition>>>
> = {
  "system.reminder": { due: reminderDue },
};

export function appInboxDefinition(appId: string, notificationClass: string): AppInboxDefinition {
  const app = AGENT_APP_REGISTRY[appId];
  if (!app) throw new Error(`unknown App Inbox app: ${appId}`);
  const definition = app[notificationClass];
  if (!definition) throw new Error(`unknown App Inbox class: ${appId}/${notificationClass}`);
  return definition;
}
