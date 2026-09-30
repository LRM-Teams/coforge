import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeEvent } from "#src/code-agent/contract";
import type { TurnInput, TurnRecord, TurnResult } from "./turn-process";

/** What the session asks a provider to launch: one turn's input, and the session id known so far
 * (`undefined` until a fresh session's first turn names it). */
export type TurnRequest = Readonly<{
  prompt: string;
  sessionId: string | undefined;
  /** The provider chose `sessionId` (`mintSessionId`) and no turn has created it yet, so this turn
   * must create it rather than resume it. */
  creating: boolean;
}>;

/** How one turn of a provider is started: the child's argv, and how the prompt reaches it. */
export type TurnCommand = Readonly<{
  argv: readonly string[];
  input: TurnInput;
}>;

/** How a turn ended, as the session tells its reader. */
export type TurnExit = TurnResult & Readonly<{ interrupted: boolean }>;

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
  /** Asked once the process has exited: whether this turn resumed a session the provider no longer
   * has. The session then starts over under a new id and runs the turn's input there; the
   * discarded turn is not reported as a turn of its own. */
  lostResume?(exit: TurnExit): boolean;
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
  /** Set for a provider with no system-prompt channel: a fresh session's first turn carries only
   * the standing instructions and must name the session, which `identityNoun` words for the failure
   * message when it does not ("Cursor did not establish a session identity"). Unset: `launch` sends
   * the instructions itself on every turn, and a fresh session spawns nothing until real input
   * arrives. */
  readonly instructionsTurn?: Readonly<{ identityNoun: string }>;
  /** The state a session resumed from a given id starts in. `unknown` for a provider whose resume
   * can find the session gone. */
  readonly resumedIdentity: "resumable" | "unknown";
  /** What a record that repeats the session id the session already has means. `ignore`: nothing.
   * `reaffirm-and-report`: the identity state is derived again, as if the id were new, and the id
   * is reported again. A record that names a different id is always adopted and reported. */
  readonly repeatedSessionId: "ignore" | "reaffirm-and-report";
  /** When the session tells the daemon its id (`onSessionId`). `every-completion`: when a record
   * names it and every time a turn completes. `once-per-id`: once per id, and again after a report
   * the daemon rejected. */
  readonly identityReports: "every-completion" | "once-per-id";
  /** Variables added on top of the Agent's environment for every turn. */
  readonly environment: Readonly<Record<string, string>>;
  /** Set for a provider whose session ids are chosen here rather than reported by the CLI: the
   * session has an id from the start, and a `sessionMode` of `create` pins the id it is given. */
  mintSessionId?(): string;
  launch(request: TurnRequest): TurnCommand;
  openTurn(scope: TurnScope, request: TurnRequest): TurnReader;
}
