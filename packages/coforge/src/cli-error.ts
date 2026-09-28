/**
 * A typed failure the Agent CLI can render consistently: a short message plus the diagnostics an
 * Agent needs to decide whether to retry, wait, or ask a person — never a bare, single-line
 * string. Built from the local daemon proxy's JSON error contract (see
 * `packages/daemon/src/agent-proxy-failure.ts`) or from a local precondition the CLI itself
 * detected before ever reaching the daemon.
 */
export type CliErrorOutputMode = "text" | "json";

export type CliErrorProxyDiagnostics = {
  failureClass?: string;
  causeCode?: string;
  routeFamily?: string;
  upstreamLayer?: string;
  upstreamStatus?: number;
  responseStarted?: boolean;
  responseComplete?: boolean;
};

export type CliErrorInit = {
  code: string;
  message: string;
  retryable?: boolean;
  effect?: string;
  /** Only meaningful for `message send`: was the local draft saved before the request failed? */
  draftSaved?: boolean;
  correlationId?: string;
  proxy?: CliErrorProxyDiagnostics;
  suggestedNextAction?: string;
  /** Rich context to print before the fixed-line footer in text mode (e.g. held-message context). */
  contextText?: string;
  /** Text mode only: what the command did achieve, printed to stdout before the error goes to
   * stderr (a send that queued its message but not every @mention). */
  stdoutText?: string;
  /** Extra structured data carried only in `--json` mode, alongside the fixed error fields. */
  details?: unknown;
  outputMode?: CliErrorOutputMode;
};

export class CliError extends Error {
  readonly code: string;
  readonly retryable?: boolean;
  readonly effect?: string;
  readonly draftSaved?: boolean;
  readonly correlationId?: string;
  readonly proxy?: CliErrorProxyDiagnostics;
  readonly suggestedNextAction?: string;
  readonly contextText?: string;
  readonly stdoutText?: string;
  readonly details?: unknown;
  readonly outputMode: CliErrorOutputMode;

  constructor(init: CliErrorInit) {
    super(init.message);
    this.name = "CliError";
    this.code = init.code;
    this.retryable = init.retryable;
    this.effect = init.effect;
    this.draftSaved = init.draftSaved;
    this.correlationId = init.correlationId;
    this.proxy = init.proxy;
    this.suggestedNextAction = init.suggestedNextAction;
    this.contextText = init.contextText;
    this.stdoutText = init.stdoutText;
    this.details = init.details;
    this.outputMode = init.outputMode ?? "text";
  }
}

/** Returns a copy of `error` carrying a different `outputMode`; `CliError` fields are immutable. */
export function withOutputMode(error: CliError, outputMode: CliErrorOutputMode): CliError {
  return new CliError({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    effect: error.effect,
    draftSaved: error.draftSaved,
    correlationId: error.correlationId,
    proxy: error.proxy,
    suggestedNextAction: error.suggestedNextAction,
    contextText: error.contextText,
    details: error.details,
    outputMode,
  });
}

function yesNoUnknown(value: boolean | undefined): string {
  return value === undefined ? "unknown" : value ? "yes" : "no";
}

/** Fixed stderr lines, in order; a line is omitted only when its field is undefined. */
export function renderCliErrorText(error: CliError): string {
  const lines: string[] = [];
  if (error.contextText) lines.push(error.contextText, "");
  lines.push(`Error: ${error.message}`);
  lines.push(`Code: ${error.code}`);
  lines.push(`Retryable: ${yesNoUnknown(error.retryable)}`);
  if (error.effect !== undefined) lines.push(`Effect: ${error.effect}`);
  if (error.correlationId !== undefined) lines.push(`Correlation: ${error.correlationId}`);
  if (error.proxy?.failureClass !== undefined)
    lines.push(`Proxy failure class: ${error.proxy.failureClass}`);
  if (error.proxy?.causeCode !== undefined)
    lines.push(`Proxy cause code: ${error.proxy.causeCode}`);
  if (error.proxy?.routeFamily !== undefined)
    lines.push(`Proxy route family: ${error.proxy.routeFamily}`);
  if (error.proxy?.upstreamLayer !== undefined)
    lines.push(`Proxy upstream layer: ${error.proxy.upstreamLayer}`);
  if (error.proxy?.upstreamStatus !== undefined)
    lines.push(`Proxy upstream status: ${error.proxy.upstreamStatus}`);
  if (error.proxy?.responseStarted !== undefined)
    lines.push(`Proxy response started: ${yesNoUnknown(error.proxy.responseStarted)}`);
  if (error.proxy?.responseComplete !== undefined)
    lines.push(`Proxy response complete: ${yesNoUnknown(error.proxy.responseComplete)}`);
  if (error.draftSaved !== undefined) lines.push(`Draft saved: ${error.draftSaved ? "yes" : "no"}`);
  if (error.suggestedNextAction !== undefined)
    lines.push(`Next action: ${error.suggestedNextAction}`);
  return lines.join("\n");
}

