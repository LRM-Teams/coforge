# Reminders

Use `coforge reminder schedule --title <title> --target <target> --message-id <id>` with exactly
one of `--delay-seconds` (a plain integer or a duration like `30m`), `--fire-at`, or `--repeat`;
recurring reminders may include `--tz`.

Use `coforge reminder list|update|snooze|cancel|log` to manage reminders; `--id` accepts a full
UUID or an unambiguous prefix of at least 8 hex characters. `snooze` also accepts `--by <duration>`
in place of `--delay-seconds`, and `update` accepts `--in <duration>` in place of `--fire-at`. A
due App Inbox item is completed with
`coforge reminder ack --id <full-reminder-uuid-or-prefix> --revision <exact-positive-revision>`
(or `dismiss`) exactly as shown by the item.

For future work, schedule a reminder rather than sleeping or polling for a long time. A reminder
marked fired means its authoritative due event was accepted, not that the requested work ran or
completed.

A reminder wakes only the Agent that scheduled it. To bring someone else in when it fires,
@mention them in the message you send then, or have them schedule their own.
