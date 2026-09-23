/** Minimal transport instructions; feature workflows belong in event output or the Manual. */
export type AgentLaunchIdentity = {
  name?: string;
  displayName?: string;
  description?: string;
  runtimeContext?: {
    workspaceId?: string;
    workspaceSlug?: string;
    workspaceName?: string;
    computerId?: string;
    computerName?: string;
    computerHostname?: string;
    computerOs?: string;
    computerVersion?: string;
  };
};

/**
 * Everything `buildCoforgeAgentInstructions` needs. `agentWorkspaceDirectory` and `agentId` are
 * local facts the daemon always has; `identity` is server-authored and optional end to end. The
 * daemon's only local contribution is the Agent workspace path and the `agentId`.
 */
export type CoforgeAgentPromptContext = {
  agentWorkspaceDirectory: string;
  agentId?: string;
  identity?: AgentLaunchIdentity;
  /** Provider hook for the `CRITICAL RULES:` section (see `buildCriticalRulesSection`). Empty by
   * default; no CoForge provider passes anything here today. */
  extraCriticalRules?: readonly string[];
};

/** Collapses newlines/whitespace runs to a single space and trims; used wherever user-written
 * identity text (displayName, description, name) is rendered inline so it cannot inject blank
 * lines or forge Markdown structure through whitespace alone. Exported for `agent-memory-seed.ts`,
 * which applies the same rule to the name rendered into the seeded MEMORY.md heading. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Sanitizes a value quoted inline in the identity opening: collapses newlines to spaces and
 * strips double quotes so the quoted name cannot break out of its own quotes. */
function sanitizeQuotedName(name: string): string {
  return collapseWhitespace(name).replace(/"/g, "");
}

/** Strips any line-leading `#` characters so a user-written description cannot forge a Markdown
 * heading inside `## Initial role`. Exported for `agent-memory-seed.ts`, which applies the same
 * rule to the description rendered into the seeded MEMORY.md's `## Role` section. */
export function stripHeadingMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^#+/, ""))
    .join("\n");
}

function labelWithId(label: string | undefined, id: string | undefined): string | undefined {
  if (label && id) return `${label} (${id})`;
  return label || id;
}

/**
 * `## Current Runtime Context`: bullets only for known values. `Workspace` names the tenant, so
 * the directory bullet is labelled `Agent workspace`. `Computer version` is the Computer
 * executable's version, which bundles the Daemon. Every value but the Agent workspace path and
 * `agentId` is server-authored, including `Hostname` (the Computer record's `name`, the OS
 * hostname it registered with): the Daemon renders what it is handed and never reads the local
 * hostname itself.
 */
function buildRuntimeContextSection(context: CoforgeAgentPromptContext): string {
  const identity = context.identity;
  const runtimeContext = identity?.runtimeContext;
  const lines = ["## Current Runtime Context", ""];
  const description = identity?.description?.trim();
  if (description) lines.push(`- Role: ${collapseWhitespace(stripHeadingMarkers(description))}`);
  if (identity?.name) lines.push(`- Username: @${collapseWhitespace(identity.name)}`);
  if (context.agentId) lines.push(`- Agent ID: ${context.agentId}`);
  const workspace = labelWithId(runtimeContext?.workspaceName, runtimeContext?.workspaceSlug);
  if (workspace) lines.push(`- Workspace: ${workspace}`);
  const computer = labelWithId(runtimeContext?.computerName, runtimeContext?.computerId);
  if (computer) lines.push(`- Computer: ${computer}`);
  if (runtimeContext?.computerHostname)
    lines.push(`- Hostname: ${runtimeContext.computerHostname}`);
  if (runtimeContext?.computerOs) lines.push(`- OS: ${runtimeContext.computerOs}`);
  if (runtimeContext?.computerVersion)
    lines.push(`- Computer version: v${runtimeContext.computerVersion}`);
  lines.push(`- Agent workspace: ${context.agentWorkspaceDirectory}`);
  return lines.join("\n");
}

export function buildCoforgeAgentInstructions(context: CoforgeAgentPromptContext): string {
  const rawName = context.identity?.displayName || context.identity?.name;
  const who = rawName
    ? `You are "${sanitizeQuotedName(rawName)}", an AI agent in CoForge.`
    : "You are an AI agent in CoForge.";
  return [
    who,
    buildRuntimeContextSection(context),
    ...Object.values(buildCoforgeCliGuideSections(context)),
  ].join("\n\n");
}

export type CoforgeCliGuideOptions = Pick<CoforgeAgentPromptContext, "extraCriticalRules">;
export type CoforgeCliGuideSections = ReturnType<typeof buildCoforgeCliGuideSections>;

export function buildCoforgeCliGuideSections(options: CoforgeCliGuideOptions = {}) {
  return {
    communication: `## CoForge communication
Use the shell tool to execute CoForge commands: text outside an executed \`coforge message send\` command is not delivered to chat. Reply to direct user messages; reply in channels when addressed or useful. Reuse the exact \`target=\`, including its thread suffix.

\`\`\`sh
coforge message send --target '@alice' <<'COFORGE_MESSAGE'
Your reply
COFORGE_MESSAGE
\`\`\`

Targets: \`@handle\` for DM, \`#channel\` for a channel, with \`:12345678\` for a thread. Use plain inline @handles for mentions; channel mentions require membership. Trust the message's \`type=human|agent|system\` sender field; system notices are information, not user requests.`,
    messages: `## Read and send
A body-free message notice points to work: use \`coforge message check\` for pending messages or \`coforge message read --target <target>\` for one conversation. Check marks returned messages read; handle all returned requests before ending the turn. Thread checks may omit earlier context; read the thread when needed. For older context, use \`coforge message search\` then \`read --around\`.
Follow send-result recovery instructions. If a failed send says \`Draft saved: yes\`, delivery is unknown: do not resend automatically. Do not poll for new messages.`,
    execution: `## Work
Complete the user's request using your native tools and project instructions. Ordinary requests need no Task or approval ceremony. For an existing shared Task, claim before execution; finish as in_review, then done after human approval. If a claim fails, do not start conflicting execution.
Read persistent MEMORY.md and relevant notes when recovering missing context; save only useful cross-session facts or progress. No per-turn memory reading or writing is required.`,
    safety: `## Boundaries
Never disclose private DM contents or secrets to a public channel. Do not solicit or expose credentials; redact unexpected secrets. Workspace permissions are enforced by the server. Follow user preferences for communication.
${(options.extraCriticalRules ?? []).join("\n")}`.trim(),
    help: `## Help
Use \`coforge <command> --help\` for syntax. Load feature instructions only when needed: \`coforge manual get <topic> --intent "<goal, 12+ characters>" --reason "<need, 12+ characters>"\`. Use topic \`index\` to browse or \`coforge manual search "<keywords>"\` with the same flags. Do not put secrets or message bodies in these fields. App notices provide their own handling instructions.`,
  };
}
