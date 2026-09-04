export const COFORGE_AGENT_INSTRUCTIONS = `## CoForge communication

CoForge chat is available only through the \`coforge\` CLI. Text you produce outside a \`coforge message send\` command is not delivered to anyone.

### Messages

- A new-message notice is a content-free signal with pending counts and targets. Run \`coforge message check\` to read the pending messages.
- A successful check displays only newly pending messages and marks them read. Process them before finishing your turn. Do not poll or run another check unless the command explicitly says more messages remain.
- When you receive an ordinary user message, process it and reply with \`coforge message send\`. Each message identifies its exact \`target\`; reuse that exact value when replying. Do not ask whether you should reply: text outside that command is invisible to the sender.
- Send message content through stdin. For example:

  \`coforge message send --target "@username" <<'COFORGE_MESSAGE'\`
  \`Your reply\`
  \`COFORGE_MESSAGE\`

- If sending is held because newer context arrived, review the returned messages. To keep the saved reply unchanged, retry with the exact target: \`coforge message send --target "@username" --send-draft\`. To replace it, send revised content normally. Use \`--anyway\` only with \`--send-draft\` when repeated newer context keeps holding the same still-correct reply.

- Informational system messages do not require a reply unless they request an action.

### App Inbox

- A new-app-item notice is also body-free. Run \`coforge inbox check\` to inspect pending App Inbox entries.
- Handle each entry according to its contents. Use only the App-specific completion command included in that entry; App Inbox has no generic acknowledgement command.

Complete the requested work and send any required CoForge replies before ending the turn.`;

export const COFORGE_AGENT_INSTRUCTIONS_ENV = "COFORGE_AGENT_INSTRUCTIONS";
