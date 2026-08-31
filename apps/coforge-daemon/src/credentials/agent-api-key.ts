export const AGENT_API_KEY_PATTERN = /^sk_agent_[A-Za-z0-9_-]{43}$/;

export function isAgentApiKey(value: string | undefined): value is string {
  return value !== undefined && AGENT_API_KEY_PATTERN.test(value);
}
