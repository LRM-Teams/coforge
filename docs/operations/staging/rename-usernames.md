# Renaming existing usernames

Accounts created before readable usernames carry names such as `andong3-d9956ab1`, `user-<32 hex>`,
or a digit-first `9527abc`. New accounts get a readable name from the allocator
(`apps/web/src/server/auth/username-allocation.server.ts`); this one-time script gives the existing
accounts the name the allocator would give them now. Run it once per environment, after the
release that carries readable usernames is deployed there.

The script is `apps/web/scripts/rename-usernames.ts` (rules and writes in
`apps/web/src/server/auth/username-rename*.server.ts`). It reads `DATABASE_URL` from the environment
and nothing else, and every mode starts by printing the database it will use (`database:
host:port/name`, never the credentials): read that line before you go on.

## What it decides

For each user, oldest account first:

- **Kept**: the username is already what the rules produce, and no live Agent of a Workspace the
  person belongs to has that name. The database has no `preferred_username`, the allocator's first
  source, so a username the sign-in did not build from the account's id counts as one: a readable
  name a person has is never replaced by their email's.
- **Renamed** otherwise, to the first source that yields a name: the current name (digit-first gets
  the prefix `u`, a long one is cut to 24 characters), the email's local part, the local part an
  id-suffixed name was built from (accounts that have no email stored yet), the full name, the
  display name, then `user`. A name that is reserved or has a run of 11 or more digits (it may be a
  phone number) is skipped. A taken name gets the smallest free `-N`, from `-2`.
- A new name is never one any account has now, so two people never get one name and the updates
  need no order. It is never the name of a live Agent of a Workspace the person belongs to either.

The plan's `source` column says which produced each name (`current-name`, `email`, `old-name`,
`full-name`, `display-name`, `fallback`).

## What it rewrites

A username is copied into other rows when they are written, and an Agent reads those copies back as
`@handle`. The script rewrites every copy of a renamed person's username in one transaction:

| Table.column | Rows |
| --- | --- |
| `users.username` | the renamed users |
| `message_mentions.handle` | `kind = 'user'` rows of that person (`actorId`) |
| `task_history_events.actorName` | `actorType = 'user'` rows with the old name |
| `task_history_events.payload` | a title change (`changes.title.from` and `.to`): each `@old` mention, but only in the Workspaces the person belongs to, and not where a live Agent has that name |
| `pending_mention_actions.targetHandle` | rows targeting that person |
| `reminders.target` | `@old` and `@old:<thread>` |

A title is free text, so `@old` there can mean an Agent of another Workspace; hence that scope. A
mention is what the mention grammar reads: `@old` not followed by a handle character, so `@old-x` and
`@older` are other people. A pending mention's strip orders its rows by where each
handle sits in the message text, which still has the old handle, so those rows (at most 7 days old)
fall back to the order they were stored in.

## What it leaves alone

- The personal Workspace's slug, a URL that keeps working, and its name, which was built from the
  person's name when they signed up.
- An `@handle` still written as text in a message body or a task description: the body is what the
  sender wrote. A mention that resolved is stored as a token and reads the current name.
- Records (`weekly_reports.title` may hold a username as a label; that module has its own owner)
  and Workspace-memory content already sent to OpenViking.

## The rules it checks

The apply checks these before it commits, and rolls back everything if one is broken.
`--verify` runs the first four on the whole database at any time (after the apply, `agent-name` means
an Agent was created since with a person's name, and a `stale-*` rule that something wrote a copy with
the old one). The last three need the old names, so only the apply, which has the plan, checks them.

| Rule | Broken when |
| --- | --- |
| `duplicate-username` | two users share a username |
| `agent-name` | a person's username is a live Agent's name in a Workspace they belong to |
| `stale-mention-handle` | a `message_mentions` row of a person differs from their username |
| `stale-pending-handle` | a `pending_mention_actions` row differs from its target's username |
| `stale-history-actor` | a history event of a person still names an old username |
| `stale-history-title` | a history title change still mentions an old username |
| `stale-reminder-target` | a reminder still points at an old username |

## Before you run it

- Take a database snapshot first: the dump is the way back for this script, a snapshot for the rest.
- Pick a quiet moment. A sign-in that takes a name the plan chose while it runs makes it stop on the
  collision, name it, and change nothing.
- Do not deploy between the apply and copying the dump out: it lives in the container's `/tmp`.

## Run it on staging

Staging's PostgreSQL has no public port, and the web container has `DATABASE_URL` in its environment
but only built output in `/app`. So the operator bundles the script, streams the one file into the
container, and runs it there with `bun`: the connection string never leaves the server. Commands
below run from your machine; `<host>` is the `deploy` login on the staging host, which runs
`deploy`'s rootless Docker (see [container logs](container-logs.md)), and on the host itself you drop
the `ssh <host>` part. The container is `coforge-staging-web-1`.

