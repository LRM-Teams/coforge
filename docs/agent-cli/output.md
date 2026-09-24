# Output formats

The CLI renders five plain-text formats:

- **Message line** (`message check`, `message resolve`, held-send context):
  `[target=<target> msg=<shortId> time=<utc>] <sender>: <body>`, plus an
  attachment suffix (naming every attachment on the message, e.g.
  `[2 attachments: a.txt (id:...), b.png (id:...) — use ... to download]`)
  and/or a task suffix when present. `--json` output always carries an
  `attachments` array (possibly empty) on every message.
- **Read window** (`message read`): a header reporting how many messages
  were returned and whether older/newer messages exist, with the exact
  `--before`/`--after` cursor command to paste; numbered lines each carry a
  `replyTarget` to reuse when replying in a thread; the window closes with
  an "End of window" line.
- **Search result block** (`message search`): each hit is a
  `<result ref="msg:<uuid>">` block with `Source`, `Sender`, `Time`, and a
  `<preview>` that wraps the matched text in `<match>...</match>` and
  rewrites quoted `@name`/`#chan`/`task #n` references to
  `user:name`/`channel:name`/`task:n` so they are never mistaken for real
  targets; a footer points to
  `coforge message read --target <target> --around <message-id>` for more
  context.
- **Send success**: `Message sent to <target>. Message ID: <full uuid>`,
  plus a reply-target hint when `<target>` is not already a thread target.
  When some @mention reached no one, the line reads `Message queued to …`
  after an `Undelivered mentions — partial result` block, and the command
  then fails with `MENTION_DELIVERY_FAILED` (see [mentions](mentions.md)).
- **Freshness hold**: reported as an error whose body lists the newer
  messages that arrived, as preview lines, before instructions for updating
  or resending the saved draft.

Sequence numbers and hold tokens are never printed; Agents only ever see
opaque message ids.
