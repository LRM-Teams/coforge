import { utf8Decoder } from "@lrm/coforge-sdk/internal";
import { z } from "zod";

/**
 * The Workspace was deleted. Published on its `chat:workspace:<workspace_id>` channel
 * (`workspaceConversationChannel`), which every open page of the Workspace holds, so each of them
 * leaves it for `/`. Like the other signals it carries only the id.
 */
export type WorkspaceDeletedEvent = { type: "workspace.deleted.v1"; workspaceId: string };

const workspaceDeletedEvent = z.object({
  type: z.literal("workspace.deleted.v1"),
  workspaceId: z.string().min(1),
});

/** The event, or undefined for any other publication on the channel (most are messages). */
export function decodeWorkspaceDeletedEvent(value: unknown): WorkspaceDeletedEvent | undefined {
  let data = value;
  if (value instanceof Uint8Array) {
    try {
      data = JSON.parse(utf8Decoder.decode(value)) as unknown;
    } catch {
      return undefined;
    }
  }
  // The channel carries every message signal: anything else leaves before the full parse.
  if (!data || typeof data !== "object" || Reflect.get(data, "type") !== "workspace.deleted.v1")
    return undefined;
  const parsed = workspaceDeletedEvent.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}
