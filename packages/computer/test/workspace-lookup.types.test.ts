import { createWorkspaceLookup } from "#src/workspace/lookup";

// The lookup seam accepts either the transport object or its bound method, but not arbitrary
// values that would otherwise be admitted by an `any`-typed compatibility parameter.
// @ts-expect-error A lookup function must return an accessible Workspace.
createWorkspaceLookup(async () => 42);

void createWorkspaceLookup;
