export class WorkspaceMemoryScopeError extends Error {
  constructor() {
    super("cross-workspace memory reference is rejected");
    this.name = "WorkspaceMemoryScopeError";
  }
}

export class WorkspaceMemoryReplayConflictError extends Error {
  constructor(readonly operationId: string) {
    super(`workspace memory operation ${operationId} drifted`);
    this.name = "WorkspaceMemoryReplayConflictError";
  }
}

export class WorkspaceMemoryCitationKindError extends Error {
  constructor() {
    super("memory citation kind does not match a typed workspace record");
    this.name = "WorkspaceMemoryCitationKindError";
  }
}

export class WorkspaceMemoryBindingError extends Error {
  constructor() {
    super("OpenViking binding is invalid");
    this.name = "WorkspaceMemoryBindingError";
  }
}

export function isUniqueConstraintError(error: unknown): boolean {
  return isPrismaCode(error, "P2002");
}

export function isIntegrityConstraintError(error: unknown): boolean {
  return (
    isPrismaCode(error, "P2003") || isPrismaCode(error, "P2010") || isPrismaCode(error, "P2011")
  );
}

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}
