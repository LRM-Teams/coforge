import { m } from "@/paraglide/messages";

/** Why an upgrade request ended without a verified new Computer version. */
export type ComputerUpgradeFailure = {
  reason: "timeout" | "publication" | "evidence" | "reported";
  error?: string;
};

// Only "reported" carries the Computer's own account of what went wrong; the rest are what the
// server could infer from a Computer that never came back with the expected version.
const REASONS: Record<ComputerUpgradeFailure["reason"], () => string> = {
  reported: m.computer_upgrade_failed_reported,
  timeout: m.computer_upgrade_failed_timeout,
  publication: m.computer_upgrade_failed_publication,
  evidence: m.computer_upgrade_failed_evidence,
};

/**
 * One line a Workspace member can act on. Request IDs, stage lists, and timing stay in the logs
 * and in the machine's own result files; the failure text is already sanitized of local paths.
 */
export function describeComputerUpgradeFailure(failure: ComputerUpgradeFailure): string {
  const headline = (REASONS[failure.reason] ?? m.computer_upgrade_failed_unknown)();
  return failure.error ? `${headline}: ${failure.error}` : `${headline}.`;
}
