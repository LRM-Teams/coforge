export const EVAL_ARMS = ["openviking"] as const;
export type EvalArm = (typeof EVAL_ARMS)[number];

/** One haystack turn as the dataset stores it: the human ("user") or the Task
 * Agent ("assistant") speaking. The assistant turns become the Task Agent's own
 * channel history, which is what single-session-assistant questions probe. */
export type LongMemEvalTurn = {
  role: "user" | "assistant";
  text: string;
};

export type LongMemEvalSession = {
  sessionIndex: number;
  sessionKey: string;
  occurredAt: Date;
  turns: LongMemEvalTurn[];
};

export type LongMemEvalQuestion = {
  sampleId: string;
  questionIndex: number;
  questionType: string;
  question: string;
  answer: string;
  questionDate: Date | null;
};

export type LongMemEvalSample = {
  sampleIndex: number;
  sampleId: string;
  sessions: LongMemEvalSession[];
  question: LongMemEvalQuestion;
};

export type Mechanism =
  | "ok"
  | "no_reply"
  | "no_offer"
  | "uncited_offer"
  | "leak"
  | "timeout"
  | "ingest_failed";

export type JudgeLabel = "CORRECT" | "WRONG" | "UNJUDGED";

export type EvalAttempt = {
  arm: EvalArm;
  sampleId: string;
  questionIndex: number;
  questionType: string;
  question: string;
  goldAnswer: string;
  /** The Task Agent's judged channel reply (its last message inside the settle window). */
  reply: string | null;
  offerMessageId: string | null;
  citationCount: number;
  /** Channel messages the Task Agent sent after the question (including the judged one). */
  taskMessageCount: number;
  /** Memory-Agent channel messages after the question that are not the offer itself. */
  memoryLeakMessageIds: string[];
  toolsUsed: string[];
  mechanism: Mechanism;
  headlineEligible: boolean;
  judge: JudgeLabel;
  judgeReason: string;
  elapsedMs: number;
};

export type QuestionTypeSummary = {
  questionType: string;
  attempts: number;
  headlineTotal: number;
  headlineCorrect: number;
};

export type ArmSummary = {
  arm: EvalArm;
  sampleId: string;
  workspaceId: string;
  ingestedSessions: number;
  attempts: number;
  headlineCorrect: number;
  headlineTotal: number;
  leaks: number;
  mechanismFails: number;
  byQuestionType: QuestionTypeSummary[];
};
