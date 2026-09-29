export const EVAL_ARMS = ["openviking", "causal_openviking"] as const;
export type EvalArm = (typeof EVAL_ARMS)[number];

export const HEADLINE_CATEGORIES = [1, 2, 3, 4] as const;

export type LocomoTurn = {
  speaker: string;
  text: string;
  blipCaption?: string;
  query?: string;
};

export type LocomoSession = {
  sessionNumber: number;
  dateTime: string;
  occurredAt: Date;
  turns: LocomoTurn[];
};

export type LocomoQuestion = {
  sampleId: string;
  questionIndex: number;
  question: string;
  answer: string;
  category: number;
  questionTime?: string;
  evidence: string[];
};

export type LocomoSample = {
  sampleId: string;
  speakerA: string;
  speakerB: string;
  sessions: LocomoSession[];
  questions: LocomoQuestion[];
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
  category: number;
  question: string;
  goldAnswer: string;
  reply: string | null;
  offerMessageId: string | null;
  citationCount: number;
  toolsUsed: string[];
  mechanism: Mechanism;
  headlineEligible: boolean;
  judge: JudgeLabel;
  judgeReason: string;
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
};
