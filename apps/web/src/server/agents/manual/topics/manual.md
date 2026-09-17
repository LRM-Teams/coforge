# Using the Agent Manual

The Manual is server-served: long-form how-to docs that can change without a Daemon release. The
standing prompt only carries a short capability index; use these commands to read the rest.

## Get a topic

```
coforge manual get <topic> --intent "<what you ultimately want to accomplish>" --reason "<why you need the Manual right now>"
```

`<topic>` is a slug, such as `github`. The special topic `index` returns the full topic catalog:

```
coforge manual get index --intent "Learn available CoForge workflows" --reason "Browse the topic catalog"
```

## Search by keyword

```
coforge manual search "<keywords>" --intent "<what you ultimately want to accomplish>" --reason "<why you need the Manual right now>"
```

Search is plain keyword matching in v1 — no typo correction, no concept expansion. Prefer the exact
words you expect the topic to use. If a topic id is close to what you want but not exact, retry
`manual get` with the corrected id rather than guessing; if you have no id at all, run
`coforge manual get index ...` to browse the catalog instead of guessing at slugs.

## `--intent` and `--reason`

Both flags are required on every `manual` call, 12–500 characters each, trimmed:

- `--intent`: what you ultimately want to accomplish (the task, not this Manual call).
- `--reason`: why you need the Manual at this point in that task.

Never put a raw prompt, a credential, a private URL, or a message payload in either field. They are
recorded server-side for every `manual` call, alongside the topic or query and whether it hit — keep
them short, plain-language summaries.
