import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeEvent } from "#src/code-agent/contract";
import type { TurnInput, TurnRecord } from "./turn-process";

/** What the session asks a provider to launch: one turn's input, and the session id known so far
 * (`undefined` until a fresh session's first turn names it). */
export type TurnRequest = Readonly<{
  prompt: string;
  sessionId: string | undefined;
}>;

/** How one turn of a provider is started: the child's argv, and how the prompt reaches it. */
export type TurnCommand = Readonly<{
  argv: readonly string[];
  input: TurnInput;
}>;

/**
 * The session as one turn's reader sees it. Everything is synchronous, so the events a record
 * produces stay in the order the CLI printed it.
 */
export interface TurnScope {
  emit(event: AgentRuntimeEvent): void;
  /** The provider's own record named the session; the session adopts and reports it. */
  observeSessionId(sessionId: string): void;
}

/** Reads one turn's records. Its state (tool calls in flight, whether a result frame reported an
 * error) belongs to that turn alone, so a new turn gets a new reader. */
export interface TurnReader {
  read(record: TurnRecord): void;
  /** Whether the turn reported an error of its own, which fails it even after a clean exit. */
  readonly failed: boolean;
}

/**
 * What a per-turn provider supplies to `createPerTurnSession`: how to launch one turn and how to
 * read its records. The session owns everything else a turn has in common - the state machine,
 * the input queue, interrupt and dispose, the session identity and its reports, and how a turn's
 * exit becomes `completed`.
 */
export interface TurnProtocol {
  readonly provider: RuntimeProvider;
  /** How the provider is named in log lines and failure messages. */
  readonly displayName: string;
  /** What a fresh session's first turn must establish, for the failure message when it does not
   * ("Cursor did not establish a session identity"). */
  readonly identityNoun: string;
  /** Variables added on top of the Agent's environment for every turn. */
  readonly environment: Readonly<Record<string, string>>;
  launch(request: TurnRequest): TurnCommand;
  openTurn(scope: TurnScope): TurnReader;
}
