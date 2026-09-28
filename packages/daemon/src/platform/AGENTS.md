# platform instructions

Rules for OS primitives in `src/platform/`. They extend
`packages/daemon/AGENTS.md`.

- This directory holds OS-specific details only. Expose them through
  interfaces such as the process-tree seam; do not leak platform APIs upward.
- `operating-system.ts` is the single OS release observation, shared by
  Computer registration and Daemon ready reporting. On macOS, report the
  product version, not the kernel version.

## Logging

- `daemon-log-file.ts` prepares owner-only log paths and rejects symlinks. It
  must not wrap LogTape configuration or loggers.

## Processes

- `launchd-job.ts` owns launchd user-job registration and native observations.
- `launchd-process.ts` runs external Agent stdio and cleanup in a separate
  launchd job behind the process-tree interface. Its internal runner is
  embedded in Computer, never another installed product.
- `windows-job-object.ts` owns Win32 Job Object create/assign/terminate and
  ActiveProcesses queries. On Windows, `process-tree.ts` places external Agent
  children in a Job Object and waits for an empty job before allowing a
  replacement launch. When the Job Object APIs cannot be loaded, it fails
  closed.

## Locks

- `process-lock.ts` is the reusable SQLite-backed process lock primitive. The
  Supervisor lifetime lock uses it only for foreground exclusion and safe
  recovery of owned children; Computer uses it separately for its
  full-operation machine mutation lock. Do not reuse one lock for the other.
- Lock files are permanent local-filesystem inodes with no tables or business
  data. Never replace or unlink them.
