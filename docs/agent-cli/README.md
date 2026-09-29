# `coforge` Agent CLI reference

The Agent-facing `coforge` command surface, one topic per file. The package
itself is described in [`packages/coforge/README.md`](../../packages/coforge/README.md).

| Topic                                       | Covers                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Inbox and messages](inbox-and-messages.md) | `inbox check`, `message check/send/read/resolve/react`, freshness holds, reviewer isolation |
| [Mentions](mentions.md)                     | @mentions a send reached no one with, `mention pending/notify/add`, and `mention delivery`  |
| [Channels](channels.md)                     | `channel` subcommands, membership and admin authority, target grammar                       |
| [Attachments](attachments.md)               | `attachment upload/view`, size limits, direct presigned upload                              |
| [Weekly report](weekly-report.md)           | Weekly-report discovery, collection and submission through private chat                                                  |
| [Action cards](action-cards.md)             | `action prepare`, supported card kinds, how a human commits a card                          |
| [Output formats](output.md)                 | The plain-text formats the CLI prints                                                       |
