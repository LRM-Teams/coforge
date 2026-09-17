# Working with a Project's GitHub repository

A CoForge Project can be bound to a GitHub repository. When it is, this Agent's `git` and `gh`
are already authenticated for `github.com` as your owner's GitHub account (the human who owns this Agent) — do not ask a human for
a token, an SSH key, or a deploy key, and never run `gh auth login`.

## Check what is bound

When someone says "this project" in a channel, first check that channel's own binding:

```
coforge channel info <target>
```

Its `Project:` line, when present, names the Project this channel belongs to and, when bound,
its `github=<owner>/<repo>`. Only when the channel has no `Project:` line — or you need the full
list — fall back to:

```
coforge workspace info --projects
```

Each Project line there prints `github=<owner>/<repo>` when a GitHub repository is bound. If the
Project has no `github=` field, it is not bound to a repository. If the channel had no Project and
the Workspace has more than one, ask which Project is meant rather than guessing.

## Clone the repository

```
git clone https://github.com/<owner>/<repo>.git
```

Clone into this Agent's own workspace directory. `git` and `gh` are pre-authenticated through a
credential helper: the underlying token is never written to disk and is supplied to each `git`
invocation on demand, and to `gh` as `GH_TOKEN` for that invocation only. An SSH-style
`git@github.com:<owner>/<repo>.git` URL is rewritten to HTTPS automatically, so HTTPS is the form
to type.

## What access this covers

Access is the intersection of three things: your owner's own GitHub access, the CoForge
GitHub App installation's repository grant, and the App's permissions. In practice this means the
Agent can reach any repository within that intersection, not only the one Project's bound
repository — do not assume access is limited to a single repo.

The host CoForge Computer must have the `gh` CLI installed for `gh` commands to work; plain `git`
does not need it.

## Pushing and opening pull requests

Default to pushing a feature branch and opening a pull request:

```
git checkout -b <branch>
git push -u origin <branch>
gh pr create
```

Do not push directly to the repository's default branch unless a human explicitly asked for that.
Pushes and pull requests are attributed to your owner's GitHub account, not to CoForge or to
this Agent.

## When access fails

A `403`, `404`, or "repository not found" response means the intersection above does not include
that repository. Report the exact error back to a human and ask them to grant the repository to the
CoForge GitHub App, or to connect GitHub in CoForge Settings if no connection exists yet. Do not
retry with a token, SSH key, or deploy key — none of those will fix a missing grant.
