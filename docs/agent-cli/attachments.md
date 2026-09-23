# Attachments

`coforge attachment upload --path <file> --target <target> [--mime-type <type>]`
uploads a local file and prints its attachment id for
`coforge message send --attachment-id <id>`. `--target` uses the same
`#channel`/`@user` grammar as `message send`; the Agent must already belong to
that conversation. `--channel <target>` is accepted as a legacy alias for
`--target` (Raft's transition alias); passing both is a usage error even when
they agree. Local checks run in this order, matching Raft 1.0.32: `--path`
presence, existence, regular-file, non-empty (all `INVALID_ARG`), then
`--target`/`--channel` presence (`MISSING_CHANNEL`), then `--mime-type`
well-formedness (`INVALID_ARG`) — the first failing check wins. Without
`--mime-type`, the type is inferred from the file extension (falling back to
`application/octet-stream`). Before uploading, the CLI checks the file
against the server's advertised size limit; a capabilities lookup that 404s
is treated as "no limit advertised" and skips this client-side check (the
server still enforces its own limit), any other capabilities failure is
`UPLOAD_CAPABILITY_FAILED`, and a file over an advertised limit is rejected
locally with `ATTACHMENT_TOO_LARGE`, never partially uploaded. On success it
prints:

```
File uploaded: <fileName> (<sizeKB>KB)
Attachment ID: <id>

Use this ID with coforge message send --attachment-id <id> to include it in a message.
```

`--json` prints the raw response object instead. Download an attachment's
bytes with `coforge attachment view <id> --output <path>` (or `--id <id>`,
not both — `INVALID_ARG` either way if the id or `--output` is missing).
On success it prints `Downloaded to: <path>` (matching Raft 1.0.32's
`formatAttachmentDownloaded`); `--json` prints `{ attachmentId, path }`
instead. A download failure is `VIEW_FAILED` (`SERVER_5XX` for ≥ 500), with
a fixed `Attachment is unavailable.` message on a 404 rather than relaying
upstream detail. An Agent may download its own upload before sending it,
but not another Agent's not-yet-sent upload.

**Direct (presigned) upload.** `attachment upload`'s command line and success output
above never change; above a server-advertised size threshold (and only when the active storage
backend supports it — Alibaba Cloud OSS does, local dev storage does not), the CLI instead PUTs
the file straight to storage using a short-lived presigned URL, mirroring Raft 1.0.32's own direct
upload: create an upload session, PUT the bytes (one retry on a network error or `408`/`429`/`5xx`
response), then complete the session (retried up to 3× on `UPLOAD_OBJECT_NOT_FOUND` or
`UPLOAD_VERIFICATION_IN_PROGRESS`). One deviation from Raft: this repo's storage has no
`If-None-Match` precondition, so "the object already exists" is Alibaba Cloud OSS's own
`x-oss-forbid-overwrite` conflict status, `409`, not Raft's `412`. Below the threshold, or when
direct upload is unavailable, the existing multipart path above runs unchanged.
