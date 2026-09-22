# Complete OpenViking access uses a policy gateway

**Status: accepted for prototype.** CoForge will integrate OpenViking's complete backend capability through a private runtime and a policy-enforcing gateway rather than exposing long-lived OpenViking credentials to browsers or Agents. The gateway preserves OpenViking's runtime interface while applying CoForge authentication, Workspace and actor mapping, and operation-specific authorization.

The gateway is deny-by-default. It classifies allowed method and path combinations, strips client-supplied identity and account headers, chooses the server-owned mapped OpenViking identity, and forwards only to the configured private runtime. Root, cross-account, identity-management, and administration operations require explicit typed CoForge control-plane modules and cannot pass through the generic data-plane route merely because OpenViking exposes them.

## Considered options

- Hand-write a CoForge wrapper for every OpenViking endpoint: rejected because it would duplicate a large evolving interface and prevent complete capability parity.
- Publish OpenViking directly and give clients account keys: rejected because credentials, Workspace authority, and revocation would escape the CoForge control plane.
- Transparently proxy every OpenViking route without classification: rejected because ordinary callers could reach root or administration operations and could smuggle identity headers.

## Consequences

Profile lifecycle, account and user provisioning, ACL mapping, Managed Causal Projection, delegated credentials, and destructive administration use typed modules. Authorized resource, filesystem, memory, skill, session, retrieval, task, watch, pack, snapshot, observer, and related data-plane calls use the policy gateway when a route policy exists. Unsupported or newly introduced OpenViking routes remain denied until classified.

Workspace authority maps to distinct OpenViking identities: Owners and Admins control Workspace-level configuration and shared resources, Members retain authorized shared access and their own user namespace, ordinary Agents receive explicit grants, the Memory Agent is read-only over Workspace-shared content and the Managed Causal Projection, and the projection worker can mutate only that projection. Operational access does not imply default permission to read Workspace content.