export function renderCliErrorJson(error: CliError): string {
  const proxy = error.proxy
    ? {
        ...(error.proxy.failureClass !== undefined
          ? { failure_class: error.proxy.failureClass }
          : {}),
        ...(error.proxy.causeCode !== undefined ? { cause_code: error.proxy.causeCode } : {}),
        ...(error.proxy.routeFamily !== undefined ? { route_family: error.proxy.routeFamily } : {}),
        ...(error.proxy.upstreamLayer !== undefined
          ? { upstream_layer: error.proxy.upstreamLayer }
          : {}),
        ...(error.proxy.upstreamStatus !== undefined
          ? { upstream_status: error.proxy.upstreamStatus }
          : {}),
        ...(error.proxy.responseStarted !== undefined
          ? { response_started: error.proxy.responseStarted }
          : {}),
        ...(error.proxy.responseComplete !== undefined
          ? { response_complete: error.proxy.responseComplete }
          : {}),
      }
    : undefined;
  return JSON.stringify({
    error: {
      message: error.message,
      code: error.code,
      retryable: error.retryable ?? null,
      ...(error.effect !== undefined ? { effect: error.effect } : {}),
      ...(error.draftSaved !== undefined ? { draft_saved: error.draftSaved } : {}),
      ...(error.correlationId !== undefined ? { correlation_id: error.correlationId } : {}),
      ...(proxy ? { proxy } : {}),
      ...(error.suggestedNextAction !== undefined
        ? { next_action: error.suggestedNextAction }
        : {}),
    },
    ...(error.details !== undefined ? { details: error.details } : {}),
  });
}

export function renderCliError(error: CliError): string {
  return error.outputMode === "json" ? renderCliErrorJson(error) : renderCliErrorText(error);
}

/**
 * Raft-aligned guidance for a send failure raised AFTER the request was handed to the transport:
 * delivery state is unknown, and neither reading nor the absence of a message settles it. Do not
 * resend on this evidence alone.
 */
export function unknownDeliveryNextAction(target: string): string {
  return (
    "Delivery state is UNKNOWN: the send failed after the draft was saved, so the message may or " +
    "may not have been committed. Reading cannot settle this: `coforge message read --target " +
    `${JSON.stringify(target)}\` can only show that a matching message exists, which is not proof ` +
    "that YOUR send committed. Not seeing it proves nothing either, because delivery to readable " +
    "lags. Do not resend on this evidence. Wait, or ask a person. Sending the draft again with " +
    `\`coforge message send --send-draft --target ${JSON.stringify(target)}\` is a decision by a ` +
    "person to accept a possible duplicate, not a finding that the original failed."
  );
}

/** Guidance for a failure raised BEFORE any request was issued; nothing to undo or wait on. */
export const NO_MESSAGE_SENT_NEXT_ACTION =
  "No message was sent; fix the problem above, then run the command again.";

/** Raft-aligned guidance for `coforge manual get|search` when the topic or query did not match:
 * retry narrower, or browse the generated catalog via the `index` topic. */
export const MANUAL_NOT_FOUND_NEXT_ACTION =
  "Retry with a close topic id or different keywords. Browse topics: coforge manual get index";
