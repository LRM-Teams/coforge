import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";

/** A profile-panel tab's centred one-line state (unavailable, empty, failed), with Retry when the
 * failure can be retried. */
export function PanelMessage({
  text,
  alert = false,
  onRetry,
}: {
  text: string;
  alert?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <p role={alert ? "alert" : undefined} className="text-sm text-tertiary">
        {text}
      </p>
      {onRetry && (
        <Button size="sm" color="secondary" onPress={onRetry}>
          {m.agent_workspace_retry()}
        </Button>
      )}
    </div>
  );
}
