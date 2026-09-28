export const EVAL_ARMS = ["openviking"] as const;
export type EvalArm = (typeof EVAL_ARMS)[number];

export type TaskFile = {
  /** Path relative to the file group's root (skill dir / environment / tests). */
  relPath: string;
  absPath: string;
};

export type TaskSkill = {
  name: string;
  files: TaskFile[];
};

export type SkillsBenchTask = {
  name: string;
  dir: string;
  /** instruction.md verbatim; the /root/ rewrite happens at post/stage time. */
  instruction: string;
  skills: TaskSkill[];
  /** environment/* excluding skills/, Dockerfile, .DS_Store. */
  envFiles: TaskFile[];
  /** tests/** — pytest files (test_*.py) plus helpers. */
  testFiles: TaskFile[];
};

export type Verification = {
  verified: boolean;
  passed: boolean;
  testScore: number | null;
  output: string;
  error: string | null;
};

export type Mechanism =
  | "ok"
  | "no_reply"
  | "no_offer"
  | "uncited_offer"
  | "leak"
  | "timeout";

export type EvalAttempt = {
  arm: EvalArm;
  taskName: string;
  instructionExcerpt: string;
  reply: string | null;
  offerMessageId: string | null;
  citationCount: number;
  taskMessageCount: number;
  memoryLeakMessageIds: string[];
  toolsUsed: string[];
  mechanism: Mechanism;
  headlineEligible: boolean;
  verification: Verification;
  elapsedMs: number;
};

export type ArmSummary = {
  arm: EvalArm;
  tasks: string[];
  executed: number;
  passed: number;
  passRate: number;
  scoreSum: number;
  leaks: number;
  mechanismFails: number;
};
