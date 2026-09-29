# Weekly report

`coforge weekly-report context|list|read` is the weekly-report assistant's
authorized on-demand read surface. It reuses the Credential Proxy and Agent
HTTPS API. Context is a compact page manifest, list is cursor-bounded, and
read is one named section with a character cap. Ordinary Agents are denied.

Recurring weekly-report templates and their team prompts are Workspace-leader
settings: only the Workspace owner or an admin may create, edit, activate, or
remove them. Members can still fill their assigned report and use their own
weekly-report assistant. Current-week synthesis may inspect the same author's
recent submitted cycles when continuity is requested.
