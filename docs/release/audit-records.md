# Audit records

Keep both the platform's deployment or publication record and the durable
release record defined in [Release identity and evidence](evidence.md) for every staging release, production promotion,
failed attempt, and rollback. Record the human approver and exact approved
artifact identity for production, the previous and resulting identities,
verification evidence, rollback trigger and result, and the final observed
state. An interrupted release is a recorded outcome, not a missing entry. The
records must reveal the selected and next rollback identities without relying
on an Agent's private memory, and must never contain secrets. Local records also
preserve the previous and resulting version strings, the manifest's per-platform
SHA-256 checksums, authenticated storage read-back evidence, and the unsigned
private-origin guard result. Independently run CDN acceptance evidence may be
linked, but is not required for routine publication or rollback.