1. **Bundle** the script from a checkout of the deployed commit:

   ```bash
   bun install --frozen-lockfile
   bun run --cwd packages/coforge-sdk generate
   bun run --cwd apps/web db:generate
   bun build apps/web/scripts/rename-usernames.ts --target=bun --outfile /tmp/rename-usernames.js
   ```

   The result is one self-contained file (about 7 MB, Prisma's query compiler inlined): nothing
   ships beside it.

2. **Stream it in** (`/tmp` is writable by the container's user `bun`):

   ```bash
   ssh <host> "docker exec -i coforge-staging-web-1 sh -c 'cat > /tmp/rename-usernames.js'" < /tmp/rename-usernames.js
   ```

3. **Dry run**, which writes nothing:

   ```bash
   ssh <host> docker exec coforge-staging-web-1 bun /tmp/rename-usernames.js
   ```

   It prints one line per rename, `userId  old → new  (source)`, then how many users and rows would
   change. Read it. A name that looks wrong comes from the account's own data (email, full name or
   display name): fix the data or leave that account for later, then run the dry run again.

4. **Apply**, with a dump file that does not exist yet:

   ```bash
   ssh <host> docker exec coforge-staging-web-1 bun /tmp/rename-usernames.js --apply --dump /tmp/username-rename-dump.json
   ```

   Inside one transaction it plans, writes the dump (mode `0600`, never overwriting a file), renames,
   and checks the rules above. Nothing is written when there is nothing to rename, and a second run
   after a successful one plans nothing.

5. **Copy the dump out, check it, and keep it**, then verify:

   ```bash
   (umask 077; ssh <host> docker exec coforge-staging-web-1 cat /tmp/username-rename-dump.json > username-rename-dump.json)
   test -s username-rename-dump.json && bun -e 'const d = JSON.parse(await Bun.file("username-rename-dump.json").text()); if (d.format !== "coforge-username-rename-dump/1" || !Array.isArray(d.renames)) process.exit(1)' && echo dump ok
   ssh <host> docker exec coforge-staging-web-1 bun /tmp/rename-usernames.js --verify
   ```

   Do not go on to step 6 until the second command printed `dump ok`: the local copy must be
   non-empty and read as a dump. `--verify` prints `no violations` and exits 0, or one line per
   broken rule and exits 1.

6. **Clean up** once the local dump is checked:

   ```bash
   ssh <host> docker exec coforge-staging-web-1 rm -f /tmp/rename-usernames.js /tmp/username-rename-dump.json
   ```

The dump holds the old value of every row the rename changed, with the keys to find them (`users`,
`messageMentions`, `taskHistoryEvents`, `taskHistoryPayloads`, `pendingMentionActions`, `reminders`)
and the `renames` list; it carries no email or other profile data. Anywhere else, run
`bun run scripts/rename-usernames.ts [--apply --dump <file> | --verify | --restore <file>]` from
`apps/web` of a checkout with `DATABASE_URL` in the environment.

## If an apply fails

The apply is one transaction, so a failure changes nothing, and the first line of the message says
which rule or name stopped it (a `stale-*` or `agent-name` rule, or a name a new account took while
it ran). If it had already written the dump, the script moves it to `<name>.failed.json` and says
so on the next line (or says why it could not): that file
describes a rename that never happened, so it is not a way back and a restore refuses it. Delete it
or keep it as a record. Fix the cause, then run the apply again with a new `--dump` file name; a
file that already exists is never overwritten.

## Going back

Step 6 deleted the bundle and a deploy replaces the container, so first rebuild the bundle from the
same or a later commit (step 1) and stream it in (step 2). Then stream the dump in and restore:

```bash
ssh <host> "docker exec -i coforge-staging-web-1 sh -c 'cat > /tmp/username-rename-dump.json'" < username-rename-dump.json
ssh <host> docker exec coforge-staging-web-1 bun /tmp/rename-usernames.js --restore /tmp/username-rename-dump.json
```

This runs the dump's `renames` the other way in one transaction, so a mention, history actor or
reminder written since the rename under a new name goes back with its person. The title payloads
the dump lists are written back by id; no other title is touched, so one written since the rename
keeps its `@new`, which in free text may mean an Agent. It only restores a rename that is still in
place: every user in the dump must still hold the name the rename gave them, and no other account
may hold an old one. Otherwise it changes nothing and says, for each user, what does not match (a
user that no longer exists, an account called something else now, an old name another account
took). A taken name needs that account dealt with first. The dump's `rows` hold the old values by
primary key for a manual update if it cannot be used.

## After the rename

- Sessions and API keys are keyed by user id and keep working. A browser session also carries the
  username it was signed in with, for up to 14 days (`SESSION_TTL_SECONDS` in
  `browser-login.server.ts`), and two reads use that copy: the conversation opened around one
  message (`loadConversationAround`) marks the person's own mentions and reactions by the old name,
  and a message they just sent shows the old handle until reloaded. Signing in again corrects both;
  reading the username from the database instead of the session would remove them.
- A running Computer may hold the old target of a reminder it was sent, until it takes its next
  snapshot from the cloud (a restart or reconnect); the database already has the new one.
- An Agent's own notes may still say the old `@handle`; it reads the new one from every mention.
  Send results kept in Redis for a replayed request (24 hours) may show the old handle too.
