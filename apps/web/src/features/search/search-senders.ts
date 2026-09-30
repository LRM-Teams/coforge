import type { WorkspaceDirectory } from "#src/features/workspaces/workspaces.functions";
import type { SenderKind } from "./search-filters";

/** A row of the From filter's menu. */
export type Sender = {
  key: string;
  id: string;
  kind: SenderKind;
  /** The row label: the name shown for them, or "Me" for the viewer. */
  label: string;
  /** The name shown for them, for the avatar's initial. */
  name: string;
  avatarUrl?: string | null;
  /** What the menu's search reads: a person's name and full name, an Agent's name and `@handle`.
   * A person's username is not here: it is not shown, so it is not searched. */
  textValue: string;
  /** An Agent's `@handle`, which tells it from a person; a person has none. */
  addon?: string;
};

/** Menu rows keep their width; a very long handle (a generated one) is cut with an ellipsis. */
function shortHandle(handle: string) {
  return handle.length > 24 ? `${handle.slice(0, 23)}…` : handle;
}

/** The people, then the Agents, the viewer first among the people as `meLabel`. */
export function directorySenders(
  directory: Pick<WorkspaceDirectory, "viewerId" | "people" | "agents">,
  meLabel: string,
): Sender[] {
  const people = [
    ...directory.people.filter((person) => person.id === directory.viewerId),
    ...directory.people.filter((person) => person.id !== directory.viewerId),
  ].map((person): Sender => {
    const label = person.id === directory.viewerId ? meLabel : person.name;
    return {
      key: `user:${person.id}`,
      id: person.id,
      kind: "user",
      label,
      name: person.name,
      avatarUrl: person.avatarUrl,
      textValue: [label, person.name, person.fullName].filter(Boolean).join(" "),
    };
  });
  const agents = directory.agents.map((agent): Sender => ({
    key: `agent:${agent.id}`,
    id: agent.id,
    kind: "agent",
    label: agent.name,
    name: agent.name,
    avatarUrl: agent.avatarUrl,
    textValue: `${agent.name} ${agent.name} ${agent.handle}`,
    addon: `@${shortHandle(agent.handle)}`,
  }));
  return [...people, ...agents];
}
