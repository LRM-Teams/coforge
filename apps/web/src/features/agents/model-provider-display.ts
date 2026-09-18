/** Brand names for model provider ids Pi ships with; any other id (a Computer's own
 * `~/.pi/agent/models.json` provider such as `lenovo-deepseek-v4`) is humanized instead. */
const MODEL_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  fusecode: "FuseCode",
  google: "Google",
  "kimi-coding": "Kimi For Coding",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax CN",
  moonshotai: "Moonshot AI",
  "moonshotai-cn": "Moonshot AI CN",
  openai: "OpenAI",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  openrouter: "OpenRouter",
  "qwen-token-plan": "Qwen Token Plan",
  "qwen-token-plan-cn": "Qwen Token Plan CN",
  xai: "xAI",
  xiaomi: "Xiaomi",
  zai: "Z.AI",
  "zai-coding-cn": "Z.AI Coding CN",
};

const TOKEN_SPELLINGS: Record<string, string> = {
  ai: "AI",
  api: "API",
  chatgpt: "ChatGPT",
  claude: "Claude",
  codestral: "Codestral",
  deepseek: "DeepSeek",
  flash: "Flash",
  free: "Free",
  gemini: "Gemini",
  hy3: "HY3",
  kimi: "Kimi",
  minimax: "MiniMax",
  nano: "Nano",
  nemotron: "Nemotron",
  omni: "Omni",
  opus: "Opus",
  openai: "OpenAI",
  pro: "Pro",
  sonnet: "Sonnet",
  super: "Super",
};

function displayToken(token: string): string {
  const lower = token.toLowerCase();
  const spelled = TOKEN_SPELLINGS[lower];
  if (spelled) return spelled;
  if (lower === "b" || lower === "m") return lower.toUpperCase();
  if (/^v\d+(\.\d+)?$/.test(lower)) return lower.toUpperCase();
  if (/^\d+[mbk]$/i.test(token) || /^m\d+(\.\d+)?$/i.test(token)) return token.toUpperCase();
  if (/^\d/.test(token)) return token;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** "zai-coding-cn" → "Z.AI Coding CN", "lenovo-deepseek-v4" → "Lenovo DeepSeek V4". */
export function modelProviderDisplayName(providerId: string): string {
  return (
    MODEL_PROVIDER_DISPLAY_NAMES[providerId] ??
    providerId
      .replace(/\[(\d+)m\]/gi, "-$1m")
      .split(/[-_/]/)
      .filter(Boolean)
      .map(displayToken)
      .join(" ")
  );
}
