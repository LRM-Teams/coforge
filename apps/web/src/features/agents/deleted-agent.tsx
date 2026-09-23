import { Badge } from "@/components/base/badges/badges";
import { m } from "@/paraglide/messages";

/**
 * The single place that renders a deleted Agent's identity treatment. A deleted Agent
 * keeps its history, so it can still appear in message rows, the thread root, the thread reply
 * preview and the DM header; all of those share this module so the grey avatar and the `DELETED`
 * badge cannot drift apart between surfaces.
 */

/**
 * The deleted avatar background. Deliberately its own token rather than `bg-offline`:
 * `docs/design-tokens.md` documents `--color-offline` as the presence/status *dot* colour, and a
 * deleted identity is not a presence state. The value matches the light/dark offline greys so the
 * rendering is unchanged, but the name says what it means.
 */
export const DELETED_AGENT_AVATAR_CLASS = "bg-avatar-deleted text-white";

/** The `DELETED` marker shown beside a deleted Agent's name. */
export function DeletedAgentBadge() {
  return (
    <Badge size="sm" color="gray" className="shrink-0 font-semibold tracking-wide">
      {m.agent_deleted_badge()}
    </Badge>
  );
}
